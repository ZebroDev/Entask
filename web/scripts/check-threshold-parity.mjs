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
//   3. **每一側都必須「恰好命中宣告的次數」**。命中 0 次（改名、改形狀）與數量不符
//      （同一句寫兩處、或其中一處被刪掉）都 exit 1：前者會讓這一列**靜默變成守著空氣**，
//      後者讓「在比哪一個」失去答案。這一條與 `check-error-codes.mjs` 的「恰好一處」是
//      同一種驅動；前端側多一個 `count`（預設 1）用來宣告**重數**——同一條界線在畫面上
//      有兩個消費端時，列 2 比放寬成「至少一次」誠實。
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
//   4. **只認「左運算元 ＋ 比較運算子 ＋ 數值右運算元」**這個形狀。兩邊都是變數的比較、
//      或左右顛倒（`0.8 <= m.fpy`）不在涵蓋範圍。
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
 * 兩側必須相符的門檻。後端用 `pattern`（跑在遮罩後的字串上，抓 `op` 與 `value` 兩個
 * 具名群組），前端用 `left`（**左運算元的原始碼文字**，比對時把空白全部去掉）。
 */
const PAIRS = [
  {
    concept: "一次交付通過率（fpy）的 S 門檻",
    relation: "same",
    backend: { file: TEAM_REPORT_CS, pattern: /fpy (?<op>>=|>|<=|<) (?<value>\d+(?:\.\d+)?)/ },
    frontend: { file: TEAM_REPORT_TSX, left: "m.fpy" },
  },
  {
    concept: "主管評分調整項的樣本門檻",
    relation: "same",
    backend: { file: TEAM_REPORT_CS, pattern: /scoreSamples (?<op>>=|>|<=|<) (?<value>\d+(?:\.\d+)?)/ },
    frontend: { file: TEAM_REPORT_TSX, left: "(m.scoreSamples ?? 0)" },
  },
  {
    concept: "跨團隊使用者搜尋的最短長度",
    relation: "complementary",
    backend: { file: "src/Entask.Api/Endpoints/AuthEndpoints.cs", pattern: /trimmed\.Length (?<op>>=|>|<=|<) (?<value>\d+(?:\.\d+)?)/ },
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

/** 後端一側：遮罩（字串與註解變空白）之後才比對，且必須恰好命中一次。 */
const backendSite = (spec, concept) => {
  const { masked } = maskCSharp(readSource(spec.file), spec.file);
  const matches = [...masked.matchAll(new RegExp(spec.pattern.source, "g"))];
  if (matches.length !== 1) {
    violations.push(
      `${matches.length === 0 ? "找不到站點" : `命中 ${matches.length} 次（必須恰好 1 次）`}：` +
        `${concept}——後端 ${spec.file} 的 ${spec.pattern.source}。` +
        `改寫了那個條件就要一起更新這一列的 pattern（本檢查不猜）。`,
    );
    return null;
  }
  const [match] = matches;
  return { ...match.groups, line: lineOf(masked, match.index) };
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
  const back = backendSite(backend, concept);
  const front = frontendSite(sourceFor(frontend.file), frontend, concept, "前端");
  if (!back || !front) continue;

  const valuesDiffer = Number(back.value) !== front.value;
  const operatorsDiffer =
    relation === "same" ? back.op !== front.op : COMPLEMENT[front.op] !== back.op;

  if (valuesDiffer) {
    violations.push(
      `數值不同：${concept}——後端 ${backend.file}:${back.line} 是 ${back.value}，` +
        `前端 ${frontend.file}:${front.line} 是 ${front.value}。`,
    );
  }
  if (operatorsDiffer) {
    violations.push(
      `運算子不同：${concept}——後端 ${backend.file}:${back.line} 是 \`${back.op}\`，` +
        `前端 ${frontend.file}:${front.line} 是 \`${front.op}\`（這一列宣告的關係是 \`${relation}\`）。`,
    );
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
