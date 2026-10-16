**English** · [繁體中文](README.zh-TW.md)
# Entask.Api

The Entask backend API (.NET 10, minimal APIs, PostgreSQL). This document covers the environment
variables (configuration) required to run it.

## Configuration sources

ASP.NET Core reads configuration in the following order (later overrides earlier):

1. `appsettings.json`
2. `appsettings.{ASPNETCORE_ENVIRONMENT}.json` (for example `appsettings.Development.json`)
3. Environment variables

Environment variables use double underscores (`__`) to map the configuration's colon hierarchy.
For example `ConnectionStrings__Default` maps to `Configuration["ConnectionStrings:Default"]`, and
`Jwt__Secret` maps to `Configuration["Jwt:Secret"]`.

> **Development**: `appsettings.Development.json` holds the local connection string and the
> development JWT secret, is excluded by `.gitignore`, and is **never** committed to version
> control. Replace it with environment variables when deploying.

## Environment variables at a glance

| Variable | Required | Description | Default |
| --- | --- | --- | --- |
| `ConnectionStrings__Default` | Yes | PostgreSQL connection string | none (needed at startup) |
| `Jwt__Secret` | Yes | JWT signing key (at least 32 bytes / 256 bits) | none (required — an empty or shorter key throws at runtime) |
| `Jwt__Issuer` | No | JWT issuer | `entask` |
| `Jwt__Audience` | No | JWT audience | `entask-web` |
| `Jwt__AccessTokenMinutes` | No | Access token lifetime, in minutes | `30` |
| `Jwt__RefreshTokenDays` | No | Refresh token lifetime, in days | `14` |
| `Seed__AdminUsername` | No | system administrator account created at startup | `admin` |
| `Seed__AdminPassword` | No | administrator password (>= 8 characters) | empty string (no administrator created) |

## Variable reference

### ConnectionStrings__Default

PostgreSQL connection string, Npgsql format:

```
Host=db.example.internal;Port=5432;Database=entask;Username=entask_app;Password=__REPLACE_ME__
```

- `Host` / `Port`: database address and port (this document's example uses `db.example.internal:5432`).
- `Database`: `entask` (production), `entask_test` (tests).
- Do not use a shared account that can leak; in production, prefer a dedicated account holding only
  the privileges it needs.

### Jwt__Secret

The symmetric signing key for JWTs; HS256 is used to issue and validate tokens. **Required** — use a random value of at least 32 bytes (256 bits); the JWT library rejects empty or shorter keys at runtime (HS256 requires at least 256 bits), and the application does not check the key at startup. For example:

```powershell
# PowerShell: generate 64 hex characters (32 bytes)
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

```bash
# or with OpenSSL
openssl rand -hex 32
```

Always generate a fresh random key for production; do not reuse development/test values.

### Jwt__Issuer / Jwt__Audience

Token validation parameters; they must match the token obtained at front-end login. Defaults are
`entask` / `entask-web`, and normally no change is needed; if you do change them, the front end
and the backend must change together.

### Jwt__AccessTokenMinutes / Jwt__RefreshTokenDays

Access-token and refresh-token lifetimes (`JwtOptions`). The defaults apply when unset.

### Seed__AdminUsername / Seed__AdminPassword

The system administrator account created at startup (`AdminSeed`):

- When **both** have values, the account is created if it does not exist, and is granted the admin
  claim (`entask:admin=true`).
- If either is the empty string, the admin-creation flow is skipped (existing accounts are not
  overwritten).
- The password must satisfy the identity policy: length >= 8, and it is protected by the lockout
  policy (5 failures lock it for 15 minutes).

> The administrator is created at startup only if it does not already exist; to change the password later, do it
> inside the application or via `UserManager` directly — editing environment variables does not
> update an existing account's password.

## Running it

```powershell
# set the environment variables, then run (example)
$env:ASPNETCORE_ENVIRONMENT = "Production"
$env:ConnectionStrings__Default = "Host=db.example.internal;Port=5432;Database=entask;Username=entask_app;Password=..."
$env:Jwt__Secret = "replace with a random secret"
dotnet run
```

Under IIS, set these variables on the application pool or in the site's `web.config`
`<aspNetCore><environmentVariables>`; see `docs/DEPLOY.md` for details.
