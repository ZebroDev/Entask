[English](README.md) · **繁體中文**
# Entask.Api

Entask 後端 API（.NET 10、minimal API、PostgreSQL）。本文件說明執行所需的環境變數（組態）。

## 組態來源

ASP.NET Core 依下列順序讀取組態（後者覆寫前者）：

1. `appsettings.json`
2. `appsettings.{ASPNETCORE_ENVIRONMENT}.json`（例如 `appsettings.Development.json`）
3. 環境變數

環境變數使用雙底線（`__`）對應組態的冒號階層。例如 `ConnectionStrings__Default` 對應
`Configuration["ConnectionStrings:Default"]`、`Jwt__Secret` 對應 `Configuration["Jwt:Secret"]`。

> **開發環境**：`appsettings.Development.json` 內含本機連線字串與開發用 JWT 密鑰，
> 已被 `.gitignore` 排除，**不會**被提交到版本控制。部署時請以環境變數取代。

## 環境變數一覽

| 變數 | 必填 | 說明 | 預設值 |
| --- | --- | --- | --- |
| `ConnectionStrings__Default` | 是 | PostgreSQL 連線字串 | 無（啟動即需要） |
| `Jwt__Secret` | 是 | JWT 簽章密鑰（至少 32 bytes / 256 bits） | 無（必填——空值或更短的金鑰會在執行期拋出例外） |
| `Jwt__Issuer` | 否 | JWT 發行者（issuer） | `entask` |
| `Jwt__Audience` | 否 | JWT 受眾（audience） | `entask-web` |
| `Jwt__AccessTokenMinutes` | 否 | Access Token 有效分鐘數 | `30` |
| `Jwt__RefreshTokenDays` | 否 | Refresh Token 有效天數 | `14` |
| `Seed__AdminUsername` | 否 | 啟動時建立的系統管理員帳號 | `admin` |
| `Seed__AdminPassword` | 否 | 系統管理員密碼（需 ≥ 8 字元） | 空字串（不建立管理員） |

## 變數說明

### ConnectionStrings__Default

PostgreSQL 連線字串，Npgsql 格式：

```
Host=db.example.internal;Port=5432;Database=entask;Username=entask_app;Password=您的密碼
```

- `Host` / `Port`：資料庫位址與連接埠（本文件範例為 `db.example.internal:5432`）。
- `Database`：`entask`（正式）、`entask_test`（測試）。
- 請勿使用易外流的共用帳號；正式環境建議使用僅具最小權限的專用帳號。

### Jwt__Secret

JWT 的對稱簽章密鑰，用 HS256 簽發與驗證 Token。**必填**——請使用至少 32 bytes（256 bits）的隨機值；空值或更短的金鑰會被 JWT 程式庫在執行期拒絕（HS256 要求至少 256 bits），應用程式不會在啟動時檢查金鑰。例如：

```powershell
# PowerShell 產生 64 個十六進位字元（32 位元組 / 256 位元）
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

```bash
# 或使用 OpenSSL
openssl rand -hex 32
```

正式環境務必產生新的隨機密鑰，不要沿用開發/測試環境的值。

### Jwt__Issuer / Jwt__Audience

Token 驗證參數，與前端登入取得的 Token 需一致。預設 `entask` / `entask-web`，
一般無需變更；若變更，前端與後端必須同步。

### Jwt__AccessTokenMinutes / Jwt__RefreshTokenDays

Access Token 與 Refresh Token 的有效期間（`JwtOptions`）。未設定時使用預設值。

### Seed__AdminUsername / Seed__AdminPassword

啟動時（`AdminSeed`）建立的系統管理員帳號：

- 兩者**都**有值時，若該帳號不存在則建立，並授予管理員 claim（`entask:admin=true`）。
- 任一個為空字串時，跳過管理員建立流程（不會覆寫既有帳號）。
- 密碼須符合身分驗證原則：長度 ≥ 8，且受帳號鎖定政策保護（5 次失敗鎖定 15 分鐘）。

> 管理員每次啟動都會檢查，不存在才建立；日後變更密碼請在應用程式內或直接以 `UserManager` 處理，
> 修改環境變數不會更新既有帳號的密碼。

## 執行方式

```powershell
# 指定環境變數後直接執行（範例）
$env:ASPNETCORE_ENVIRONMENT = "Production"
$env:ConnectionStrings__Default = "Host=db.example.internal;Port=5432;Database=entask;Username=entask_app;Password=..."
$env:Jwt__Secret = "請填入隨機密鑰"
dotnet run
```

IIS 部署時，將上述變數設定於應用程式集區或站台 `web.config` 的
`<aspNetCore><environmentVariables>`，詳見 `docs/DEPLOY.zh-TW.md`。
