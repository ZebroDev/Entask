// EF 全域 query filter 的破例只准有一處。CI 與本機皆可跑：node scripts/check-query-filter-exceptions.mjs
//
// 為什麼需要這支（設計 §5，`docs/superpowers/specs/2026-09-18-entask-reviewer-soft-delete-design.md`）：
//
// 審查者的移除在 2026-09-18 改成軟刪除（`CardReview.RemovedAt`，設計 §4.2），而「排除已移除的
// 人」靠的是 `EntaskDbContext` 的全域 query filter（`r.RemovedAt == null`，§4.3）。全庫唯一的
// 破例是 FPY 的分母：它要的是「**曾**指派過審查者」（`ProjectReportQueries` 的
// `db.Cards.IgnoreQueryFilters()`，§4.4）——那一行**就是**那個語意的實作本體，不是最佳化。
//
// 為什麼破例數需要閘門：來源是設計文件裁定表的 **D2 那一列**
// （`docs/superpowers/specs/2026-09-18-entask-reviewer-soft-delete-design.md`），原文逐字是
// 「12 個讀取點裡 11 個要「排除已移除」、1 個（FPY 分母）要「包含」，**所以預設值應該是排除**。
// 反向做法（逐一加條件）漏一個就是靜默錯誤，四道閘門都不會響」。破例一旦從
// 1 變多，「預設正確」就不再成立——而每一處新的破例都是**靜默**的：它不紅、看起來像一條正常
// 查詢，只是那條路徑從此看得到已移除的指派（rollup、待我審查、報表統計都是這一類）。
// 這個 repo 吃過「只有註解守著」的虧（B2-7 的 R6 教訓），所以做成一支腳本。
//
// 為什麼是**新的一支**、不塞進 check-error-codes.mjs（設計 §5）：那一支的檔頭自己寫明了它為什麼
// 不與 check-label-tables.mjs 合併——「硬塞進同一支會讓那個名字變得不精確」。同一條理由在這裡
// 逐字成立：錯誤碼形狀與 query filter 例外是兩件事。
//
// **閘門數的是「程式碼裡的出現」，不是「文字裡的出現」**（T4 的 R7）：`src/` 的註解**本來就會**
// 提到 `IgnoreQueryFilters()`（`EntaskDbContext.cs` 是在 query filter 上方解釋那個 filter 為什麼
// 存在，`ProjectReportQueries.cs` 是在破例那一行上方解釋它為什麼**只有**這一處），
// 所以 `grep -rn IgnoreQueryFilters src/ --include=*.cs` 的行數**必然多於**本檢查的命中數。
// 數字不寫在這裡（會腐爛）——兩個都自己量：`grep` 的輸出自己數，本檢查的命中數與落點印在
// 下面那行成功訊息裡。本檢查跑在 `maskCSharp`（`lib/label-table-extract.mjs`，與
// check-label-tables.mjs 共用同一份實作）的遮罩結果上——**不要**把它改寫成文字比對。
//
// **已知盲區（四類，誠實記載）**：
//   1. **識別碼不出現就看不到**：先存成變數（`var q = db.Cards; q.IgnoreQueryFilters();`）、
//      用擴充方法或別名包一層、或走反射呼叫，這一支都看不到——它掃的是**這個識別字在
//      `src/` 的 `.cs` 裡出現幾次**，不是「執行期有幾條查詢關掉了 filter」。
//   2. **效果相近但名字不同的 API**：`IgnoreAutoIncludes()` 之類不在守備範圍（名字不同、
//      語意也不同），要不要管是另一個決定。
//   3. **`tests/` 不在範圍內**（T4 的 R3）：測試**合法地**用 `IgnoreQueryFilters()`——
//      設計 §6.1 第 2 條要它用（不用的話看不到被軟刪除的那一列）。
//   4. **掃描器認不得的構件一律 exit 1**（大聲，不是放行）——**不要**把這句讀成「凡它認得的
//      都處理對了」：2026-09-18 fix round 2 之前，「**有洞的**逐字內插字串」（`$@"…{…}"`）就是
//      「認得卻處理錯」的那一類（洞被當內容整段遮掉、不報錯，而洞裡正好可以放本閘門要抓的
//      那一行）；現在它改成大聲。**與本閘門的判讀直接相關的三類**是：**有洞的**逐字內插字串
//      `$@"…{…}"`／`@$"…{…}"`、**內插的**原始字串 `$"""`／`$$"""`、以及不在放行清單裡的
//      前置處理器指示詞（`#if` 這類條件編譯、`#line`；放行清單是 `TRANSPARENT_DIRECTIVES`）。
//      **這不是「今天會 bail 的全部」**：`maskCSharp` 也對**未收尾**的字面值與註解大聲
//      （一般／逐字／內插字串、字元字面值、原始字串、區塊註解）。**那不是本階段新加的形狀**
//      ——T4 只多加了原始字串那一條，其餘在 T4 之前就在，fix round 1／2 一條都沒動
//      （量法：`git show <rev>:web/scripts/lib/label-table-extract.mjs | grep -c "沒有收尾"`
//      ⇒ T4 前 6、`7b48717` 起 7，兩個修訂之間只差原始字串那一行）。每一條的實際訊息見
//      task-4-report 的 fix round 3 節的探針輸出。
//      **刻意不在這裡補成窮舉**：一份寫著「逐項列出」卻會跟著掃描器腐爛的清單，比一句把
//      範圍講清楚的話更糟（fix round 2 修的正是這個毛病的小一號版本）。完整的判準與邊界
//      在 `maskCSharp` 的說明裡（它自己記著「未收尾的引號成對時會配得起來 ⇒ 靜默」那條
//      已知限制）。
//
// 掃描範圍＝`src/` 底下**非 `bin/`／`obj/`** 的 `.cs`。`bin`／`obj` 底下是建置產物
// （`AssemblyInfo.cs`、`GlobalUsings.g.cs` 這一類），而本 repo 因為「dev server 鎖 DLL」的
// workaround 累積了許多 `bin/<變體>/` 目錄——不排除的話，**「掃了幾個檔案」會變成一個取決於
// 上次建置的數字**。（`walk()` 只回傳 `.cs`，讀到的永遠是文字檔，所以這裡擋的**不是**
// 「讀到二進位」——那些建置產物有沒有命中那個識別字是會變的事實，不寫死。）
// 與 check-error-codes.mjs 同一條規則、同一個理由。要複驗那個檔案數（Git Bash）：
// `find src -name '*.cs' -not -path '*/bin/*' -not -path '*/obj/*' | wc -l`，
// 對比不帶那兩個 `-not` 的版本。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { LabelTableParseError, maskCSharp } from "./lib/label-table-extract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const repoRoot = join(root, "..");
const scanDir = join(repoRoot, "src");

// 掃的是**識別字**（不要求後面接括號）：方法群組轉型、`nameof` 之類的寫法也算，方向是更吵。
const PATTERN = /IgnoreQueryFilters/g;

// 契約（設計 §5）：**恰好**一處。大於一是「破例變多了」，等於零是「那一行不見了」——
// 兩個方向都會讓 D2 的「預設正確」失效，而症狀都是靜默的，所以兩個方向都要 exit 1。
const EXPECTED = 1;

const SKIP_DIRS = new Set(["bin", "obj"]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".cs") ? [full] : [];
  });
}

/** 遮罩後的位置 → 行號。遮罩是等長的（`\n`／`\r` 保留），索引可以直接換算。 */
const lineAt = (source, index) => source.slice(0, index).split("\n").length;

const hits = [];
const unreadable = [];
let scanned = 0;

for (const file of walk(scanDir)) {
  const rel = relative(repoRoot, file).replaceAll("\\", "/");
  scanned += 1;
  const source = readFileSync(file, "utf8");
  let masked;
  try {
    ({ masked } = maskCSharp(source, rel));
  } catch (error) {
    // 認不得的形狀＝大聲。**不要**在這裡 continue 掉就算了：那會讓「掃不到」看起來像「沒問題」。
    if (error instanceof LabelTableParseError) {
      unreadable.push(error.message);
      continue;
    }
    throw error;
  }
  for (const match of masked.matchAll(PATTERN)) {
    hits.push(`${rel}:${lineAt(source, match.index)}`);
  }
}

if (unreadable.length > 0) {
  console.error("查詢篩選破例檢查無法完成——掃描器遇到它認不得的形狀（本檢查不猜）：\n");
  for (const message of unreadable) console.error(`  - ${message}`);
  console.error("\n請改寫該檔，或更新 web/scripts/lib/label-table-extract.mjs 的 C# 掃描器。");
  process.exit(1);
}

if (hits.length > EXPECTED) {
  console.error(`查詢篩選的破例超過一處（實測 ${hits.length} 處，契約是恰好 ${EXPECTED} 處）：\n`);
  for (const hit of hits) console.error(`  - ${hit}`);
  console.error(
    `\n全域 query filter（\`CardReview.RemovedAt == null\`）是「排除已移除的指派」的**預設值**，` +
      `每一處破例都是放棄那個預設，而且不會有任何測試變紅。新增的查詢請直接用預設（不要加` +
      ` IgnoreQueryFilters）；真的需要第二處破例時，先改設計（§4.3／§4.4／D2）再改這支閘門。`,
  );
  process.exit(1);
}

if (hits.length === 0) {
  console.error(`查詢篩選的破例一處都沒有（契約是恰好 ${EXPECTED} 處）：\n`);
  console.error(
    `  那一處是 FPY 分母「曾指派過審查者」的實作本體（設計 §4.4／D2）——少了它，` +
      `\`c.Reviews.Any()\` 會退化成「**現在**有審查者」，把某張卡的審查者全部移除就能讓它離開分母。\n` +
      `  若語意改成別的方式實作了（不再需要破例），請一併更新設計與這支閘門。`,
  );
  process.exit(1);
}

console.log(
  `查詢篩選破例檢查通過：${scanned} 個後端原始檔中，IgnoreQueryFilters 恰好 ${EXPECTED} 處（${hits[0]}）。`,
);
