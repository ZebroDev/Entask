// 標籤表契約鎖的抽取層：吃**原始碼字串**，回傳結構（或拋 LabelTableParseError）。
//
// 為什麼要抽成一個模組（2026-09-17，Task 8 fix round 2）：
//
// `check-label-tables.mjs` 原本自己帶著四條定位器，而它們全都是「對原始碼做 match，
// 然後假設命中是活碼」。每一次被指出一個靜默放行的形狀，修法都是在同一條近似上再加一層
// 啟發式——2026-09-17 的 fix round 1 就是這樣：新增的 `skipNonCode`（逐字元跳略註解／
// 字串）關掉了「宣告在註解裡被判成活碼」的洞，卻在**反方向**開了一個同型的新洞（D1：
// 正則字面值裡的 `'` 被當成字串開頭 ⇒ 活宣告被跳過 ⇒ 假字串在註解內的撇號收尾 ⇒
// 解析在註解內部恢復 ⇒ 註解裡的死副本被判成活碼）。實測：**同一個輸入在修正前 exit 1、
// 修正後 exit 0**，而活函式指向一個不存在的 key。
//
// ⇒ 判準（見 AGENTS.md）：「沒有收尾一律 fail closed」擋不住「收了尾但收錯地方」。
// 啟發式的跳略規則只會在大聲與靜默之間選一邊，而**錯的方向決定一切**。所以 `.ts`／`.tsx`
// 這一側改用 TypeScript 的 compiler API 取節點——註解與字串在 AST 裡**不是節點**，
// 整類「這個字元在不在程式碼裡」的近似一次退場。
//
// `.cs` 這一側沒有現成的 parser（`typescript` 是這個 package 唯一的相關 devDependency，
// 不新增 runtime 依賴），所以是**自己寫的 C# 口味掃描器**：把它認得的構件（`//`、
// `/* */`、`"…"`、`@"…"`、`$"…"`、`$@"…"`、`'c'`、C# 11 的原始字串 `"""…"""`——最後一項
// 自 2026-09-18 起）遮成空白之後才跑形狀比對，
// **認不得的構件一律 fail closed**（**內插的**原始字串 `$"""…"""`、前置處理器指示詞）。
// 但那句話**有前提**（Task 8 fix round 3 的 F1 更正）：這支掃描器的保證只及於**可編譯的
// C#**——未收尾的引號只在**落單（奇數）**時才會一路走到檔尾而拋錯，成對時兩者會配成一個
// 「合法」的字面值，於是中間的活宣告被靜默吃掉。逐條與「為什麼可以接受」見 `maskCSharp`。
// 為什麼不能共用 JS 口味的跳略：兩者的轉義規則相反——JS 的 `\` 是轉義，
// C# 的**逐字字串裡不是**，合成樣本 `public const string LogRoot = @"C:\logs\";`
// 會讓 JS 口味在 `\"` 之後少收一次引號、級聯把後面 3 個宣告全判成非程式碼
// （fix round 1 的 scoped re-review B3 實測 3/3）。
//
// 三個呼叫端（`check-label-tables.mjs`、`check-query-filter-exceptions.mjs`——2026-09-18 起，
// 它只用 `maskCSharp`——與 `label-table-extract.test.mjs`）共用同一份碼：
// 測試在記憶體裡餵字串，CLI 讀檔。**這支模組不讀任何檔案**（讀檔與讀語系 JSON 都在呼叫端）。

import ts from "typescript";

/** 抽取失敗。訊息就是給人看的那一行（呼叫端直接記進錯誤清單，不再包一層）。 */
export class LabelTableParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "LabelTableParseError";
  }
}

const bail = (message) => {
  throw new LabelTableParseError(message);
};

/** `.tsx` 走 TSX，`.ts` 走 TS。TSX 對多數 `.ts` 安全，但 `<T>(x)` 這種斷言會被讀成 JSX。 */
function scriptKindOf(fileName) {
  if (typeof fileName !== "string") return ts.ScriptKind.TSX;
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function parse(fileName, source) {
  return ts.createSourceFile(
    fileName ?? "inline.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindOf(fileName),
  );
}

const lineNumberAt = (sourceFile, pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

/** 找出具名函式的本體節點：`function X(…) {…}` 或 `const X = (…) => {…}`。 */
function findFunctionBody(sourceFile, name) {
  let found;
  const visit = (node) => {
    if (found !== undefined) return;
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === name) {
      found = node;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const init = node.initializer;
      if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        found = init;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found === undefined ? undefined : found.body;
}

/** `t(…)` 或 `i18n.t(…)`——兩種都是動態 key 的合法寫法（後者見 `CardActivityTab`）。 */
function isTranslateCall(expr) {
  if (ts.isIdentifier(expr)) return expr.text === "t";
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "t" && ts.isIdentifier(expr.expression) && expr.expression.text === "i18n";
  }
  return false;
}

/**
 * 翻譯呼叫的引數是不是標籤表要的形狀：第一個引數是字串字面值，後面最多一個**識別碼**
 * （`t("error:x", params)`——值是帶佔位名的訊息，見 check-label-tables.mjs 的第八張表）。
 *
 * `t("a", { … })` 不在此列：物件字面值的引數會被判成「不是這個形狀」而整條 case 落空。
 * **落空的方向不是靜默——但前提是那個值本來就在後端集合裡**：檢查 1 會大聲報出
 * 「後端有、前端沒有」。值不在後端集合裡的那種落空（本來就是死 case）對檢查 1–8 全部
 * 隱形，這條路徑上沒有守門員（Task 8 fix round 3 自檢補記；與 `selectItems` 的子節點數
 * 放寬會造成的隱形是同一種形狀）。
 */
function translateKeyOf(call) {
  const args = call.arguments;
  if (args.length === 0 || args.length > 2) return undefined;
  if (!ts.isStringLiteral(args[0])) return undefined;
  if (args.length === 2 && !ts.isIdentifier(args[1])) return undefined;
  return args[0].text;
}

/** `case "值": return t("key");`。`pos` 是 **case 關鍵字**的位置（行號的來源）。 */
function casePairOf(clause, sourceFile) {
  if (!ts.isStringLiteral(clause.expression)) return undefined;
  const stmt = clause.statements[0];
  if (stmt === undefined || !ts.isReturnStatement(stmt)) return undefined;
  const ret = stmt.expression;
  if (ret === undefined || !ts.isCallExpression(ret)) return undefined;
  if (!isTranslateCall(ret.expression)) return undefined;
  const key = translateKeyOf(ret);
  if (key === undefined) return undefined;
  return { value: clause.expression.text, key, pos: clause.getStart(sourceFile) };
}

/** `<SelectItem value="值">{t("key")}</SelectItem>`。`pos` 是 `<` 的位置。 */
function selectItemPairOf(jsx, sourceFile) {
  const open = jsx.openingElement;
  if (open.tagName.getText(sourceFile) !== "SelectItem") return undefined;
  let value;
  for (const attr of open.attributes.properties) {
    if (
      ts.isJsxAttribute(attr) &&
      attr.name.getText(sourceFile) === "value" &&
      attr.initializer !== undefined &&
      ts.isStringLiteral(attr.initializer)
    ) {
      value = attr.initializer.text;
    }
  }
  if (value === undefined) return undefined;
  // 子節點必須**恰好**是一個 `{t("key")}`：`{/* 註解 */}`、純文字、多個運算式都不算，
  // 與舊版正則的 `\{t\("…"\)\}` 同義。
  const meaningful = jsx.children.filter((c) => !(ts.isJsxText(c) && c.text.trim() === ""));
  if (meaningful.length !== 1) return undefined;
  const child = meaningful[0];
  if (!ts.isJsxExpression(child) || child.expression === undefined || !ts.isCallExpression(child.expression)) {
    return undefined;
  }
  if (!isTranslateCall(child.expression.expression)) return undefined;
  const key = translateKeyOf(child.expression);
  if (key === undefined) return undefined;
  return { value, key, pos: jsx.getStart(sourceFile) };
}

/**
 * 前端標籤表的「值 → key」對照。回傳 `{ pairs, scopeLine }`，每一筆帶
 * `{ value, key, line, scope }`——診斷訊息要指到**行號**（一支檔案裝兩張表時，
 * 光有檔名分不出是哪一張）。
 *
 * `shape`：`"switch"`（預設）掃 `case "值": return t("key");`；`"selectItems"` 掃 JSX 選單。
 * `scope`：只對 switch 有意義，把掃描範圍縮到該函式的本體。
 *
 * **宣告只在註解裡／在字串裡時，AST 根本看不到那個節點**，所以 `scope` 找不到本體
 * 一律失敗（fail closed）——這正是舊版要花一整段啟發式去逼近、而 D1 證明逼近不住的事。
 */
export function extractLabelTable(source, { label, fileName, shape = "switch", scope } = {}) {
  const sourceFile = parse(fileName ?? label, source);
  if (shape === "selectItems") {
    const pairs = [];
    const visit = (node) => {
      if (ts.isJsxElement(node)) {
        const p = selectItemPairOf(node, sourceFile);
        if (p !== undefined) pairs.push({ value: p.value, key: p.key, line: lineNumberAt(sourceFile, p.pos), scope: null });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    if (pairs.length === 0) {
      bail(
        `${label} 解析不到任何「<SelectItem value="值">{t("key")}</SelectItem>」——` +
          `若該選單改成別種寫法（例如從後端清單 map 出來），這道檢查會失去守備範圍，請一併更新本檔的 TABLES。`,
      );
    }
    return { pairs, scopeLine: null };
  }

  let region = sourceFile;
  let scopeLine = null;
  if (scope !== undefined && scope !== null) {
    const body = findFunctionBody(sourceFile, scope);
    if (body === undefined || body === null || !ts.isBlock(body)) {
      bail(
        `${label} 找不到 ${scope} 的本體（TABLES 的 scope 指名的函式）——` +
          `改名或改寫之後這一張表的守備範圍會變成空的，請一併更新本檔的 TABLES。` +
          `（宣告**只出現在註解或字串裡**時也走這一條：AST 看不到那些位置上的宣告，` +
          `見本檔開頭的說明。）`,
      );
    }
    region = body;
    scopeLine = lineNumberAt(sourceFile, body.getStart(sourceFile));
  }
  const pairs = [];
  const visit = (node) => {
    if (ts.isCaseClause(node)) {
      const p = casePairOf(node, sourceFile);
      if (p !== undefined) {
        pairs.push({ value: p.value, key: p.key, line: lineNumberAt(sourceFile, p.pos), scope: scope ?? null });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(region, visit);
  if (pairs.length === 0) {
    // 有 `scope` 時，「一條 case 都沒有」有兩個成因，訊息要分得開：這個函式真的不是
    // switch，或者它的本體不是 block（`=> t("x")` 這種簡潔本體）。兩者都 fail closed。
    bail(
      scope !== undefined && scope !== null
        ? `${label} 的 ${scope} 本體裡一條「case "值": return t("key")」都沒有。` +
            `若不是這個函式已經改成查表（那會讓這道檢查與 i18next-parser 同時失效，` +
            `請先讀 i18next-parser.config.js 的說明），就是本體不是 block——` +
            `AST 版的 scope 只認 function 宣告與函式運算式／箭頭函式的 block 本體。` +
            `請確認 ${scope} 的宣告形狀。`
        : `${label} 解析不到任何「case "值": return t("key")」——` +
            `若該表改成查表（而非 switch），這道檢查與 i18next-parser 會同時失效，請先讀 i18next-parser.config.js 的說明。`,
    );
  }
  return { pairs, scopeLine };
}

/** 去掉 `as const`／`satisfies T`／括號，取裡面的運算式。 */
function unwrap(expr) {
  let e = expr;
  while (
    e !== undefined &&
    (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e))
  ) {
    e = e.expression;
  }
  return e;
}

/** 找出 `export const <name> = …` 的初始值。 */
function findExportedConst(sourceFile, name) {
  let init;
  const visit = (node) => {
    if (init !== undefined) return;
    if (ts.isVariableStatement(node) && (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          init = decl.initializer;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return init;
}

/** 該檔裡 `export const <name> = [...]` 的字串元素（同一份清單的第二個副本）。 */
export function extractArrayConst(source, { label, fileName, name } = {}) {
  const sourceFile = parse(fileName ?? label, source);
  const arr = unwrap(findExportedConst(sourceFile, name));
  if (arr === undefined || !ts.isArrayLiteralExpression(arr)) {
    bail(`${label} 找不到 ${name} 的陣列字面值——請確認它仍是 export const ${name} = [...]。`);
  }
  return arr.elements.map((el, index) => {
    if (!ts.isStringLiteral(el)) {
      // 舊版把中括號內的**所有** `"…"` 撈出來，展開或變數會被靜默丟掉。這裡不猜。
      // 訊息帶行號與索引（Task 8 fix round 3 的 Info-1）：同檔可能有第二份同名宣告，
      // 只給檔名的訊息沒辦法回答「是哪一個」。
      bail(
        `${label}:${lineNumberAt(sourceFile, el.getStart())} 的 ${name} 陣列第 ${index} 個元素` +
          `不是字串字面值——本檢查不猜（請把該元素展開成字面值）。`,
      );
    }
    return el.text;
  });
}

/**
 * 行首 `#` 的放行清單：**判準是「這個指示詞會不會改變『哪一段是活的』」**，不是「常不常見」。
 * `#nullable` 只影響可為 null 的分析、`#region`／`#endregion` 只是折疊標記、
 * `#pragma`（這裡出現的是 `warning disable／restore 612, 618`）只影響診斷訊息——三者都不會
 * 讓某一段程式碼變成活的或死的。`#if`／`#elif`／`#else`／`#endif`／`#define`／`#undef`
 * 會，`#line`／`#error`／`#warning` 不在判準的正面清單裡（罕見，且沒有理由現在放行），
 * 一律 fail closed。清單有變動時，上面那段說明與 test 檔要一起改。
 */
const TRANSPARENT_DIRECTIVES = new Set(["nullable", "region", "endregion", "pragma"]);

/**
 * C# 掃描器：把認得的**非程式碼構件**遮成空白（換行保留，行號才不會跑掉），
 * 回傳 `{ masked, strings }`——`strings` 是「開引號的位置 → `{ value, end }`」。
 *
 * 認得：行註解、區塊註解（斜線星號那一對，這裡刻意不寫出字面以免提前收尾本註解）、
 * `"…"`（`\` 轉義）、`@"…"`（`""` 代表一個引號）、
 * `$"…"`（`{{`／`}}` 轉義，`{…}` 的洞遞迴當程式碼掃）、`'c'`、
 * **C# 11 的原始字串**（`"""…"""`，引號可以更多；2026-09-18 起，見下）。
 * **認不得的一律 fail closed**（拋 LabelTableParseError）：
 *   - **有洞的**逐字內插字串（`$@"…{…}…"`／`@$"…{…}…"`）——**2026-09-18 fix round 2**。
 *     上面那行原本把 `$"`／`$@"`／`@$"` 寫成同一種、說三者的洞都遞迴當程式碼掃，**逐字那兩者
 *     從來沒有**：洞的處理在 `readString` 的非逐字分支（逐字分支在它前面就 `continue` 掉了）
 *     ⇒ `{…}` 被當成內容整段遮掉、**沒有例外**，而 `$@"{db.Cards.IgnoreQueryFilters()}"` 正是
 *     本閘門要抓的那一行。曝險是 0（`grep -rn --include=*.cs -e '\$@"' -e '@\$"' src/ tests/`
 *     無命中），所以選擇**大聲**而不是補一組洞的解析：本檔的契約是「可編譯的 C# 上正確或
 *     大聲、絕不靜默猜」，而這支掃描器的近似史就是「在下一個沒想到的輸入上換方向」。
 *     **沒有洞的**逐字內插字串照常遮掉（`$@""""` 也在這一類）。
 *   - **內插的**原始字串（`$"""…"""`／`$$"""…"""`）：有幾個 `$` 決定幾個 `{` 才算洞，
 *     「整段遮掉」對它並不正確（洞裡是程式碼）⇒ 大聲。**實查：今天 `src/` 的原始字串
 *     每一處開引號前都沒有 `$`**（`grep -rn '"""' src/ --include=*.cs` 逐行看）。
 *   - 行首的 `#`，但**只放行不影響「哪一段是活的」的那幾個**（見 `TRANSPARENT_DIRECTIVES`：
 *     遮成空白、不 fail closed）。`#if`／`#define` 這類**條件編譯**會讓「哪一段才是活的」
 *     取決於編譯常數，那不是這支腳本猜得出來的 ⇒ fail closed。
 *     **實查（2026-09-18，軟刪除 T4）**：`src/` 今天只有兩種指示詞——`#nullable disable`
 *     與 `#pragma warning disable／restore`，**全部落在 EF 產生的 migration／snapshot**，
 *     其他 `.cs`（含 12 張標籤表受檢的那 9 支）一個都沒有。放行它們是**閘門的前提**：
 *     `check-query-filter-exceptions.mjs` 掃整個 `src/`，而那些檔開頭就是 `#nullable disable`
 *     ——不放行的話閘門對每一個 migration 檔拋錯，整支跑不動（實測：不放行時 39 個檔拋錯）。
 *     **這是收斂不是開放**：清單外的（含 `#line`／`#error`）仍然 fail closed。
 *
 * **原始字串為什麼從「不解析」改成「遮掉」（2026-09-18，審查者軟刪除 T4 的 R8）**：
 * 舊契約是「遇到 `"""` 就 fail closed」，而 `src/` 今天有三個檔用到它（`ProjectEndpoints.cs`
 * 是單行、兩支 migration 是多行），於是新加的查詢篩選閘門（`check-query-filter-exceptions.mjs`）
 * 整支掃不動——那個閘門要的是**遮罩**，不是「掃到的每一支檔都拋錯」。做法是**整段（含內容）
 * 遮成空白**、**不進 `strings`**：原始字串的值要按收尾引號的縮排逐行去縮排，本掃描器不做，
 * 而消費端拿不到值時是**大聲**的（`extractBackendValues` 遇到
 * `public const string X = """…"""` 會拋「不是字面值字串」，不是靜默少一筆）。
 * 收尾的判準是「**引號數 ≥ 開引號數**的那一串引號」——單行與多行共用同一個規則。
 * **這條近似之所以等價，靠的是編譯器的 CS9000**（「原始字串常值分隔符號必須位於自己的行」／
 * the delimiter must be on its own line，2026-09-18 以 SDK 10.0.400 實測）：任何長度夠的
 * 引號串**就是**分隔符號，而 CS9000 要求它自成一行的開頭——所以「行中的」與「行首但後面還有
 * 別的程式碼」兩種形態都是**編譯錯誤**，可編譯的 C# 裡不會有內容的引號串先達到那個長度。
 * 實測：`"""` 開、內容有一行 `a """ b` ⇒ 錯誤回報在**那一行**（CS9000）。
 * **不要**把這條寫成「收尾引號是該行第一個非空白字元」——那只是必要條件，不是規則本身
 * （收尾那一行後面接著 `;`／`,`／`+ "x"` 都是合法的，見 test 檔的行首帶尾註測試）。
 * **未收尾的原始字串仍然 fail closed**（一路掃到檔尾就拋錯）。
 *
 * **上面那句「認不得的一律 fail closed」只在引號落單（奇數）時成立**（Task 8 fix round 3
 * 的 F1 更正，實查）：fail closed 的判準是「這個字面值一路讀到檔尾（字元字面值則是換行）
 * 都沒收尾」。一個未收尾的 `"` 會走到檔尾 ⇒ 拋錯；但同樣未收尾的 `"` **有兩個（偶數）**
 * 時，兩者會兩兩配對成一個「合法」的字串 ⇒ 中間的程式碼全部被遮成空白，於是**本文完全
 * 正常的活宣告被靜默吃掉**（實測：`public const string First` 與 `Last` 之間夾兩個未收尾的
 * `"` ⇒ 回 `["first"]`、沒有錯誤、閘門 exit 0）。字元字面值同理，但只在**同一行**內配得
 * 起來（`readChar` 碰到換行就拋錯）。
 * 區塊註解沒有這條縫（`/*` 沒收尾必然走到檔尾）。
 *
 * 為什麼可以接受這一點：那個前提是**該檔不是合法的 C#**（C# 不接受跨行的非逐字字串），
 * 而 `dotnet build -c Release` 會擋下它 ⇒ 這種輸入到不了全綠。**不要**把這條讀成
 * 「任何輸入都會大聲」：這支掃描器的保證只及於**可編譯的 C#**，釘住這個邊界的是 test 檔
 * 那支「未收尾且成對 ⇒ 已知限制」。
 * 措辭更正（Task 8 fix round 3 的 Minor-1／2）：原本寫「**CI 的 backend job** 對同一個
 * commit 跑 `dotnet build -c Release` ⇒ 到不了『**CI** 全綠』」。指令與結論都對，但那句話
 * 暗指 CI 是一道會先響的閘門——`.github/workflows/ci.yml` 裡 `needs:` 出現 **0 次**
 * （兩個 job 平行，沒有「先」），而且**這個 checkout 沒有 remote**，workflow 今天根本
 * 不會被觸發。真正在擋的是**本機**的 build。
 */
export function maskCSharp(source, label) {
  const masked = source.split("");
  const lineOf = (at) => source.slice(0, at).split("\n").length;
  const blank = (from, to) => {
    for (let i = from; i < to && i < masked.length; i++) {
      if (masked[i] !== "\n" && masked[i] !== "\r") masked[i] = " ";
    }
  };

  /** 某個位置是不是可以開一個字串；回傳 `{ quoteIndex, verbatim, interp }` 或 null。 */
  const stringStart = (i) => {
    const c = source[i];
    if (c === '"') return { quoteIndex: i, verbatim: false, interp: false };
    if (c === "@" && source[i + 1] === '"') return { quoteIndex: i + 1, verbatim: true, interp: false };
    if (c === "$" && source[i + 1] === '"') return { quoteIndex: i + 1, verbatim: false, interp: true };
    if (c === "$" && source[i + 1] === "@" && source[i + 2] === '"') {
      return { quoteIndex: i + 2, verbatim: true, interp: true };
    }
    if (c === "@" && source[i + 1] === "$" && source[i + 2] === '"') {
      return { quoteIndex: i + 2, verbatim: true, interp: true };
    }
    return null;
  };

  const strings = new Map();

  /**
   * `'c'`：字元字面值（**受檢的 9 個 `.cs` 檔裡**唯一一處是 `PermissionCategories.cs:33`
   * 的 `code.IndexOf('.')`；repo 別處還有 `';'`／`'\t'` 這類，只是沒有表掃它們）。
   */
  const readChar = (i) => {
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === "\\") {
        j += 2;
        continue;
      }
      if (source[j] === "'") {
        blank(i, j + 1);
        return j + 1;
      }
      if (source[j] === "\n") break;
      j++;
    }
    bail(`${label}:${lineOf(i)} 的字元字面值沒有收尾——本檢查不猜（fail closed）。`);
    return i;
  };

  /**
   * C# 11 的原始字串字面值（`"""…"""`）：**整段（含前綴與內容）遮成空白**，回傳收尾之後的
   * 第一個索引。收尾＝第一串**長度 ≥ 開引號數**的引號；非內插的形態下這與 C# 的規則等價
   * ——靠的是 **CS9000**（分隔符號必須自成一行的開頭）與「內容不得含長度足夠的引號串」
   * 這兩條編譯器規則（實測見檔頭）。
   *
   * 呼叫端只在 `!verbatim`（原始字串不可能有 `@` 前綴）且引號數 ≥ 3 時進來；
   * 內插的形態（`$"""`／`$$"""`）在這裡 fail closed。
   *
   * `quotes` 是開引號的個數（`"""` 是 3，`""""` 是 4）。
   */
  const readRawString = (i, s, quotes) => {
    if (s.interp) {
      bail(
        `${label}:${lineOf(s.quoteIndex)} 含內插的原始字串字面值（\`$"""\`）——有幾個 \`$\` 決定` +
          `幾個 \`{\` 才算洞，本檢查不解析它（洞裡是程式碼，整段遮掉會是靜默）。` +
          `請改寫該檔，或更新 web/scripts/lib/label-table-extract.mjs 的 C# 掃描器。`,
      );
    }
    const open = s.quoteIndex;
    let j = open + quotes;
    while (j < source.length) {
      if (source[j] !== '"') {
        j++;
        continue;
      }
      let run = 0;
      while (source[j + run] === '"') run++;
      if (run >= quotes) {
        const end = j + quotes;
        blank(i, end);
        return end;
      }
      j += run;
    }
    bail(`${label}:${lineOf(open)} 的原始字串字面值沒有收尾——本檢查不猜（fail closed）。`);
    return i;
  };

  /**
   * 讀一個字串字面值：回傳結束後的第一個索引（**非逐字**內插字串的洞不遮，只有字面部分遮）。
   * **逐字**內插字串（`$@"…"`／`@$"…"`）的洞沒有處理，遇到就 fail closed——見檔頭那條。
   */
  const readString = (i) => {
    const s = stringStart(i);
    if (s === null) bail(`${label} 內部錯誤：位置 ${i} 不是字串的開頭。`);
    let quotes = 0;
    while (source[s.quoteIndex + quotes] === '"') quotes++;
    // `!s.verbatim` 不是防禦性條件，是正確性條件（2026-09-18，T4 fix round 1 的 Important）：
    // 原始字串**不可能**有 `@` 前綴，而逐字字串的內容**可以**以引號開頭（`@""""` 的值是一個
    // `"`，合法 C#）。少了這個守衛，`@""""` 會被誤判成原始字串 ⇒ 一路找到**下一個**同樣的
    // 字面值才收尾 ⇒ 中間的活程式碼整段被靜默遮掉（該檔是完全合法的 C#）。實測：兩個
    // `@""""` 之間夾一個 `IgnoreQueryFilters()` 時，遮罩後那一行消失 ⇒ 本閘門看不到它。
    // 有守衛時它走下面的逐字分支：`""` 是轉義的引號，讀法正確。
    if (quotes >= 3 && !s.verbatim) return readRawString(i, s, quotes);
    let j = s.quoteIndex + 1;
    let value = "";
    let contentFrom = j;
    const flush = (to) => {
      blank(contentFrom, to);
      contentFrom = to;
    };
    while (j < source.length) {
      const ch = source[j];
      if (s.verbatim) {
        if (ch === '"') {
          if (source[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          flush(j);
          if (!s.interp) strings.set(s.quoteIndex, { value, end: j + 1 });
          return j + 1;
        }
        // 逐字內插字串（`$@"…"`／`@$"…"`）的洞：**這裡沒有洞的解析**（非逐字的那條在下面），
        // 照舊往下走的話 `{` 會被當內容整段遮掉——靜默，正是本檔禁止的方向。
        // `{{` 是**轉義**（逐字的轉義規則與非逐字者相同），對配對的第一個 `{` 大聲會是普通
        // 字串上的假警報，所以先吃掉它。單一個 `}` 開不了洞（也不需要轉義判準以外的處理），
        // 所以這裡只認 `{`——不要為了對稱補上 `}` 的分支。
        // 今天 `src/`／`tests/` 的曝險是 0，大聲的代價因此是零（見檔頭）。
        if (s.interp && ch === "{") {
          if (source[j + 1] === "{") {
            value += "{";
            j += 2;
            continue;
          }
          bail(
            `${label}:${lineOf(s.quoteIndex)} 含內插的逐字字串字面值（\`$@"…"\`／\`@$"…"\`）——` +
              `洞裡是程式碼，本檢查不解析它（整段遮掉會是靜默）。` +
              `請改寫該檔，或更新 web/scripts/lib/label-table-extract.mjs 的 C# 掃描器。`,
          );
        }
        value += ch;
        j++;
        continue;
      }
      if (ch === "\\") {
        value += source[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (ch === '"') {
        flush(j);
        if (!s.interp) strings.set(s.quoteIndex, { value, end: j + 1 });
        return j + 1;
      }
      if (s.interp && ch === "{" && source[j + 1] === "{") {
        value += "{";
        j += 2;
        continue;
      }
      if (s.interp && ch === "}" && source[j + 1] === "}") {
        value += "}";
        j += 2;
        continue;
      }
      if (s.interp && ch === "{") {
        // 洞：遞迴當程式碼掃到配對的 `}`。洞裡可以有字串（`$"{d["k"]}"`），
        // 所以走的是同一個 readString／readChar。
        flush(j);
        let depth = 0;
        j++;
        while (j < source.length) {
          const c2 = source[j];
          if (c2 === '"' || c2 === "@" || c2 === "$") {
            const inner = stringStart(j);
            if (inner !== null) {
              j = readString(j);
              contentFrom = j;
              continue;
            }
          }
          if (c2 === "'") {
            j = readChar(j);
            contentFrom = j;
            continue;
          }
          if (c2 === "/" && source[j + 1] === "/") {
            const nl = source.indexOf("\n", j);
            j = nl < 0 ? source.length : nl;
            continue;
          }
          if (c2 === "/" && source[j + 1] === "*") {
            const e = source.indexOf("*/", j + 2);
            if (e < 0) bail(`${label}:${lineOf(j)} 的區塊註解沒有收尾——本檢查不猜（fail closed）。`);
            j = e + 2;
            continue;
          }
          if (c2 === "{") depth++;
          else if (c2 === "}" && depth === 0) {
            j++;
            break;
          } else if (c2 === "}") depth--;
          j++;
        }
        contentFrom = j;
        continue;
      }
      value += ch;
      j++;
    }
    bail(`${label}:${lineOf(s.quoteIndex)} 的字串字面值沒有收尾——本檢查不猜（fail closed）。`);
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "#" && /(^|\n)[ \t]*$/.test(source.slice(0, i))) {
      const directive = /^#([A-Za-z]+)/.exec(source.slice(i))?.[1];
      if (directive !== undefined && TRANSPARENT_DIRECTIVES.has(directive)) {
        // 整行遮掉（指示詞後面接的是名稱／參數，不是程式碼）。
        const nl = source.indexOf("\n", i);
        const end = nl < 0 ? source.length : nl;
        blank(i, end);
        i = end;
        continue;
      }
      bail(
        `${label}:${lineOf(i)} 含前置處理器指示詞` +
          `${directive === undefined ? "" : ` \`#${directive}\``}——本檢查只放行不影響「哪一段是活的」` +
          `的那幾個（${[...TRANSPARENT_DIRECTIVES].map((d) => `#${d}`).join("／")}）；` +
          `\`#if\` 這類條件編譯猜錯的方向是靜默。請改寫該檔，或更新本檔的 C# 掃描器。`,
      );
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl < 0 ? source.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const e = source.indexOf("*/", i + 2);
      if (e < 0) bail(`${label}:${lineOf(i)} 的區塊註解沒有收尾——本檢查不猜（fail closed）。`);
      blank(i, e + 2);
      i = e + 2;
      continue;
    }
    if (stringStart(i) !== null) {
      i = readString(i);
      continue;
    }
    if (c === "'") {
      i = readChar(i);
      continue;
    }
    i++;
  }
  return { masked: masked.join(""), strings };
}

/**
 * 後端常數的值集合（`.cs`）。**在它認得的形狀裡**，解析不到或值不是字面值一律拋錯——
 * 呼叫端據此**跳過該表的其餘檢查**（不跳過的話，空集合會被當成「後端什麼都沒有」，
 * 每一個 case 都各自再報一次「後端沒有這個常數」，噪音蓋掉唯一有意義的那一行）。
 * **前提：只掃 `public const string`**（Task 8 fix round 3 的自檢補記）。`internal const
 * string`／`static readonly string` 這類宣告形狀**不在守備範圍、也不會拋錯**——它們只是
 * 不出現在期望集合裡（實測：`internal const string A = "a";` ＋ `public const string B =
 * "b";` 回 `["b"]`；整個檔一條都沒有時才會拋「解析不到任何」）。少了的那個值若前端還在
 * 用，檢查 2（前端有、後端沒有）會大聲——**不要**把上面那句讀成「任何認不得的宣告形狀
 * 都會拋錯」。
 *
 * `arrayName` 給定時，來源改成該檔裡的 `public static readonly string[] <arrayName> = [...]`，
 * 再把陣列裡的識別碼逐一帶回同一檔的 `public const string`（R8：審查表單的立場選單
 * 只接受可提交的狀態，那是 `All` 的子集）。
 *
 * `withNames` 給定時回傳 **`Map<常數名, 值>`**（方向是**名 → 值**，不是反過來）。
 * 本函式內部本來就有一張 `consts`，這個旗標只是把它交出來，不必反轉——**反轉過的版本今天
 * 也跑得動**（實測：`ErrorCodes.cs` 的常數名與值都各自唯一 ⇒ 反轉無損、測試照綠），
 * 但 C# 不禁止兩個常數同值，屆時反轉會讓其中一個**靜默消失**，而呼叫端只會說
 * 「某個 code 找不到」——**指錯方向**。`arrayName` 同時給定時交出的 Map 只留被陣列引用的
 * 常數（同一張 Map、同一個方向）；**兩個回傳路徑都吃這個旗標**（只加在其中一條上，
 * 另一個分支就是靜默的 no-op）。呼叫端是 Gate B（`check-error-messages.mjs`）。
 *
 * 三條舊版的靜默放行都在這裡收掉（fix round 1 的 scoped re-review B2，逐條見 test 檔）：
 *   ① 上方一份完整註解副本 ⇒ 舊版取到死碼那份；遮罩後只認活的。
 *   ② 活值改名 ＋ 下方留舊值註解副本 ⇒ 舊版的 `Map` 後者勝出；遮罩後死碼不存在。
 *   ③ 一條 const 被區塊註解包起來 ⇒ 舊版仍收進期望集合；遮罩後它不在集合裡，
 *      被陣列引用時會大聲說「引用了一個找不到的常數」。
 *
 * **哪些操作跑在原始碼、哪些跑在遮罩後**（Task 8 fix round 3 的 F5 更正——fix round 2 的
 * 報告只列了兩個形狀正則，讀起來像是「只有那兩個」）：
 *   - 跑在**遮罩後**文字（`masked`）上：兩個形狀正則（`public const string` 與
 *     `public static readonly string[] <name> =`），以及本函式對陣列的處理
 *     （`masked[i]` 的 `\s`、`masked.indexOf("]")`、`masked.slice`、`split(",")`、
 *     `/^[A-Za-z_]\w*$/`）。
 *   - 跑在**原始碼**（`source`）上：`maskCSharp` 的前置處理器偵測（行首的 `#`）與本函式
 *     的「值後面接的是不是分號」檢查——兩者都需要**未被遮罩的字元**：前者要分辨「行首的
 *     `#`」與「字串裡的 `#`」，後者要確認引號之後真的是 `;`（遮罩後那裡是空白，看不出
 *     原本有沒有分號）。遮罩是**等長**的（`\n`／`\r` 保留），兩邊的索引可以直接互換。
 */
export function extractBackendValues(source, { label, arrayName, withNames } = {}) {
  const { masked, strings } = maskCSharp(source, label);

  // 值必須是**這個掃描器認得的字串字面值**：`"…"` 與 `@"…"` 讀得出值，`$"…"` 讀不出
  // （洞是運算式）⇒ 後者 fail closed。舊版的正則要求 `=` 之後直接是 `"`，
  // 所以 `@"…"` 會被**靜默漏掉**（不在期望集合裡），那正是這一輪要收掉的靜默方向。
  const consts = new Map();
  const declRe = /public\s+const\s+string\s+(\w+)\s*=/g;
  for (let m = declRe.exec(masked); m !== null; m = declRe.exec(masked)) {
    const name = m[1];
    const line = source.slice(0, m.index).split("\n").length;
    let i = m.index + m[0].length;
    while (/\s/.test(masked[i] ?? "")) i++;
    while (masked[i] === "@" || masked[i] === "$") i++;
    const literal = masked[i] === '"' ? strings.get(i) : undefined;
    if (literal === undefined) {
      bail(
        `${label}:${line} 的 public const string ${name} 不是字面值字串（內插字串或認不得的形狀）` +
          `——本檢查不猜（fail closed）。`,
      );
    }
    // 這裡刻意**不設窗口大小**（Task 8 fix round 3 的 Minor-4）：舊版是
    // `/^\s*;/.test(source.slice(literal.end, literal.end + 8))`，於是「合法 C# 但分號
    // 落在 8 個字元之後」（空行 ＋ 縮排）會被拒，而訊息還把因果說錯——分號明明在，
    // 只是比較遠。判準改成「引號之後的**第一個非空白字元**是不是分號」：跨行成立，
    // 也跑不過頭（中間只要夾了別的東西，它就大聲）。
    let after = literal.end;
    while (/\s/.test(source[after] ?? "")) after++;
    if (source[after] !== ";") {
      bail(`${label}:${line} 的 public const string ${name} 結尾不是「字串字面值 ＋ 分號」——本檢查不猜（fail closed）。`);
    }
    if (consts.has(name)) {
      bail(
        `${label} 有兩個活的 public const string ${name}——本檢查不猜：` +
          `重複宣告時「後者勝出」會讓期望集合靜默改變（C# 自己也編不過）。`,
      );
    }
    consts.set(name, literal.value);
  }

  if (arrayName !== undefined && arrayName !== null) {
    const re = new RegExp(`public\\s+static\\s+readonly\\s+string\\[\\]\\s+${arrayName}\\s*=\\s*\\[`, "g");
    const m = re.exec(masked);
    if (m === null) {
      bail(`${label} 解析不到 public static readonly string[] ${arrayName} = [...]——請確認該檔仍是這個形狀（本檢查不猜）。`);
    }
    const open = m.index + m[0].length - 1;
    const close = masked.indexOf("]", open);
    if (close < 0) bail(`${label} 的 ${arrayName} 陣列沒有收尾的 \`]\`——本檢查不猜（fail closed）。`);
    const inner = masked.slice(open + 1, close);
    if (inner.includes("[")) bail(`${label} 的 ${arrayName} 陣列裡有巢狀的 \`[\`——本檢查不猜（fail closed）。`);
    const names = inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (names.length === 0) {
      bail(`${label} 的 ${arrayName} 是空陣列——後端沒有任何屬於它的值。`);
    }
    const values = [];
    for (const name of names) {
      if (!/^[A-Za-z_]\w*$/.test(name)) {
        bail(`${label} 的 ${arrayName} 陣列裡有非識別碼的成員（\`${name}\`）——本檢查不猜（fail closed）。`);
      }
      const value = consts.get(name);
      if (value === undefined) {
        bail(`${label} 的 ${arrayName} 引用了 ${name}，但同一檔找不到 public const string ${name}——本檢查不猜。`);
      }
      values.push(value);
    }
    if (withNames) {
      // 同一張 Map 的方向（名 → 值）：`values` 是逐一走 `names` push 的（每個 name 恰好一個值，
      // 中途 bail 不會回傳），所以兩者等長、索引一一對應。
      return new Map(names.map((name, i) => [name, values[i]]));
    }
    return values;
  }
  // 空集合的守衛讀 `consts.size`，**不是推導出來的陣列**：`withNames` 交出去的是那張 Map，
  // 而讀陣列的寫法在 Map 這條路徑上永遠不會響（兩個分支共用這一個守衛）。
  if (consts.size === 0) {
    bail(`${label} 解析不到任何 public const string——請確認該檔仍是這個形狀（本檢查不猜）。`);
  }
  return withNames ? consts : [...consts.values()];
}

/** `src/i18n/locales.ts` 的 `export const SUPPORTED_LOCALES … = [...]`。 */
export function extractSupportedLocales(source, { label = "src/i18n/locales.ts", fileName } = {}) {
  const sourceFile = parse(fileName ?? label, source);
  const arr = unwrap(findExportedConst(sourceFile, "SUPPORTED_LOCALES"));
  if (arr === undefined || !ts.isArrayLiteralExpression(arr)) {
    bail(`${label} 解析不到 SUPPORTED_LOCALES——請確認該宣告仍是一行陣列字面值。`);
  }
  return arr.elements.map((el, index) => {
    if (!ts.isStringLiteral(el)) {
      bail(
        `${label}:${lineNumberAt(sourceFile, el.getStart())} 的 SUPPORTED_LOCALES 第 ${index} 個元素` +
          `不是字串字面值——本檢查不猜（fail closed）。`,
      );
    }
    return el.text;
  });
}
