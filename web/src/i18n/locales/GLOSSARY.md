# 術語對照表（四個語系的共同權威）

2026-09-16 建立。來源：`en` 的複閱（970 條）。
2026-09-20 全盤同步。此後產品又動了三批：**品牌改名**、**審查生命週期**
（審查歷程、交付、一次交付通過率、主管考評），以及 **2026-09-20 的三條詞彙裁定**
（列表／檢查清單／項目、卡片標題、期間）。這張表已跟著更新，並新增「en 自己的分裂」一節。
**2026-09-22 再增「UI 側的分裂統一」一節**（同日十一條全數結案：**九條統一 ＋ 兩條維持現狀**）。

**用途**：`zh-CN`／`ja`／`ko`／`es-419` 的譯者照這張表決定術語，不要各自發明。
它同時是複閱的判準之一——**同一個術語在目標語系裡只准有一種寫法**。

**這張表是「zh-TW → en」的權威映射**，不是「中文詞典」。英文那一欄就是 `en` 語系檔裡的實際值。

| zh-TW | en | 說明 |
|---|---|---|
| 團隊 | team | |
| 專案 | project | |
| 成員 | member | |
| 大頭貼 | avatar | 不用「頭像」「頭貼」——UI 與錯誤訊息同一個詞 |
| 帳號 | **Username**（登入身分）／**Account**（個人設定的分頁） | 不用「使用者名稱」。**en 這一欄本身有兩個值**，見「en 自己的分裂」 |
| 看板 | board | |
| 卡片 | card | |
| 卡片標題 | **card title** | 2026-09-20 裁定：表單標籤、輸入提示、甘特表頭、表格表頭**一律用這一個詞**。不用「卡片名稱」「任務名稱」「標題」 |
| 心智圖 | **mind map**（兩字） | 不是 `mindmap` |
| 通知 | notification | |
| 設定 | settings | |
| 未讀 | unread | |
| 審查 | review | 名詞與動詞同形 |
| 審查者 | reviewer | |
| 待審查 | Pending | 「還沒審」不是一種結果，不發通知（也不可提交——`ReviewStatuses.Submittable`） |
| 通過 | Approved | |
| 評語 | comment | **審查退回**時必填的那段文字。不用「意見」——**「不用意見」只管這一格**（`comment`）；年度簽核那一格是「主管考評**意見**」，2026-09-22 裁定，見「2026-09-22 詞彙裁定」 |
| 評分 | **Score** | 不用 `Rating`——`Rating` 在本專案專指**等級**（S／A／B／C） |
| 交付 | submit | 活動標籤寫成小寫謂語（`submitted for review`），接在人名之後 |
| 審查歷程 | review history | zh-TW 用「歷程」；**`zh-CN` 的區段標題用「审查记录」**（2026-09-22 裁定：跟隨它自己的 `活动记录`／`暂无审查记录` 慣例）。**不要照 zh-TW 把它改成「历程」** |
| 一次交付通過率 | **First-pass yield** | 縮寫 FPY。S 級的第三個資格條件 |
| 年終評級 | **Year-end rating** | S／A／B／C ＋ 主管評分的 ±1 級調整項。**與「評分」是兩件事** |
| 主管考評 | **Supervisor review** | 年度簽核 |
| 指派 | assign | 不用 `ask`（I5 的教訓） |
| 工作日誌 | **worklog**（一字） | 不是 `work log` |
| 工時 | **hours**（量）／`time`（動作） | 不用 `effort`（I4 的教訓） |
| 回報工時 | log hours | A3 裁定（2026-09-21）：**動作**用「回報工時」、**名詞**一律用「工時」。「報時」已廢，不得再用 |
| 退回 | **rejected** | 不是 `returned`（I3 的教訓）。**四個語系一律照此，不得各自決定**（spec §12.2）：產品目前只有 approve／reject 兩態，所以 `rejected` 成立；若日後加入「退回後可重新送審」的第三態，才需要重新裁定 |
| 刪除失敗 | `Failed to delete` | 不用 `Delete failed` |
| 更新失敗 | `Failed to update` | 不用 `Update failed` |
| 列表 | list | 與「檢查清單」（checklist）是**兩個實體**，中英都不可互換（2026-09-20 裁定） |
| 檢查清單 | checklist | |
| 項目 | item | 2026-09-20 裁定。**舊表收的「檢查項」已廢**，不要再用 |
| 標籤 | label | |
| 自訂欄位 | custom field | 不縮成 `field` 除非上下文已明確 |
| 到期日／截止日 | due date | 兩個中文詞共用一個英文詞，可接受 |
| 開工日 | start date | 活動型別標籤一律寫「**更新開工日**」（2026-09-22 裁定）——舊的「更新開工時間」**已廢**；構詞與 `dueChange` 的「更新截止日」對齊 |
| 封存／已封存 | archive／archived | |
| 綁定 | bound（狀態）／bind（動作） | |
| 範疇 | scope | |
| 型態 | type | |
| 選項 | option | |
| 期間 | **period**（UI）／**range**（`query.rangeTooLong`） | 2026-09-20 裁定：中文一律「期間」，不用「區間」。**en 那一側兩種都有——2026-09-22 裁定維持現狀（同形異義，見下）** |
| 系統管理員 | **system administrator**／`admin` | en 兩者並存：說明句與權限標籤用**全稱**（權限標籤寫成 `system administrator (Admin)`）；只有 `auth.adminGrantFailed` 用裸 `admin`（依 2026-09-20 裁定）。**2026-09-22 裁定維持現狀**——見「en 自己的分裂」 |
| 績效報表 | **team report**（單複數隨語法位置） | 2026-09-22 裁定**統一**：舊的 `performance reports` **已廢**，不要再用；zh-TW／zh-CN 同日也對齊為「績效報表／绩效报表」。**權限分類的標題取它的中心語**（zh-TW「報表」／zh-CN「报表」／en `Report`，同日第四輪裁定）。見「en 自己的分裂」、「同日第三輪」與「同日第四輪」 |
| 大綱／畫布 | Outline／Canvas | |

## 品牌名

| 詞 | 值 | 說明 |
|---|---|---|
| 品牌 | **Entask** | 六個語系**同字、不翻譯、不音譯**。舊品牌名已全面退役（**資料庫層與 Fly app 名除外**，見 `docs/REBRANDING.md`）。今天 `en` 語系檔裡只剩 `login.footer` 一處（實查） |

## en 自己的分裂（2026-09-22 全數裁定，清單清空）

**這一節原本是「已知，未裁定」的四條**——改哪一個詞是產品決定，所以當時只記錄、不統一。
2026-09-22 使用者逐條裁定如下。**判準與上一節同一條**：這兩個位置會不會指到同一件事？

| 概念 | 裁定 | 落地／理由（實查） |
|---|---|---|
| 績效報表 | **統一為 `team report`** | `en/team.json` 的 `tab.report`：`Performance report` → **`Team report`**；`en/permission.json` 的 `report.view`：`View performance reports` → **`View team reports`**。**單複數隨語法位置**——分頁標籤是單數（與同一張表的 `Report`／`Worklog` 同形），權限與錯誤訊息是複數（`permission:report.view` 與 `error:team.notMember` 現在**逐字共用** `view team reports`） |
| 帳號 | **維持現狀（同形異義）** | `Username` 是**登入欄位**（`auth:login.username.label`，實查值 `Username`）、`Account` 是**個人設定的分頁**（`me:settings.tab.account`，實查值 `Account`）——**這兩個位置不會指到同一件事** |
| 期間 | **維持現狀（同形異義）** | `period` 是**工作日誌的 UI 用語**（實查 `en/worklog.json`：`"Next period"`、`"Previous period"`、`"No hours reported in this period"`）；`range` 是**查詢區間過長的錯誤**（`error:query.rangeTooLong`，實查值 `The date range cannot exceed {{max}} days`）——前者是顯示、後者是後端驗證 |
| 系統管理員 | **維持現狀** | 說明句與正式權限用**全稱**（`team:empty.description` 與 `team:noTeam.description` 的說明句、`team:user.admin.label` 的 `Grant system administrator (Admin) rights`），**角色簡稱與錯誤碼用 `admin`**（`error:auth.adminGrantFailed`，實查值 `Failed to grant admin privileges`） |

**「維持現狀」的三條與裁定 1 是兩種不同的裁定**（判準同上一節的「★」）：統一的對象是
**同一個概念被寫成兩個詞**；維持現狀的對象是**兩個不同的概念剛好共用一個中文詞**，
或**同一個英文詞在不同語法位置扮演不同角色**。⇒ **把它們「統一」反而會讓其中一邊用錯詞。**

**出處一律寫 key、不寫行號**：這一節的上一版寫的是 `en/team.json` 的 `:241`／`:251`／`:270`，
而 2026-09-22 實查那三處已經位移到 `:247`／`:257`／`:276`（同一天稍早的批次讓該檔長了 6 行）
——**行號會腐爛，key 不會**。

## 排版慣例

- **引號＝彎引號 `“ ”`**（`en` 的決定，見設計文件 §4.2）。
- **省略號＝ASCII `...`**（與 B2-1 的既有決定一致）。
- **數字與單位之間有空格**：`20 MB`、`5 MB`。
- **en 的錯誤訊息（`error.json`）單句不帶尾句號**，兩句以上才帶
  （`This card could not be found. It may have been deleted.`）。2026-09-20 普查 81 條值，
  帶句號的 15 條**全是兩句**；要複驗就自己對 `en/error.json` 跑一次同樣的判斷。
  **這條沒有例外**：`auth.adminGrantFailed` 原本是唯一一條帶尾句號的單句
  （`Failed to grant admin privileges.`），已於 2026-09-20 依使用者裁定移除尾句號
  ——「單句不帶尾句號」現在是全庫 81 條**無一例外**的慣例。
- **★ 上一條的適用範圍僅限 `error.json`**（2026-09-21 使用者裁定收回適用範圍）。
  這一行原本寫的是「`ja`／`ko`／`es-419` 照這條寫，**單句不要留尾句號**」——**過寬，已刪**。
  `error.json` **以外**的一般文案**沒有**「單句不留尾句號」的強制約束：各語系的句末標點
  **由它自己的慣例決定**，保留自然發展，不為了對齊 en 而機械修改。
  **量測支持這個界定**（`tmp/period-matrix-v2.mjs`，六語系 × 18 鍵）：`error.json` 的命中
  六語系**皆 0**，而 18 格全在散文 namespace，且 zh-TW 自己就有 **16 條單句帶 `。`**
  ——**來源語系自己也不是無一例外**，把規則推給目標語系本來就無效。
  **判準：這一條是「強制」還是「描述」，看值在不在 `error.json` 裡。**
  非 `error.json` 的值今天**維持現狀**（zh-TW 那 16 條、ko 的 7 條鏡射與 5 條不鏡射都不動）。
- **序列逗號**：`a, b, and c`（美式）。
- **表單驗證訊息＝裸祈使句**（`Select a list`），**後端錯誤碼層＝宣告句**
  （`Comment is required`）。兩層刻意不同句型：前者是「阻止送出」，後者是「回報失敗」。
- **活動型別標籤＝小寫謂語**（`archived the card`）——它們接在人名之後渲染成一句話。

## 目標語系的排版慣例（**不要照抄 en**）

引號、省略號、標點**是語系相關的**，不套用 en 的規則：

| 語系 | 引號 | 省略號 | 標點 |
|---|---|---|---|
| `zh-CN` | `“ ”`（簡體慣例） | 跟隨 zh-TW 的來源（該檔本身有分歧，見下） | `，。：、` |
| `ja` | `「 」` | `…` | `、。：` |
| `ko` | `“ ”` 或 `「 」`（擇一，全檔一致） | `…` | `, . :` 半形為主 |
| `es-419` | `“ ”` | `...` | `, . :` ＋ 倒問號 `¿` |

**zh-TW 來源檔本身的省略號有分歧**（`…` 與 `...` 並存，P1 的 Minor 已記錄）。`zh-CN` 是**轉換**，
繼承這個分歧是預期行為；`ja`／`ko` 用自己的 `…`，不受影響。

## 2026-09-22 詞彙裁定（UI 側的分裂統一）

**來源**：`docs/STATE.md` 的「UI 側自己分裂的詞彙（等產品裁定）」清單（出處：`locale-audit.md`
的「UI↔UI」段）。**這一類與 `error.json` 那條判準無關**——那一條管的是「語系自己的 UI ↔ 錯誤訊息」，
這一類管的是「UI ↔ UI」。

**判準：目標語系自己的一致性優先於對齊來源語系。** `zh-CN` 這一輪是**各挑一個寫法統一，挑的是
它自己多數的那一個**（例：`error.json` 三處「这条」對一處「这笔」）⇒ **統一之後 `zh-CN` 與
`zh-TW` 會出現措辭不同，那是刻意的**——`zh-CN` 是**轉換**語系，不是鏡射語系。

| 語系 | 位置 | 裁定 |
|---|---|---|
| `zh-TW` | `me.json` 的 `preferences.loadError`／`save.action`／`saved` | 偏好設定 →「**通知設定**」（三條一起）。同一格的 `settings.tab.notifications` 本來就叫「通知設定」，`ja`／`ko` 也早就是通知設定——**分裂在 `zh-TW` 自己**，不是譯者的問題 |
| `zh-TW` | `card.json` 的 `activityType.startChange` | 「更新開工時間」→「**更新開工日**」，構詞與 `dueChange` 的「更新截止日」對齊 |
| `zh-TW` | `team.json` 的 `report.dossier.supervisor.hint` | 「考評評語」→「考評**意見**」。同一格的 `label` 是「主管考評與年度簽核**意見**」，**hint 與 label 對不上**。與 `comment` 那條的「不用意見」不衝突——**一個是審查退回的文字，一個是年度簽核的欄位** |
| `zh-CN` | `me.json` 的 `stat.reviews.hint` | 审**批** → 审**查** |
| `zh-CN` | `team.json` 的 `report.kpi.delivered.title` | 「结案卡片总数」→「**已完成**卡片总数」 |
| `zh-CN` | `card.json` 的 `reviewHistory.title` | 「审查**历程**」→「审查**记录**」（跟隨 `team.json` 的 `活动记录`） |
| `zh-CN` | `error.json` 的 `review.notReviewer` | 「这**笔**审查」→「这**条**审查」（`error.json` 內自己的多數） |
| `zh-CN` | `error.json` 的 `attachment.unsupportedType` | 文件**类型** → 文件**格式**（跟隨 `error.json` 的 `avatarUnsupportedFormat`） |

### 同日補裁定：末三條結案（「未裁定」清單至此清空）

| 語系 | 位置 | 裁定 |
|---|---|---|
| `zh-CN` | `project.json` 的「添加／指派」 | **維持現狀，結案（非衝突）**——兩者是**不同語境**（「添加選項」vs「指派成員」）。實查：`添加` 用在**還不存在的東西**（`project.json:93`「添加选项」、`card.json:67`「添加」標籤），`指派` 用在**把既有成員掛上去**（`card.json:255`／`project.json:191`「指派成员」） |
| `ko` | `team.json`／`card.json` 的 의견 | **維持現狀，結案（非衝突）**——卡片的 **리뷰 의견**（`card.json:278`、`error.json:95` 的 `commentRequiredOnReject`）與考評的 **평가 의견**（`team.json:146-147`）**皆為韓語自然用法**；`en` 對應的也確實是兩個概念（`comment` ↔ `supervisor review`） |
| `en` | `me.json` 的 `preferences.*` | **統一對齊 `notification settings`**——`Failed to load notification settings`／`Save notification settings`／`Notification settings saved`。**`en` 是這張表的權威欄**，所以它自己分裂比別的語系分裂更該收 |

### 同日第三輪：`en` 自己分裂的四條 ＋ `zh-TW`／`zh-CN` 的「報告／报告」

| 語系 | 位置 | 裁定 |
|---|---|---|
| `en` | `team.json` 的 `tab.report`、`permission.json` 的 `report.view` | **統一為 `team report`**（`Performance report` → `Team report`；`View performance reports` → `View team reports`）。**單複數隨語法位置**——標籤單數、權限與錯誤訊息複數，後者與 `error:team.notMember` 逐字共用 `view team reports`。見「en 自己的分裂」節 |
| `en` | 帳號／期間／系統管理員 三條 | **維持現狀（同形異義）**——見「en 自己的分裂」節 |
| `zh-TW` | `permission.json` 的 `report.view` | **統一為「檢視績效報表」**（原「檢視績效**報告**」）——與 `team.json` 的 `tab.report`「績效報表」、`error.json` 的 `team.notMember`「無法檢視績效報表」對齊 |
| `zh-CN` | `permission.json` 的 `report.view` | **統一為「查看绩效报表」**（原「查看绩效**报告**」）——同上，與 `zh-CN` 的 `tab.report`／`team.notMember` 對齊 |

**這四條是同一個概念被寫成兩個詞**（不是同形異義）：`report.view` 授權的就是那張績效報表。
**`ja`／`ko`／`es-419` 不受影響**——實查三者的 `permission.report.view`、`team.tab.report`、
`error.team.notMember` 本來就同詞（`レポート`／`성과 보고서`／`Informe de desempeño`），
各語系用自己的詞、不鏡射 zh-TW。

### 同日第四輪：權限分類標題的「報告／报告」（2026-09-22 裁定）

上一輪把 `team.json` 的 `permissionCategory.report` 判成「**不是分裂**、只記錄」
（它確實不是第三輪那種「同一個概念被寫成兩個詞」）——**使用者當日推翻那個處置、裁定統一**。
推翻的理由是那個判斷漏看的另一半：**它與其他五個分類標題不同型**——看板／卡片／心智圖／
專案／團隊用的都是**與功能同名**的詞，只有它是縮寫。

| 語系 | 位置 | 裁定 |
|---|---|---|
| `zh-TW` | `team.json` 的 `permissionCategory.report` | **「報告」→「報表」** |
| `zh-CN` | `team.json` 的 `permissionCategory.report` | **「报告」→「报表」** |
| `en` | `team.json` 的 `permissionCategory.report` | **維持 `Report`**（與 Board／Card／Project／Team 一致採單數） |

**★ 真正的判準：短形式取到哪裡為止＝取到功能名的「中心語」。** 實查六個語系，改完之後
**六者一致**——zh-TW `報表` ⊂ `績效報表`、zh-CN `报表` ⊂ `绩效报表`、en `Report` ⊂
`Team report`、ko `보고서` ⊂ `성과 보고서`、es-419 `Informe` ⊂ `Informe de desempeño`；
ja 兩者同形（`レポート`）。⇒ **`ja`／`ko`／`es-419` 本來就合這個規則，只有 zh-TW／zh-CN 要動。**

**這一格有測試看著**：`RoleEditDialog.test.tsx` 那個 `it.each` 的**第三欄**就是分組標題。
突變實測（只把 zh-TW 的值退回「報告」、fixture 留「報表」）⇒ **恰好 1 支紅**，
訊息 `Unable to find an element with the text: 報表`；還原後 sha1 逐位元組相符、再跑一次綠。

**★「維持現狀」與上面的「統一」是兩種不同的裁定，不要混用**：統一的對象是
**同一個概念被寫成兩個詞**；維持現狀的對象是**兩個不同的概念剛好共用一個中文詞**
（「添加」與「指派」、「리뷰 의견」與「평가 의견」）。
判準：**這兩個位置會不會指到同一件事？** 會，就是分裂、要統一；不會，就是**同形異義**，不必動
——**把它們「統一」反而會讓其中一邊用錯詞**。

**一處仍然同形**：`card.json:24` 的 `memberAdded` 是「添加**成员**」（`en` 作 `added a member`）
——它與「指派成员」共用「成員」二字，但前者是**活動牆的過去式敘述**（某人把成員加進來）、
後者是**動作鈕與欄位標籤**。⇒ 仍是同形異義，不是分裂；譯者遇到時照這個分別判。

**這一類沒有機器守門員**：`i18n:parity` 比的是 **key 集合**與佔位名，`check:labels` 比的是
**key ↔ 後端常數**，`check:copy` 看的是複製樣板——**沒有一道閘門比對「同一個概念在不同 key
的措辭」**。⇒ 這一類只有複閱看得出來，而**這張表就是複閱的判準**。
