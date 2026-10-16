[English](README.md) · **繁體中文**
# Entask web（React SPA）

Entask 的單頁前端：React 19、Vite、TypeScript、TanStack Query v5、zustand（僅存 auth 狀態）、
以 Radix 原生元件為底的 shadcn/ui、負責拖放的 @dnd-kit，以及用於即時協作的 SignalR。
開發伺服器跑在 5173 埠，並把 `/api` 與 `/hubs` 代理到 `http://localhost:5088` 的後端
（見 `vite.config.ts`）。

## 需求

- Node.js 20+ 與 npm
- 執行中的後端，例如 `dotnet run --project ../src/Entask.Api`

## 指令

| 指令 | 作用 |
|---|---|
| `npm install` | 安裝相依套件 |
| `npm run dev` | Vite 開發伺服器（HMR） |
| `npm run build` | `tsc -b && vite build`——production bundle 產出到 `dist/` |
| `npm run preview` | 在本機伺服建置產物 |
| `npm run lint` | oxlint |
| `npx vitest run --maxWorkers=2` | 單元與元件測試（jsdom）；`--maxWorkers=2` 避開機器忙碌時已知的 worker 崩潰 |
| `npx tsc -b` | 對整個專案做型別檢查（這個 solution 佈局下 `tsc --noEmit` 什麼都不編、恆 exit 0——不要用它） |

## 守契約的檢查

這些在 CI 執行；推送前先跑。

| 指令 | 守什麼 |
|---|---|
| `npm run i18n:parity` | 六個語系的 key 集合與複數類別一致 |
| `npm run check:labels` | 後端字串常數 ↔ 前端標籤表 ↔ 各語系譯文 |
| `npm run check:thresholds` | 門檻副本（同一個門檻在 C# 與 TS 各有一份）的數值與運算子相符 |
| `npm run check:errors` | 錯誤碼形狀 |
| `npm run check:query-filters` | `src/` 之下 `IgnoreQueryFilters` 恰好一處（刻意的例外） |
| `npm run check:error-paths` | `src/` 之下不得直讀 `error.message`、不得巢狀 `t()`（AST 掃描） |
| `npm run check:copy` | 「有沒有翻」的白名單 |
| `npm run check:error-messages` | `ErrorMessages.cs` ↔ `zh-TW/error.json` 的值相符 |
| `npm run check:message-values` | 各站點內嵌的 `message` 字面值 ↔ `zh-TW/error.json`，雙向 |
| `npx i18next-parser --fail-on-update` | 語系檔與程式碼使用的翻譯 key 相符 |

## 目錄結構

- `src/pages/`——路由層畫面
- `src/components/`——共用 UI（`components/ui` 之下是 shadcn 衍生的原生元件）
- `src/hooks/`、`src/stores/`、`src/lib/`——hooks、zustand store、API client 與工具
- `src/i18n/`——i18next 設定與六個語系包（`locales/<lang>/*.json`）
- `src/test/`——vitest 設定與共用測試輔助

## 截圖與示範資料（維護者工具）

`seed_demo.cjs`（由 `seed-data.<locale>.cjs` 資料集驅動）、`capture_all.cjs` 與
`pseudo_sweep.cjs` 負責產生示範資料、手冊截圖與偽語系掃頁。建資料與截圖腳本以純 HTTP
與執行中的應用溝通，不直接碰資料庫。
