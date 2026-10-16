**English** · [繁體中文](SELF-HOSTING.zh-TW.md)
# Self-hosting Entask

Entask ships one `docker-compose.yml` that builds the application image and runs it together with
PostgreSQL 18. You need a checkout of this repository and Docker; nothing else.

Every command below is run from the repository root — the directory that contains
`docker-compose.yml`.

> **Scope: trial-grade, not production-grade.** This setup exists so you can evaluate Entask, demo
> it, or run it for a small trusted group on a machine you control. Section 1 lists what it
> deliberately does not do. Read section 9 before you put a modified copy on the internet.

## 1. What this is, and what it is not

**What it is.** Two containers. `db` runs PostgreSQL with a named volume for its data directory.
`app` is built from `Dockerfile.fly`: it compiles the React SPA, publishes the .NET API, and serves
both from a single HTTP port (`8080` inside the container, `APP_PORT` on the host, default `8080`).
The browser and the API are the same origin, so there is nothing to configure for hostnames.

**What it is not.** It is a trial-grade deployment. In particular it has none of the following:

- **No TLS.** The application speaks plain HTTP. There is no HTTPS redirection and no HSTS in the
  API, and the reverse proxy is not part of this stack. If the traffic leaves your machine or
  crosses a network you do not control, you must put your own TLS terminator in front of it
  (section 7). **TLS and certificates are entirely your business, not this runbook's.**
- **No automated backups.** Section 5 shows the manual commands.
- **No monitoring, alerting, or log shipping.** Container logs go to the Docker log driver.
- **No high availability.** One database, one application instance, no replicas, no failover.
- **No resource limits.** The compose file sets no CPU or memory ceilings; the containers can use
  what the host gives them.
- **No secret management.** The three secrets are plain values in a `.env` file on disk, readable by
  anyone who can read the file. That file is gitignored (`git status` will never show it); keep it
  that way.

If you need any of the above, treat this stack as the application layer and build the rest around
it.

## 2. Requirements

- **Docker Engine with the Compose v2 plugin.** The commands below use `docker compose` (the plugin
  form), not the old `docker-compose` binary. Confirm with `docker compose version`. This stack was
  tested on Docker Engine 29.7.2 with Compose v5.5.1; any reasonably current Engine with Compose v2
  should behave the same.
- **One free TCP port on the host**, `APP_PORT`, default `8080`. Only the `app` service publishes a
  port; the `db` service publishes none and is reachable only from inside the compose network.
- **The images.** `db` runs `postgres:18-alpine` — PostgreSQL 18, 18.6 at the time of writing. The
  compose file pins the PostgreSQL major version by tag, not by digest, so you get the current 18.x.
  The `app` image is not pulled from anywhere: it is built locally from `Dockerfile.fly`, which uses
  `node:22-alpine`, `mcr.microsoft.com/dotnet/sdk:10.0` and `mcr.microsoft.com/dotnet/aspnet:10.0`.
- **CPU and memory.** No minimum is measured or published here. The running side is PostgreSQL 18
  plus the .NET application; the first build additionally runs `npm ci`, the Vite production build,
  `dotnet restore` and `dotnet publish` inside the build stage, and that build is the demanding
  part. Size the host like a small PostgreSQL deployment and let the build use more than the runtime
  needs.
- **Disk.** Budget for the image layers, the build cache, and two volumes that grow with your data.
  Section 3 lists the sizes of the images this stack pulls and builds.

## 3. Quick start

```bash
cp .env.example .env      # then edit the three required values (section 4)
docker compose up -d --build
curl http://localhost:8080/api/health
```

The health check prints `{"status":"ok"}` — if you changed `APP_PORT` from its default, use that
port instead of `8080` in this `curl` and in the URLs below. Open `http://localhost:8080` in a
browser and log in with the admin account (`ADMIN_USERNAME`, default `admin`, and the
`ADMIN_PASSWORD` from your `.env`).

**The first build takes minutes, not seconds.** It compiles the React SPA (`npm ci` plus
`npm run build`) and the .NET solution (`dotnet restore` plus `dotnet publish`). Measured on the
author's machine on 2026-10-05, uncontended:

- **First build: 149 s** (`docker compose build --no-cache app`). That figure **excludes pulling
  images** — the run had zero `Pulling` lines. On a fresh machine you additionally download
  `postgres:18-alpine` (about 304 MB) and the base images (`node:22-alpine`,
  `mcr.microsoft.com/dotnet/sdk:10.0`, `mcr.microsoft.com/dotnet/aspnet:10.0`), so do not read
  149 s as the total time to a running site on a machine that has never built this before.
- **Rebuild with nothing changed: 6 s** (every step `CACHED`).
- **Application image: about 247 MB** (247,143,308 bytes).

**Both containers have healthchecks.** `db` runs `pg_isready`, and `app` runs
`curl -fsS http://127.0.0.1:8080/api/health` every 30 s (20 s grace period, 3 retries). `app` also
waits for `db` to be healthy before it starts, so `docker compose ps` showing both `healthy` is the
machine's answer; the honest "it is up" test is still the `curl` above.

## 4. The three values

Copy `.env.example` to `.env` and fill in the three required values. The rest have defaults and can
be left alone. `.env` is gitignored — never commit it, and keep your own copy of it somewhere safe.

| Variable | What it is | Generate | If it is wrong |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Password of the `entask` database role. It is given to the `db` container **and** interpolated into the connection string the app uses. | `openssl rand -hex 24` | Empty: compose refuses to start (section 8, item 1). Containing `;` or a quote: it is inserted verbatim into a connection string and breaks it, and the app then restarts in a loop without the error pointing at this cause. |
| `JWT_SECRET` | Signing key for the access tokens. | `openssl rand -hex 32` (32 bytes / 256 bits — required) | Empty: compose refuses to start (section 8, item 1). Shorter than 32 bytes: rejected at runtime when tokens are signed or validated — HS256 requires a key of at least 256 bits, and the app does not check the key at startup. |
| `ADMIN_PASSWORD` | Password of the admin account created on first boot. At least 8 characters, including at least one uppercase letter, one lowercase letter, one digit and one non-alphanumeric character (`src/Entask.Api/Program.cs` overrides only the length minimum; the other four rules are ASP.NET Core Identity's defaults). | anything that meets those rules, or a generated one | Empty: compose refuses to start (section 8, item 1), and no account exists to log in with. Rejected by the identity policy: the app fails at startup, the container restarts, and `docker compose logs app` names the rule that rejected it. Changing it later has no effect — see section 8, item 1. |

The two optional values you may care about are `ADMIN_USERNAME` (default `admin`) and `APP_PORT`
(default `8080`).

When a required value is missing or empty, Compose refuses to start before anything runs and names
the variable it is missing — the exact message is in section 8, item 1.

These values initialize the stack rather than configure it, and that is true of `POSTGRES_PASSWORD`
in particular. It is used only when the database directory is first created: the PostgreSQL
entrypoint skips initialization entirely on a directory that already contains a database, so editing
the value afterwards leaves the password stored in the database untouched while the app starts
sending the new one — and the app can no longer connect. If you really have to change it, change the
database role's password inside the database to match.

## 5. What persists

Two named volumes, prefixed with the compose project name `entask`:

| Volume | Mounted at | Holds |
|---|---|---|
| `entask_pgdata` | `/var/lib/postgresql` in `db` | The database itself. |
| `entask_storage` | `/app/storage` in `app` | Uploaded **attachments** (`/app/storage/attachments`) and **avatars** (`/app/storage/avatars`). |

- `docker compose down` removes the containers and the network but **keeps both volumes**. Verified:
  after `down` followed by `up -d`, both volumes were still there, and the project, the avatar and
  the attachment all came back unchanged (each was sha1-compared through the API before and after
  the restart).
- `docker compose down -v` **deletes both volumes.** Everything is gone: no database, no
  attachments, no avatars. Verified.

The `pgdata` mount point is `/var/lib/postgresql`, not `/var/lib/postgresql/data`. That is
deliberate for PostgreSQL 18, which keeps its data in a version subdirectory of the parent
directory. If you edit that path, the PostgreSQL entrypoint refuses to start and prints the mount it
considers unused — a loud failure in `docker compose logs db`, not a silent one.

**Logging in is not proof that your data survived.** The admin account is re-created on boot
whenever it does not exist (section 8, item 1), so "I can still log in" is not evidence that the
database volume persisted. Check for data you created instead.

**Back up the database:**

```bash
docker compose exec -T db pg_dump -U entask -d entask > entask-backup.sql
```

**Restore it** (into a database that is empty, or with the tables dropped first):

```bash
cat entask-backup.sql | docker compose exec -T db psql -U entask -d entask
```

**Back up attachments and avatars** — they are files on the `storage` volume and are **not** in the
database dump:

```bash
docker compose cp app:/app/storage ./entask-storage-backup
```

Restoring the files is the same operation in reverse:

```bash
docker compose cp ./entask-storage-backup/. app:/app/storage
```

## 6. Upgrading

```bash
git pull
docker compose up -d --build
```

`--build` is not optional after a code change. Without it, Compose reuses the image that is already
on the machine: the container restarts, `docker compose ps` shows it `Up`, and you are still running
the old code. This is the most common way to be fooled by this stack — see section 8, item 4.

Database migrations run automatically at application startup: the API applies the EF Core migrations
before it starts serving (`src/Entask.Api/Program.cs`). There is no separate migration step, and
there is nothing to run against the database by hand. Migrations only move forward — going back to
an older commit does not undo a schema change.

Take a backup (section 5) before an upgrade, then check `curl http://localhost:8080/api/health`
afterwards. The build itself is the same build as in section 3: minutes when something actually
changed, seconds when every step is `CACHED`.

## 7. Behind your own reverse proxy

The stack publishes exactly one HTTP port. Terminate TLS at your proxy and forward to it.

**Keep one origin.** The SPA, the API and the collaboration hub are all served from the same host
and port: the front end calls `/api/...` and `/hubs/collaboration` on relative URLs
(`web/src/lib/api.ts`, `web/src/lib/collaboration.ts`), so a new hostname needs no rebuild. Forward
the whole path space to the app; do not route `/api` to a different host than the SPA.

**WebSocket upgrade must reach the hub.** Real-time collaboration goes through the SignalR hub at
`/hubs/collaboration` (`src/Entask.Api/Hubs/CollaborationHub.cs`, mapped in
`src/Entask.Api/Program.cs`). Your proxy has to let the WebSocket upgrade through on that path. If
it does not, the client is not restricted to WebSockets (`web/src/lib/collaboration.ts` names no
transport) and will try the fallbacks — server-sent events, then long polling — and a proxy that
buffers or times out those responses leaves **real-time collaboration silently not working** while
every other page keeps behaving normally. This is the failure that looks most like "the app is
broken" without anything being broken — presence indicators and live updates simply never arrive.

**The block below is not output from this stack** — no proxy was exercised when this was tested. It
is the standard shape an nginx location needs for the hub, and the equivalent settings exist in
every reverse proxy:

```nginx
location /hubs/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

`1.1` and the two upgrade headers are the load-bearing lines. The long read timeout keeps an idle
WebSocket from being cut every minute.

Two more things worth knowing when you put a proxy in front:

- `APP_PORT` changes only the host-side published port. The container always listens on `8080`, so
  the proxy target is `<host>:<APP_PORT>`.
- The API does read `X-Forwarded-For` and `X-Forwarded-Proto` (those two, and not the host or
  prefix headers), so the client address and the scheme it records come from your proxy — once that
  proxy is trusted. Only loopback is trusted by default, so a proxy on another host has to be named
  in `ForwardedHeaders__KnownProxies` (or set `ForwardedHeaders__TrustAllProxies=true`, which trusts
  any peer and is only for a proxy address you cannot pin). Until you do that, anything that records
  a client address — for example the address recorded alongside a refresh token — records your
  proxy's address.
- `X-Forwarded-Proto` is what `Request.IsHttps` follows, and HSTS hangs off that (outside
  Development). The application still has no HTTPS redirection and no secure-cookie policy, so a
  TLS-terminating proxy in front of plain HTTP does not produce redirect loops.

## 8. Troubleshooting

These are the failures that do not announce themselves.

**1. There is no account to log in with.**

The admin account is created at startup only when it does not already exist
(`src/Entask.Identity/AdminSeed.cs`: `if (admin is null)`).

With `ADMIN_PASSWORD` empty, Compose refuses to start and no account is created at all. The exact
message (the text after the colon comes from the guard written into `docker-compose.yml`):

```
error while interpolating services.app.environment.Seed__AdminPassword: required variable ADMIN_PASSWORD is missing a value: 在 .env 設定 ADMIN_PASSWORD（≥8 字元）
```

`JWT_SECRET` and `POSTGRES_PASSWORD` produce the same shape of message, naming their own variable.

**Changing `ADMIN_PASSWORD` later does not change an existing account's password.** The seed skips
accounts that already exist, so a new value in `.env` takes effect only on a database that does not
contain that account. On an instance that is already running, change the password from inside the
application while logged in, or start over with a fresh `pgdata` volume. Editing `.env` and
restarting will look like nothing happened.

**Changing `ADMIN_USERNAME` later does not rename anything.** The seed looks the account up by name
on every boot, so a different name creates a second admin account and leaves the existing one
untouched.

**2. The application container never starts because the database is not ready.**

`app` does not start until the `db` healthcheck (`pg_isready -U entask -d entask`) passes. While the
database is unhealthy, the app container sits in `Created` and the site never answers — there is no
partial state where the UI loads and only the database is missing.

```bash
docker compose ps        # is db healthy? is app stuck at "Created"?
docker compose logs db   # why the database is unhappy
```

One way to get there: if the `pgdata` volume is mounted anywhere other than
`/var/lib/postgresql`, the PostgreSQL 18 entrypoint refuses to start and names the mount it
considers unused. That failure is loud — the same message repeats in `docker compose logs db` — but
the visible symptom up in the app is only "the site does not load".

**3. The port is already in use.**

If `APP_PORT` collides with something else on the host, `docker compose up -d` fails and the Docker
daemon reports:

```
Bind for 0.0.0.0:8080 failed: port is already allocated
```

Set a different `APP_PORT` in `.env` and run `docker compose up -d` again. Nothing else in the
stack needs to change; the port inside the container stays `8080`.

**4. You pulled but did not rebuild.**

`docker compose up -d` without `--build` reuses the image already on the machine. The container
restarts, looks perfectly healthy, and runs the old code — the change you just pulled is nowhere in
the running system. Always `docker compose up -d --build` after changing the source. If you are not
sure whether the running container has your change, rebuild and watch the build output: steps that
are not `CACHED` are the ones that reflect your change, and a build where everything is `CACHED`
means the image is already up to date with the files in the working tree.

## 9. License and your obligations

Entask is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. The full text is
in `LICENSE`; the License section of the [README](../README.md#license) states the same and is the
project's own summary.

- **Self-hosting it unmodified:** you have no additional obligation. The source link shown inside
  the application points at the upstream repository, which is the code you are running.
- **Self-hosting a modified copy:** if you change the application (rename it, white-label it, change
  its behaviour — [`docs/REBRANDING.md`](REBRANDING.md) section 1 is the list of what can be
  changed) and then let other people use it over a network, **you are the party AGPL-3.0 §13 applies
  to.** You must prominently offer everyone who interacts with it remotely an opportunity to receive
  the Corresponding Source **of your version**. Concretely: change `SOURCE_URL` in
  `web/src/lib/source-offer.ts` to point at your own source and rebuild — that is the value the
  in-app link renders from. `docs/REBRANDING.md` section 1, item 11, covers exactly this row and is
  worth reading in full before you rename anything.

The test is the version you run, not the upstream version. `LICENSE` §13 says a modified version
"must prominently offer all users interacting with it remotely through a computer network ...
an opportunity to receive the Corresponding Source **of your version**". Nothing checks this
automatically; no test turns red if you forget.
