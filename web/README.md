**English** · [繁體中文](README.zh-TW.md)
# Entask web (React SPA)

The single-page front end of Entask: React 19, Vite, TypeScript, TanStack Query v5, zustand (auth
state only), shadcn/ui on Radix primitives, @dnd-kit for drag-and-drop, and SignalR for real-time
collaboration. The dev server runs on port 5173 and proxies `/api` and `/hubs` to the backend on
`http://localhost:5088` (see `vite.config.ts`).

## Requirements

- Node.js 20+ and npm
- A running backend, e.g. `dotnet run --project ../src/Entask.Api`

## Commands

| Command | What it does |
|---|---|
| `npm install` | install dependencies |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | `tsc -b && vite build` — the production bundle in `dist/` |
| `npm run preview` | serve the built bundle locally |
| `npm run lint` | oxlint |
| `npx vitest run --maxWorkers=2` | unit and component tests (jsdom); `--maxWorkers=2` avoids the known worker crash on busy machines |
| `npx tsc -b` | type-check the whole project (`tsc --noEmit` compiles nothing in this solution layout and always exits 0 — do not use it) |

## Contract checks

CI runs these; run them before pushing.

| Command | What it guards |
|---|---|
| `npm run i18n:parity` | locale key sets and plural categories agree across the six locales |
| `npm run check:labels` | backend string constants ↔ frontend label tables ↔ translations |
| `npm run check:thresholds` | threshold copies (the same threshold held in both C# and TS) carry matching values and operators |
| `npm run check:errors` | error-code shapes |
| `npm run check:query-filters` | `IgnoreQueryFilters` appears exactly once under `src/` (a deliberate exception) |
| `npm run check:error-paths` | no raw `error.message` reads and no nested `t()` under `src/` (AST scan) |
| `npm run check:copy` | the "has this been translated" allowlist |
| `npm run check:error-messages` | `ErrorMessages.cs` ↔ the values in `zh-TW/error.json` agree |
| `npm run check:message-values` | inline `message` literals ↔ `zh-TW/error.json`, in both directions |
| `npx i18next-parser --fail-on-update` | locale files match the translation keys used in code |

## Layout

- `src/pages/` — route-level screens
- `src/components/` — shared UI (shadcn-derived primitives under `components/ui`)
- `src/hooks/`, `src/stores/`, `src/lib/` — hooks, zustand stores, API client and helpers
- `src/i18n/` — i18next setup and the six locale bundles (`locales/<lang>/*.json`)
- `src/test/` — vitest setup and shared test helpers

## Screenshots and demo data (maintainer tooling)

`seed_demo.cjs` (driven by a `seed-data.<locale>.cjs` dataset), `capture_all.cjs` and
`pseudo_sweep.cjs` generate the demo data, the manual screenshots and the pseudo-locale sweep. The
seeding and capture scripts talk to the running app over plain HTTP and never touch the database
directly.
