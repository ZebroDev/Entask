[English](REBRANDING.md) · **繁體中文**
# Entask 白標與改名指南

> 目的：讓自架者與授權方知道**改哪些檔案就能換品牌**，以及**哪些字串看起來可以改、改了會壞**。
>
> 這條線不是本文件發明的。本專案在 2026-09-13 完成了一次完整的改名工程，已經把它畫出來
> （品牌 / 識別碼 / 執行期契約三批），本文件沿用同一條線。

**一句話原則：白標換的是畫面上印的字與圖，不是系統的識別碼。**

**範圍**：本文件只涵蓋產品本體（前端顯示點、執行期契約）與產生文件的腳本。
**不涵蓋**改名工程期間的歷史紀錄——那些是當時的事實，改寫即篡改歷史。

---

## 1. 顯示用身分（可以改）

改完只需要 `cd web && npm run build`（第 12 項除外，它在組件中繼資料裡，還要 `dotnet build`）。**這一節沒有任何一項需要動資料庫、後端程式碼或 JWT 設定。**

本文件的「位置」欄只寫放著那個字串的檔案、不寫行號——**行號只要有人動過那個檔就會失效**，
而失效的行號會指到錯的地方、且沒有任何提示。

| # | 項目 | 位置 | 現在的值 |
|---|---|---|---|
| 1 | 登入頁標題 | `web/src/pages/LoginPage.tsx` | `Entask` |
| 2 | 頁首品牌字 | `web/src/components/layout/AppLayout.tsx` | `Entask` |
| 3 | 頁首（尚未選團隊時） | `web/src/components/layout/AppLayout.tsx` | `Entask` |
| 4 | 登入頁頁腳 | `web/src/i18n/locales/{en,es-419,ja,ko,zh-CN,zh-TW}/auth.json` 的 `login.footer` | `Entask 企業級敏捷專案管理平台 · 版本 v1.0.4`（每個語系一份翻譯） |
| 5 | 瀏覽器分頁標題 | `web/index.html` | `<title>Entask</title>` |
| 6 | iOS 加入主畫面名稱 | `web/index.html` | `apple-mobile-web-app-title` = `Entask` |
| 7 | PWA manifest | `web/public/manifest.json` | `name` / `short_name` / `description` 三者的值都是 `Entask` |
| 8 | 應用圖示 | `web/public/favicon.svg` | 512×512 橘色標記，純圖形無文字 |
| 9 | README | `README.md`、`README.zh-TW.md` | 文件標題與架構說明 |
| 10 | on-prem 部署文件 | `docs/DEPLOY.zh-TW.md`（另有英文版 `docs/DEPLOY.md`） | 文件標題、集區 `EntaskPool`、排程 `Entask-DB-Backup`、站台名稱與部署路徑範例 |
| 11 | **AGPL §13 的 Source 連結** | `web/src/lib/source-offer.ts` 的 `SOURCE_URL`；渲染點在 `web/src/pages/LoginPage.tsx`（頁腳）與 `web/src/components/layout/AppLayout.tsx`（使用者選單） | `https://github.com/ZebroDev/Entask` |
| 12 | **著作權名義** | `Directory.Build.props` 的 `<Copyright>` 屬性、`LICENSE` 第 1 行，以及 `README.md`、`README.zh-TW.md` 的著作權行 | `Copyright (c) 2026 ZebroDev` |

第 1～3 項是 JSX 裡的**硬編碼字面值**，沒有走 i18n。改它們不會影響任何語系檔的完整性檢查。

### 第 11、12 項與其他十項不同——改錯了不是「不好看」

**第 11 項改錯是不實授權、第 12 項改錯是不實歸屬。** 兩者都是誠實問題而非美觀問題，
而且都沒有任何自動檢查。

**第 11 項——原始碼連結指向哪裡。** §13 的觸發條件是「**你修改了**這個程式」（`LICENSE:542`，
逐字），要提供的是「**你的版本**的 Corresponding Source」。所以**你改了名、重新編譯、
自己架起來，你就是 §13 的義務人**；而 `SOURCE_URL` 的預設值指向的是**上游**——那時它指向的
正是錯的地方。

改品牌時**把它一起改成指向你自己的原始碼**。未經修改就自架的人維持預設值即可
（那時上游就是你的 Corresponding Source）。這一條純粹是誠實問題：它沒有自動檢查，
沒有任何測試會因為你忘了改而變紅。

**第 12 項——著作權聲明署名給誰。** 不改它，等於把**你的**產品掛在**別人的名字**下發布
——那是**不實歸屬**，不是美觀問題。與第 11 項一樣，它沒有任何自動檢查：
**測試套件沒有任何斷言看著這個字串**。

`ZebroDev` 是本專案的品牌名——獨立維護者對外發布用的筆名，**不是公司或法人**。它仍然是
*本專案的*名字，所以白標後的建置要掛你自己的名字。有兩個機械上的差異：
`Directory.Build.props:3` 會被編進組件的著作權中繼資料（改它要 `dotnet build`，不只是
`npm run build`）；而 `LICENSE:1` 就是授權檔本身——那一行以下的 AGPL-3.0 條文不會跟著變。

### 顯示用這一側**沒有**的東西（省下你去找的時間）

- **後端沒有任何使用者可見的品牌字串**。實查 `src/` 的全部 C# 字串字面值：出現 `Entask` 的只有
  命名空間、`JwtOptions` 的預設值、`entask:admin` claim 型別、EF migration 的快照字串，
  外加兩處**開發者面向**的字面值（`src/Entask.Api/Endpoints/ExportLabels.cs` 的 `:10` doc 註解與
  `:80` 的啟動期例外訊息，後者提到 `Entask.Api.csproj`）——**全部屬於第 2 節**。
  `src/Entask.Api/Resources/export.{en,zh-CN,zh-TW}.json` 三個資源檔內也無 `Entask`。
- 匯出與通知目前分為三種情況：工作日誌/團隊報表 xls 已使用標籤表、通知文案已改由前端渲染，但**專案報表 CSV 表頭確實仍寫死英文**。這些是 i18n 的未結項目，**不是品牌點**，白標時不必動。

### 兩個非顯而易見的細節

1. **PWA 已安裝的使用者必須重新安裝才會看到新名稱**——`manifest.json` 的名稱在安裝當下就固定了，
   瀏覽器不會因為伺服器上的檔案變了就更新已安裝的捷徑。
2. **`web/index.html:7` 是唯一的分頁標題來源**。`web/src` 全庫沒有任何 `document.title` 賦值，
   而 `src/Entask.Api/Program.cs:280` 對 `index.html` 只送 `Cache-Control` 標頭、**不改寫內容**。
   所以改那一行就是全部，不必找伺服器端。

---

## 2. 執行期身分（**不要改**）

這一節的每一項都是**識別碼**，不是文案。它們被寫進資料庫、token 或瀏覽器儲存區之後，
改動會產生**沒有錯誤訊息**的故障——這是它們與第 1 節的根本差別。

| # | 項目 | 位置（實查） | 現在的值 | 改了會怎樣 |
|---|---|---|---|---|
| 1 | 命名空間 / 專案名 / 方案檔 | `Entask.sln`、`src/Entask.*`（7 個專案）、`tests/Entask.Tests` | `Entask.*` | 改名工程為此動了 213 個檔案。改了沒有好處，只有成本 |
| 2 | JWT issuer / audience | `src/Entask.Identity/Options/JwtOptions.cs` | `entask` / `entask-web` | **簽得出 token，但每個請求都 401**。兩端（簽發 / 驗證）由 `Program.cs` 的 `PostConfigure` 與區域變數取自同一份字面值；**不要在 `ValidIssuer` 另寫字面值**，那正是這個故障原本的成因 |
| 3 | 同一組值的第二、三處 | `fly.toml` 的 `[env]`（`Jwt__Issuer` / `Jwt__Audience`）、Fly secrets | 同上 | **Fly secret 的優先序高於 `fly.toml` 的 `[env]`**。若 secret 存在，改 `fly.toml` 不會生效、而且沒有任何徵兆 |
| 4 | localStorage 鍵（4 個） | `web/src/lib/storage-keys.ts` | `entask-auth` / `entask-ui-theme` / `entask-mindmap-collapsed-` / `entask-mindmap-cascade-drag` | **靜默失去憑證**：auth store 寫得進去，請求攔截器讀不到，每個請求都無憑證送出。主題與心智圖偏好一併重置 |
| 5 | 語系鍵 | `web/src/lib/storage-keys.ts` | `entask-locale` | 使用者的語系偏好靜默重置。注意這個鍵**以「存不存在」編碼兩個狀態**（不存在 = 跟隨瀏覽器），改鍵名等於讓所有人回到跟隨瀏覽器 |
| 6 | 管理員 claim 型別 | `src/Entask.Identity/AdminSeed.cs` | `entask:admin` | **所有管理員靜默降權**。既有資料列的遷移在 `AdminClaimSeed`（`src/Entask.Infrastructure/Data/Seed/AdminClaimSeed.cs`），其 `LegacyClaimType` 刻意保留**舊品牌的 claim 值**（供既有資料列比對遷移）——那是 **`src/` 內唯一還寫死舊識別碼的地方**（其餘舊值在設定檔與測試檔），**不可「順手清掉」** |
| 7 | 資料庫角色 / 庫名 | `src/Entask.Api/appsettings.Development.json`（**gitignored**）、`.github/workflows/ci.yml` | 角色 `entask_app`、庫 `entask` / `entask_test` | 無法連線。`AdminClaimSeed` 的歷史字面值也依賴它 |
| 8 | 測試連線環境變數 | `ENTASK_TEST_CONNECTION` | 同上 | 後端測試全數無法啟動（**硬改名、無 fallback**） |

**第 2 節的通行判準**：一個字串只要**被當成識別碼用過**（資料列比對鍵、儲存鍵、token 宣告、
連線參數），它就不能是譯文、也不能是品牌。這是改名工程踩過的坑，也是 P-A 修正三處
「以中文字串做資料列比對鍵」的同一條原則。

---

## 3. 產生器腳本（重生文件或重拍截圖前要一起改）

這些腳本不進交付的應用，但**它們產出的東西會**。改了品牌卻沒改它們，
下次重生手冊或重拍截圖會做出舊品牌的成品。

| 腳本 | 品牌字串位置 | 說明 |
|---|---|---|
| `docs/generate_manual_docx.py` | 輸出檔名、標題，以及內文多處 | 產生 `docs/Entask_系統使用說明書.docx`（腳本未包含於本 repo） |
| `docs/generate_guide_pptx.py` | 輸出檔名、標題，以及內文多處 | 產生 `docs/Entask_User_Guide.pptx`（腳本未包含於本 repo） |
| `web/capture_all.cjs` | `page.type('#password', …)` 直接對登入表單輸入密碼 | Puppeteer 截圖（24 張），**打的是 dev server** |
| `web/pseudo_sweep.cjs` | `PASSWORD`（可用 `SWEEP_PASSWORD` 環境變數覆寫） | 偽語系掃頁，同上 |

後兩者輸入的是**種子帳密**而非品牌。而這組值在 repo 內有**多份副本**——改名階段就實際做過
一次同步（改名時把開發預設密碼整組換新）。改 `Seed__AdminPassword` 時要整組一起處理：

| 副本 | 位置 | 不同步會怎樣 |
|---|---|---|
| 正典（種子來源） | `src/Entask.Api/appsettings.Development.json`（**gitignored**） | — |
| 登入頁的 dev 填入鈕 | `web/src/pages/LoginPage.tsx` | dev 模式下按鈕填入舊密碼、登入失敗。它只在 `import.meta.env.DEV` 下渲染，所以這個故障只在開發時顯形 |
| 截圖腳本 | `web/capture_all.cjs` 的 `page.type('#password', …)` | Puppeteer 登入失敗，截圖流程中斷 |
| 偽語系掃頁 | `web/pseudo_sweep.cjs`（可用 `SWEEP_PASSWORD` 覆寫） | 同上 |
| README | `README.zh-TW.md` | 文件寫的帳密是錯的 |
| 測試 | `web/src/pages/LoginPage.test.tsx` | **會變紅——這是刻意的**，它就是你漏改時的提示 |

> **這兩個 .docx / .pptx 已於 2026-09-19 重生**，檔名與內容一致（先前「檔名改了、內容還是舊品牌」
> 的窗口已關閉：當時說明書內舊品牌名 12 次、簡報 3 次，現在兩份全 zip 掃描皆為 0 處）。
> 重生的順序不能顛倒——**重跑產生器只修得了文字、救不了截圖**，所以是
> 「重建示範資料 → 重拍 24 張 → 重跑產生器」。

---

## 4. 刻意保留原樣的名字（不是漏改）

以下三項**看起來像漏改的字串，其實是刻意保留原樣的**。改它們會壞事，所以列在這裡。

| 項目 | 位置 | 為什麼不改 | 改了會怎樣 |
|---|---|---|---|
| Fly app 名 | `fly.toml` 的 `app` 值 | Fly 的 app 名是全球命名空間，且**建 app 那一刻就定了**——app 是「以某個名字建立」，不是改名改出來的 | 把 `fly.toml` 指向別的名字 ⇒ 等於部署到別的地方；網域與部署目標必須一起換 |
| Fly volume 名 | `fly.toml` 的 `[mounts] source` 值 | 那個名字後面是**既有 volume 與裡面真的檔案**；volume 的名字一樣**建立後不可改** | 把掛載指到別的（例如新開的、空的）volume ⇒ **附件與頭像看起來全部消失**；資料還在舊 volume 上，只是它不再被掛載 |
| 本機路徑 | 任何被工具以名稱匹配的 repo 或備份目錄名（**刻意不改**） | 改名會使**既有備份永遠不被輪替清理**（輪替正則綁著舊目錄名） | **舊目錄的備份凍結在原地、空間不回收**；新目錄的新備份仍正常輪替（保留最近 14 份），所以它是**有界的**殘留，不是無限累積 |

---

## 5. 改完之後要跑什麼

顯示用的改動（第 1 節）只需要前端——第 12 項除外，它在組件中繼資料裡，還要後端重建
（`dotnet build`）。跑這一組：

```bash
cd web
npm run build              # tsc -b && vite build
npx vitest run --maxWorkers=2
npm run i18n:parity        # 各語系 key 集合與複數類別
npm run check:labels       # 後端字串常數 <-> 前端標籤表
npm run check:errors       # 錯誤碼形狀
npm run check:copy         # 「有沒有翻」的白名單
npx i18next-parser --fail-on-update
```

第 4 項（`check:labels`）與品牌無關但**必須跑**：它守的是後端識別碼 ↔ 前端標籤表的契約，
而那個契約的失效方式與品牌一模一樣——**畫面直接印出識別碼，沒有任何測試會紅**。

若你不只改顯示字，還動了第 2 節的任何一項，**再加跑後端**：

```powershell
$env:ENTASK_TEST_CONNECTION = <本機 gitignored 檔中的連線字串>
dotnet test
```

> **不要改寫改名工程期間的歷史紀錄**。那是當時的事實，改寫即篡改歷史。
