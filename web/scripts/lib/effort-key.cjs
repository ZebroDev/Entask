// 工時去重鍵的**單一來源**（2026-10-11，`docs/state/42`）。
//
// 這個鍵原本有三份手寫副本，彼此只有註解相連（2026-10-11 逐條 grep 實查，全 repo 就這三處）：
//   ① `web/seed_demo.cjs` 的伺服器端集合（該卡當下的 `effort.logs` → `Set`，迴圈之前只建一次）
//   ② `web/seed_demo.cjs` 的成員資格檢查（`logged.has(...)` ⇒ 命中就 `continue`）
//   ③ `web/scripts/seed-data.test.mjs` 的閘門（「同卡三元組互異」）
// ⇒ 改一處而另外兩處不動時，**閘門會靜默地不再測真正的契約、而且維持綠**。
//   （同型的「門檻副本」在 C#／TS 之間有 `check:thresholds` 守；這個鍵原本沒有對應物。）
//
// 副檔名是 `.cjs`、不是隔壁那幾個 `.mjs`：`seed_demo.cjs` 是 CJS，而 `.cjs` 兩邊都吃得到
// （測試端已經有 `createRequire`）。刻意不成為第二個「要同步的東西」。
//
// ★ `note` 一律正規化（`?? ''`）：`null`／`undefined` 都收斂成空字串。不正規化的樣板字串
//   會把 `null` 印成字串 "null"，而**伺服器端集合用的是 `l.note ?? ''`** ⇒ 兩邊對不上
//   ⇒ **重跑會多寫一列**。今天兩份資料集都沒有 null 的 note（2026-10-11 實查：zh-TW 15 筆、
//   en 15 筆，null 皆 0）⇒ 那個分歧是**潛伏的**，不是現行症狀；抽出這個函式時一併收斂掉。
//
// 鍵**不含日期**是刻意的：工時是 append-only，重跑不該偽造歷史——已存在的那一筆保留它當初
// 寫下的日期，只有新補的才用新的 `daysAgo`（完整理由在 `seed_demo.cjs` 呼叫端）。
function effortKey(who, hours, note) {
  return `${who}|${hours}|${note ?? ''}`;
}

module.exports = { effortKey };
