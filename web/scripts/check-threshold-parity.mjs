// 同一個門檻在 C# 與 TypeScript 各有一份時，**數值與運算子必須相符**。
// CI 與本機皆可跑：node scripts/check-threshold-parity.mjs
//
// 為什麼需要這支（2026-09-28，第 13 道閘門）：前端有幾處**後端門檻的副本**，而它們
// **不會有任何紅燈**——`tsc -b` 看不到（兩邊都是合法的數字）、四道 i18n 家族的閘門
// 看不到（它們比 key 集合與譯文）、後端測試看不到（它只驗自己那一側）。
// 唯一的防線是「調門檻的人記得兩邊一起改」，而 `docs/STATE.md` 已經記著那個門檻
// （`RatingFor` 的 4.5／2.0／0.85／0.80）**最可能在真實資料上要調**。
//
// **它比的是「同一個概念的兩份值」，不是「兩個看起來像的數字」**——後者機器分不出來，
// 所以這道閘門的核心是一張**人工宣告表**（`PAIRS`）：每一列指名一個概念、兩側的站點、
// 以及兩側運算子的關係。表**沒有**的東西它一概不管。
//
// 三個機制，各自都有測試看著（見 `check-threshold-parity.test.mjs`）：
//
//   1. **後端那一側先過 `maskCSharp`**。`TeamReportEndpoints.cs` 的 XML 註解**刻意**
//      寫著同一句 `fpy >= 0.80`（那是給下一個人的說明，見該檔 `RatingFor` 段）——不遮罩
//      會抽到 2 處，而「恰好一次」那條會紅在錯的理由上。
//   2. **前端那一側走 TypeScript AST，不是 grep**。TSX 的註解裡同樣有一份同形的比較
//      （`TeamReportTab.tsx` 的三格註解就在講那幾個門檻）。AST 讓「註解與字串不是節點」
//      這件是**結構上**成立，不是靠正規表示式小心避開——那是 `check-error-paths.mjs`
//      已經立下的同一條規矩。
//   3. **後端右運算元可以是具名常數**（2026-10-20）：門檻集中成
//      `private const double FpyS = 0.80;` 這一類宣告之後，比較式本身不再帶數字。
//      閘門因此讀**同一檔**的 `const <型別> <名稱> = <數值>;` 宣告把值解析回來。
//      **解析不到就 exit 1，不是略過**：那時「在比哪一個值」沒有答案。宣告在別的檔、
//      或值不是單純數字（算式、另一個常數）也一樣大聲——這一支不猜。
//   4. **每一側都必須「恰好命中宣告的次數」**。命中 0 次（改名、改形狀）與數量不符
//      （同一句寫兩處、或其中一處被刪掉）都 exit 1：前者會讓這一列**靜默變成守著空氣**，
//      後者讓「在比哪一個」失去答案。這一條與 `check-error-codes.mjs` 的「恰好一處」是
//      同一種驅動；兩側都可以用 `count`（預設 1）宣告**重數**——同一條界線在畫面上／
//      程式裡有兩個消費端時，列 2 比放寬成「至少一次」誠實。
//
// **關係（`relation`）的兩種值**：
//   - `same`：兩側的**運算子逐字相同**且數值相等（`>=` 與 `>` 在邊界上差一個值 ⇒ 分開看）。
//   - `complementary`：兩側運算子**互補**且數值相等——「拒絕低於 N」與「允許 N 以上」
//     是同一條界線的兩面（搜尋最短長度就是這一種：後端擋掉太短的字串，前端不要送出
//     那個必定被擋的請求）。
//
// **已知盲區（四類，誠實記載）**——前三類是這個做法本身的性質，不是實作缺陷：
//   1. **只守表上宣告過的對**。新出現的第四份副本它**看不到**——「這兩個數字是不是同一個
//      概念」是語意的問題，機器只能比對人宣告過的連結。⇒ 新增這類副本時要自己補一列。
//   2. **非副本那一列（`NOT_A_COPY`）不比對數值**，它守的是「宣告還指著真實的站點」
//      （避免宣告腐爛成保護死碼）。值的漂移不歸它。
//   3. **後端那一側是遮罩後的正規表示式，不是 C# AST**（本 repo 沒有 C# 剖析器）。
//      所以形狀改寫之後 pattern 會失配——但那是**大聲**的（「找不到站點」），不是靜默。
//      具名常數的值解析同理：只認同一檔「`const <型別> <名稱> = <數字>;`」的宣告，
//      讀不到就 exit 1（「解析不到常數」），不會退回 0 對。
//   4. **只認「左運算元 ＋ 比較運算子 ＋ 數值右運算元」**這個形狀。兩邊都是變數的比較、
//      或左右顛倒（`0.8 <= m.fpy`）不在涵蓋範圍。
//   5. **同一檔若在兩個類別各宣告同名常數，解析會取最後一個宣告的值**（本樹沒有這個形狀；
//      真有時值若不同會靜默挑一個）。要收緊就得把「解析到幾個宣告」變成第三種命中數，
//      那會讓這一列的 `count` 同時管兩件事——現階段選擇如實記載，不假裝它被守住了。
//
// 名稱：**門檻**（threshold），不是「常數」——這一支管的是「拿來比大小的那一條界線」，
// 常數的一般性比對（`ErrorCodes` 的值 ↔ 前端）另有 `check:labels` 與 `check:errors`。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { maskCSharp } from "./lib/label-table-extract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const repoRoot = join(root, "..");

/** 比較運算子 → 它的互補寫法（`x >= N` 的補是 `x < N`）。 */
const COMPLEMENT = { ">=": "<", ">": "<=", "<=": ">", "<": ">=" };
const OPERATORS = Object.keys(COMPLEMENT);

const TEAM_REPORT_CS = "src/Entask.Api/Endpoints/TeamReportEndpoints.cs";
const TEAM_REPORT_TSX = "web/src/pages/team/TeamReportTab.tsx";

/**
 * 後端右運算元的兩種形狀：數字字面值（`0.80`）或**具名常數**（`FpyS`）。
 * 常數的值由同一檔的 `const <型別> <名稱> = <數值>;` 宣告解析（`constantDeclarations`）。
 */
const VALUE_PATTERN = String.raw`(?<value>[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)`;

/** 以左運算元的原始碼文字組出後端比較的 pattern（跑在遮罩後的字串上）。 */
const comparisonPattern = (left) => new RegExp(String.raw`${left} (?<op>>=|>|<=|<) ${VALUE_PATTERN}`);

/**
 * 兩側必須相符的門檻。後端用 `pattern`（跑在遮罩後的字串上，抓 `op` 與 `value` 兩個
 * 具名群組），前端用 `left`（**左運算元的原始碼文字**，比對時把空白全部去掉）。
 *
 * `count` 是**宣告的重數**，兩側都適用（預設 1）。後端兩列都是 2：同一個門檻除了
 * 主公式（`RatingFor`／`ApplyScoreAdjustment`）之外，grade 分解的狀態（`BuildRatingBreakdown`
 * 的 sGate）與 `NotAppliedReason` 也各再比一次——**兩處都必須指著同一個值**，
 * 所以列 2 而不是放寬成「至少一次」。
 */
const PAIRS = [
  {
    concept: "一次交付通過率（fpy）的 S 門檻",
    relation: "same",
    backend: { file: TEAM_REPORT_CS, pattern: comparisonPattern(String.raw`fpy`), count: 2 },
    frontend: { file: TEAM_REPORT_TSX, left: "m.fpy" },
  },
  {
    concept: "主管評分調整項的樣本門檻",
    relation: "same",
    backend: { file: TEAM_REPORT_CS, pattern: comparisonPattern(String.raw`scoreSamples`), count: 2 },
    frontend: { file: TEAM_REPORT_TSX, left: "(m.scoreSamples ?? 0)" },
  },
  {
    concept: "跨團隊使用者搜尋的最短長度",
    relation: "complementary",
    backend: {
      file: "src/Entask.Api/Endpoints/AuthEndpoints.cs",
      pattern: comparisonPattern(String.raw`trimmed\.Length`),
    },
    // `count: 2`——同一條界線在畫面上有**兩個**消費端：`enabled`（不要送出必定被擋的請求）
    // 與「其他團隊」那一區的渲染條件（沒有查詢結果就不要宣稱在搜尋）。兩者都要跟著後端走，
    // 少一個就是宣告過期；**第三個**出現時要一起改這個數字（那正是它存在的理由）。
    frontend: { file: "web/src/pages/team/AssignMemberDialog.tsx", left: "searchTerm.length", count: 2 },
  },
];

/**
 * 看起來像副本、**但刻意不是**的站點。守衛只有一條：宣告仍須命中**恰好一次**。
 * 值的漂移不歸它守（見檔頭盲區 2）——會列在這裡的理由是**後端沒有可比的對應物**，
 * 不是「值不同」。
 */
const NOT_A_COPY = [
  {
    file: TEAM_REPORT_TSX,
    left: "m.onTimeRate",
    reason:
      "後端 `RatingFor` 的準時率條件是 **0.85**，這一格的 0.8 是純 UI 的著色門檻（不是任何後端常數的副本）。" +
      "會誤認是因為隔壁 fpy 那格的門檻也是 0.8，而**它才是** `fpy >= 0.80` 的副本。",
  },
];

const violations = [];
const bail = (message) => {
  console.error(`門檻副本檢查無法完成——${message}`);
  process.exit(1);
};

const readSource = (rel) => {
  try {
    return readFileSync(join(repoRoot, rel), "utf8");
  } catch (error) {
    // 檔案不見了也是「認不得就大聲」：那一列從此守著空氣，而它不會自己說出來。
    bail(`讀不到 ${rel}（${error.code ?? error.message}）——表上的路徑要跟著程式碼走。`);
  }
};

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * 同一檔的數字常數宣告：`private const double FpyS = 0.80;` ⇒ `FpyS → 0.80`。
 * **只認宣告值就是一個數字**的形狀（可帶負號）；算式、別人的常數、字串一律不認——
 * 那些情況會落到 `backendSites` 的「解析不到常數」，而不是被猜一個值。
 */
const constantDeclarations = (masked) => {
  const constants = new Map();
  const declaration =
    /\bconst\s+[A-Za-z_][A-Za-z0-9_]*\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>-?\d+(?:\.\d+)?)\s*;/g;
  for (const match of masked.matchAll(declaration)) {
    constants.set(match.groups.name, Number(match.groups.value));
  }
  return constants;
};

const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;

/**
 * 後端一側：遮罩（字串與註解變空白）之後才比對，且必須恰好命中宣告的次數。
 * 右運算元若是具名常數，值由同一檔的宣告解析；解析不到就記違規、整列不算完成
 * （回傳 null）——**不略過**。
 */
const backendSites = (spec, concept) => {
  const masked = maskCSharp(readSource(spec.file), spec.file).masked;
  const expected = spec.count ?? 1;
  const matches = [...masked.matchAll(new RegExp(spec.pattern.source, "g"))];
  if (matches.length !== expected) {
    violations.push(
      `${matches.length === 0 ? "找不到站點" : `命中 ${matches.length} 次（必須恰好 ${expected} 次）`}：` +
        `${concept}——後端 ${spec.file} 的 ${spec.pattern.source}。` +
        `改寫了那個條件就要一起更新這一列的 pattern（本檢查不猜）。`,
    );
    return null;
  }

  const constants = constantDeclarations(masked);
  const sites = [];
  for (const match of matches) {
    const line = lineOf(masked, match.index);
    const raw = match.groups.value;
    let value;
    let constant = null;
    if (NUMERIC_LITERAL.test(raw)) {
      value = Number(raw);
    } else if (constants.has(raw)) {
      value = constants.get(raw);
      constant = raw;
    } else {
      violations.push(
        `解析不到常數：${concept}——後端 ${spec.file}:${line} 的比較右邊是 \`${raw}\`，` +
          `但同一檔找不到 \`const <型別> ${raw} = <數值>;\` 的宣告。` +
          `宣告在別的檔、或值不是單純數字（算式／另一個常數）時這裡都讀不到——本檢查不猜。`,
      );
      continue;
    }
    sites.push({ op: match.groups.op, value, raw, constant, line });
  }
  return sites.length === matches.length ? sites : null;
};

const sourceFileOf = (rel) => {
  const source = readSource(rel);
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
  if (sourceFile.parseDiagnostics.length > 0) {
    const first = sourceFile.parseDiagnostics[0];
    const at = sourceFile.getLineAndCharacterOfPosition(first.start).line + 1;
    bail(
      `${rel}:${at} 有 ${sourceFile.parseDiagnostics.length} 個語法錯誤` +
        `（${ts.flattenDiagnosticMessageText(first.messageText, " ")}）。本檢查讀的是語法樹，不猜。`,
    );
  }
  return sourceFile;
};

const normalize = (text) => text.replace(/\s+/g, "");

/** 前端一側：語法樹上「左運算元文字相符 ＋ 右運算元是數值字面值」的比較，恰好一次。 */
const frontendComparisons = (sourceFile, left) => {
  const wanted = normalize(left);
  const found = [];
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      OPERATORS.includes(node.operatorToken.getText(sourceFile)) &&
      node.right.kind === ts.SyntaxKind.NumericLiteral &&
      normalize(node.left.getText(sourceFile)) === wanted
    ) {
      found.push({
        op: node.operatorToken.getText(sourceFile),
        value: Number(node.right.getText(sourceFile)),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/**
 * 前端一側的站點。`spec.count` 是**宣告的重數**（預設 1）：同一條界線在畫面上可能出現
 * 在兩個地方（見表上搜尋那一列的說明），那時列 2 比列 1 誠實——「至少一次」會讓
 * 「其中一個被刪掉」變成靜默，而兩者都**必須**跟著後端走。
 */
const frontendSite = (sourceFile, spec, concept, what) => {
  const expected = spec.count ?? 1;
  const found = frontendComparisons(sourceFile, spec.left);
  if (found.length !== expected) {
    violations.push(
      `${found.length === 0 ? "找不到站點" : `命中 ${found.length} 次（必須恰好 ${expected} 次）`}：` +
        `${concept}——${what} ${spec.file} 的 \`${spec.left}\` 在語法樹上` +
        `找不到／數量不符的「數值比較」節點。改了形狀或增刪站點就要一起更新這一列。`,
    );
    return null;
  }
  return found[0];
};

// 同一個檔案可能被好幾列指名（`TeamReportTab.tsx` 就有三列）⇒ 語法樹只建一次。
const parsed = new Map();
const sourceFor = (rel) => {
  if (!parsed.has(rel)) parsed.set(rel, sourceFileOf(rel));
  return parsed.get(rel);
};

for (const { concept, relation, backend, frontend } of PAIRS) {
  const backs = backendSites(backend, concept);
  const front = frontendSite(sourceFor(frontend.file), frontend, concept, "前端");
  if (!backs || !front) continue;

  for (const back of backs) {
    // 訊息要能回指到「哪一個站點、哪一個常數」——值一樣但常數不同時，讀者才知道在比什麼。
    const where =
      `後端 ${backend.file}:${back.line}` +
      (back.constant === null ? "" : ` 的常數 \`${back.constant}\`（${back.value}）`);

    if (back.value !== front.value) {
      violations.push(
        `數值不同：${concept}——${where} 是 ${back.value}，` +
          `前端 ${frontend.file}:${front.line} 是 ${front.value}。`,
      );
    }
    const operatorsDiffer =
      relation === "same" ? back.op !== front.op : COMPLEMENT[front.op] !== back.op;
    if (operatorsDiffer) {
      violations.push(
        `運算子不同：${concept}——${where} 是 \`${back.op}\`，` +
          `前端 ${frontend.file}:${front.line} 是 \`${front.op}\`（這一列宣告的關係是 \`${relation}\`）。`,
      );
    }
  }
}

for (const { file, left, reason } of NOT_A_COPY) {
  if (frontendComparisons(sourceFor(file), left).length !== 1) {
    violations.push(
      `宣告過期：${file} 的 \`${left}\` 不再是一個數值比較。這一列只是要記下「它不是副本」` +
        `（${reason}）——站點真的不在了就把這一列從 NOT_A_COPY 刪掉，不要留著保護死碼。`,
    );
  }
}

if (violations.length > 0) {
  console.error("後端與前端的同一組門檻不一致（或表上的站點已經不在了）：\n");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\n調門檻是**兩邊一起**的事：這一張表的用意是讓那個「一起」有紅燈看著，" +
      "不是禁止調整（`docs/STATE.md` 的〈前端有一份後端門檻的副本〉有當時的裁定）。",
  );
  process.exit(1);
}

// 通過時把對數與非副本數印出來，**清單本身不寫死在訊息裡**——寫死的話，新增一列而
// 忘了改這行時，跑綠的人是看不出來的（`check-error-codes.mjs` 的同一條規矩）。
console.log(
  `門檻副本檢查通過：${PAIRS.length} 對相符（${PAIRS.map((pair) => pair.concept).join("／")}），` +
    `另有 ${NOT_A_COPY.length} 處宣告為非副本。`,
);
