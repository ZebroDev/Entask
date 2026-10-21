**English** · [繁體中文](REBRANDING.zh-TW.md)
# Entask White-label and Rename Guide

> Purpose: to tell self-hosters and licensees **which files to change to rebrand**, and **which
> strings look editable but break things when changed**.
>
> This line is not invented by this document. The project completed a full rename effort on
> 2026-09-13, which already drew it (in three batches: brand / identifiers / runtime contracts);
> this document follows the same line.

**The one-sentence principle: white-labelling changes the words and images printed on the screen, not the system's identifiers.**

**Scope**: this document covers only the product itself (front-end display points, runtime
contracts) and the scripts that generate documentation. **It does not cover the historical record
of the rename effort** — that is what happened at the time, and rewriting it would falsify history.

---

## 1. Display identity (safe to change)

After the change you only need `cd web && npm run build` — except item 12, which lives in assembly
metadata and needs `dotnet build` too. **Nothing in this section requires touching the database,
backend code, or JWT configuration.**

The Location columns in this document name the file that holds the string, not a line number:
**a line number would go stale** the moment anyone edits that file, and a stale one sends you to the
wrong place with no warning.

| # | Item | Location | Current value |
|---|---|---|---|
| 1 | Login page title | `web/src/pages/LoginPage.tsx` | `Entask` |
| 2 | Header brand text | `web/src/components/layout/AppLayout.tsx` | `Entask` |
| 3 | Header (before a team is selected) | `web/src/components/layout/AppLayout.tsx` | `Entask` |
| 4 | Login page footer | `login.footer` in `web/src/i18n/locales/{en,es-419,ja,ko,zh-CN,zh-TW}/auth.json` | `Entask enterprise agile project management platform · v1.0.3` (one translation per locale) |
| 5 | Browser tab title | `web/index.html` | `<title>Entask</title>` |
| 6 | iOS add-to-home-screen name | `web/index.html` | `apple-mobile-web-app-title` = `Entask` |
| 7 | PWA manifest | `web/public/manifest.json` | all three of `name` / `short_name` / `description` are `Entask` |
| 8 | Application icon | `web/public/favicon.svg` | 512×512 orange mark, pure graphic with no text |
| 9 | README | `README.md`, `README.zh-TW.md` | the document title and the architecture description |
| 10 | On-prem deployment document | `docs/DEPLOY.md` (Chinese version: `docs/DEPLOY.zh-TW.md`) | the document title, the `EntaskPool` application pool, the `Entask-DB-Backup` scheduled task, and the site name / deployment path example |
| 11 | **The AGPL §13 source link** | `SOURCE_URL` in `web/src/lib/source-offer.ts`; rendered on `web/src/pages/LoginPage.tsx` (footer) and `web/src/components/layout/AppLayout.tsx` (user menu) | `https://github.com/ZebroDev/Entask` |
| 12 | **The copyright holder name** | the `<Copyright>` property in `Directory.Build.props`, the first line of `LICENSE`, and the copyright line in `README.md` and `README.zh-TW.md` | `Copyright (c) 2026 ZebroDev` |

Items 1–3 are **hard-coded literals** in JSX; they do not go through i18n. Changing them does not
affect any locale file's completeness checks.

### Items 11 and 12 differ from the other ten — getting either wrong is not "ugly"

**Getting item 11 wrong is a false licence; getting item 12 wrong is a false attribution.** Both are
honesty problems rather than appearance problems, and neither is checked automatically.

**Item 11 — where the source link points.** §13's trigger is "**if you modify the Program**"
(`LICENSE:542`, verbatim), and what you must offer is the Corresponding Source **of your version**.
So **if you rebrand, rebuild, and self-host, you are the party §13 applies to**; and `SOURCE_URL`'s
default points at **upstream** — which, by then, is precisely the wrong place.

When rebranding, **change it to point at your own source as well**. Anyone self-hosting unmodified
can keep the default (upstream is then your Corresponding Source). This is purely a matter of
honesty: nothing checks it automatically, and no test turns red if you forget.

**Item 12 — whose name the copyright notice carries.** Leave it and you publish **your** product
under **someone else's** name — a **false attribution**, not a cosmetic miss. As with item 11,
nothing checks it: **no test in the suite asserts this string**.

`ZebroDev` is the project's brand name — the pen name the independent maintainer publishes under,
**not a company or legal entity**. It is still *this project's* name, so a white-labelled build has
to carry yours. Two mechanics differ from the items above: `Directory.Build.props:3` is compiled
into the assembly's copyright metadata (so the change needs `dotnet build`, not just
`npm run build`), and `LICENSE:1` is the licence file itself — the AGPL-3.0 text below that line
does not change.

### What the display side does **not** have (saving you the search)

- **The backend has no user-visible brand strings.** An inspection of every C# string literal in
  `src/`: the only occurrences of `Entask` are namespaces, `JwtOptions` defaults, the `entask:admin`
  claim type, EF migration snapshot strings, plus two **developer-facing** literals (the `:10` doc
  comment and the `:80` startup exception message in
  `src/Entask.Api/Endpoints/ExportLabels.cs`, the latter mentioning `Entask.Api.csproj`) — **all of
  them belong to section 2**.
  The three resource files `src/Entask.Api/Resources/export.{en,zh-CN,zh-TW}.json` contain no
  `Entask` either.
- Export and notification text is now handled in three ways: Worklogs and Team reports use labels, and notifications are rendered by the frontend, but **Project report CSV headers are still hard-coded in English**. These are open i18n items, **not a brand point**; white-labelling does not need to touch it.

### Two non-obvious details

1. **Users who already installed the PWA must reinstall to see the new name** — `manifest.json`'s
   name is fixed at install time; the browser will not update an installed shortcut just because
   the file on the server changed.
2. **`web/index.html:7` is the only source of the tab title.** Nothing in `web/src` ever assigns
   `document.title`, and `src/Entask.Api/Program.cs:280` only sends `Cache-Control` headers for
   `index.html`, **without rewriting the content**. So changing that one line is all there is; no
   need to look server-side.

---

## 2. Runtime identity (**do not change**)

Every item in this section is an **identifier**, not copy. Once they have been written into the
database, tokens, or browser storage, changing them produces **failures with no error message** —
the fundamental difference from section 1.

| # | Item | Location (verified) | Current value | What breaks if changed |
|---|---|---|---|---|
| 1 | Namespaces / project names / solution file | `Entask.sln`, `src/Entask.*` (7 projects), `tests/Entask.Tests` | `Entask.*` | The rename effort touched 213 files for this. Changing it has no upside, only cost |
| 2 | JWT issuer / audience | `src/Entask.Identity/Options/JwtOptions.cs` | `entask` / `entask-web` | **Tokens still get signed, but every request returns 401.** Both ends (issue / validate) take the same literal via `Program.cs`'s `PostConfigure` and a local variable; **do not write a second literal in `ValidIssuer`** — that is exactly what caused this failure originally |
| 3 | The same pair's second and third homes | `fly.toml`'s `[env]` (`Jwt__Issuer` / `Jwt__Audience`), Fly secrets | as above | **Fly secrets take precedence over `fly.toml`'s `[env]`.** If the secret exists, editing `fly.toml` has no effect and shows no symptom |
| 4 | localStorage keys (4) | `web/src/lib/storage-keys.ts` | `entask-auth` / `entask-ui-theme` / `entask-mindmap-collapsed-` / `entask-mindmap-cascade-drag` | **Silent credential loss**: the auth store writes fine, but the request interceptor reads nothing back, so every request goes out unauthenticated. Theme and mind-map preferences reset along with it |
| 5 | Locale key | `web/src/lib/storage-keys.ts` | `entask-locale` | Users' language preference silently resets. Note this key **encodes two states by its presence** (absent = follow the browser); renaming the key sends everyone back to following the browser |
| 6 | Admin claim type | `src/Entask.Identity/AdminSeed.cs` | `entask:admin` | **Every admin is silently demoted.** Migration of existing rows lives in `AdminClaimSeed` (`src/Entask.Infrastructure/Data/Seed/AdminClaimSeed.cs`), whose `LegacyClaimType` deliberately keeps the **old brand's claim value** (for matching and migrating existing rows) — it is **the only place in `src/` still hard-coding the old identifier** (the remaining old values live in config and test files). **Do not "tidy it away"** |
| 7 | Database role / database names | `src/Entask.Api/appsettings.Development.json` (**gitignored**), `.github/workflows/ci.yml` | role `entask_app`, databases `entask` / `entask_test` | Cannot connect. `AdminClaimSeed`'s historical literal depends on it too |
| 8 | Test connection environment variable | `ENTASK_TEST_CONNECTION` | as above | Every backend test fails to start (**hard rename, no fallback**) |

**Section 2's general rule**: once a string **has been used as an identifier** (row-match key,
storage key, token claim, connection parameter), it cannot be a translation, and it cannot be a
brand. This is a pit the rename effort fell into, and it is the same principle behind the P-A fix
of three places that "used Chinese strings as row-match keys".

---

## 3. Generator scripts (change these together when regenerating docs or re-shooting screenshots)

These scripts do not ship in the application, but **what they produce does**. Rebrand without
changing them and the next manual regeneration or screenshot session will produce old-brand output.

| Script | Brand-string locations | Notes |
|---|---|---|
| `docs/generate_manual_docx.py` | output filename, title, plus many places in the body | produces `docs/Entask_系統使用說明書.docx` (script not included in this repository) |
| `docs/generate_guide_pptx.py` | output filename, titles, plus many places in the body | produces `docs/Entask_User_Guide.pptx` (script not included in this repository) |
| `web/capture_all.cjs` | `page.type('#password', …)` types the password straight into the login form | Puppeteer screenshots (24 images), **against the dev server** |
| `web/pseudo_sweep.cjs` | `PASSWORD` (overridable via the `SWEEP_PASSWORD` environment variable) | pseudo-locale page sweep, same as above |

The last two take **seed credentials**, not brand text. And that value has **multiple copies** in
the repo — the rename stage actually synchronised them once (the whole dev default password was
rotated at rename time). When changing `Seed__AdminPassword`, handle the whole set:

| Copy | Location | What happens if not synchronised |
|---|---|---|
| Canonical (seed source) | `src/Entask.Api/appsettings.Development.json` (**gitignored**) | — |
| Login page's dev-fill button | `web/src/pages/LoginPage.tsx` | in dev mode the button fills in the old password and login fails. It only renders under `import.meta.env.DEV`, so this failure shows up only during development |
| Screenshot script | `page.type('#password', …)` in `web/capture_all.cjs` | Puppeteer login fails; the screenshot run aborts |
| Pseudo-locale sweep | `web/pseudo_sweep.cjs` (overridable via `SWEEP_PASSWORD`) | same as above |
| README | `README.zh-TW.md` | the credentials printed in the document are wrong |
| Tests | `web/src/pages/LoginPage.test.tsx` | **turns red — deliberately**; it is your reminder that you missed one |

> **Both the .docx and the .pptx were regenerated on 2026-09-19**, and filename and content match
> (the earlier window where "the filename changed but the content kept the old brand" is closed:
> the manual then contained the old brand 12 times and the deck 3 times; both are now 0 across a
> full zip scan).
> The regeneration order cannot be reversed — **re-running the generators only fixes text, not
> screenshots** — so it is "rebuild demo data → re-shoot the 24 images → re-run the generators".

---

## 4. Names deliberately kept as they are (not oversights)

The following three names **look like strings that were missed and are deliberately kept as they are**.
Changing them breaks things, which is why they are listed here.

| Item | Location | Why not | What breaks if changed |
|---|---|---|---|
| Fly app name | the `app` value in `fly.toml` | a Fly app name is global and is fixed at creation — an app is created **as** a name, not renamed into one | pointing `fly.toml` at a different name means deploying somewhere else; the domain and the deploy target have to change together |
| Fly volume name | the `[mounts] source` value in `fly.toml` | that name is an **existing volume with your files in it**, and a volume's name is fixed at creation too | pointing the mount at a different (for example newly created, empty) volume ⇒ **attachments and avatars appear to all vanish**; the data is still on the old volume, which is simply no longer mounted |
| Local directories | a repository or backup directory name that tooling matches on (**deliberately kept**) | renaming makes **existing backups never get rotated away** (the rotation regex is bound to the old directory name) | **backups in the old directory freeze in place and their space is never reclaimed**; new backups in the new directory still rotate normally (keeping the most recent 14), so it is a **bounded** residue, not unbounded growth |

---

## 5. What to run after changing things

Display-only changes (section 1) need the front end only — except item 12, which is assembly
metadata and also needs a backend rebuild (`dotnet build`). Run this set:

```bash
cd web
npm run build              # tsc -b && vite build
npx vitest run --maxWorkers=2
npm run i18n:parity        # locale key sets and plural categories
npm run check:labels       # backend string constants <-> frontend label tables
npm run check:errors       # error-code shapes
npm run check:copy         # the "has it been translated" whitelist
npx i18next-parser --fail-on-update
```

Item 4 (`check:labels`) is unrelated to branding but **must run**: it guards the contract between
backend identifiers and front-end label tables, and that contract fails in exactly the same way as
branding does — **the screen prints raw identifiers and no test goes red**.

If you changed more than display text — anything in section 2 — **also run the backend**:

```powershell
$env:ENTASK_TEST_CONNECTION = <the connection string from your local gitignored file>
dotnet test
```

> **Do not rewrite the historical record of the rename effort.** That is what happened at the
> time; rewriting it would falsify history.
