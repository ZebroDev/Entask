// 後端不得再用字面值當錯誤訊息。CI 與本機皆可跑：node scripts/check-error-codes.mjs
//
// 為什麼需要這支（設計 §8.2）：這道閘門才是**讓這次遷移永久化**的東西。
// 沒有它，下一個人寫一個新的中文 Results.BadRequest 又是四道防線全隱形
// ——tsc 看不到 .cs、zh-TW 測試看不到、i18next-parser 看不到、parity 比的是語系之間。
// 而那正是這次要修的病。
//
// 與 check-label-tables.mjs 的第八張表是兩件事，刻意分成兩支（設計 §8.3）：
// 那一支是**契約比對**（後端常數集 ↔ 前端 case 集，兩個檔案的一對一），
// 這一支是**原始碼形狀掃描**（單一檔案內的寫法）。硬塞進同一支會讓「標籤表」
// 這個名字變得不精確，而它是既有 7 張表的家。
//
// **已知盲區（三類，誠實記載）**——三類都是形狀掃描的固有限制，不是實作缺陷：
//   1. **`Results.X(變數)`**：11 個非字面值站點改完之後結構上就固定了，
//      但「有人新增一個帶中文的變數」它看不到。
//   2. **`Results.BadRequest(new { message = "…" })`（沒有 `code` 的那一種）**：
//      本檢查只認緊接在 `(` 之後的引號，這種物件初始化子整條隱形。
//      要抓它就得用寬鬆的正規表示式去撈 `message = "…"`，而那會對**合法的**
//      `new { code, message }` 產生大量誤判（兩者的那一段長得一模一樣），
//      所以刻意不做、改以本行記載。今天這種站點是 **0 處**。
//   3. **不經 `Results.*` 的寫法**：自己組 body 再送出的路徑（例如全域例外處理常式
//      用的 `WriteAsJsonAsync`）整條繞過本掃描——它掃的是 `Results.*` 的呼叫形狀。
//
// 三者的共同性質：本檢查驗的是**原始碼的形狀**，不是「有沒有一個沒帶 `code` 的訊息」。
// 與 check-label-tables.mjs 的解析失敗處理同一類。
//
// ── 2026-09-20 起多了 Gate A：404 的形狀鎖（設計 §5）────────────────────────
//
// 背景：本階段把全庫的裸 `Results.NotFound()` 站點改成 `ApiResults.NotFound(ErrorCodes.X)`，
// 而 404 的唯一產生點（`src/Entask.Api/Endpoints/ApiResults.cs`）走
// `Results.Json(..., statusCode: StatusCodes.Status404NotFound)`。沒有這道鎖，
// 下一個人寫一個 `Results.NotFound()` 就又是一個**沒有 code 的 404**——與上面那段同一條
// 理由：tsc／zh-TW 測試／i18next-parser／parity 四道防線全都看不到。
//
// 六條「歸零」規則（R1／R2／R3／R5／R6／R7；訊息指名 file:line）＋ 一條「恰好一處」規則（R4）。
// R4 照 check-query-filter-exceptions.mjs 的 `IgnoreQueryFilters` 既有慣例：**釘住單一產生點、
// 沒有白名單檔**（多一個產生點就是多一條不會帶 code 的路）。掃這六條的理由是它們**都是 404 的
// 等價寫法**——`Results.Forbid()` 之於 403 就是這樣漏掉的。
//
// **詞界 `(^|[^A-Za-z])` 是規則的一部分，不是版面——但它只對 R1 有意義**（R2／R6／R7 刻意
// 不帶詞界：歸零規則寧可大聲，`MyNotFoundResult` 被命中是可接受的）。拿掉它，R1 會把
// **已經改好的** `ApiResults.NotFound(` 一起命中（而 `TypedResults.NotFound()` 也含
// `Results.NotFound(`）⇒ R1 永遠紅——**詞界就是 R1 與 R2 分得開的原因**。
//
// **R3 刻意不帶詞界**（2026-09-20，final whole-branch review 的 F1）：`Results.StatusCode(404)`
// 與 `TypedResults.StatusCode(404)` 在 wire 上**是同一個被禁的形狀**（都沒有 code、也沒有訊息表），
// 接收者是誰不改變這件事 ⇒ 規則只認 `.StatusCode(…404…)`。原本寫的是
// `(^|[^A-Za-z])Results\.StatusCode\(`，而 `TypedResults` 的 `d` 讓詞界失敗：
// `TypedResults.StatusCode(404)` **一條規則都不命中**，偏偏原本那句講詞界理由的話就是拿
// `TypedResults.StatusCode(int)` 舉例——**停在結論的前一步**（閘門已經用 R2 擋住它的兄弟
// `TypedResults.NotFound`，所以這是漏的、不是選的）。放寬不會誤傷：`.StatusCode(200)` 的括號內
// 沒有 `404`，而 `Results.Json(…, statusCode: StatusCodes.Status404NotFound)` 的 `statusCode:`
// 前面也沒有 `.`。
//
// **R7 是 F1 的另一半**：`NotFoundResult` 是設計 §1.1 的普查列過、卻一條規則都沒有的形狀
// （`grep -c NotFoundResult` 當時是 0）。補上之後**普查的 6 個形狀逐一有規則**
// （`Results.NotFound("` → R1、`TypedResults.NotFound` → R2、`StatusCode(404)` → R3、
// `StatusCodes.Status404NotFound` → R4、`statusCode: 404` → R5、`NotFoundResult` → R7），
// 而 R6（`HttpStatusCode.NotFound`）是反方向的落差——普查沒列、閘門守得比普查寬。
//
// ── 2026-09-20 起多了 401 家族（R8–R13 ＋ R14）──────────────────────────────
//
// 同一天把 401 的空 body 補完（`Results.Unauthorized()` 與 JwtBearer 的認證挑戰原本都不帶
// body），規則**逐條對應**上面六條：R8↔R1（含同樣的詞界理由）、R9↔R2、R10↔R3（同樣**刻意
// 不帶前綴**）、R11↔R5、R12↔R6、R13↔R7，而 R14↔R4（`StatusCodes.Status401Unauthorized`
// 恰好一處、且在 `API_RESULTS_FILE`）。
//
// **R13 比 R7 寬一格是刻意的**：404 那一側的 `NotFoundHttpResult` 靠 R2 的**呼叫形狀**
// （`TypedResults.NotFound`）守著，而 401 階段的普查是把 `UnauthorizedHttpResult` 列成
// **一個形狀**（實測當時 0 處）⇒ R13 直接認那個型別名。嚴格變寬、不是變錯
// ——F1 的教訓就是「普查列過的形狀要逐一有規則」。
//
// **兩個家族共同的已知盲區**：不經這些形狀的寫法（`new SomeHttpResult()` 之類）看不到，
// 與檔頭第 3 類同一性質——本閘門驗的是**原始碼的形狀**，不是「執行期有沒有回 401」。
//
// ── 2026-09-21 起多了 500 家族（R15–R21）────────────────────────────────────
//
// 全域例外中介層（`Program.cs` 的 `app.Use` 第二個 catch）與四個既有站點收斂到
// `ApiResults.WriteInternalErrorAsync`／`ApiResults.InternalError`（兩個入口、一個
// `ExecuteInternalErrorAsync`）之後，500 與 404／401 同形：單一產生點、單一常數。
//
// **R15 就是那個常數**（`StatusCodes.Status500InternalServerError`：恰好一處、且在
// `API_RESULTS_FILE`），形狀與 R4／R14 逐字相同。**能這樣收，靠的是兩個入口共用同一個
// `ExecuteInternalErrorAsync`**——兩個入口各寫一次狀態碼的話，這裡就得開「恰好兩處」這個
// 第三種驅動，而那正是漂移的溫床（與 401 那批同一條理由）。
//
// **R16–R21 是 500 的六種替代形狀**，與前面兩個家族對應：R16↔R3／R10、R17↔R2／R9、
// R18↔R5／R11、R19↔R6／R7，R20／R21 是 500 獨有的兩條。
// 形狀清單與命中數是**先量再寫規則**（2026-09-21 實測，掃遮罩後的程式碼）：
// `Status500InternalServerError` 原始 3 處 ⇒ 程式碼裡 **1 處**（另兩處是 `ApiResults.cs`
// 的 `///` 註解）、`.StatusCode(…5xx…)`／`statusCode: 5xx`／`StatusCodeResult`／
// `HttpStatusCode.InternalServerError`／`Results.Problem(` 各 **0 處**。
//
// **R16 照 R3／R10 刻意不帶前綴**（接收者是誰不改變「這是手寫狀態碼」這件事），
// 而 `[^)]*` 可以跨行。它不會誤傷 R15 的那一行：`statusCode: StatusCodes.Status500…` 裡的
// `StatusCode` 後面接著 `s` 而不是 `(`，前面也沒有 `.`。
//
// **R20 的盲區（誠實記載）**：它掃的是字面值，而 `WebApplication` 在 Development 下
// **隱式**加的那一層 developer exception page **不在原始碼裡**（任何 grep 都看不到）。
// R20 收的三種寫法（`UseExceptionHandler`／`AddProblemDetails`／`IExceptionHandler`）
// 都是**會與這個中介層搶同一個例外**的——搶到的話 body 就不是 `{code, message}`
// （框架那層隱式的今天無害：例外在**內層**就被攔下，它到不了；本階段實測，改動前它才是
// 那個把型別／訊息／堆疊整份送出去的東西，見 `InternalErrorBodyTests` 檔頭）。
//
// **R21（`Results.Problem(`）不是上面 `PATTERN` 那個 `Problem` 的複製品**：`PATTERN` 只認
// `Results.Problem("字面值")`，這一條認的是**整個形狀**。`ProblemDetails` 的 body 是
// `{type, title, status, detail, …}`——前端唯一的錯誤出口認不得它，那是**第五種形狀**，
// 等於沒有訊息（與 `Program.cs` 舊的 `{ error = "…" }` 同一類）。
//
// **R19 只認 `InternalServerError` 一個成員**：`HttpStatusCode.ServiceUnavailable` 之類的
// 其他 5xx 成員今天 0 處、不在規則內（要收就補一條，判別力照下面那些規則的做法）。
//
// **遮罩（`maskCSharp`）是這些規則能不能成立的前提，不是加分項**：`ApiResults.cs` 自己的
// `///` 註解**刻意**寫著 `Results.NotFound(...)`、`Results.StatusCode(500)`、
// `StatusCodes.Status404NotFound` 與 `StatusCodes.Status500InternalServerError`（那是給
// 下一個人的說明，見該檔檔頭）——不遮的話 R1 會數到它、R4／R15 會各數到兩處、R16 會多一處。
// **不要**改用「跳過行首 `//`／`*`」的近似：那對行尾註解（`var x = 1; // Results.NotFound(`）
// 沒有用，而 `maskCSharp` 已經存在（`lib/label-table-extract.mjs`）、`check:query-filters`
// 就對同一個 `src/` 跑它——**不要再寫第二份「判斷某個位置在不在程式碼裡」**（那條規則在
// 標籤表閘門已經用一次回歸換來過）。遮罩是**等長**的（只把字串／註解的內容換成空白，
// 引號與換行留著），所以 `lineAt` 可以直接換算，而既有的 `PATTERN`（需要 `\(\s*"`）
// 在遮罩後仍然成立——搬過去是行為不變，不是放寬。認不得的構件一律 fail closed
// （`LabelTableParseError` ⇒ exit 1，不猜）：今天不會拋——`check:query-filters` 已經對
// 同一個 `src/` 跑同一個掃描器且是綠的（那是**實查依據，不是保證**）。
//
// **Gate A 自己的已知盲區（承上面三類，這裡只記新的）**：本閘門掃的是**寫法**，不是
// 「執行期有沒有回 404」。`ApiResults.NotFound(變數)` 是合法的（code 由呼叫端決定）；
// 但自己組 body 的路徑（`Results.Json(..., statusCode: 一些變數)`、`WriteAsJsonAsync`）
// 整條看不到——與上面第 3 類同一個性質。
//
// ── 2026-09-24 起多了 429 家族（R22–R24 ＋ R25）──────────────────────────────
//
// 列舉面限流（`Program.cs` 的 `AddRateLimiter` ＋ `Options/RateLimitPolicy`）逾額時經
// `ApiResults.WriteTooManyRequestsAsync` 產生 429（`{code, message}` ＋ `Retry-After`）。
// 429 與 404／401／500 同形：**一個入口、一個常數**（R25 就是那個常數）。
//
// **這一族的形狀普查是當場編譯量出來的，不是從前三個家族抄的**（2026-09-24）：探針專案
// 實際編譯的結果是——`Results.TooManyRequests` 與 `TypedResults.TooManyRequests`
// **不存在**（`CS0117: 'Results' 未包含 'TooManyRequests' 的定義`），而
// `Results.StatusCode(429)` 與 `HttpStatusCode.TooManyRequests` **存在**。
// ⇒ 這一族**沒有** R2／R9 那種「框架方法名」的規則（那個 API 根本不在框架裡），
// R22／R23／R24 逐條對應 R3／R10／R16、R5／R11／R18、R6／R12／R19。
// **不要**憑「前三個家族各有六條」就補出第六條——形狀清單要跟著**實測**走，
// 為一個不存在的 API 寫規則等於留一個永遠不會響的守衛。
//
// **R25 的「恰好一處」比 R4／R14／R15 更硬**：那三條的家族各有兩個入口（`IResult` 與
// `HttpContext`），是靠收斂到同一個 `Execute*` 才成立的；429 只有一個入口
// （限流器是中介層，手上只有 `HttpContext`）⇒ 它連「兩個入口各寫一次」的機會都沒有。
// 反過來說：**`options.RejectionStatusCode = StatusCodes.Status429TooManyRequests`**
// 這一行（空 body 的 429）會被 R25 以「多於一處」擋下——那正是這一條要守的東西。
//
// 已知盲區與上面三個家族相同：不經這些形狀的寫法（`new SomeHttpResult()` 之類）看不到。

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { LabelTableParseError, maskCSharp } from "./lib/label-table-extract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const repoRoot = join(root, "..");
const scanDir = join(repoRoot, "src");

// 掃描範圍＝**整個 `src/`**。
//
// 原本只掃 `src/Entask.Api/Endpoints`——那是遷移期間的範圍。收尾時放寬的理由有兩條：
// ① 端點目錄不是錯誤訊息的唯一產地，領域層也會產生使用者看得到的訊息
//    （`src/Entask.Board/CustomFields/CustomFieldValidator.cs` 就是現成的例子，
//    它原本落在掃描範圍外）；
// ② 放寬的成本是零——實測 `src/` 底下的命中數與只掃端點目錄時相同。
//
// 分批期間這裡有一份 `MIGRATED` 檔案清單與 `範圍外` 分支（B2 的檔案範圍閘門形狀）；
// 六批跑完之後`範圍外`已無語意，清單與分支一併刪除。
// 檔案數不必回填：那時清單的 21 是「**曾經有字面值**的檔案數」，不是這個目錄的檔案數。
// 掃的是**遮罩後**的整份檔案（不是逐行——`\s*` 本來就可以跨行，跨行的字面值站點在舊版
// 是漏的；這一步讓它變吵，方向是對的）。引號本身在遮罩後留著，所以 `\(\s*"` 仍然成立。
const PATTERN = /Results\.(BadRequest|NotFound|Conflict|Problem|Forbid|Unauthorized)\(\s*"/g;

// ── Gate A 的規則（詳見檔頭）────────────────────────────────────────────
// 「歸零」規則（R1／R2／R3／R5／R6／R7 之於 404、R8–R13 之於 401、R16–R21 之於 500、
// R22–R24 之於 429）＋「恰好一處」四條（R4／R14／R15／R25）。
// ★ **這裡刻意不寫總條數**（2026-09-24 複閱的 L-2）：原本寫的是「十八條＋三條」，而 429 家族
// 加進來之後沒有人會想起它——本 repo 已經反覆記載「寫死的條數會腐爛」。要數就數上面那串 id
// （`GATE_A_ZERO_RULES.map(r => r.id).join("/")` 也會在通過時印出來）。
// 都跑在遮罩後的整份檔案上，命中位置再由 `lineAt`
// 換算成行號。`id` 同時用在訊息與測試的對照（測試靠 `R1：` 這種標頭分辨紅在哪一條）。
// **編號不連號是刻意的，而且編號順序不等於陣列順序**：R4 是 404 那一批就有的「恰好一處」、
// 插在中間；之後每一批的新規則接在**當時**的最大號之後——所以 R15（500 的「恰好一處」）
// 排在 `GATE_A_EXACT_ONE`，而號碼比它大的 R16–R21 在 `GATE_A_ZERO_RULES`。
const API_RESULTS_FILE = "src/Entask.Api/Endpoints/ApiResults.cs";

const GATE_A_ZERO_RULES = [
  {
    id: "R1",
    pattern: /(^|[^A-Za-z])Results\.NotFound\(/g,
    header: "R1：`Results.NotFound(` 是 404 的舊形狀",
    hint: "404 一律走 `ApiResults.NotFound(ErrorCodes.X)`——唯一的產生點，會帶 code 與譯文。",
  },
  {
    id: "R2",
    pattern: /TypedResults\.NotFound/g,
    header: "R2：`TypedResults.NotFound` 是同一種舊形狀的另一個寫法",
    hint: "同上，改用 `ApiResults.NotFound(ErrorCodes.X)`。",
  },
  {
    id: "R3",
    // **刻意不帶詞界**（F1）：`Results.StatusCode(404)` 與 `TypedResults.StatusCode(404)` 是
    // 同一個被禁的形狀。`[^)]*` 可以跨行——`Results.StatusCode(\n  StatusCodes.Status404NotFound)`
    // 也命中。接收者（`Results.`／`TypedResults.`／任何變數）一律不管。
    pattern: /\.StatusCode\([^)]*404/g,
    header: "R3：`.StatusCode(…404…)` 是手寫狀態碼，404 不走它（兩個前綴都算）",
    hint: "改用 `ApiResults.NotFound(ErrorCodes.X)`（403 那批的手寫站點是 403 的事）。",
  },
  {
    id: "R5",
    pattern: /statusCode:\s*404(?!\d)/g,
    header: "R5：`statusCode: 404` 是裸的數字，少了 code 與訊息表",
    hint: "改用 `ApiResults.NotFound(ErrorCodes.X)`。",
  },
  {
    id: "R6",
    pattern: /HttpStatusCode\.NotFound/g,
    header: "R6：`HttpStatusCode.NotFound` 不是這個 repo 產生 404 的方式",
    hint: "改用 `ApiResults.NotFound(ErrorCodes.X)`。",
  },
  {
    id: "R7",
    // 照 R2／R6：**不帶詞界**（歸零規則寧可大聲）。收的是 MVC 型別
    // `Microsoft.AspNetCore.Mvc.NotFoundResult`——它同樣是不帶 code 的 404 寫法。
    pattern: /NotFoundResult/g,
    header: "R7：`NotFoundResult`（MVC 型別）不是這個 repo 產生 404 的方式",
    hint: "改用 `ApiResults.NotFound(ErrorCodes.X)`。",
  },
  {
    id: "R8",
    // 詞界的理由與 R1 逐字相同：`ApiResults.Unauthorized(` 也含 `Results.Unauthorized(`
    // （前面那個字母是 `i`），少了詞界這條規則永遠紅、且與 R9 分不開。
    pattern: /(^|[^A-Za-z])Results\.Unauthorized\(/g,
    header: "R8：`Results.Unauthorized()` 是 401 的舊形狀（沒有 body）",
    hint: "401 一律走 `ApiResults.Unauthorized(ErrorCodes.X)`——它會帶 code 與譯文。",
  },
  {
    id: "R9",
    pattern: /TypedResults\.Unauthorized/g,
    header: "R9：`TypedResults.Unauthorized` 是同一種舊形狀的另一個寫法",
    hint: "同上，改用 `ApiResults.Unauthorized(ErrorCodes.X)`。",
  },
  {
    id: "R10",
    // 照 R3：**刻意不帶前綴**（`Results.StatusCode(401)` 與 `TypedResults.StatusCode(401)`
    // 是同一個被禁的形狀）。`[^)]*` 可以跨行。
    pattern: /\.StatusCode\([^)]*401/g,
    header: "R10：`.StatusCode(…401…)` 是手寫狀態碼，401 不走它（兩個前綴都算）",
    hint: "改用 `ApiResults.Unauthorized(ErrorCodes.X)`。",
  },
  {
    id: "R11",
    pattern: /statusCode:\s*401(?!\d)/g,
    header: "R11：`statusCode: 401` 是裸的數字，少了 code 與訊息表",
    hint: "改用 `ApiResults.Unauthorized(ErrorCodes.X)`。",
  },
  {
    id: "R12",
    pattern: /HttpStatusCode\.Unauthorized/g,
    header: "R12：`HttpStatusCode.Unauthorized` 不是這個 repo 產生 401 的方式",
    hint: "改用 `ApiResults.Unauthorized(ErrorCodes.X)`。",
  },
  {
    id: "R13",
    // 照 R2／R6／R7：**不帶詞界**（歸零規則寧可大聲）。比 R7 寬一格——同時收 MVC 的
    // `UnauthorizedResult` 與 minimal API 的 `UnauthorizedHttpResult`，理由見檔頭。
    pattern: /Unauthorized(Http)?Result/g,
    header: "R13：`UnauthorizedResult`／`UnauthorizedHttpResult` 不是這個 repo 產生 401 的方式",
    hint: "改用 `ApiResults.Unauthorized(ErrorCodes.X)`。",
  },
  {
    id: "R16",
    // 照 R3／R10：**不寫前綴**，一個 pattern 同時涵蓋 `Results.` 與 `TypedResults.`（同一個
    // 被禁的形狀）。`[^)]*` 可以跨行。不會誤傷 R15 那一行——見檔頭。
    //
    // **原文的理由是錯的（2026-09-21 由突變更正）**：這裡原本寫「刻意不帶前綴，因為帶了會把
    // `TypedResults.` 排掉」——**帶了照樣命中**，`Results\.` 是 `TypedResults\.` 的子字串
    // （`TypedResults` 以 `Results` 結尾）。實測：改成 `/Results\.StatusCode\(…/` ⇒ 39 支全綠，
    // 那個突變根本沒有改變行為（**無效突變**，不是「測試沒判別力」）。有判別力的是相反方向
    // 與詞界形式，兩者都實測過（見 `check-error-codes.test.mjs` 的三列 `TypedResults`）。
    pattern: /\.StatusCode\([^)]*5\d\d/g,
    header: "R16：`.StatusCode(…5xx…)` 是手寫狀態碼，500 不走它（兩個前綴都算）",
    hint: "改用 `ApiResults.InternalError(ErrorCodes.X)`——唯一會帶 code 與譯文的產生點。",
  },
  {
    id: "R17",
    // `(?:Results|TypedResults)\.` 裡的 `Results` 那一支**是多餘的**（同 R16 的子字串關係：
    // `Results\.InternalServerError` 本身就命中 `TypedResults.InternalServerError`；2026-09-21
    // 實測：拿掉 `TypedResults` 那一支，39 支全綠）。留著只是讓兩個前綴在原始碼裡一眼看得見
    // ——`ApiResults` 的檔頭也是這樣寫的。**兩列測試各守一邊，各自有紅燈**（皆實測）：
    // 規則收成只剩 `TypedResults.` ⇒ `Results.` 那一列紅；寫成帶詞界的 `\bResults\.` ⇒
    // `TypedResults.` 那一列紅。
    pattern: /(?:Results|TypedResults)\.InternalServerError/g,
    header: "R17：`Results.InternalServerError` ／ `TypedResults.InternalServerError` 是同一種舊形狀",
    hint: "同上，改用 `ApiResults.InternalError(ErrorCodes.X)`——它有 body，這一種只有狀態碼。",
  },
  {
    id: "R18",
    pattern: /statusCode:\s*5\d\d(?!\d)/g,
    header: "R18：`statusCode: 5xx` 是裸的數字，少了 code 與訊息表",
    hint: "同上，改用 `ApiResults.InternalError(ErrorCodes.X)`。",
  },
  {
    id: "R19",
    // 照 R6／R7／R12／R13：**不帶詞界**（歸零規則寧可大聲）。只認 `InternalServerError`
    // 這一個成員，其餘 5xx 成員不在規則內——見檔頭。
    pattern: /HttpStatusCode\.InternalServerError|StatusCodeResult/g,
    header: "R19：`HttpStatusCode.InternalServerError`／`StatusCodeResult` 不是這個 repo 產生 500 的方式",
    // ★ `StatusCodeResult` 是**形狀**、不分狀態碼（歸零規則寧可大聲）⇒ `new StatusCodeResult(429)`
    // 也由這一條接住，而它離 500 家族的 hint 很遠（2026-09-24 複閱的 L-3）。
    // 判準不變：被接住是對的，錯的只有「該怎麼修」那一句——所以 hint 補上 429 的分支，
    // **不要**為了讓訊息精準而把 pattern 收窄成 `StatusCodeResult\(5`：那會讓
    // `new StatusCodeResult(429)` 從此沒有一條規則看得到（另一個拼法的盲區）。
    hint: "同上，改用 `ApiResults.InternalError(ErrorCodes.X)`；若它帶的是 **429**，改用 `ApiResults.WriteTooManyRequestsAsync(context)`。",
  },
  {
    id: "R20",
    // 這三種（＋ `IExceptionHandler`）都會**與 `Program.cs` 的中介層搶同一個例外**，
    // 搶到的話 body 就不是 `{code, message}` 了。改動前那個隱式的 developer exception page
    // 掃不到（不在原始碼裡）——見檔頭。
    pattern: /UseExceptionHandler|AddProblemDetails|UseDeveloperExceptionPage|IExceptionHandler/g,
    header: "R20：`UseExceptionHandler`／`AddProblemDetails`／`UseDeveloperExceptionPage`／`IExceptionHandler` 會蓋掉全域例外中介層",
    hint: "例外一律由 `Program.cs` 的 `app.Use` 那一條處理（它呼叫 `ApiResults.WriteInternalErrorAsync`）；要改行為就改那裡，不要並存第二條管線。",
  },
  {
    id: "R21",
    // 與上面 `PATTERN` 的 `Problem` 是兩件事：那一條只認帶字面值的呼叫，這一條認整個形狀。
    pattern: /(?:Results|TypedResults)\.Problem\(/g,
    header: "R21：`Results.Problem(`／`TypedResults.Problem(` 的 body 是 `ProblemDetails`，前端認不得",
    hint: "改用 `ApiResults.InternalError(ErrorCodes.X)`——`{code, message}` 才是全庫唯一的錯誤 body 形狀。",
  },
  {
    id: "R22",
    // 照 R3／R10／R16：**不寫前綴**，一個 pattern 同時涵蓋 `Results.` 與 `TypedResults.`
    // （同一個被禁的形狀：空的 429）。`[^)]*` 可以跨行。
    // 不會誤傷 R25 那一行——`statusCode: StatusCodes.Status429…` 裡的 `StatusCode` 後面
    // 接著 `s` 而不是 `(`（與 R16 之於 R15 逐字相同的理由）。
    pattern: /\.StatusCode\([^)]*429/g,
    header: "R22：`.StatusCode(…429…)` 是手寫狀態碼，429 不走它（兩個前綴都算）",
    hint: "改用 `ApiResults.WriteTooManyRequestsAsync(context)`——它會帶 code 與譯文。",
  },
  {
    id: "R23",
    // 2026-09-24 複閱的 M-1 **放寬**：原本只認 `statusCode:` 這個**冒號**拼法。
    // 而 `RateLimiterOptions.RejectionStatusCode` 的型別是 **`int`**（`Program.cs` 的註解
    // 講的就是這個屬性）⇒ 空 body 的 429 最自然的寫法是 `RejectionStatusCode = 429`
    // ——**等號**，一條規則都不命中。
    // ★ 這正是「同一個被禁形狀的另一個拼法沒有規則」，本檔已記載過兩次（`TypedResults.
    // StatusCode(404)` 因詞界而全不命中、`NotFoundResult` 一條規則都沒有）⇒ 判準是
    // **形狀清單要跟著「人能怎麼寫」走**，不是跟著當時手上那一個寫法走。
    // 放寬成 `[:=]` 之後兩種拼法都收。**不誤傷 R25**：`= StatusCodes.Status429TooManyRequests`
    // 的 `=` 之後接的是 `StatusCodes`、不是數字（那是 R25 的「恰好一處」在守的形狀）。
    pattern: /statusCode\s*[:=]\s*429(?!\d)/gi,
    header: "R23：`statusCode` 被寫成裸的數字 429（`:` 與 `=` 兩種拼法都算）",
    hint: "同上，改用 `ApiResults.WriteTooManyRequestsAsync(context)`。",
  },
  {
    id: "R24",
    // 照 R6／R7／R12／R13：**不帶詞界**（歸零規則寧可大聲）。存在的證據是當場編譯
    // （`HttpStatusCode.TooManyRequests` 編得過，見檔頭）——不是從前三個家族推的。
    pattern: /HttpStatusCode\.TooManyRequests/g,
    header: "R24：`HttpStatusCode.TooManyRequests` 不是這個 repo 產生 429 的方式",
    hint: "同上，改用 `ApiResults.WriteTooManyRequestsAsync(context)`。",
  },
];

// 「恰好一處」的規則（今天四條：R4 之於 404、R14 之於 401、R15 之於 500、R25 之於 429）。
// 不是歸零，而是必須在 `API_RESULTS_FILE`：三個方向（多於一處／一處都沒有／位置不對）都 exit 1。
// **沒有白名單檔**是刻意的（見檔頭）。
//
// 401 與 500 之所以能與 404 同形——單一檔案、單一常數、恰好一行——是因為 `ApiResults` 把
// `IResult` 與 `HttpContext` 兩個入口都收斂到同一個 `ExecuteUnauthorizedAsync`／
// `ExecuteInternalErrorAsync`（見該檔的說明）。**沒有那個收斂就沒有這條規則**：兩個入口
// 各寫一次狀態碼的話，這裡就得開一個「恰好兩處」的第三種驅動，而那正是漂移的溫床。
// （429 那一族連這個機會都沒有——它只有一個入口，見下面那一節。）
const GATE_A_EXACT_ONE = [
  {
    id: "R4",
    pattern: /StatusCodes\.Status404NotFound/g,
    header: "R4：`StatusCodes.Status404NotFound` 必須恰好一處",
    missing:
      "0 處：唯一的產生點不見了。`ApiResults.NotFound` 必須經由 " +
      "`StatusCodes.Status404NotFound` 產生 404。",
    elsewhere: "404 的產生點只有那一個檔案（設計 §5 Gate A）；換位置只是把同一條路搬去別處。",
  },
  {
    id: "R14",
    pattern: /StatusCodes\.Status401Unauthorized/g,
    header: "R14：`StatusCodes.Status401Unauthorized` 必須恰好一處",
    missing:
      "0 處：唯一的產生點不見了。`ApiResults.Unauthorized` 必須經由 " +
      "`StatusCodes.Status401Unauthorized` 產生 401。",
    elsewhere: "401 的產生點只有那一個檔案；換位置只是把同一條路搬去別處。",
  },
  {
    id: "R15",
    pattern: /StatusCodes\.Status500InternalServerError/g,
    header: "R15：`StatusCodes.Status500InternalServerError` 必須恰好一處",
    missing:
      "0 處：唯一的產生點不見了。`ApiResults.InternalError` 與 " +
      "`WriteInternalErrorAsync` 必須經由 `StatusCodes.Status500InternalServerError` 產生 500。",
    elsewhere: "500 的產生點只有那一個檔案；換位置只是把同一條路搬去別處。",
  },
  {
    id: "R25",
    pattern: /StatusCodes\.Status429TooManyRequests/g,
    header: "R25：`StatusCodes.Status429TooManyRequests` 必須恰好一處",
    missing:
      "0 處：唯一的產生點不見了。`ApiResults.WriteTooManyRequestsAsync` 必須經由 " +
      "`StatusCodes.Status429TooManyRequests` 產生 429。",
    elsewhere: "429 的產生點只有那一個檔案；換位置只是把同一條路搬去別處。",
  },
];

const GATE_A_RULES = [...GATE_A_ZERO_RULES, ...GATE_A_EXACT_ONE];

// `bin`／`obj` 底下是建置產物（`AssemblyInfo.cs`、`GlobalUsings.cs` 之類），
// 掃它們只會讓「掃了幾個檔案」變成一個取決於上次建置的數字。
const SKIP_DIRS = new Set(["bin", "obj"]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".cs") ? [full] : [];
  });
}

const violations = [];
const gateAHits = new Map(GATE_A_RULES.map((rule) => [rule.id, []]));
const unreadable = [];
let scanned = 0;

const lineAt = (source, index) => source.slice(0, index).split("\n").length;

// 行號換算以**規則真正指到的 token** 為準，不是 `match.index`：R1／R8 的第 1 個群組是
// 詞界那一格，而它可能**是一個換行**（行首的 `Results.NotFound(` 前面沒有別的字元）
// ——直接拿 `match.index` 會報到**上一行**，把下一個人送到錯的地方。**只有 R1／R8 有群組**
// （2026-09-20，F1：R3 放寬之後不再有詞界那一格；R8 沿用 R1 的形狀），其餘各條的
// `match[1]` 是 undefined ⇒ 0，同一條式子涵蓋全部規則。
// 既有的 `PATTERN` **不適用**（它的第 1 群組是動詞名），那邊直接用 `match.index`
// ——它的比對從 `Results` 開始，本來就對。
const hitIndex = (match) => match.index + (match[1]?.length ?? 0);

for (const file of walk(scanDir)) {
  const rel = relative(repoRoot, file).replaceAll("\\", "/");
  scanned += 1;

  const source = readFileSync(file, "utf8");

  // 認不得的形狀＝大聲。**不要**在這裡 `continue` 掉就算了：那會讓「掃不到」看起來像
  // 「沒問題」。遮罩是七條規則的前提（見檔頭），這裡遮不動就沒有後面的判定可言。
  let masked;
  try {
    ({ masked } = maskCSharp(source, rel));
  } catch (error) {
    if (error instanceof LabelTableParseError) {
      unreadable.push(error.message);
      continue;
    }
    throw error;
  }

  const lines = source.split(/\r?\n/);
  const lineText = (index) => (lines[lineAt(source, index) - 1] ?? "").trim();

  for (const match of masked.matchAll(PATTERN)) {
    violations.push(`${rel}:${lineAt(source, match.index)}  ${lineText(match.index)}`);
  }

  for (const rule of GATE_A_RULES) {
    for (const match of masked.matchAll(rule.pattern)) {
      const at = hitIndex(match);
      gateAHits.get(rule.id).push(`${rel}:${lineAt(source, at)}  ${lineText(at)}`);
    }
  }
}

if (unreadable.length > 0) {
  console.error("錯誤碼形狀檢查無法完成——掃描器遇到它認不得的形狀（本檢查不猜）：\n");
  for (const u of unreadable) console.error(`  - ${u}`);
  console.error("\n請改寫該檔，或更新 web/scripts/lib/label-table-extract.mjs 的 C# 掃描器。");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("後端仍有以字面值當錯誤訊息的站點：\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\n共 ${violations.length} 處。改用 new { code = ErrorCodes.X, message = "原文" }` +
      `（設計 §5.2；帶數字時再加 @params）。`,
  );
  process.exit(1);
}

const firedZeroRules = GATE_A_ZERO_RULES.filter((rule) => gateAHits.get(rule.id).length > 0);
if (firedZeroRules.length > 0) {
  console.error("後端仍有 404／401／429／500 的替代形狀（設計 §5 Gate A；這幾條的契約都是一律 0 處）：\n");
  for (const rule of firedZeroRules) {
    const hits = gateAHits.get(rule.id);
    console.error(`  ${rule.header}——實測 ${hits.length} 處：`);
    for (const hit of hits) console.error(`    - ${hit}`);
    console.error(`    ${rule.hint}`);
  }
  process.exit(1);
}

// 「恰好一處」的規則各有三種壞法：多於一處、一處都沒有、位置不對。
for (const rule of GATE_A_EXACT_ONE) {
  const hits = gateAHits.get(rule.id);
  if (hits.length !== 1) {
    console.error(
      `${rule.header}——實測 ${hits.length} 處：\n` +
        (hits.length === 0 ? `  （${rule.missing}）\n` : hits.map((hit) => `  - ${hit}\n`).join("")) +
        `  契約是恰好 1 處、且在 ${API_RESULTS_FILE}——多一處就是多一條不會帶 code 的路。` +
        "沒有白名單檔（照 check:query-filters 的 IgnoreQueryFilters 慣例）。",
    );
    process.exit(1);
  }

  if (!hits[0].startsWith(`${API_RESULTS_FILE}:`)) {
    console.error(
      `${rule.header}——恰好 1 處，但不在 ${API_RESULTS_FILE}：\n` +
        `  - ${hits[0]}\n` +
        `${rule.elsewhere}`,
    );
    process.exit(1);
  }
}

// 通過時把規則數印出來，**規則清單本身不寫死在訊息裡**——寫死的話，新增一條規則而
// 忘了改這行的話，跑綠的人是看不出來的（R14 就是新加的那種）。歸零規則逐條列 id，
// 讓「哪幾條今天在守」在輸出裡看得見。
console.log(
  `錯誤碼形狀檢查通過：${scanned} 個後端原始檔中沒有字面值錯誤訊息，` +
    `404／401／429／500 的替代形狀（${GATE_A_ZERO_RULES.map((rule) => rule.id).join("／")}）0 處，` +
    GATE_A_EXACT_ONE.map(
      (rule) => `${rule.pattern.source.replaceAll("\\", "")} 恰好 1 處`,
    ).join("、") +
    `（${API_RESULTS_FILE}）。`,
);
