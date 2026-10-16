// 前端的錯誤路徑只有一個出口：`apiErrorMessage(error, fallback)`（`src/lib/utils.ts`）。
// CI 與本機皆可跑：node scripts/check-error-paths.mjs
//
// 為什麼需要這支：
//
// 前端讀 `error.message` 時，對 axios 而言那是**傳輸層字串**（由
// `node_modules/axios/lib/core/settle.js` 產生，字面就是 `Request failed with status code 400`），
// 不是伺服器說的任何一句話。而 `src/lib/error-messages.ts` 早就把後端每一個錯誤碼的譯文
// 準備好了——那個集合由 `check-label-tables.mjs` 的第八張表與 `src/Entask.Core/ErrorCodes.cs`
// 釘成相等（兩邊各 57 條，實查 2026-09-19），所以「這個錯誤碼有沒有譯文」不是問題，
// **問題只是呼叫端沒去拿**。
//
// AGENTS.md 從 P-C 起就寫著「新增 `onError` 時一律走 `apiErrorMessage`」——這條規則**零強制**，
// 於是累積了 50 處違反（mutation toast 34 ＋ 讀伺服器原文 6 ＋ query 錯誤內嵌渲染 10）。
// 2026-09-19 一次收乾淨，並把規則變成這支閘門。
//
// 為什麼是 AST 掃描而不是 grep（屋規）：
//
// 「`.message` 出現在哪裡」是**語法**問題，不是**文字**問題——註解裡、字串裡、變數名稱裡
// 都有這串字。近似式的跳略規則只會在大聲與靜默之間選一邊，而錯的方向決定一切
// （`lib/label-table-extract.mjs` 走了三輪 fix、66 支測試才站穩，教訓逐字在 AGENTS.md）。
// 這裡對**真實語法樹**做祖先查詢，所以 `console.error(e.message)` 與
// `const m = e.message; console.error(m)` 分得開——文字掃描器分不開這兩者。
//
// 兩條規則：
//
//   A. `src/` 裡不得出現 `.message` 的屬性存取。四種形狀都是節點（實測 typescript 6.0.3）：
//      `PropertyAccessExpression`（`error.message`）、帶 `questionDotToken` 的同上（`e?.message`）、
//      `ElementAccessExpression` 且引數是 `"message"` 字面值（`err["message"]`）、
//      以及 `ObjectBindingPattern` 底下的 `BindingElement`（`const { message } = err`）。
//      **巢狀選填鏈不必特別處理**：`err?.response?.data?.message` 是一棵同質的樹，`.message`
//      是**頂端單一節點**。⚠️ `ts.SyntaxKind.PropertyAccessChain` 在 TS 6 是 `undefined`
//      （實測）——照 5.0 以前的節點種類寫的規則會**什麼都match不到、而且是靜默綠的**。
//      **為什麼整批 `.message` 都算、不分「是不是 Error」**：要分辨就得看識別字的名字
//      （`error`／`err`／`e`）或跑型別檢查。前者是**會靜默失手**的手維護近似（有人寫
//      `catch (problem) { toast.error(problem.message) }` 就漏了）；後者要 `ts.createProgram`
//      （每次 CI 全量型別檢查）而且在單檔沙箱裡答不了。**寧可多報**——多報的代價是一行指著
//      `file:line` 的紅燈，而收乾淨之後在範圍內**沒有任何一處非錯誤的 `.message`**（實查）
//      ⇒ 假陽性率 0。這是「近似式的跳略規則只會在大聲與靜默之間選一邊」用在接收者分類器上。
//
//   B. `t()`（或 `i18n.t()`）出現在**另一個同類呼叫的引數子樹裡** ⇒ 紅，**報內層的位置**
//      ——那是 key 不會被抽出的那一個。`i18next-parser` 抽得到外層、**抽不到內層**，
//      而 `keepRemoved: false` 會把內層那條從語系檔**刪掉**，畫面只顯示 key 本身，
//      四道防線（`tsc -b`、vitest、parity、`--fail-on-update` 自己）**全都不會紅**。
//      **觸發條件比「巢狀」更精確**：巢狀不會當場壞——要那個 key **沒有其他可被抽取的引用**時
//      才會被刪。這正是本階段要修的那 9 處 query 錯誤的形狀（`apiErrorMessage` ＋ 巢狀
//      fallback）：照最直覺的寫法改**今天不會壞**，因為 `common:error.tryLater` 另有引用撐著
//      ——但那是把 9 個畫面的存續**綁在別處的引用上**。抽成陳述式就沒有這個耦合。
//
// **已知盲區（逐條列，刻意不寫成窮舉——清單會跟著掃描器腐爛）**：
//   1. **計算出來的鍵**：`err[k]`、`err["mes" + "sage"]`。引數不是字面值，任何語法規則
//      都看不到。
//   2. **`src/lib/` 依宣告排除，而它不是沒有 sink**：`notificationStore.ts` 會
//      `toast(title, …)`。已用「單獨收回那一支」緩解（見下方的範圍宣告）；殘餘是
//      `src/lib/` 其他檔案裡的 `.message` 若流進那個 toast 就看不到。
//   3. **`*.test.*` 與 `src/test/**` 不在範圍**：測試合法地斷言傳輸層字串。
//   4. **`console.*` 以外的開發者 sink**（`logger.debug(e.message)`）會被旗標——**大聲的
//      假陽性**，刻意的：豁免清單只有 `console.*`，因為那是本 repo 在用的。
//   5. **非錯誤物件的 `.message` 會被旗標**（同 4，寧可多報）。
//   6. **規則 B 不管提上去的變數落在哪**：提到模組層級雖然修好了抽取，卻會凍結當下的語系
//      （AGENTS.md「譯文不得穿過不會隨語系重算的邊界」②）。那要人看，掃描器看不到。
//   7. **規則 B 認的是識別字 `t`**：與 `i18next-parser` 自己做的近似相同。AGENTS.md 記過
//      8 次 `t` 被區域變數遮蔽——被遮蔽的 `t` 若又巢狀會產生**大聲的假陽性**（錯的方向
//      是安全的那一邊）。**兄弟不是巢狀**：`cond ? t("a") : t("b")` 綠，述詞是**祖先關係**。
//   8. **`<Trans ns>` 被 `useTranslation` 覆寫**（P-B2-4）是同一族的靜默 i18n 失敗，
//      **不在本閘門範圍**（全庫 1 處）。
//   9. **名字的精確性**：規則 B 的一般形式（「抽取器看不到的 `t()`」）不限於錯誤路徑。
//      它若長大到超過錯誤路徑，就該獨立成 `check-i18n-nesting.mjs`——理由與
//      `check-error-codes.mjs` 不併進 `check-label-tables.mjs` 完全相同，見那一支的檔頭。
//
// **掃描範圍＝`src/**/*.{ts,tsx}` 減 `*.test.*`、`src/test/**`、`src/lib/**`，再把
// `src/lib/notificationStore.ts` 收回來。** `src/lib/` 整個排除的理由是**它自己就是錯誤翻譯
// 管線的家**（`utils.ts` 是契約本體；`error-messages.ts` 與 `notification-text.ts` 讀的是
// 伺服器 body 的 `message` **欄位**，不是 `Error.message`）。但**排除規則不准吞掉 sink**，
// 所以那一支單獨收回來。這是**範圍宣告**，不是跳略規則。
// `src/i18n/**` **不排除**（`i18next-parser` 排除它是因為它不准**定義**文案，理由不轉移）。
// `scripts/` 不在範圍——閘門自己就要寫 `.message` 這個字串。
//
// **認不得就大聲（屋規）**：`ts.createSourceFile` **不拋錯**，它把問題放進 `parseDiagnostics`。
// 實測：一個壞檔（`const b = ;`）**仍數得到錯誤點之前的 `.message` 節點** ⇒
// **「數到節點」不是「讀過這個檔」的證據**。所以任一檔案的 `parseDiagnostics` 非空一律 exit 1、
// 指名該檔，**不靜默跳過那個檔**（那會讓「掃不到」看起來像「沒問題」）。
// `ts.getParseDiagnostics` **不存在**（實測 `undefined`，不是公開 API）⇒ 讀 `sf.parseDiagnostics`，
// 並用 `in` 檢查它在不在——少了這道，未來 TS 改個名會**靜默關掉整個 bail**。
// 認不得的副檔名（`src/` 底下的 `.js`／`.jsx`／`.mjs`／`.cjs`）同樣 bail。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const scanDir = join(webRoot, "src");

/** 認不得的「看起來像程式碼」的副檔名——遇到就 bail，不靜默跳過。 */
const UNPARSABLE = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** `src/lib/` 依宣告排除，但這一支是 sink，單獨收回來。 */
const REINCLUDED = "lib/notificationStore.ts";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * 範圍宣告（見檔頭）。`rel` 是相對 `src/` 的路徑，例如 `pages/board/CardPage.tsx`。
 * 回傳 "scan" | "skip" | "bail"。
 */
function classify(rel) {
  if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return "skip";
  if (rel.startsWith("test/")) return "skip";
  if (rel.startsWith("lib/") && rel !== REINCLUDED) return "skip";
  if (rel.endsWith(".ts") || rel.endsWith(".tsx")) return "scan";
  const ext = rel.slice(rel.lastIndexOf("."));
  if (UNPARSABLE.has(ext)) return "bail";
  return "skip"; // .json／.md 這一類本來就不是程式碼
}

// .tsx 走 TSX、.ts 走 TS：`<T>(x)` 這種斷言在 TSX 下會被讀成 JSX。
const scriptKindOf = (rel) => (rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** t 或 i18n.t。 */
function isTranslateCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "t";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "t" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "i18n"
  );
}

/**
 * 豁免若且唯若**最近的**外層 `CallExpression` 的 callee 是 `console.<name>`。
 * 所以 `console.error(e.message)` 綠，而 `const m = e.message; console.error(m)` **紅**
 * ——後者的讀取點根本不是 console 的引數（往上走只會走到區塊，那個 CallExpression 是兄弟）。
 */
function isConsoleArgument(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (!ts.isCallExpression(n)) continue;
    const callee = n.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "console"
    );
  }
  return false;
}

const detail = (source, node, file) => {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, text: source.getFullText().split("\n")[line].trim() };
};

const ruleA = [];
const ruleB = [];
const unreadable = [];
let scanned = 0;

for (const file of walk(scanDir)) {
  const relFromSrc = relative(scanDir, file).replaceAll("\\", "/");
  const verdict = classify(relFromSrc);
  if (verdict === "skip") continue;
  const rel = `src/${relFromSrc}`;
  if (verdict === "bail") {
    unreadable.push(`${rel} 的副檔名不在掃描器認得的範圍（只認 .ts／.tsx）`);
    continue;
  }

  scanned += 1;
  const source = ts.createSourceFile(rel, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, scriptKindOf(relFromSrc));

  if (!("parseDiagnostics" in source)) {
    unreadable.push(`${rel}：這個版本的 typescript（${ts.version}）不再提供 parseDiagnostics，掃描器無法確認它讀完整個檔`);
    continue;
  }
  if (source.parseDiagnostics.length > 0) {
    const first = source.parseDiagnostics[0];
    const { line } = source.getLineAndCharacterOfPosition(first.start ?? 0);
    unreadable.push(`${rel}:${line + 1} 有語法錯誤（${ts.flattenDiagnosticMessageText(first.messageText, " ")}）`);
    continue;
  }

  const visit = (node) => {
    // ── 規則 A ────────────────────────────────────────────────────────────
    let messageNode = null;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "message") {
      messageNode = node;
    } else if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "message"
    ) {
      messageNode = node;
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && key.text === "message") messageNode = node;
    }
    if (messageNode !== null && !isConsoleArgument(messageNode)) {
      ruleA.push(detail(source, messageNode, rel));
    }

    // ── 規則 B ────────────────────────────────────────────────────────────
    if (isTranslateCall(node)) {
      for (const arg of node.arguments) {
        // 從引數本身開始測（`t(t("x"))` 的引數就是內層），再往下走它整棵子樹。
        const inner = (child) => {
          if (isTranslateCall(child)) ruleB.push(detail(source, child, rel));
          ts.forEachChild(child, inner);
        };
        inner(arg);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

const dedupeByLine = (hits) => {
  const seen = new Set();
  return hits
    .filter((h) => {
      const id = `${h.file}:${h.line}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};

const list = (hits) => hits.map((h) => `  - ${h.file}:${h.line}  ${h.text}`).join("\n");

if (unreadable.length > 0) {
  console.error("錯誤路徑檢查無法完成——掃描器遇到它認不得的形狀（本檢查不猜）：\n");
  for (const message of unreadable) console.error(`  - ${message}`);
  console.error(
    "\n這代表有檔案**沒有被讀過**，而它裡面可能有本檢查要抓的東西。\n" +
      "請修正語法錯誤，或把該檔改成 .ts／.tsx，或更新這支掃描器。",
  );
  process.exit(1);
}

const a = dedupeByLine(ruleA);
const b = dedupeByLine(ruleB);

if (a.length > 0) {
  console.error(`錯誤路徑直讀傳輸層字串（.message）：${a.length} 處\n`);
  console.error(list(a));
  console.error(
    "\naxios 的 `Error.message` 是傳輸層字串（`Request failed with status code 400`），" +
      "不是伺服器說的任何一句話。錯誤物件請走 `apiErrorMessage(error, fallback)`" +
      "（`@/lib/utils`）——它會先查後端錯誤碼的譯文，查不到才退回那個字串。\n" +
      "開發者面向的診斷請印整個 error 物件：`console.error(\"…\", error)`（這一種本檢查放行）。",
  );
}

if (b.length > 0) {
  console.error(`巢狀 t()：i18next-parser 抽不到內層，該 key 會從語系檔被刪掉：${b.length} 處\n`);
  console.error(list(b));
  console.error(
    "\n`keepRemoved: false` 會把「原始碼裡找不到」的 key 從語系檔刪掉，畫面只顯示 key 本身" +
      "——`tsc -b`、vitest、parity 全都不會紅。\n" +
      "請把內層提成一個陳述式（放在 **render 裡**，不要提到模組層級——那會凍結當下的語系）。",
  );
}

if (a.length > 0 || b.length > 0) process.exit(1);

console.log(`錯誤路徑檢查通過：${scanned} 個前端原始檔中，無 .message 直讀、無巢狀 t()。`);
