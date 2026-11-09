[English](CHANGELOG.md) · **繁體中文**
# 變更記錄

Entask 所有值得注意的變更都記錄在本檔。

格式以 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 為基礎，
且本專案遵循[語意化版本](https://semver.org/spec/v2.0.0.html)。

## [1.0.7] - 2026-11-09

### 安全性

- 修正 Web 端的跨帳號資料外洩：登出、切換帳號，或從其他分頁登入時，現在會清除共用的查詢快取、停止前一個帳號的即時協作連線、關閉其通知，並由共用儲存還原新的 session。
- 修正停用與刪除的使用者仍可用已簽發的 access token 存取 API（最長 30 分鐘）的問題。每個已驗證請求（含 SignalR negotiate）現在都會檢查帳號狀態，回 401 `auth.sessionInvalid`。
- 修正撤權後 SignalR 訂閱仍然有效的問題：停用或刪除使用者、移除團隊／專案成員、變更角色時，現在會立即中止該使用者的既有連線並讓權限快取失效；重連時重新驗證目前權限。
- 修正 `localStorage` 不可用（隱私模式或配額已滿）時無法登入的問題。請求與 token refresh 改用記憶體 session；跨分頁的 token 輪替透過 `storage` 事件同步，session 被替換時會丟棄在途 refresh，避免 refresh token 重放導致所有 session 被撤銷。
- 強化 refresh 的持久化：一個帳號的 token 不可能被寫進另一個帳號的儲存記錄；登入寫入失敗也不會讓前一個帳號復活。

### 備註

- 沒有資料庫 migration 或設定變更。

## [1.0.6] - 2026-11-03

### 安全性

- JWT 簽章金鑰改為啟動時驗證：`Jwt:Secret` 必須至少 32 個 UTF-8 位元組；空值或過短會讓 host 啟動失敗，不再拖到登入時才壞。
- 附件上傳全面套用文件上的 20 MiB 上限：multipart 請求 body 上限 21 MiB（20 MiB 檔案＋1 MiB boundary／標頭），並加 `Content-Length` 前置檢查。先前的有效上限接近 128 MiB。
- 附件下載與建立使用者端點現在會在任何 admin／權限判斷前拒絕停用或刪除的主體，回 401 `auth.sessionInvalid`。
- `follow-redirects` 升到 1.16.2，修掉 1.16.0–1.16.1 的 high 等級公告。

### 備註

- 停用管理員會撤銷該使用者的 refresh token，但已簽發的 access token 在到期前仍有效（最長 30 分鐘）。若懷疑 access token 外洩，請輪替 `Jwt:Secret`。
- 沒有資料庫 migration。升級注意：`Jwt:Secret` 必須至少 32 個 UTF-8 位元組；超過 20 MiB 的附件現在會被拒絕。

## [1.0.5] - 2026-10-21

### 修正

- 安全性：建置與測試用的相依套件 `vite` 升到 8.3.5（內含的 `launch-editor` 三個 high 等級
  公告已修：Windows 參數轉義與存在性檢查繞過）；正式相依鏈中的 `follow-redirects` 升到
  1.16.1（兩個 high：認證標頭可能跨來源外洩）。
- 手機版：成員績效檔案（考核表）改為在視窗內垂直捲動，不再超出畫面下緣。
- 手機版：團隊報表 drill-down 表格的卡片欄保持可讀；窄螢幕改由表格橫向捲動，
  不再一列一個字。

### 備註

- 沒有資料庫 migration，也沒有設定變更。

## [1.0.4] - 2026-10-21

### 修正

- 前端測試套件不再假設團隊報表 drill-down 斷言裡「日期」與「時段」之間是哪一個空白字元；
  ICU 版本在該處不同（U+2009 與 U+0020），1.0.3 的 CI 因此失敗。使用者可見行為不變。

## [1.0.3] - 2026-10-21

### 新增

- 團隊績效報表可解釋性：每位成員的評級附上分解——完成率對到的等級、準時交付率與
  一次交付通過率的 S 門檻（含門檻值與樣本數），以及主管評分調整（含所依據的平均分）。
- 成員的完成率、準時交付率、一次交付通過率與平均評分可 drill-down 到背後的卡片或
  review 明細；沒有權限閱讀的列會單獨計數，不會默默消失。
- 截止日變更會記錄舊值與新值，並顯示在準時交付率的明細裡。歷史從本版開始；
  本版之前的變更沒有舊值可追。

### 修正

- 團隊報表改用完整內容寬度、成員操作入口移到第一欄，可點的數字有可見的提示。
- 使用者管理與系統活動頁改用與其他頁面相同的頁殼。
- 列印成員考核表只輸出一頁：對話框不再於每一頁重複，應用程式外殼、關閉鈕與頭像不進紙張。

### 備註

- 沒有資料庫 migration，也沒有設定變更。

## [1.0.2] - 2026-10-16

### 修正

- 安全性：隨前端出貨的 HTTP 客戶端 `axios` 升至 1.20.0，解掉正式相依樹上的 12 條通報
  （其中 7 條 high）；僅供建置與測試使用的 `undici`、`vitest`、`brace-expansion`、
  `source-map-js` 也升到已修正的版本。
- CI 工作流程改為明示最小權限 `permissions`（`contents: read`），解掉三條 code scanning 通報。
  使用者可見行為不變。

## [1.0.1] - 2026-10-16

### 修正

- 前端測試套件不再假設繁體中文日期時間輸出裡「日期」與「時段」之間是哪一個空白字元；
  ICU 版本在該處不同（U+2009 與 U+0020），1.0.0 的 CI 因此失敗。使用者可見行為不變。

## [1.0.0] - 2026-10-16

首次開源發行，以 GNU Affero General Public License version 3.0 only
（AGPL-3.0-only）授權。

### 新增

- 看板：拖放、清單／卡片排序，以及各專案成員；觸控裝置上長按即開始拖曳，清單握把則立即拖曳
- 每個專案的心智圖檢視
- 卡片工作日誌（估計 vs. 實際工時）、個人工作日誌頁與團隊工作日誌
- 專案報表：狀態、工作量、評等，以及可選時間範圍的工作日誌報表
- 日曆與甘特圖檢視，以及可批次編輯的表格檢視
- 卡片審查生命週期：請求審查、核准、要求變更、移除審查者；送出審查前另有確認步驟
- 自訂欄位、標籤、檢查清單、留言、附件、全域搜尋與通知
- 以角色為基礎的存取控制，權限可細分到專案
- 僅限管理員的系統活動記錄，涵蓋使用者生命週期事件；重設密碼時一併解鎖帳號
- 卡片活動、留言與系統活動記錄皆為 cursor 分頁（「載入更多」）
- 強化的部署預設值：容器以非 root 使用者執行、健康檢查、安全標頭與內容安全政策，以及反向代理轉送標頭支援
- 六種語系，包含英文與繁體中文
- 以 Docker Compose 一鍵自架；附 Fly.io 部署檔
- 登入頁與使用者選單中的 AGPL 第 13 條原始碼提供連結

[1.0.7]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.7
[1.0.6]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.6
[1.0.5]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.5
[1.0.4]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.4
[1.0.3]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.3
[1.0.2]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.2
[1.0.1]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.1
[1.0.0]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.0
