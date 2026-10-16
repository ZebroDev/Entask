[English](DEPLOY.md) · **繁體中文**
# Entask 部署與維運手冊（on-prem / IIS）

本文件說明如何將 Entask（.NET 10 後端 API + React SPA）部署到 Windows Server 上的
IIS，以及資料庫備份排程。

> **注意：IIS 部署未實際使用。** 本專案的實際部署走 Fly.io（`fly.toml` + `Dockerfile.fly`），
> 本文件保留作為 on-prem 備援方案的參考，內容未經近期驗證。
> 不想用 IIS 的人，另有一條 Docker Compose 自架路線（一鍵部署），完整 runbook 見 `docs/SELF-HOSTING.zh-TW.md`。
> 文中 `db.example.internal` 與 `C:\path\to\...` 形式的路徑皆為**範例值**，請替換為你自己的環境。
> 完整的改名／白標清單（可以改的 vs 不要碰的，每列附「改了會怎樣」）見 `docs/REBRANDING.zh-TW.md`。

## 1. 架構總覽

```
瀏覽器 ── HTTPS ──► IIS 站台 entask（根目錄）
                    │
                    ├─ /api/*        → ASP.NET Core（Entask.Api，站台根應用程式）
                    ├─ /（index.html）→ SPA 靜態檔（web/dist，IIS 靜態檔案處理）
                    └─ 其他前端路由   → web.config rewrite → index.html
資料庫：PostgreSQL 18.6（db.example.internal:5432，db entask）
```

- 前端以相對路徑 `/api/*` 呼叫後端（`web/src/lib/api.ts` 的 `baseURL: "/api"`），
  因此 **SPA 與 API 必須在同一站台（same-origin）**。
- 後端端點已固定註冊於 `/api/*`（`src/Entask.Api/Endpoints`）。ASP.NET Core 掛載為
  IIS 子應用程式時，子應用程式路徑會變成 `PathBase`，`/api/*` 路由將無法匹配而回 404；
  因此 **API 必須作為站台根應用程式**部署（與 SPA 靜態檔共用站台根目錄）。

## 2. 前置需求（伺服器）

| 項目 | 版本/用途 | 說明 |
| --- | --- | --- |
| Windows Server | 2019 / 2022+ | 內含 IIS 角色 |
| IIS | 10+ | 含「靜態內容」與「URL Rewrite」模組 |
| .NET Hosting Bundle | 10.x | 執行 .NET 10 應用程式所必需 |
| IIS URL Rewrite | 2.x | SPA fallback rewrite 規則需要，未安裝會使 web.config 組態無效 |
| PostgreSQL | 18.6 | 資料庫（本文件範例為 `db.example.internal:5432`） |
| Node.js | 20 LTS | 僅建置前端用（伺服器上可不安裝，改在 CI/開發機建置） |

安裝 .NET Hosting Bundle（可於 [dotnet.microsoft.com](https://dotnet.microsoft.com/download/dotnet)
下載，安裝後需 `iisreset`）：

```powershell
iisreset
```

確認 URL Rewrite 模組存在：IIS 管理員 → 站台 →「URL Rewrite」圖示有出現即可。
若無，請以「Web Platform Installer」或微軟官方安裝檔安裝「IIS URL Rewrite 2.0」。

資料庫需先建立（本專案使用資料庫 `entask`、帳號 `entask_app`）：

```sql
CREATE DATABASE entask;
CREATE USER entask_app WITH PASSWORD '請替換為強密碼';
GRANT ALL PRIVILEGES ON DATABASE entask TO entask_app;
```

> 後端啟動時會自動執行 EF Core migration 並初始化權限/角色，因此資料庫連線字串
> 的帳號需具備建立資料表（DDL）權限。

## 3. 建置發佈產物

建置後端與前端：

```powershell
# 後端
dotnet publish src\Entask.Api -c Release -o publish\api

# 前端
cd web
npm ci
npm run build          # 產出 web\dist
cd ..

# 把建置好的 SPA 放到第 4 節複製來源的位置
robocopy web\dist publish\web /E /IS /IT
```

產出 `publish\api`（後端）與 `publish\web`（前端）。

## 4. IIS 站台設定

1. IIS 管理員 →「站台」→ 右鍵 →「新增網站」。
2. 站台名稱：`entask`；實體路徑：部署資料夾（例如 `C:\inetpub\entask`）。
3. 應用程式集區：建立新集區 `EntaskPool`，**.NET CLR 版本設為「無受控程式碼
   （No Managed Code）」**（ASP.NET Core 由 CoreCLR 自行裝載，不需桌面 CLR）。
4. 繫結：`http`（80）與 `https`（443，見第 7 節）。

### 部署檔案佈局

將 `publish\api\*` 與 `publish\web\*` **都複製到站台根目錄**：

```powershell
robocopy publish\api C:\inetpub\entask /E /IS /IT
robocopy publish\web C:\inetpub\entask /E /IS /IT

# 安全：移除開發環境設定檔（內含開發連線字串/密鑰，勿佈署）
Remove-Item C:\inetpub\entask\appsettings.Development.json -ErrorAction SilentlyContinue

# 以「完整版 web.config」覆蓋 dotnet publish 產生的 web.config
# （deploy\web.config 需先依第 6 節建立）
Copy-Item deploy\web.config C:\inetpub\entask\web.config -Force

iisreset
```

複製後根目錄應同時包含後端組件（`Entask.Api.dll`、`web.config`、`appsettings.json` 等）
與前端檔案（`index.html`、`assets\`、`favicon.svg` 等）。

> **為何共用根目錄？** 前端以 `/api/*` 相對路徑呼叫後端，且後端路由已固定為 `/api/*`。
> 若把 API 掛成名為 `api` 的子應用程式，IIS 會把 `/api` 視為 `PathBase`，後端的
> `/api/auth/...` 等路由將無法命中而全部 404。共用根目錄（PathBase 為空）是與
> 目前程式碼相容的唯一方式。

## 5. 環境變數

IIS 下建議將環境變數寫入站台根目錄 `web.config` 的 `<aspNetCore><environmentVariables>`，
或設定於應用程式集區（IIS 管理員 → 應用程式集區 → `EntaskPool` → 右鍵 → 進階設定 →
「環境變數」）。變數使用雙底線（`__`）對應組態階層。

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `ConnectionStrings__Default` | 是 | PostgreSQL 連線字串（`Host=...;Port=5432;Database=entask;Username=entask_app;Password=...`） |
| `Jwt__Secret` | 是 | JWT 簽章密鑰（至少 32 bytes／256 bits 的隨機值，正式環境務必更換） |
| `Jwt__Issuer` | 否 | 預設 `entask` |
| `Jwt__Audience` | 否 | 預設 `entask-web` |
| `Seed__AdminUsername` | 否 | 預設 `admin`；首次啟動建立的系統管理員帳號 |
| `Seed__AdminPassword` | 否 | 管理員密碼（≥ 8 字元）；**為空則不建立管理員** |

產生 JWT 密鑰範例：

```powershell
openssl rand -hex 32
```

## 6. 站台根目錄 web.config（SPA fallback + API）

### SPA fallback 規則（核心）

前端使用 client-side routing，重新整理 `/teams/xxx` 等路徑時 IIS 找不到實體檔，需 rewrite
到 `index.html`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="SPA fallback" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="/index.html" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

> 本專案因為 API 與 SPA 共用站台根目錄，fallback 規則**必須加一條 `{REQUEST_URI}` 排除
> `/api`**，否則 `/api/*` 也會被改寫到 `index.html`。請使用下列「完整版 web.config」。

### 完整版 web.config（站台根目錄直接使用）

將下列內容存成 `deploy\web.config` 並覆蓋站台根目錄的 `web.config`（保留
`dotnet publish` 產生的 `aspNetCore` handler，加上 SPA fallback、環境變數與安全性過濾）：

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet" arguments=".\Entask.Api.dll" stdoutLogEnabled="false" stdoutLogFile=".\logs\stdout" hostingModel="inprocess">
        <environmentVariables>
          <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Production" />
          <environmentVariable name="ConnectionStrings__Default" value="Host=db.example.internal;Port=5432;Database=entask;Username=entask_app;Password=請替換" />
          <environmentVariable name="Jwt__Secret" value="請替換為至少32字元隨機密鑰" />
          <environmentVariable name="Jwt__Issuer" value="entask" />
          <environmentVariable name="Jwt__Audience" value="entask-web" />
          <environmentVariable name="Seed__AdminUsername" value="admin" />
          <environmentVariable name="Seed__AdminPassword" value="請替換" />
        </environmentVariables>
      </aspNetCore>
      <rewrite>
        <rules>
          <rule name="SPA fallback" stopProcessing="true">
            <match url=".*" />
            <conditions logicalGrouping="MatchAll">
              <add input="{REQUEST_URI}" pattern="^/api" negate="true" />
              <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
              <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
            </conditions>
            <action type="Rewrite" url="/index.html" />
          </rule>
        </rules>
      </rewrite>
      <security>
        <requestFiltering>
          <fileExtensions>
            <add fileExtension=".dll" allowed="false" />
            <add fileExtension=".pdb" allowed="false" />
            <add fileExtension=".exe" allowed="false" />
            <add fileExtension=".json" allowed="false" />
            <add fileExtension=".config" allowed="false" />
          </fileExtensions>
        </requestFiltering>
      </security>
    </system.webServer>
  </location>
</configuration>
```

重點說明：

- **`{REQUEST_URI}` 排除 `/api`**：確保 `/api/*` 不會被 fallback 改寫，而是進入
  `aspNetCore` handler 由後端處理。
- **`security/requestFiltering`**：站台根目錄同時放了後端組件，阻止 IIS 直接對外提供
  `.dll` / `.json` / `.config` 等檔案（例如誤漏的 `appsettings.Development.json`）。
- **`.json` 這一條的代價是 web app manifest。** SPA 在 `web/index.html` 掛了
  `/manifest.json`，該檔由建置從 `web/public/` 複製過來。把 `.json` 整個延伸檔名擋掉之後，
  IIS 對這一支會回 **404.7**（request filtering 的「檔案副檔名被拒」子狀態碼）。應用程式
  照常運作；停掉的是**所有會讀 manifest 的東西**——例如「加到主畫面」時瀏覽器採用的名稱、
  圖示與可安裝性。若要保住 manifest，請改成**按檔名擋後端自己的 JSON**、而不是整條副檔名。
  **下面這段沒有在真實 IIS 上跑過**（撰寫時沒有可用的 IIS），是標準寫法；
  `publish\api` 底下其餘的 `.json`（`dir publish\api\*.json`）可比照列出：

  ```xml
  <fileExtensions>
    <add fileExtension=".dll" allowed="false" />
    <add fileExtension=".pdb" allowed="false" />
    <add fileExtension=".exe" allowed="false" />
    <add fileExtension=".config" allowed="false" />
  </fileExtensions>
  <denyUrlSequences>
    <add sequence="appsettings" />
    <add sequence=".deps.json" />
    <add sequence=".runtimeconfig.json" />
  </denyUrlSequences>
  ```

  `alwaysAllowedUrls` **不是**把 `/manifest.json` 放行回來的方法：它只覆寫
  `<denyUrlSequences>`，對 `<fileExtensions>` 沒有任何作用——副檔名仍被擋的情況下，把
  manifest 加進那裡等於什麼都沒改。
  驗收方式：`curl -I https://<你的站台>/manifest.json`（預期 `200`）、
  `curl -I https://<你的站台>/appsettings.json`（預期 `404`）。
- 若需開啟 stdout log 排錯，可暫時改 `stdoutLogEnabled="true"`，log 輸出至
  `.\logs\stdout`（需先建立資料夾並授權給應用程式集區身分）。

## 7. HTTPS

### 自簽憑證（內部測試）

```powershell
New-SelfSignedCertificate -DnsName "entask.local" -CertStoreLocation "cert:\LocalMachine\My"
```

### 內部 CA / 正式憑證

由內部 CA（ADCS）或公開 CA 簽發，匯入到本機「個人（Personal）」憑證存放區。

### 綁定

1. IIS 管理員 → 站台 `entask` → 右鍵 →「編輯繫結」→「新增」。
2. 類型：`https`；連接埠：`443`；主機名稱：`entask.local`（依實際網域名稱）。
3. SSL 憑證：選取上述憑證 → 確定。
4. 讓站台同時存在 http 與 https 時，建議將 http 永久轉向 https（URL Rewrite 規則，
   加入第 6 節 `<rewrite><rules>` 內）。
   注意：HTTPS Redirect 規則**必須放在 SPA fallback 規則之前**——fallback 帶有
   `stopProcessing="true"`，若將 redirect 放在其後，規則永遠不會被執行，登入等
   機敏流量將繼續以明文 HTTP 傳輸：

```xml
<rule name="HTTPS Redirect" stopProcessing="true">
  <match url="(.*)" />
  <conditions>
    <add input="{HTTPS}" pattern="off" ignoreCase="true" />
  </conditions>
  <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
</rule>
```

## 8. 備份排程

使用 PostgreSQL 18 的 `pg_dump` 將 `entask` 資料庫匯出成 SQL 檔：

```powershell
pg_dump -h db.example.internal -p 5432 -U entask_app -d entask -f C:\path\to\backups\entask_yyyyMMdd_HHmmss.sql
```

你可以將上述指令寫入批次檔（如 `backup.bat`）並設定排程工作。

### 排程（每日）

```powershell
schtasks /Create /TN "Entask-DB-Backup" /TR "C:\path\to\backups\backup.bat" /SC DAILY /ST 02:00 /RU SYSTEM /RL HIGHEST
```

或使用「工作排程器」GUI 新增每日 02:00 觸發的工作。備份檔輸出至
`C:\path\to\backups\entask_yyyyMMdd_HHmmss.sql`。

### 免互動密碼（重要）

`pg_dump` 連線需要密碼；排程執行（非互動）時不會跳出密碼提示，需預先提供，二擇一：

1. 設定環境變數 `PGPASSWORD`（工作層級或 SYSTEM 環境變數）：

   ```powershell
   [Environment]::SetEnvironmentVariable("PGPASSWORD", "資料庫密碼", "Machine")
   ```

2. 建立 `pgpass.conf`（PostgreSQL 官方機制，比環境變數更安全）：

   ```
   # %APPDATA%\postgresql\pgpass.conf
   db.example.internal:5432:entask:entask_app:資料庫密碼
   ```

   `pgpass.conf` 請設定僅系統帳號可讀取。

### 驗證備份

```powershell
# 還原至測試資料庫驗證
psql -h db.example.internal -p 5432 -U entask_app -d entask_test -f C:\path\to\backups\entask_xxxx.sql
```

> 請勿在正式環境直接還原；先以 `entask_test` 驗證 dump 完整性。

## 附件儲存

- 附件存放於站台內容根目錄 `storage/attachments/`（可於 appsettings `Storage:AttachmentsPath` 覆寫為絕對路徑，例如 `C:\path\to\storage\attachments`）。
- 應用程式集區身分（IIS AppPool 帳戶）需對該資料夾有**讀寫** NTFS 權限，否則上傳/下載會 500.19/500.30 或 UnauthorizedAccessException。
- 備份排程需將附件資料夾納入檔案備份範圍。

## 9. 疑難排解

| 症狀 | 可能原因 / 處理 |
| --- | --- |
| 啟動即失敗，事件檢視器有 ANCM 錯誤 | 未安裝 .NET 10 Hosting Bundle；web.config 的 `aspNetCore` handler 缺漏；站台資料夾沒有 `Entask.Api.dll` |
| `/api/*` 回 404 | API 被掛成子應用程式導致 `PathBase` 偏移；請確認 API 為站台根應用程式 |
| 前端路由重新整理後 404 | SPA fallback rewrite 規則遺失，或 `{REQUEST_URI}` 排除 `/api` 沒有生效 |
| `/api/*` 被導向 index.html | fallback 規則缺少 `^/api` 排除條件 |
| `appsettings.json`、`.dll` 可被直接下載 | 檢查 `security/requestFiltering` 是否套用 |
| 瀏覽器 console 回報 `/manifest.json` 404 | 第 6 節 `requestFiltering` 的 `.json` 條目擋掉了 SPA 的 web app manifest；見完整版 web.config 下方的說明 |
| 排程備份失敗、卡在密碼 | 未設定 `PGPASSWORD` 或 `pgpass.conf` |
| 重新整理頁面出現「HTTP 500.19」 | web.config 格式錯誤或 URL Rewrite 模組未安裝 |

## 10. 參考文件

- 後端環境變數：`src\Entask.Api\README.zh-TW.md`
