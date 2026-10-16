**English** · [繁體中文](DEPLOY.zh-TW.md)
# Entask Deployment and Operations Guide (on-prem / IIS)

This document explains how to deploy Entask (a .NET 10 backend API plus a React SPA) to IIS on
Windows Server, and how to schedule database backups.

> **Note: the IIS deployment is not actually in use.** This project's real deployment runs on
> Fly.io (`fly.toml` + `Dockerfile.fly`); this document is kept as a reference for the on-prem
> fallback path and has not been recently verified.
> If you do not want IIS, there is also a Docker Compose self-hosting route (one-command deploy);
> the full runbook is in `docs/SELF-HOSTING.md`.
> Paths written in the `db.example.internal` or `C:\path\to\...` forms are **example values** —
> replace them with your own environment.
> The full rename / white-label checklist (what may be changed versus what must not, each row with
> its failure mode) is in `docs/REBRANDING.md`.

## 1. Architecture overview

```
Browser ── HTTPS ──► IIS site entask (site root)
                     │
                     ├─ /api/*         → ASP.NET Core (Entask.Api, site-root application)
                     ├─ / (index.html) → SPA static files (web/dist, IIS static file handling)
                     └─ other routes   → web.config rewrite → index.html
Database: PostgreSQL 18.6 (db.example.internal:5432, db entask)
```

- The front end calls the backend over relative `/api/*` paths (`web/src/lib/api.ts`,
  `baseURL: "/api"`), so **the SPA and the API must be on the same site (same origin)**.
- The backend endpoints are registered under `/api/*` (`src/Entask.Api/Endpoints`). When an
  ASP.NET Core app is mounted as an IIS sub-application, the sub-application path becomes the
  `PathBase` and the `/api/*` routes stop matching, returning 404; therefore the **API must be
  deployed as the site-root application** (sharing the site root directory with the SPA static
  files).

## 2. Prerequisites (server)

| Item | Version / purpose | Notes |
| --- | --- | --- |
| Windows Server | 2019 / 2022+ | with the IIS role |
| IIS | 10+ | with the "Static Content" and "URL Rewrite" modules |
| .NET Hosting Bundle | 10.x | required to run .NET 10 applications |
| IIS URL Rewrite | 2.x | needed by the SPA fallback rewrite rule; without it the web.config is invalid |
| PostgreSQL | 18.6 | the database (this document's example uses `db.example.internal:5432`) |
| Node.js | 20 LTS | for building the front end only (can be skipped on the server, by building in CI or on a dev machine) |

Install the .NET Hosting Bundle (download from
[dotnet.microsoft.com](https://dotnet.microsoft.com/download/dotnet); `iisreset` afterwards):

```powershell
iisreset
```

Confirm the URL Rewrite module is present: in IIS Manager, the site should show a "URL Rewrite"
icon. If it does not, install "IIS URL Rewrite 2.0" via the Web Platform Installer or Microsoft's
official installer.

Create the database first (this project uses the database `entask` and the account `entask_app`):

```sql
CREATE DATABASE entask;
CREATE USER entask_app WITH PASSWORD 'replace-with-a-strong-password';
GRANT ALL PRIVILEGES ON DATABASE entask TO entask_app;
```

> On startup the backend applies EF Core migrations automatically and initializes permissions and
> roles, so the connection string's account needs permission to create tables (DDL).

## 3. Building the publish output

Build the backend and the front end:

```powershell
# Backend
dotnet publish src\Entask.Api -c Release -o publish\api

# Front end
cd web
npm ci
npm run build          # produces web\dist
cd ..

# Stage the built SPA at the path section 4 copies from
robocopy web\dist publish\web /E /IS /IT
```

This produces `publish\api` (backend) and `publish\web` (front end).

## 4. IIS site configuration

1. IIS Manager → "Sites" → right-click → "Add Website".
2. Site name: `entask`; physical path: the deployment folder (for example `C:\inetpub\entask`).
3. Application pool: create a new pool `EntaskPool` and set **.NET CLR version to "No Managed
   Code"** (ASP.NET Core is hosted by CoreCLR itself; the desktop CLR is not needed).
4. Bindings: `http` (80) and `https` (443, see section 7).

### Deployment file layout

Copy **both** `publish\api\*` and `publish\web\*` into the site root:

```powershell
robocopy publish\api C:\inetpub\entask /E /IS /IT
robocopy publish\web C:\inetpub\entask /E /IS /IT

# Security: remove the development settings file (it contains the dev connection string / keys; never deploy it)
Remove-Item C:\inetpub\entask\appsettings.Development.json -ErrorAction SilentlyContinue

# Overwrite the web.config produced by dotnet publish with the "full" web.config
# (create deploy\web.config first — section 6)
Copy-Item deploy\web.config C:\inetpub\entask\web.config -Force

iisreset
```

After the copy, the root directory must contain both the backend assemblies (`Entask.Api.dll`,
`web.config`, `appsettings.json`, ...) and the front-end files (`index.html`, `assets\`,
`favicon.svg`, ...).

> **Why share the root directory?** The front end calls the backend over relative `/api/*` paths,
> and the backend routes are fixed at `/api/*`. If the API were mounted as a sub-application named
> `api`, IIS would treat `/api` as a `PathBase`, and the backend's `/api/auth/...` routes would all
> miss and return 404. Sharing the root directory (an empty `PathBase`) is the only arrangement
> compatible with the current code.

## 5. Environment variables

Under IIS, set environment variables in the `<aspNetCore><environmentVariables>` section of the
site root's `web.config`, or on the application pool (IIS Manager → Application Pools →
`EntaskPool` → right-click → Advanced Settings → "Environment Variables"). Variables use double
underscores (`__`) to map the configuration hierarchy.

| Variable | Required | Notes |
| --- | --- | --- |
| `ConnectionStrings__Default` | Yes | PostgreSQL connection string (`Host=...;Port=5432;Database=entask;Username=entask_app;Password=...`) |
| `Jwt__Secret` | Yes | JWT signing key (at least 32 bytes / 256 bits; always change it in production) |
| `Jwt__Issuer` | No | default `entask` |
| `Jwt__Audience` | No | default `entask-web` |
| `Seed__AdminUsername` | No | default `admin`; the system administrator account created on first start |
| `Seed__AdminPassword` | No | administrator password (>= 8 characters); **empty means no administrator is created** |

Generate a JWT secret:

```powershell
openssl rand -hex 32
```

## 6. Site-root web.config (SPA fallback + API)

### The SPA fallback rule (the core)

The front end uses client-side routing; when you refresh a path like `/teams/xxx` IIS finds no
physical file and has to rewrite to `index.html`:

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

> Because this project puts the API and the SPA in the same site root, the fallback rule **must
> also exclude `/api` via a `{REQUEST_URI}` condition**; otherwise `/api/*` would be rewritten to
> `index.html` as well. Use the "full web.config" below.

### The full web.config (use it at the site root as-is)

Save the following as `deploy\web.config` and copy it over the site root's `web.config` (this
keeps the `aspNetCore` handler that `dotnet publish` generated and adds the SPA fallback,
environment variables and the security filtering):

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
          <environmentVariable name="ConnectionStrings__Default" value="Host=db.example.internal;Port=5432;Database=entask;Username=entask_app;Password=__REPLACE_ME__" />
          <environmentVariable name="Jwt__Secret" value="replace with at least 32 random characters" />
          <environmentVariable name="Jwt__Issuer" value="entask" />
          <environmentVariable name="Jwt__Audience" value="entask-web" />
          <environmentVariable name="Seed__AdminUsername" value="admin" />
          <environmentVariable name="Seed__AdminPassword" value="REPLACE_ME" />
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

Notes:

- **`{REQUEST_URI}` excluding `/api`**: guarantees `/api/*` is not rewritten by the fallback and
  instead reaches the `aspNetCore` handler.
- **`security/requestFiltering`**: the site root also holds backend assemblies, so this stops IIS
  from serving `.dll` / `.json` / `.config` files directly (for example a stray
  `appsettings.Development.json`).
- **The `.json` entry costs you the web app manifest.** The SPA links `/manifest.json`
  (`web/index.html`); the build copies that file from `web/public/`. With `.json` denied as an
  extension, IIS answers the manifest request with **404.7** (request filtering's substatus for a
  denied file extension). The application keeps working — what stops working is everything that
  reads the manifest, such as the name, icon and installability a browser uses when the site is
  added to a home screen. To keep the manifest, deny the backend's own JSON files by name instead
  of denying the extension as a whole. **The block below was not exercised here** (no IIS was
  available when this was written); it is the standard shape, and every other published `.json`
  (`dir publish\api\*.json`) can be listed the same way:

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

  `alwaysAllowedUrls` is **not** the way to allow `/manifest.json` back: it overrides
  `<denyUrlSequences>` only and has no effect on `<fileExtensions>`, so adding the manifest there
  while the extension stays denied changes nothing.
  Check the outcome with `curl -I https://<your site>/manifest.json` (expect `200`) and
  `curl -I https://<your site>/appsettings.json` (expect `404`).
- To debug with stdout logging, temporarily set `stdoutLogEnabled="true"`; logs go to
  `.\logs\stdout` (create the folder first and grant the application pool identity access).

## 7. HTTPS

### Self-signed certificate (internal testing)

```powershell
New-SelfSignedCertificate -DnsName "entask.local" -CertStoreLocation "cert:\LocalMachine\My"
```

### Internal CA / real certificate

Issued by your internal CA (ADCS) or a public CA, imported into the machine's "Personal"
certificate store.

### Binding

1. IIS Manager → site `entask` → right-click → "Edit Bindings" → "Add".
2. Type: `https`; port: `443`; host name: `entask.local` (use your actual domain name).
3. SSL certificate: select the certificate above → OK.
4. When the site serves both http and https, redirect http to https permanently (a URL Rewrite
   rule added inside section 6's `<rewrite><rules>`).
   Note: the HTTPS Redirect rule **must come before the SPA fallback rule** — the fallback carries
   `stopProcessing="true"`, so a redirect placed after it would never run, and login traffic and
   other sensitive requests would keep travelling in plain HTTP:

```xml
<rule name="HTTPS Redirect" stopProcessing="true">
  <match url="(.*)" />
  <conditions>
    <add input="{HTTPS}" pattern="off" ignoreCase="true" />
  </conditions>
  <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
</rule>
```

## 8. Backup schedule

Use PostgreSQL 18's `pg_dump` to export the `entask` database to a SQL file:

```powershell
pg_dump -h db.example.internal -p 5432 -U entask_app -d entask -f C:\path\to\backups\entask_yyyyMMdd_HHmmss.sql
```

You can write the above command into a batch file (e.g., `backup.bat`) and schedule it.

### Schedule (daily)

```powershell
schtasks /Create /TN "Entask-DB-Backup" /TR "C:\path\to\backups\backup.bat" /SC DAILY /ST 02:00 /RU SYSTEM /RL HIGHEST
```

Or add a daily 02:00 trigger with the Task Scheduler GUI. Backup files are written to
`C:\path\to\backups\entask_yyyyMMdd_HHmmss.sql`.

### Password-free operation (important)

`pg_dump` needs a password to connect; a scheduled (non-interactive) run never gets a password
prompt, so provide it ahead of time — one of two ways:

1. Set the `PGPASSWORD` environment variable (task-level or as a SYSTEM environment variable):

   ```powershell
   [Environment]::SetEnvironmentVariable("PGPASSWORD", "the-database-password", "Machine")
   ```

2. Create `pgpass.conf` (the official PostgreSQL mechanism; safer than an environment variable):

   ```
   # %APPDATA%\postgresql\pgpass.conf
   db.example.internal:5432:entask:entask_app:the-database-password
   ```

   Make `pgpass.conf` readable by the system account only.

### Verifying a backup

```powershell
# Restore into a test database to verify
psql -h db.example.internal -p 5432 -U entask_app -d entask_test -f C:\path\to\backups\entask_xxxx.sql
```

> Never restore over production; validate the dump against `entask_test` first.

## Attachment storage

- Attachments live under the site content root in `storage/attachments/` (override via the
  appsettings key `Storage:AttachmentsPath` to an absolute path, for example
  `C:\path\to\storage\attachments`).
- The application pool identity (IIS AppPool account) needs **read/write** NTFS permission on that
  folder; otherwise uploads/downloads fail with 500.19/500.30 or `UnauthorizedAccessException`.
- Include the attachments folder in the file backup's scope.

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Fails at startup; ANCM errors in the Event Viewer | .NET 10 Hosting Bundle not installed; the `aspNetCore` handler missing from web.config; no `Entask.Api.dll` in the site folder |
| `/api/*` returns 404 | the API is mounted as a sub-application, shifting `PathBase`; make the API the site-root application |
| Front-end routes 404 after a refresh | the SPA fallback rewrite rule is missing, or its `{REQUEST_URI}` `/api` exclusion is not taking effect |
| `/api/*` is served index.html | the fallback rule is missing its `^/api` exclusion condition |
| `appsettings.json` or `.dll` files can be downloaded directly | check that `security/requestFiltering` is applied |
| The browser console reports 404 for `/manifest.json` | the `.json` entry in section 6's `requestFiltering` denies the SPA's web app manifest; see the note under the full web.config |
| The scheduled backup hangs on a password | `PGPASSWORD` or `pgpass.conf` is not set |
| Refreshing a page shows "HTTP 500.19" | web.config is malformed, or the URL Rewrite module is not installed |

## 10. References

- Backend environment variables: `src\Entask.Api\README.md`
