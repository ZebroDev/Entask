// 後端識別碼 ↔ 前端標籤表的契約鎖。CI 與本機皆可跑：node scripts/check-label-tables.mjs
//
// 為什麼需要這支（2026-09-14，B2-4 code review 的懸而未決項裁定）：
//
// 後端有一批「機器可讀的字串常數」會被原樣送到前端，前端再用一張標籤表翻成顯示文字：
//
//   src/Entask.Core/ActivityTypes.cs       29 個 → pages/board/tabs/CardActivityTab.tsx 的 typeLabel
//   src/Entask.Core/CustomFieldTypes.cs     6 個 → lib/custom-fields.ts 的 typeLabel
//   src/Entask.Core/ReviewStatuses.cs       3 個 → pages/project/tabs/ReportTab.tsx 的 reviewLabel
//
// 這裡的個數是**示意**（2026-09-17 實查；`ActivityTypes` 當天由 28 長到 29）——真正的集合
// 由這支腳本自己數，這幾行不隨常數增減更新，也**不要拿它當數字來源**。
//
// 這條鏈上有三份必須同步的清單（後端常數、前端 switch、每個語系的 key），而本來
// **沒有任何一道既有的守門員看得到「後端加了、前端沒加」**：
//
//   - tsc -b：switch 的 default 分支讓少一個 case 也編得過，而且沒有任何型別是這樣連的。
//   - zh-TW 的測試：CardActivityTab 沒有測試檔；自訂欄位型態的標籤也沒有斷言。
//   - i18next-parser --fail-on-update：它只看得到前端寫出來的 key，看不到後端。
//   - check-locale-parity.mjs：它比的是「各語系之間」，來源語系自己少了 key 它看不到。
//
// 後果是 B2-4 實測到的形狀：後端 28 種、前端只有 24 種，四種活動在活動牆上
// 直接印出原始型別字串（王小明 mindmap_bound），zh-TW 與 en 都一樣。
// 那不是 B2-4 造成的，是這條鏈從一開始就沒有守門員。
//
// 為什麼落在 scripts/ 而不是測試檔或後端測試套件：
//
//   - 不能放前端測試檔。測試檔在 tsconfig.app.json 的 include（src）裡，所以 tsc -b
//     會檢查它們，而該檔的 types 刻意只有 ["vite/client"]——實測（2026-09-14）
//     import "node:fs" 在 tsc -b 下是 TS2591: Cannot find name 'node:fs'。
//     要放就得把 node 加進 types，那會讓**應用程式碼**也能若無其事地 import node 模組，
//     換掉的是整個 app 的邊界。vitest 的 globals 同理（測試檔一律明確 import）。
//   - 不該放後端測試套件。那是「後端測前端檔案」的反向耦合，而且會把一支純文字比對
//     綁進 8 分鐘的 DB 套件（dotnet test 沒辦法只跑它）。
//   - scripts/ 底下是 .mjs，不在任何 tsconfig 的 include 裡，讀檔不受限；
//     check-locale-parity.mjs 已經是同一條路徑上的前例。
//
// 方向是「前端讀後端的檔案」，也就是依賴的天然方向——前端是後端契約的消費者。
// 讀的是文字，不需要 .NET SDK，所以 CI 的 frontend job 跑得動（它本來就整庫 checkout）。
//
// 解析失敗一律失敗，不靜默跳過——與 check-locale-parity.mjs 同一條規則。
//
// **抽取層在 `lib/label-table-extract.mjs`**（2026-09-17，Task 8 fix round 2）。這裡只留
// TABLES、檢查 1–8 與診斷訊息；「原始碼 → 值／key 對照」整段搬過去，理由是那些定位器
// **需要被測**：這支腳本沒有測試，而 fix round 1 的 18 個形狀只能躺在 gitignored 的目錄裡，
// 每次修都要重新推導一次。搬過去之後 `label-table-extract.test.mjs` 可以在記憶體裡餵字串
// （`npx vitest run` 會收）、CLI 照舊讀檔。
//
// `.ts`／`.tsx` 的抽取用 **TypeScript compiler API**（`typescript` 本來就是 devDependency）。
// 這是判定的結果不是偏好：fix round 1 用逐字元跳略（`skipNonCode`）去逼近「這個字元在不在
// 程式碼裡」，結果關掉一個洞、在反方向開了同型的另一個（D1：同一個輸入修正前 exit 1、
// 修正後 exit 0）。近似只要還在，就還會在下一個沒想到的輸入上換方向。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LabelTableParseError,
  extractArrayConst,
  extractBackendValues,
  extractLabelTable,
  extractSupportedLocales,
} from "./lib/label-table-extract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const repoRoot = join(root, "..");

const errors = [];
// 同一條訊息只記一次。抽取層的失敗訊息只帶檔名（不含表名），所以一支 `.cs` 餵幾張表就會
// 印幾次——`ReviewStatuses.cs` 一個檔五張表 ⇒ 同一條解析失敗印 5 次，而那是**檔案級**的
// 失敗，重複的每一行都沒有新資訊（Task 8 fix round 3 的 F3；舊版行為相同、非回歸）。
// 這一層只在失敗路徑上生效，exit code 仍由「訊息清單非空」決定。
const fail = (msg) => {
  if (!errors.includes(msg)) errors.push(msg);
};

/**
 * 受檢的標籤表。source 相對 repo 根，table 相對 web/。
 *
 * arrayConst 是同一份清單在該檔裡的第二個副本（下拉選單用的值陣列）——它與後端常數
 * 是同一件事寫兩次，所以一併比對：只改一邊會讓選單出現後端不認得的型別，或反過來
 * 讓某個型別選不到。
 */
const TABLES = [
  {
    name: "活動型別",
    source: "src/Entask.Core/ActivityTypes.cs",
    table: "src/pages/board/tabs/CardActivityTab.tsx",
    arrayConst: null,
    ns: "card",
    keyPrefix: "activityType",
  },
  {
    name: "自訂欄位型態",
    source: "src/Entask.Core/CustomFieldTypes.cs",
    table: "src/lib/custom-fields.ts",
    arrayConst: "FIELD_TYPES",
    ns: "common",
    keyPrefix: "fieldType",
  },
  {
    // B2-5b 補進來的第三張（原本是模組層級的寫死中文，抽字串時才變成 switch）。
    //
    // 這張表的 key 在 `common:state.*` 而不是 `project:*`：同一組後端值在
    // `ItemDetailsTab` 的審查結果下拉選單裡已經是 `common:state.approved` 與
    // `common:state.rejected`，另立一組會讓同一件事有兩份譯文。`keyPrefix` 因此
    // 是比較寬的 `state`（那個 namespace 底下還有別的狀態詞），守的是「不可以指到
    // 別的家族去」——「指到一個不存在的 key」由檢查 5 擋。
    name: "審查狀態",
    source: "src/Entask.Core/ReviewStatuses.cs",
    table: "src/pages/project/tabs/ReportTab.tsx",
    arrayConst: null,
    ns: "common",
    keyPrefix: "state",
  },
  {
    // 第四張：**同一個後端值的第二個取用點**（B2-5b code review 的 HIGH）。
    //
    // 後端 `ReviewStatuses` 的值在畫面上有兩處被翻成顯示文字——報表表格的
    // `reviewLabel`（上一張）與審查表單的狀態下拉選單。只鎖前者時，後端加了狀態
    // 而選單沒跟上，症狀是「選單少一個選項」：不會印出識別碼、不會紅、沒有日誌。
    //
    // 形狀不同（`<SelectItem value="x">{t("key")}</SelectItem>` 而不是 switch），
    // 所以由 `shape: "selectItems"` 指定解析器。key 跨兩個 namespace，因此用
    // `allowedPrefixes` 取代單一的 ns ＋ keyPrefix——D4 之後選單只剩「可提交」的
    // 兩個立場，目前實際用到的只有 `common:state.`。
    //
    // **來源是 `Submittable` 而不是 `All`（R8）**：審查表單在 D4 之後不再提供
    // `pending` 這個選項（它是「還沒審」而不是一種提交），所以這一張表要跟著選單
    // 一起收窄。`All` 仍餵第三張表（報表表格要顯示 `pending` 這一列）——
    // **兩張表刻意不同源**，改這裡不會動到那一張。
    //
    // 兩者必須同批改：只改前端不改來源時 `check:labels` 會紅在「後端有 pending、
    // 選單沒有對應項」，肇因卻在下一個動到這支腳本的人身上。
    name: "審查狀態（審查表單下拉選單）",
    source: "src/Entask.Core/ReviewStatuses.cs",
    backendArray: "Submittable",
    table: "src/pages/board/tabs/ItemDetailsTab.tsx",
    shape: "selectItems",
    arrayConst: null,
    allowedPrefixes: ["common:state.", "card:review.status."],
  },
  {
    // 第五張（2026-09-14，標籤表契約補完批次）。
    //
    // 這一張的症狀與前三張同型，但**它連標籤表都不存在**——`TeamActivityTab` 把
    // `AuditLog.Action` 原樣印在畫面上（zh-TW 使用者看到「team.created：核心研發團隊」）。
    // 也就是說「後端加了動作」與「前端沒有對應」在這裡本來是同一件事：沒有表可鎖。
    //
    // ★ 2026-10-10：這張表已抽到 `src/lib/audit-labels.ts`（活動牆與系統活動頁共用），
    // `table:` 跟著搬——上面那兩句是**當時的症狀**，不是現在的位置。
    //
    // `user.created` 在**活動牆**上仍不可達（TeamId 為 null）；**系統活動頁**
    // （`/system-activity`）看得到——留著這條 case 是為了集合相等。這是刻意的：
    // 一條死 case 比在閘門裡造一個「這個值可以不用翻」的排除機制便宜，而且後者會讓
    // 下一張表也想用。
    name: "稽核動作",
    source: "src/Entask.Core/AuditActions.cs",
    table: "src/lib/audit-labels.ts",
    arrayConst: null,
    ns: "team",
    keyPrefix: "audit",
  },
  {
    // 第六張（2026-09-14，標籤表契約補完批次）。
    //
    // 症狀與活動型別**刻意相反**：B2-4 漏 case 時活動牆印出識別碼（看得出來），
    // 這裡是前端 `default` 回傳「C 待加強」——後端新增等級時畫面顯示的是**一個看起來
    // 完全正常的標籤**，沒有任何跡象。`TeamReportTab` 因此改成「認不得的評級原樣顯示」，
    // 但真正的不變量是這一張表：它比的是後端 `RatingCodes` 與前端 switch 的集合相等。
    //
    // 後端是同一個值三條輸出路徑（JSON／CSV／xls），已由 `RatingFor` 收斂成一處；
    // xls 的 `<Style>` 區塊與每一格的 StyleID 也同源（`RatingStyles`），所以這一張表
    // 只需要鎖前端這一個消費端。
    name: "績效評等",
    source: "src/Entask.Core/RatingCodes.cs",
    table: "src/pages/team/TeamReportTab.tsx",
    arrayConst: null,
    ns: "team",
    keyPrefix: "report.rating",
  },
  {
    // 第七張（2026-09-14，標籤表契約補完批次）。
    //
    // 這一張的識別碼**不存在於資料庫**——`PermissionCategories` 是純契約檔，值由
    // 「權限碼的第一段」推導而來（`card.effort.update` → `card`）。前端 `RoleEditDialog`
    // 原本拿後端 `PermissionDto.category`（寫進 DB 的中文顯示字）當 reduce 的鍵，
    // 那在 P-C 把權限目錄在地化之後會讓**鍵跟著語系跑**（切一次語系多一組分組）。
    //
    // 「前綴＝分類」這個推導本身由後端 `PermissionCategoriesTests` 釘住；這張表釘的是
    // 另一半：後端宣告的分類集合與前端 switch 的 case 集合必須相等。
    name: "權限分類",
    source: "src/Entask.Core/PermissionCategories.cs",
    table: "src/pages/team/RoleEditDialog.tsx",
    arrayConst: null,
    ns: "team",
    keyPrefix: "permissionCategory",
  },
  {
    // 第八張（2026-09-15，P-C 錯誤碼化）。
    //
    // 症狀與活動型別同型：後端新增一個錯誤碼而前端忘了補 case 時，`errorMessage`
    // 的 `default` 讓它回 `null`，呼叫端退回顯示伺服器的 `message`——**畫面是對的**
    // （這是設計 §6.1 的安全閥），所以四道既有防線全都不會紅。真正的不變量是
    // 「兩邊的集合相等」，也就是這一張表。
    //
    // 值這一側是**點分的錯誤碼字面值**而不是常數名：前端刻意不再維護一份
    // `ErrorCodes` 鏡射物件（那會是錯誤碼的第二份副本；**條數會隨錯誤碼增減，這裡不寫死**
    // ——要精確值就自己數 `ErrorCodes.cs` 的 public const string 與本檔的 `case`，
    // 兩邊必須相等），所以 `case` 直接寫字面值。
    // 打錯字面值的後果是「一條永遠不會命中的 case」，由檢查 2 抓。
    //
    // `keyPrefix` 用 `allowedPrefixes` 表達：這個 namespace 沒有二級前綴，
    // key 就是 `error:` 後面接 code 的路徑。
    name: "錯誤碼",
    source: "src/Entask.Core/ErrorCodes.cs",
    table: "src/lib/error-messages.ts",
    arrayConst: null,
    allowedPrefixes: ["error:"],
  },
  {
    // 第九張（2026-09-15，P-C Followups）。
    //
    // 這一張的症狀是**全庫最後一處「直接渲染後端顯示字」**：`RoleEditDialog` 把
    // `PermissionDto.description`（資料庫種子裡的中文）印在權限碼右邊。F4 已經處理掉
    // `category`（改用權限碼的第一段分組），`description` 是剩下的那一半。
    //
    // 值這一側是**點分的權限碼字面值**而不是常數名（與錯誤碼同一個理由：前端不維護
    // `PermissionCodes` 的鏡射物件）。打錯字面值的後果是「一條永遠不會命中的 case」，
    // 由檢查 2 抓。
    //
    // `permission` namespace 與 `error` 同型：**一個後端識別碼詞彙表一個 namespace**。
    // 分類標籤（`team:permissionCategory.*`）刻意留在 team——那是 `PermissionCategories`
    // 這個**另一個**詞彙表，與權限碼不是同一件事。
    name: "權限說明",
    source: "src/Entask.Core/PermissionCodes.cs",
    table: "src/pages/team/RoleEditDialog.tsx",
    arrayConst: null,
    allowedPrefixes: ["permission:"],
  },
  {
    // 第十張（2026-09-15，P-C Followups）。
    //
    // 症狀與錯誤碼那張**刻意相反**：`errorMessage` 的 default 回 null → 呼叫端退回伺服器的
    // message，畫面是對的；這裡的 default 回空字串 → 走舊列回退 → 最後顯示
    // `me:notification.fallback.*`。兩者的共同點是「後端加了 kind 而前端沒補」時
    // **四道既有防線全都不會紅**（tsc 有 default、zh-TW 測試看不到、parser 只看前端寫出的
    // key、parity 比的是語系之間）。
    //
    // 一個表項涵蓋兩個 switch：解析器掃的是**整檔**的 `case "x": return i18n.t("y");`，
    // 而 `notification-text.ts` 的標題與內文各有一個（值集合相同）。
    // 值這一側是 kind 的**字面值**（`comment_created`）而不是常數名——與錯誤碼同一個理由。
    name: "通知訊息變體",
    source: "src/Entask.Core/NotificationKinds.cs",
    table: "src/lib/notification-text.ts",
    arrayConst: null,
    allowedPrefixes: ["me:notification."],
  },
  {
    // 第十一張（2026-09-17，審查生命週期 Task 8；Task 6 任務審查的 M1）。
    //
    // 症狀與其他 switch 表同型（後端加了狀態而這裡沒補 case ⇒ `default: return status`
    // 把原始識別碼印到畫面上），但**這一張原本連掛都掛不上**：這支檔案裡當時有兩個 switch
    // （`reviewStatusLabel` 翻**逐位審查者**的立場、`reviewBadgeLabel` 翻**整張卡的
    // rollup**；後者已於 2026-09-17 併入 `src/lib/review-badge.ts`），而舊的掃描器是整檔
    // 掃的——兩者一掛進來，`common:state.approved` 這種兩邊都用的 key 會被檢查 4 當成
    // 「兩條 case 指向同一個 key」而誤報，正向案例就紅。
    // 所以有 `scope` 的表各自指名一個函式，掃描範圍縮到該函式的本體。
    //
    // 來源是 `ReviewStatuses.All` 而不是 `Submittable`：**逐審查者的立場可以是
    // `pending`**（還沒審），只有「提交」的那份表單不接受它。這一張與第四張刻意不同源
    // （第四張是選單的值集合，這一張是畫面上的顯示文字）。
    //
    // `pending` 這一格用 `card:review.status.pending` 而不是 `common:state.pending`：
    // 同一個畫面上「某位審查者的立場」與「這張卡的立場」本來就是兩件事，所以**鍵不同**。
    // **但兩個鍵的值已於 2026-09-19 由使用者裁定統一為「待審查」**
    // （原本是「待審查」／「待審」的分裂，那個分裂已不存在）——**不要再把這裡描述成
    // 「刻意不同字」**：那會讓下一個譯者以為值必須不一樣。本表的 `allowedPrefixes`
    // 仍然兩個前綴都收，所以兩邊各自接哪一個鍵，這一張閘門都不會響。
    //
    // **守著它的是一支渲染測試，不是本檔的閘門**（2026-09-18 whole-branch review 的 I-1
    // 更正：這裡原文寫「由檢查 8 守」是假的）。檢查 8 只比對**同一支檔案**裡的兩個
    // `scope` 表，而 2026-09-17 的合併之後全庫僅存的兩個 scoped 表分屬兩支檔案（這一張的
    // `ItemDetailsTab.tsx` 與第十二張的 `review-badge.ts`）⇒ **檢查 8 全庫已無對象可比**。
    //
    // ★ **下面這一條已經失效（2026-09-21 突變實測）**，原文留著是為了讓它不被重新發明：
    // 「真正會紅的是 `CardDialog.test.tsx`……把本表的 `pending` 改接 `common:state.pending`
    // 會讓它當場變紅」。把 `ItemDetailsTab.tsx` 的 `case "pending"` 實際改成
    // `t("common:state.pending")` 之後，**三道防線全綠**：`CardDialog.test.tsx` 82/82、
    // `check:labels` exit 0、`tsc -b` exit 0。那個預測的前提是**兩支不同字**（斷言
    // `管理員：待審` 才會分得開），統一之後前提消失。
    // ⇒ **今天沒有任何機器守著「這一張表的落點要走 `card:review.status.pending`」**，
    // 改掉它只會讓其中一個鍵變成孤兒，而且沒有紅燈。
    name: "審查狀態（逐審查者立場）",
    source: "src/Entask.Core/ReviewStatuses.cs",
    backendArray: "All",
    table: "src/pages/board/tabs/ItemDetailsTab.tsx",
    scope: "reviewStatusLabel",
    arrayConst: null,
    allowedPrefixes: ["common:state.", "card:review.status."],
  },
  {
    // 第十二張（原第十三張，2026-09-17 合併）：卡片徽章的標籤。落點是共用模組，
    // 因為六個落點（看板卡片、卡片對話框、表格、月曆、甘特、心智圖）共用同一個函式
    // ——合併前這裡有兩張同 scope 的表，各指一個檔案，加四個視圖就會變成七份副本。
    //
    // 合併的正當性在 AGENTS.md 的不變量「措辭分裂真的被統一時，收法是合併兩張表，不是砍表」，
    // **不在檢查 8**（2026-09-18 whole-branch review 的 I-1 更正：檢查 8 只比對同一支檔案裡
    // 的兩個 `scope` 表，而合併之後全庫僅存的兩個 scoped 表分屬兩支檔案 ⇒ 它沒有對象可比，
    // 引它為據會讓讀者以為這裡還有一道閘門）。統一是真的，就不該再有兩張表；砍 TABLES 的
    // 項目或 `scope` 來消音，則會讓這支檔案回到沒有守門員的狀態。
    //
    // `allowedPrefixes` 只有 `common:state.`：徽章翻的是整張卡的 rollup，它的詞彙就是
    // 這一組。指到 `card:review.status.*`（逐審查者的那一組）會被檢查 3 擋下——那正是
    // 兩個呼叫端被互相貼錯 key 的形狀。
    name: "審查狀態（卡片徽章）",
    source: "src/Entask.Core/ReviewStatuses.cs",
    backendArray: "All",
    table: "src/lib/review-badge.ts",
    scope: "reviewStateLabel",
    arrayConst: null,
    allowedPrefixes: ["common:state."],
  },
  {
    // 第十三張（2026-10-08，小型缺陷批次 A 的 Task 2／`state/31`）。
    //
    // 症狀與其他 switch 表**刻意相反**：這裡的 `default` 回傳**資料庫裡的 Name**——
    // 那是對的（自訂角色的名字是使用者的資料），所以「後端加了第七個系統角色而前端沒補
    // case」在畫面上是**一個看起來完全正常的中文/任何語系的標籤**，沒有任何跡象；
    // 而 en 使用者看到的則是種子寫死的中文。四道既有防線也全都不會紅：`tsc -b` 有 default、
    // zh-TW 的斷言看不到（譯文與種子 Name 逐字相同）、parser 只看前端寫出的 key、
    // parity 比的是語系之間。
    //
    // 來源 `SystemRoleCodes.cs` **沒有**值陣列（六個 `public const string` 就是全集），
    // 所以 `arrayConst` 是 null——與自訂欄位型態那張（有 `FIELD_TYPES` 第二副本）不同，
    // 這張沒有第二個副本要對。
    //
    // 六個 key 落在 `team` namespace 的 `roleName.` 之下：角色是團隊層級的概念，
    // 而這個 namespace 已經有 `team:permissionCategory.*`（另一張表）與
    // `team:role.*`（自訂角色 CRUD 的文案，**與本表無關**——`roleName` 與 `role`
    // 是兩個不同的鍵前綴，這正是 `keyPrefix` 要指名到 `roleName` 的原因）。
    name: "系統角色名",
    source: "src/Entask.Core/SystemRoleCodes.cs",
    table: "src/lib/role-labels.ts",
    arrayConst: null,
    ns: "team",
    keyPrefix: "roleName",
  },
];

/**
 * 抽取層的失敗一律記進這一支的錯誤清單，回傳值給呼叫端當「這一張表／這一項解析不到」。
 * 只有 LabelTableParseError 會被吞掉；其他例外照拋（那是這支腳本自己的 bug，不該靜默）。
 */
function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LabelTableParseError) {
      fail(err.message);
      return null;
    }
    throw err;
  }
}

/** 從 locales.ts 取出 SUPPORTED_LOCALES。取不到就失敗，不猜。 */
function readSupportedLocales() {
  const src = readFileSync(join(root, "src", "i18n", "locales.ts"), "utf8");
  return guard(() => extractSupportedLocales(src, { fileName: "locales.ts" })) ?? [];
}

/**
 * 後端常數的值集合。解析不到回 null 並記一筆失敗——呼叫端據此**跳過該表的其餘檢查**。
 *
 * 不跳過的話，空集合會被當成「後端什麼都沒有」，於是每一個 case 都各自再報一次
 * 「後端沒有這個常數」——28 行噪音蓋掉唯一有意義的那一行（2026-09-14 負向實測）。
 *
 * `arrayName` 給定時，來源改成該檔裡的 `public static readonly string[] <arrayName> = [...]`，
 * 再把陣列裡的識別碼逐一帶回同一檔的 `public const string`。**這是 R8 需要的**：
 * 審查表單的立場選單只接受「可提交」的狀態（`ReviewStatuses.Submittable`，`pending` 不在其中，
 * 設計 D4），而那是 `All` 的子集——只掃 `public const string` 取不出子集，
 * 寫死值又會讓「後端加了狀態」這件事不再有守門員（那正是這支腳本存在的理由）。
 * 解析不到的識別碼一律失敗，不猜、不跳過。
 */
function readBackendValues(relPath, arrayName) {
  const src = readFileSync(join(repoRoot, relPath), "utf8");
  return guard(() => extractBackendValues(src, { label: relPath, arrayName }));
}

/**
 * 前端標籤表的「值 → key」對照。解析不到回 null，理由同 readBackendValues。
 *
 * 回傳 `{ pairs, scopeLine }`——`pairs` 的每一筆帶 `{ value, key, line, scope }`，
 * 診斷訊息才能指到**行號**而不是只有檔名（一支檔案裝兩張表時，光有檔名分不出是哪一張）。
 *
 * 兩種形狀並存是刻意的：switch 是**動態 key 的標準寫法**（設計 §6.1，查表會被
 * `keepRemoved: false` 刪掉），而 `SelectItem` 的選項清單本來就是三個字面值，
 * 沒有查表問題。與其把選單改寫成 switch 去迎合檢查，不如讓檢查認得兩種形狀。
 *
 * `scope`（選填，只對 switch 形狀有意義）把掃描範圍縮到該函式的本體。需要它的理由：
 * 同一支檔案裡有兩個 switch 時，整檔掃描會把兩者的 case 混在一起——兩邊都用的 key
 * （`common:state.approved`）會被檢查 4 當成「兩條 case 指向同一個 key」而誤報，
 * 正向案例就紅；而「這一張表要守哪一個 switch」也不再分得出來。
 *
 * 抽取的實作（AST、`t("key", params)` 為什麼要收、`scope` 為什麼找不到就 fail closed）
 * 見 `lib/label-table-extract.mjs`。這一支只負責把失敗記進錯誤清單。
 */
function readLabelTable(spec) {
  const relPath = spec.table;
  const src = readFileSync(join(root, relPath), "utf8");
  return guard(() =>
    extractLabelTable(src, {
      label: relPath,
      fileName: relPath,
      shape: spec.shape ?? "switch",
      scope: spec.scope,
    }),
  );
}

/** 該檔裡同名陣列常數的內容（第二個副本）。 */
function readArrayConst(relPath, name) {
  const src = readFileSync(join(root, relPath), "utf8");
  return guard(() => extractArrayConst(src, { label: relPath, fileName: relPath, name })) ?? [];
}

/** 語系檔攤平成「點分鍵 → 值」。檔案不存在回 null（呼叫端據此回報缺檔）。 */
function readLocale(locale, ns) {
  const file = join(root, "src", "i18n", "locales", locale, `${ns}.json`);
  if (!existsSync(file)) return null;
  const out = new Map();
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) walk(v, path);
      else out.set(path, v);
    }
  };
  walk(JSON.parse(readFileSync(file, "utf8")), "");
  return out;
}

const locales = readSupportedLocales();
if (locales.length === 0) fail("SUPPORTED_LOCALES 是空的。");

let checkedValues = 0;

/** 表項的身分：值 ＋ key。兩個 switch 各自把同一個值指到不同的 key 時，這是兩筆表項。 */
const pairId = ({ value, key }) => JSON.stringify([value, key]);

// 迴圈後的跨表檢查要用：每一支檔案**掃到的**表項與**被認領的**表項。
// 兩者都以檔為單位取聯集——一支檔案可以裝兩張表（見下面的歸屬篩選）。
const scannedByFile = new Map();
const claimedByFile = new Map();
// 檢查 8（跨表、同一支檔案）要用：每一張有 `scope` 的表的值 → key 對照 ＋ 函式名。
const scopedByFile = new Map();

/** 診斷訊息裡的「位置」：檔名 ＋ 行號，有 `scope` 的再補上函式名。 */
const where = (relPath, pair) => `${relPath}:${pair.line}${pair.scope ? ` 的 ${pair.scope}` : ""}`;

for (const spec of TABLES) {
  const backend = readBackendValues(spec.source, spec.backendArray);
  const table = readLabelTable(spec);
  // 來源解析失敗時已經記了一筆，其餘檢查只會產生衍生噪音（見 readBackendValues 的說明）。
  if (backend === null || table === null) continue;
  const { pairs: allPairs, scopeLine } = table;
  const backendSet = new Set(backend);

  // 這一張表自己的表項。整檔掃到的 case 要按各自的 key 空間歸屬，不能全數算在每一張表
  // 頭上——**一支檔案可以裝兩張表**：`RoleEditDialog.tsx` 同時有權限分類與權限說明兩個
  // switch，`notification-text.ts` 同時有標題與內文兩個（後者是第十張表刻意的一個表項，
  // 見該表註解）。少了這一層，同一支檔案的兩張表會互相吃掉對方的 case：第七張把 22 條
  // `permission:*` 當成自己的、第九張把 6 條 `team:permissionCategory.*` 當成自己的，
  // 各報「後端沒有這個常數」與「不在 ... 之下」兩種錯，2026-09-16 實測合計 56 項
  // （第七張 44、第九張 12）。
  //
  // 歸屬判準有兩個分支，第二個是關鍵：**值就是本表後端集合裡的值**時一律歸本表，即使
  // key 指到別的 namespace——那正是檢查 3 要報的形狀（值對、key 貼錯）。少了這個分支，
  // 這種表項會被靜默丟掉，改由檢查 1 用「沒有對應的項目」把讀者指向一條明明存在的 case。
  const allowed = spec.allowedPrefixes ?? [`${spec.ns}:${spec.keyPrefix}.`];
  const pairs = allPairs.filter((p) => backendSet.has(p.value) || allowed.some((pre) => p.key.startsWith(pre)));
  const frontendSet = new Set(pairs.map((p) => p.value));

  // 供檢查 8 用。只在有 scope 時記錄——沒有 scope 的表掃的是整檔，兩張這種表在同一支檔案裡
  // 本來就是常態（`RoleEditDialog`、`notification-text`），把它們拿來互比會是誤報的來源。
  if (spec.scope && scopeLine !== null) {
    const entries = scopedByFile.get(spec.table) ?? [];
    entries.push({ scope: spec.scope, scopeLine, map: new Map(pairs.map((p) => [p.value, p.key])) });
    scopedByFile.set(spec.table, entries);
  }

  // 記錄（供迴圈後的跨表檢查）。只在來源解析成功時記錄——解析失敗的那張表已經各記了一筆，
  // 再把它掃到的表項全算成「沒人認領」只是衍生噪音（見 readBackendValues 的說明）。
  const scanned = scannedByFile.get(spec.table) ?? new Map();
  for (const p of allPairs) scanned.set(pairId(p), p);
  scannedByFile.set(spec.table, scanned);
  const claimed = claimedByFile.get(spec.table) ?? new Set();
  for (const p of pairs) claimed.add(pairId(p));
  claimedByFile.set(spec.table, claimed);

  // 檢查 1：後端有、前端沒有。這是 B2-4 那四條漏網的形狀——活動牆直接印原始字串。
  // 症狀依形狀而不同：switch 的 default 會把識別碼印到畫面上；下拉選單只是少一個選項。
  const symptom =
    spec.shape === "selectItems"
      ? "選單會少一個選項，那個值選不到（不印識別碼、沒有錯誤訊息、也沒有日誌）"
      : "該型別會直接印出原始字串（zh-TW 與 en 都一樣）";
  // 有 scope 的表要把函式名寫出來：同一支檔案裡的兩張表只有檔名一樣，光看檔名分不出是哪一張。
  const scopeSuffix = spec.scope ? ` 的 ${spec.scope}` : "";
  for (const value of backendSet) {
    if (frontendSet.has(value)) continue;
    fail(
      `[${spec.name}] 後端 ${spec.source} 有 "${value}"，但 ${spec.table}${scopeSuffix} 沒有對應的項目——${symptom}。`,
    );
  }

  // 檢查 2：前端有、後端沒有。不會有錯誤訊息，但這條 case 永遠不會被觸發——
  // 通常是後端改名後前端沒跟上，而 default 分支讓它靜默地無害。
  for (const value of frontendSet) {
    if (backendSet.has(value)) continue;
    fail(
      `[${spec.name}] ${where(spec.table, pairs.find((x) => x.value === value))} 有 case "${value}"，` +
        `但後端 ${spec.source} 沒有這個常數——這條永遠不會被觸發。`,
    );
  }

  // 檢查 3：key 的前綴與 namespace 對得上。對不上時下面檢查 4 會去錯的檔案找，
  // 訊息會指向語系檔而不是肇因。`allowed` 的定義在上面（歸屬篩選共用同一個清單），
  // 兩者共用是刻意的：這條檢查報得到的就是**歸屬第二個分支**收進來的表項。
  //
  // 單一 ns ＋ keyPrefix 是常態；跨 namespace 的表（同一組後端值散在兩個 namespace）
  // 改用 allowedPrefixes 列出可接受的開頭。
  for (const pair of pairs) {
    if (allowed.some((pre) => pair.key.startsWith(pre))) continue;
    fail(
      `[${spec.name}] ${where(spec.table, pair)} 的 case "${pair.value}" 指向 ${pair.key}，` +
        `不在 ${allowed.join(" 或 ")} 之下。`,
    );
  }

  // 檢查 4：兩個 case 指向同一個 key。不會壞，但幾乎一定是其中一條貼錯了。
  const seen = new Map();
  for (const pair of pairs) {
    if (seen.has(pair.key))
      fail(
        `[${spec.name}] ${where(spec.table, pair)} 的 "${seen.get(pair.key)}" 與 "${pair.value}" ` +
          `指向同一個 key ${pair.key}。`,
      );
    else seen.set(pair.key, pair.value);
  }

  // 檢查 5：每個 key 在每個語系都存在且非空。
  //
  // zh-TW 這一側由 i18next-parser 補（config 的 locales 只有 zh-TW），
  // **en 這一側沒有自動補**——那是 P-B2 的遷移工具寫的，工具於 B2-7 刪除後就得手寫。
  // 少了 en 的 key 時畫面會退回 fallback 語系（顯示中文），而 i18next-parser 不會紅
  // （它只管 zh-TW）。parity 的檢查 3 也擋得住這一條，這裡放一份是為了讓診斷訊息
  // 一次講完「後端加了什麼、前端少了什麼、哪個語系缺 key」。
  for (const pair of pairs) {
    const { value, key } = pair;
    // namespace 由 key 自己決定（不是 spec.ns）——跨 namespace 的表才找得到檔案；
    // 沒有冒號的 key 檢查 3 已經報過，這裡不重複產生衍生訊息。
    const sep = key.indexOf(":");
    if (sep < 0) continue;
    const ns = key.slice(0, sep);
    const path = key.slice(sep + 1);
    for (const locale of locales) {
      const table = readLocale(locale, ns);
      if (table === null) {
        fail(`[${spec.name}] src/i18n/locales/${locale}/${ns}.json 不存在（${key} 指到的 namespace）。`);
        continue;
      }
      const text = table.get(path);
      // 訊息裡的檔名用上面解出來的 `ns`，不是 `spec.ns`——後者在 allowedPrefixes 的表
      // （第四張）是 undefined，會印出「en/undefined.json 沒有這個 key」，把診斷指到
      // 一個不存在的檔案去。
      if (text === undefined) {
        fail(`[${spec.name}] ${where(spec.table, pair)} 的 "${value}" 指向 ${key}，但 ${locale}/${ns}.json 沒有這個 key。`);
      } else if (typeof text === "string" && text.trim() === "") {
        fail(`[${spec.name}] ${key} 在 ${locale}/${ns}.json 是空字串——沒有人填這個譯文。`);
      }
    }
  }

  // 檢查 6：同一份清單的第二個副本（值陣列）與後端一致。
  if (spec.arrayConst) {
    const arr = readArrayConst(spec.table, spec.arrayConst);
    const arrSet = new Set(arr);
    if (arr.length !== arrSet.size) fail(`[${spec.name}] ${spec.table} 的 ${spec.arrayConst} 有重複的值。`);
    for (const value of backendSet) {
      if (!arrSet.has(value)) fail(`[${spec.name}] 後端有 "${value}"，但 ${spec.arrayConst} 沒有——該型別在選單裡選不到。`);
    }
    for (const value of arrSet) {
      if (!backendSet.has(value)) fail(`[${spec.name}] ${spec.arrayConst} 有 "${value}"，但後端沒有這個常數。`);
    }
  }

  checkedValues += backendSet.size;
}

// 檢查 7（跨表）：每一支檔案掃到的表項，至少要有一張**屬於該檔案**的表認領它。
//
// 歸屬篩選（上面的 `pairs`）讓同一支檔案的兩張表不再互相污染，代價是**單表檔案**裡貼錯表的
// case 會被靜默丟掉：在 `TeamReportTab.tsx` 貼一條從別的表複製過來的
// `case "approved": return i18n.t("common:state.approved");`，該表的後端集合沒有這個值、
// key 也不在 `team:report.rating.` 之下——檢查 1～6 全都看不到它。2026-09-16 A/B 實測：
// `e30b95b` 之前是 2 項錯誤，之後是 exit 0、沒有任何訊息。
//
// **按檔案算聯集、不按表算**：按表算的話，`RoleEditDialog` 的兩張表會各自把對方沒認領的
// 表項報成孤兒——那正是 `e30b95b` 要修的病，只是換一個症狀種回來。
for (const [table, scanned] of scannedByFile) {
  const claimed = claimedByFile.get(table) ?? new Set();
  for (const [id, p] of scanned) {
    if (claimed.has(id)) continue;
    fail(
      `${where(table, p)} 的 case "${p.value}" 指向 ${p.key}，但這支檔案裡的每一張標籤表都沒有認領它——` +
        `值的集合與 key 的前綴都不相符，通常是從**別的**表複製過來的，這條 case 永遠不會被觸發。`,
    );
  }
}

// 檢查 8（跨表、同一支檔案）：兩個 `scope` 的「值 → key」對照不得完全相同。
//
// 為什麼需要這一條（2026-09-17，審查生命週期 Task 6 審查的 M1）：`ItemDetailsTab.tsx` 當時
// 有兩個 switch，在 `pending` 上**刻意不同字**（逐審查者的 `待審`／整張卡的 `待審查`），
// 而「其中一個被改成另一個的 key」這件事四個既有檢查全都看不到——值集合
// 一樣、key 的前綴都在允許清單內、沒有重複的 key、每個語系檔也都找得到。
// 突變實測：`reviewStatusLabel` 的 `pending` 改成 `common:state.pending` ⇒
// `check:labels`、`tsc -b`、`i18n:parity` 與全部測試照樣全綠，只有畫面把兩個措辭併成一個。
//
// 判準是「**對照完全相同**」而不是「某一個值相同」：同一支檔案裡只有**部分**值共用 key 是
// 正常的（那些值同源），兩個 switch 的對照完全一致時第二個 switch 才失去存在理由——
// 那正是「刻意的分裂塌掉」的可偵測形態，而且不必把 key 寫死在這裡（key 改名不會讓它腐爛）。
//
// 這條檢查**會**擋住一個合法的變更：使用者若裁定統一 `待審`／`待審查` 的措辭，兩張表就會
// 真的相同。那是對的行為（它逼出一次明示裁定），而且會隨**誠實的修法**自動解除——兩個函式
// 此時真的該合併，`ItemDetailsTab` 只剩一個 scope，這一條就沒有對象可比。
// **訊息因此必須同時點出兩種可能**（2026-09-17 Task 8 任務審查的裁定）：只寫「其中一個的
// case 被改錯了」的話，在「刻意統一」的情境下那句話是錯的，而最省事的消音方式是砍掉一個
// TABLES 項目或砍掉 `scope`——那正好把 M1 的洞重新打開。
// **不加 `allowIdenticalWith` 這類白名單欄位**：目前沒有使用者，真要統一時再加，
// 屆時它必須留下一份可審的 diff（見 AGENTS.md 的「措辭分裂真的被統一時，收法是合併兩張表，
// 不是砍表」不變量——**不是**上一條「審查立場的權威來源是 `CardReview` 本身」，
// 那一條講的是 entry 與立場的關係，與檢查 8 無關；2026-09-17 Task 8 fix round 1 的
// scoped re-review 指出這個指標指錯了地方）。
for (const [table, entries] of scopedByFile) {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.scope === b.scope || a.map.size !== b.map.size) continue;
      let identical = true;
      for (const [value, key] of a.map) {
        if (b.map.get(value) !== key) {
          identical = false;
          break;
        }
      }
      if (!identical) continue;
      fail(
        `${table} 的 ${a.scope}（:${a.scopeLine}）與 ${b.scope}（:${b.scopeLine}）兩個 switch 的「值 → key」對照完全相同——` +
          `同一支檔案裡的第二個標籤表只有在**刻意不同**時才有存在理由。兩種可能：` +
          `①其中一個的 case 被貼成了另一個的 key（措辭分裂在不知不覺中塌掉，兩個呼叫端現在會印出同一個字）；` +
          `②兩組措辭**已經被刻意統一**（` +
          `「統一 \`待審\`／\`待審查\`」在使用者的產品文案裁定清單上）。` +
          `②的正解是**合併兩個函式、把多出來的那張表從 TABLES 刪掉**（統一是真的，就不該再有兩張表）；` +
          `**不要只砍 TABLES 的項目或 scope 來消音**——那會讓這一支檔案重新回到沒有守門員的狀態。` +
          `兩者的處置見 AGENTS.md 的「措辭分裂真的被統一時，收法是合併兩張表，不是砍表」不變量。`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("標籤表契約檢查失敗：\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\n共 ${errors.length} 項。`);
  process.exit(1);
}

console.log(
  `標籤表契約檢查通過：${TABLES.map((t) => t.name).join("、")} 共 ${checkedValues} 個識別碼；` +
    `後端常數、前端 switch 與 ${locales.join("、")} 的譯文一致。`,
);
