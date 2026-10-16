// `check-error-codes.mjs` 的測試（2026-09-20，Gate A）。
//
// **為什麼要有這一支**——Gate A 的六個主張，沒有一支測試看著就是紙上論證：
//
//   1. **詞界 `(^|[^A-Za-z])`**。沒有它，R1 會把**已經改好的** `ApiResults.NotFound(` 一起
//      命中（擋掉它的正是 `ApiResults` 裡那個字母 `i`——`Results` 前面是 `i`，不是詞界；
//      `TypedResults.NotFound()` 同理，前面是 `d`，那一個由 R2 管）
//      ——R1 永遠紅、且與 R2 分不開。反例裡的第 11 行就是那個「已經改好的」寫法：少了它，
//      這條缺陷只會在真掃描上爆，而真掃描爆的時候分不出是「規則的詞界寫錯」還是
//      「站點漏改」——那正是 Step 5 的判準要人當場分辨的兩件事。
//   2. **遮罩層**。`ApiResults.cs` 的 `///` 註解**刻意**寫著 `Results.NotFound(...)` 與
//      `StatusCodes.Status404NotFound`（那是給下一個人的說明，見該檔檔頭）：不遮的話
//      R1 會是 1、R4 會是 2，而兩者的契約是 0 與「恰好 1」。反例的第 6 行就是那行註解。
//      500 那一側同理、而且更密：同一行還寫著 `Results.StatusCode(500)` 與
//      `StatusCodes.Status500InternalServerError` ⇒ 不遮的話 R15 會是 2、R16 會多一處。
//   3. **字串的內容要被遮掉、引號要留著**。既有的 `PATTERN`（字面值錯誤訊息）靠 `\(\s*"`
//      比對，而遮罩只把字串**內容**換成空白——「引號留著」因此是 `PATTERN` 的前提：反例的
//      第 7 行（逐字字串裡的 `Results.BadRequest("…")`）只釘得到「內容被遮」那半（引號
//      一起被遮掉時那一行不命中、照樣是綠的）。前提本身釘在 `label-table-extract.test.mjs`
//      的「maskCSharp 的遮罩性質」那支——動 `maskCSharp` 的遮罩範圍時一起跑。
//   4. **R4 的「恰好一處」有三種壞法**（多於一處／一處都沒有／位置不對），各一支。
//      「一處都沒有」那一支是 final review 的 F5 補的（閘門原始碼自己說三個方向都 exit 1，
//      而測試只釘了兩個）——它的獨有價值在於：`StatusCodes.Status404NotFound` 被改寫成
//      **變數**時（`statusCode: someConst`），R1／R2／R3／R5／R6／R7 一條都不響，
//      只有 R4 的歸零分支會紅。
//   5. **R3 的兩個前綴與 R7**（final review 的 F1）。F1 之前 `TypedResults.StatusCode(404)`
//      （R3 的詞界把它排除在外）與 `NotFoundResult`（一條規則都沒有）都是**閘門靜默通過**的
//      形狀，而普查表列過它們。各一支有判別力的測試，**外加一支反向對照**
//      （`.StatusCode(200)` 必須照綠——放寬成「不看括號內容」的話它會紅）。
//   6. **500 家族（R15–R21，2026-09-21）**。R15 與 R4／R14 共用同一個「恰好一處」驅動
//      ⇒ 它那一組同時是「驅動不是硬編碼」的**第二個**判別點（R14 那一組是第一個）。
//      R16–R21 逐條對應 404／401 的六條，而**每一列都是一條獨立的替代形狀**：R16 的兩個
//      前綴、R17／R21 的兩個接收者、R19 的兩個型別、R20 的四種寫法**各有自己的輸入**
//      ——照 F1 的教訓，一個分支漏寫就是一條閘門靜默通過的形狀，而**把兩條寫進同一個檔
//      是沒有判別力的**（另一條照樣命中 ⇒ 照樣紅）。另有兩列反向對照：`.StatusCode(403)`
//      與 `statusCode: StatusCodes.Status403Forbidden` 必須照綠（R16／R18 只認 5xx）。
//      還有一件事只有這一組釘得到：`Results.Problem("…")` 會**先**被既有的 `PATTERN`
//      （字面值錯誤訊息）攔下、`process.exit(1)` 之後**根本走不到** R21 的報告
//      ⇒ R21 的列刻意用非字面值的引數，否則那一列測到的是別人。
//   7. **429 家族（R22–R24 ＋ R25，2026-09-24）**。R25 與 R4／R14／R15 共用同一個「恰好一處」
//      驅動 ⇒ 那一組是「驅動不是硬編碼」的**第三個**判別點（把驅動退回只認前面幾條的形狀時，
//      這一組三支會全部變成 exit 0，而前三組照樣全綠）。
//      **形狀清單不是抄前三個家族的**：探針專案當場編譯量出來的結果是
//      `Results.TooManyRequests`／`TypedResults.TooManyRequests` **不存在**（CS0117），
//      而 `Results.StatusCode(429)` 與 `HttpStatusCode.TooManyRequests` **存在**
//      ⇒ 這一族只有**三條**歸零規則——沒有 R2／R9 那種「框架方法名」可寫。
//      **不要**憑「前三個家族各有六條」把它補到六條（見閘門檔頭）。
//      三條各一列（`singleFault`），因為**把兩條形狀寫進同一個檔是沒有判別力的**。
//      R25 的「多於一處」還多擋一個具體的退化寫法：`options.RejectionStatusCode =
//      StatusCodes.Status429TooManyRequests`（**空的 429**，沒有 body）就是「多一處」。
//
// **做法**：在系統暫存目錄造一個沙箱，把閘門本體與它的 `lib/` 複製進去，放自己的 `src/`，
// `node_modules` 用 junction 連回本 repo。閘門的 repo 根目錄由 `import.meta.url` 推導，
// 所以沙箱副本只看得到**沙箱的** `src/`——版控裡的檔案一個都沒碰。閘門以 spawn 跑子行程：
// CWD 顯式給 `os.tmpdir()`（與沙箱、與 repo 都無關），不連網。
//
// 沙箱的 `web/node_modules` 是必要的：`lib/label-table-extract.mjs` 有一行靜態
// `import ts from "typescript"`，少了它子行程會在模組載入階段就 `ERR_MODULE_NOT_FOUND`
// ——那會讓「exit 1」來自錯的理由。第 1 支的正向對照擋的正是這種事。
//
// **斷言只認標頭與具名的 `file:line`**：任何寫死的全庫計數都會跟著掃描碼腐爛（AGENTS.md
// 的維護規則）。唯一用到數字的地方是反例的 `2 個後端原始檔`——那個 2 是**沙箱裡我自己放的
// 檔案數**，不是 repo 的數字。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url)); // web/scripts
const webDir = join(scriptsDir, "..");

const GATE = "check-error-codes.mjs";

/** 沙箱：`web/scripts/`（閘門 ＋ `lib/`）＋ 空的 `src/` ＋ node_modules 連結。 */
const makeSandbox = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "entask-error-codes-gate-"));
  mkdirSync(join(sandbox, "web", "scripts", "lib"), { recursive: true });
  mkdirSync(join(sandbox, "src"), { recursive: true });
  copyFileSync(join(scriptsDir, GATE), join(sandbox, "web", "scripts", GATE));
  copyFileSync(
    join(scriptsDir, "lib", "label-table-extract.mjs"),
    join(sandbox, "web", "scripts", "lib", "label-table-extract.mjs"),
  );
  symlinkSync(join(webDir, "node_modules"), join(sandbox, "web", "node_modules"), "junction");
  return sandbox;
};

/** 測試失敗時也要刪：先解掉 node_modules 連結再遞迴刪沙箱（實測 rmSync 不會走進連結的目標）。 */
const cleanup = (sandbox) => {
  try {
    unlinkSync(join(sandbox, "web", "node_modules"));
  } catch {
    // 連結已經不在了（或平台不允許 unlink 目錄連結）——rmSync 會收掉它。
  }
  rmSync(sandbox, { recursive: true, force: true });
};

const withSandbox = (run) => {
  const sandbox = makeSandbox();
  try {
    return run(sandbox);
  } finally {
    cleanup(sandbox);
  }
};

/**
 * 寫一個檔進沙箱。`rel` 是**沙箱根目錄**起算的相對路徑（含 `src/` 前綴，與閘門訊息裡的
 * `file:line` 同一把尺——R4 的「在不在 `ApiResults.cs`」比的是那個字串，差一層就對不上）。
 * 閘門推導出來的 repo 根目錄就是沙箱根目錄，所以訊息印的就是這裡傳進來的 `rel`。
 */
const write = (sandbox, rel, lines) => {
  const full = join(sandbox, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
};

/** 跑沙箱裡的閘門本體。回傳 spawnSync 的結果（`status`／`stdout`／`stderr`）。 */
const runGate = (sandbox) =>
  spawnSync(process.execPath, [join(sandbox, "web", "scripts", GATE)], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

// 標頭（測試靠它們分辨「紅在哪一條」；閘門的訊息改了這裡要跟著改）。
const PASS = "錯誤碼形狀檢查通過";
const BAIL = "無法完成";
const R4_ELSEWHERE = "但不在"; // 「恰好一處、位置不對」那條分支共有的字樣（R4／R14 都走它）
// R14 的「位置不對」分支自己的那一句。與 R4 的在同一條分支上是**刻意不同**的：
// 少了它，「R14 走到這一支」與「R4 走到這一支」在訊息上分不開。
const R14_ELSEWHERE = "401 的產生點只有那一個檔案";
const rule = (id) => `${id}：`;
// R15 的「位置不對」分支自己的那一句（同 R14 那條的理由：少了它，R15 與 R4／R14 走到同一支
// 在訊息上分不開）。
const R15_ELSEWHERE = "500 的產生點只有那一個檔案";
// R25 的（同 R14／R15 那兩條的理由：少了它，R25 與其他三條走到同一支在訊息上分不開）。
const R25_ELSEWHERE = "429 的產生點只有那一個檔案";
// 歸零規則（「恰好一處」的 R4／R14／R15 另計）。`R1：`／`R4：` 這種標頭不會被 `R14：`／`R15：`
// 誤命中——`R14：` 裡 `R1` 後面接的是 `4` 不是 `：`，`R4：` 同理；`R15：` 對 `R1：` 亦然。
// 這三個陣列是**掃描範圍**、不是計數：`expectOnlyRules` 逐條比對，寫死條數的地方一個都沒有
// （測試標題亦然——本檔不留「十二條」這種數字，它已經腐爛過一次）。
const ZERO_RULES = [
  "R1", "R2", "R3", "R5", "R6", "R7",
  "R8", "R9", "R10", "R11", "R12", "R13",
  "R16", "R17", "R18", "R19", "R20", "R21",
  "R22", "R23", "R24",
];
const EXACT_ONE_RULES = ["R4", "R14", "R15", "R25"];

/**
 * 斷言「紅的只有這幾條」——把「紅在哪一條」變成判別力，而不是只看 exit 1。
 * 訊息裡每一條規則都以 `R{n}：` 起頭（`rule()`），所以比對標頭就分得開。
 */
const expectOnlyRules = (stderr, fired) => {
  for (const id of ZERO_RULES) {
    if (fired.includes(id)) continue;
    expect(stderr).not.toContain(rule(id));
  }
};

const ENDPOINTS = "src/Entask.Api/Endpoints";
const API_RESULTS = `${ENDPOINTS}/ApiResults.cs`;

/**
 * 唯一產生點：R4 真正的 1 處在第 11 行的程式碼、R14 的 1 處在第 14 行、R15 的 1 處在第 17 行、
 * R25 的 1 處在第 20 行，其餘的同名 token 都在第 6 行的 `///` 註解裡（靠遮罩才不算）。
 * **行號是這支 fixture 的契約**——它同時餵 R4／R14／R15／R25 四條「恰好一處」，所以下面
 * `ApiResults.cs:11` 那些斷言與這個陣列的排列綁在一起：後面的產生點只能往第 11 行**之後**加
 * （500 是這樣加的，14 與 17 都對得上；429 同理，加在第 20 行）。
 */
const API_RESULTS_FILE = [
  "using Entask.Core;",
  "",
  "namespace Entask.Api.Endpoints;",
  "",
  "/// <summary>",
  "/// 404、401、429 與 500 的唯一產生點。不得寫成 <c>Results.NotFound(...)</c>／<c>Results.Unauthorized()</c>／<c>Results.StatusCode(429)</c>／<c>Results.StatusCode(500)</c>，也不得散落 <c>StatusCodes.Status404NotFound</c>／<c>StatusCodes.Status401Unauthorized</c>／<c>StatusCodes.Status429TooManyRequests</c>／<c>StatusCodes.Status500InternalServerError</c>。",
  "/// </summary>",
  "public static class ApiResults",
  "{",
  "    public static IResult NotFound(string code)",
  "        => Results.Json(new { code, message = ErrorMessages.For(code) }, statusCode: StatusCodes.Status404NotFound);",
  "",
  "    public static Task WriteUnauthorizedAsync(HttpContext context, string code)",
  "        => Results.Json(new { code, message = ErrorMessages.For(code) }, statusCode: StatusCodes.Status401Unauthorized);",
  "",
  "    public static Task WriteInternalErrorAsync(HttpContext context)",
  "        => Results.Json(new { code = ErrorCodes.ServerInternalError, message = ErrorMessages.For(ErrorCodes.ServerInternalError) }, statusCode: StatusCodes.Status500InternalServerError);",
  "",
  "    public static Task WriteTooManyRequestsAsync(HttpContext context)",
  "        => Results.Json(new { code = ErrorCodes.RequestTooManyRequests, message = ErrorMessages.For(ErrorCodes.RequestTooManyRequests) }, statusCode: StatusCodes.Status429TooManyRequests);",
  "}",
];

/**
 * 呼叫端：反例的另外幾行在這裡——第 11 行是①（詞界），第 7 行是③（字串內容要被遮掉），
 * 第 13 行是 401 那一側的①（同一條詞界規則的第二個落點：`ApiResults.Unauthorized(` 也含
 * `Results.Unauthorized(`，少了詞界 R8 會永遠紅）。
 */
const CALLER = [
  "using Entask.Core;",
  "",
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class Caller",
  "{",
  '    private const string Legacy = @"Results.BadRequest(""訊息"")";',
  "",
  "    public static IResult Load(bool found)",
  "    {",
  "        if (!found) return ApiResults.NotFound(ErrorCodes.BoardNotFound);",
  "        return Results.Ok();",
  "    }",
  "",
  "    public static IResult Guard() => ApiResults.Unauthorized(ErrorCodes.AuthSessionInvalid);",
  "}",
];

/** 反例的兩支檔（第 1 支測試把它們寫進沙箱；其餘測試在它們之上再加一個違規檔）。 */
const clean = (sandbox) => {
  write(sandbox, API_RESULTS, API_RESULTS_FILE);
  write(sandbox, `${ENDPOINTS}/Caller.cs`, CALLER);
};

/**
 * 違規檔：第 7 行是唯一的違規行——除了 R1 之外每一支正例都一樣的位置，斷言才對得起來。
 * （R1 用的是下面那支：它的違規行必須是**行首**，理由見該支的註解。）
 */
const LEGACY = `${ENDPOINTS}/Legacy.cs`;
const offender = (line7) => [
  "using Entask.Core;",
  "",
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class Legacy",
  "{",
  `    ${line7}`,
  "}",
];

/**
 * R1 專用的違規檔：違規的 `Results.NotFound()` 在**第 9 行、欄 0**（行首，合法 C#——
 * 方法呼叫可以當陳述式，縮排不是語法）。
 *
 * **為什麼不能沿用上面那支**：R1 的詞界是 `(^|[^A-Za-z])`，而行首的 token 前面沒有別的字元
 * ⇒ 命中一定落在**前一行的那個換行**上。閘門的 `hitIndex` 就是為這件事存在（`match.index`
 * 會把行號報成第 8 行——把下一個人送到錯的地方）。整支檔案裡只有這一支的違規行在行首，
 * 所以它是那個換算唯一的判別點：把 `hitIndex` 拿掉，這裡會變成 `Legacy.cs:8`。
 */
const R1_OFFENDER = [
  "using Entask.Core;",
  "",
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class Legacy",
  "{",
  "    private static void M()",
  "    {",
  "Results.NotFound();",
  "    }",
  "}",
];

/**
 * R8 專用的違規檔：形狀與 `R1_OFFENDER` **逐字同構**（違規的呼叫在第 9 行、欄 0）。
 *
 * **為什麼要第二支**：`hitIndex` 的第 1 群組換算是**每一條帶詞界的規則各自的事**
 * ——R1 的測試釘住的是 R1 的 `match[1]`。R8 若把詞界寫成非捕獲群組
 * （`/(?:^|[^A-Za-z])Results\.Unauthorized\(/`），R1 那支照樣綠，而這裡會變成
 * `Legacy.cs:8`。判別力落在這支的 `Legacy.cs:9`。
 */
const R8_OFFENDER = [
  "using Entask.Core;",
  "",
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class Legacy",
  "{",
  "    private static void M()",
  "    {",
  "Results.Unauthorized();",
  "    }",
  "}",
];

/** R4 的第二個產生點：第 7 行一處 `StatusCodes.Status404NotFound`（R4a 用它湊到兩處）。 */
const ORIGIN = (line7) => [
  "using Entask.Core;",
  "",
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class Origin",
  "{",
  `    ${line7}`,
  "}",
];

describe("check-error-codes：反例（應 exit 0）", () => {
  // **正向對照，先寫、必須綠**：少了這一步，「exit 1」可能來自任何原因（路徑打錯、node 版本、
  // 複製失敗、模組解析失敗、`typescript` 載不到）——其餘十一支就沒有判別力。
  // 這個沙箱同時釘住上面檔頭的三條：詞界（Caller.cs:11）、遮罩（ApiResults.cs:6 的註解）、
  // 字串內容（Caller.cs:7）。
  it("乾淨沙箱 ⇒ exit 0、印出成功訊息", () => {
    withSandbox((sandbox) => {
      clean(sandbox);

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
      // 這個 2 是沙箱裡我自己放的檔案數，不是 repo 的數字。
      expect(result.stdout).toContain("2 個後端原始檔");
      expect(result.stderr).not.toContain(BAIL);
      for (const id of [...ZERO_RULES, ...EXACT_ONE_RULES]) {
        expect(result.stderr).not.toContain(rule(id));
      }
    });
  });
});

describe("check-error-codes：404 的六種替代形狀（應 exit 1）", () => {
  it("R1：裸的 `Results.NotFound()` ⇒ exit 1、指名 file:line、不與 R2 混淆", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 違規行刻意在**行首**（第 9 行，欄 0）：命中的第 1 個群組是前一行的那個換行，
      // `hitIndex` 就是為這件事存在——少了它這裡會報成 `Legacy.cs:8`。
      write(sandbox, LEGACY, R1_OFFENDER);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R1"));
      expect(result.stderr).toContain("Legacy.cs:9");
      // 這一支是「詞界」的判別點：把 `(^|[^A-Za-z])` 拿掉，反例那一支（Caller.cs:11 的
      // `ApiResults.NotFound(`）也會命中——而這裡的 `Legacy.cs:9` 才是 R1 真正要抓的形狀。
      expect(result.stderr).not.toContain(rule("R2"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R2：`TypedResults.NotFound` ⇒ exit 1、指名它、不與 R1 混淆", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(sandbox, LEGACY, offender("public static IResult Load(bool f) => f ? Results.Ok() : TypedResults.NotFound();"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R2"));
      expect(result.stderr).toContain("Legacy.cs:7");
      // `TypedResults.NotFound()` 含 `Results.NotFound(`——R1 若少了詞界就會連這一支一起報，
      // 兩條規則分不開。這是詞界存在的第二個理由。
      expect(result.stderr).not.toContain(rule("R1"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R3：`Results.StatusCode(…404…)` ⇒ exit 1、指名它（同時也觸發 R4，這裡不斷言）", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        LEGACY,
        offender("public static IResult Load(bool f) => f ? Results.Ok() : Results.StatusCode(StatusCodes.Status404NotFound);"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R3"));
      expect(result.stderr).toContain("Legacy.cs:7");
      // 這一行**同時**讓 R4 變成 2 處（`StatusCodes.Status404NotFound` 就在 R3 的形狀裡）——
      // 但六條歸零規則的區塊先報、先 exit，所以這裡只看得到 R3。
      // 刻意**不**斷言「R4 沒有被數到」：那會把「誰先報」這個實作順序釘成契約。
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R3（`TypedResults.` 前綴）：放寬前它**一條規則都不命中**", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // F1 的原始缺陷：R3 原本是 `(^|[^A-Za-z])Results\.StatusCode\(`，`TypedResults` 的 `d`
      // 讓詞界失敗。違規行刻意用**整數字面值** `404` 而不是 `StatusCodes.Status404NotFound`，
      // 這樣 R4 的計數不受影響——紅燈只可能來自 R3（判別力落在下面的 expectOnlyRules）。
      write(sandbox, LEGACY, offender("public static IResult Load() => TypedResults.StatusCode(404);"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R3"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R3"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R7：`NotFoundResult`（MVC 型別）⇒ exit 1、指名它", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 照 R2／R6：**不帶詞界**是刻意的（歸零規則寧可大聲，`MyNotFoundResult` 被命中可接受）。
      write(sandbox, LEGACY, offender("public static NotFoundResult Load() => new NotFoundResult();"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R7"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R7"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R5：裸的 `statusCode: 404` ⇒ exit 1、指名它", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(sandbox, LEGACY, offender('public static IResult Load() => Results.Json(new { code = "x" }, statusCode: 404);'));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R5"));
      expect(result.stderr).toContain("Legacy.cs:7");
      // R3 放寬之後的**不誤傷對照**：`statusCode:` 那個字串前面沒有 `.`，也不是呼叫的形狀
      // （`statusCode: 404` 不是 `.StatusCode(…)`）⇒ 這一支必須仍然只紅在 R5。
      expectOnlyRules(result.stderr, ["R5"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R6：`HttpStatusCode.NotFound` ⇒ exit 1、指名它", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        LEGACY,
        offender("public static HttpResponseMessage Load() => new HttpResponseMessage(HttpStatusCode.NotFound);"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R6"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R6"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });
});

describe("check-error-codes：401 的六種替代形狀（應 exit 1）", () => {
  // 逐條對應上面那六支。**401 與 404 的差別不在規則形狀，在歷史**：404 那批的閘門是
  // 事後補的（`Results.Forbid()` 就是因為只數了一種形狀而漏掉），401 這批是**先列舉六種
  // 形狀、再逐條寫規則**——這個 describe 是那個列舉的執行版本。
  it("R8：裸的 `Results.Unauthorized()` ⇒ exit 1、指名 file:line、不與 R9 混淆", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 違規行在**行首**（第 9 行，欄 0）：R8 的詞界與 R1 同形，命中落在前一行的換行上。
      write(sandbox, LEGACY, R8_OFFENDER);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R8"));
      expect(result.stderr).toContain("Legacy.cs:9");
      // 詞界的第二個理由（同 R2 那支）：`TypedResults.Unauthorized()` 含 `Results.Unauthorized(`，
      // 少了 `(^|[^A-Za-z])` 兩條規則會一起報、分不開。
      expect(result.stderr).not.toContain(rule("R9"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R9：`TypedResults.Unauthorized` ⇒ exit 1、指名它、不與 R8 混淆", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(sandbox, LEGACY, offender("public static IResult Load(bool f) => f ? Results.Ok() : TypedResults.Unauthorized();"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R9"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expect(result.stderr).not.toContain(rule("R8"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R10：`TypedResults.StatusCode(401)` ⇒ exit 1（放寬前它一條規則都不命中）", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 與 R3 那支同一個理由：規則**刻意不帶前綴**。違規行用**整數字面值** `401` 而不是
      // `StatusCodes.Status401Unauthorized`，這樣 R14 的計數不受影響——紅燈只可能來自 R10。
      write(sandbox, LEGACY, offender("public static IResult Load() => TypedResults.StatusCode(401);"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R10"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R10"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R11：裸的 `statusCode: 401` ⇒ exit 1、指名它", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(sandbox, LEGACY, offender('public static IResult Load() => Results.Json(new { code = "x" }, statusCode: 401);'));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R11"));
      expect(result.stderr).toContain("Legacy.cs:7");
      // 不誤傷對照（同 R5 那支）：`statusCode:` 前面沒有 `.`，不是 `.StatusCode(…)` 的形狀。
      expectOnlyRules(result.stderr, ["R11"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R12：`HttpStatusCode.Unauthorized` ⇒ exit 1、指名它", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        LEGACY,
        offender("public static HttpResponseMessage Load() => new HttpResponseMessage(HttpStatusCode.Unauthorized);"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R12"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R12"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  // R13 比 R7 寬一格（`Unauthorized(Http)?Result`），所以它有**兩支**——一支釘一個型別名。
  // 404 那一側的 `NotFoundHttpResult` 是由 R2 的呼叫形狀守著的，401 這裡沒有對應的東西。
  it("R13：`UnauthorizedResult`（MVC 型別）⇒ exit 1", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(sandbox, LEGACY, offender("public static UnauthorizedResult Load() => new UnauthorizedResult();"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R13"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R13"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("R13：`UnauthorizedHttpResult`（minimal API 型別）⇒ exit 1——這支才是 `(Http)?` 的判別點", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 少了 `(Http)?` 這一格，這個型別**一條規則都不命中**（它既不是 `…Result` 的 MVC 名、
      // 也不在任何呼叫形狀裡）：那正是 404 那批漏掉 `TypedResults.StatusCode(404)` 的同型缺陷。
      write(sandbox, LEGACY, offender("public static IResult Load() => new UnauthorizedHttpResult();"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R13"));
      expect(result.stderr).toContain("Legacy.cs:7");
      expectOnlyRules(result.stderr, ["R13"]);
      expect(result.stdout).not.toContain(PASS);
    });
  });
});

describe("check-error-codes：R3 放寬後不誤傷（應 exit 0）", () => {
  // F1 把 R3 從 `/…Results\.StatusCode\([^)]*404/` 放寬成 `/\.StatusCode\([^)]*404/`（拿掉前綴）。
  // 這個 describe 是那個放寬的**反向對照**——少了它，「放寬到不帶前綴」與「放寬到不看括號裡的
  // 數字」是不是兩件事，就只剩紙上論證。而誤傷的後果是閘門**永遠紅**，下一個人只會去加白名單
  // （那正是這個 repo 明文禁止的收場）。
  //
  // 另一個誤傷候選（`Results.Json(…, statusCode: StatusCodes.Status404NotFound)`）不必另外造：
  // 它就在反例的 `ApiResults.cs:11`，而「乾淨沙箱 ⇒ exit 0」那支已經釘著它。
  it("`.StatusCode(200)` 不是 404 的形狀 ⇒ exit 0", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(sandbox, LEGACY, offender("public static IResult Accepted() => Results.StatusCode(200);"));

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
      // 這個 3 是沙箱裡我自己放的檔案數（ApiResults.cs ＋ Caller.cs ＋ Legacy.cs），不是 repo 的數字。
      expect(result.stdout).toContain("3 個後端原始檔");
      for (const id of [...ZERO_RULES, ...EXACT_ONE_RULES]) {
        expect(result.stderr).not.toContain(rule(id));
      }
    });
  });
});

describe("check-error-codes：R4 的「恰好一處」", () => {
  it("兩處 ⇒ exit 1、兩處都被指名（多一處就是多一條不會帶 code 的路）", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        `${ENDPOINTS}/SecondOrigin.cs`,
        ORIGIN("public static IResult NotFound() => Results.Json(new { code = \"x\" }, statusCode: StatusCodes.Status404NotFound);"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R4"));
      // 兩處都要列出來：沙箱的 1 處（ApiResults.cs）＋ 新的 1 處（SecondOrigin.cs）。
      expect(result.stderr).toContain("ApiResults.cs:11");
      expect(result.stderr).toContain("SecondOrigin.cs:7");
      // 這一支走的是「多於一處」那個分支，不是「位置不對」那個。
      expect(result.stderr).not.toContain(R4_ELSEWHERE);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  // F5：閘門原始碼自己說「三個方向（多於一處／一處都沒有／位置不對）都 exit 1」，
  // 而在這一支補上之前，測試只釘了兩個——那個註解比測試多說了一句。
  // 這不是形式上的對稱：**這個方向是唯一會響的那一條**。`StatusCodes.Status404NotFound`
  // 被改寫成變數（`statusCode: someConst`、`WriteAsJsonAsync` 之類）時，R1／R2／R3／R5／R6／R7
  // 全都看不到（那正是閘門自己列的盲區），唯一的訊號就是「唯一的產生點不見了」。
  it("一處都沒有 ⇒ exit 1、說出「唯一的產生點不見了」，且歸零規則全部沉默", () => {
    withSandbox((sandbox) => {
      // 把 404 那一行拿掉——**其餘兩條產生點（401／500）要留著**：它們是旁邊兩條「恰好一處」
      // 規則的前提，少了它們這一支的紅燈就不只來自 R4，`expectOnlyRules` 那條斷言會變成
      // 在測別的東西。（`filter` 會連第 6 行那行註解一起濾掉——它也含 `Status404NotFound`；
      // 無妨，遮罩的正向對照是「乾淨沙箱」那一支。）
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status404NotFound")));
      // 另留一份乾淨的呼叫端——證明紅燈來自 R4 的歸零分支，不是來自空掃描。
      write(sandbox, `${ENDPOINTS}/Caller.cs`, CALLER);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R4"));
      expect(result.stderr).toContain("唯一的產生點不見了");
      // 判別力：這個形狀之下**沒有任何歸零規則會響**（上面三條路徑的分工）。
      expectOnlyRules(result.stderr, []);
      // 也不是「位置不對」那一支（那支是「恰好 1 處」）。
      expect(result.stderr).not.toContain(R4_ELSEWHERE);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("恰好一處但不在 ApiResults.cs ⇒ exit 1、指出它不在該在的檔案", () => {
    withSandbox((sandbox) => {
      // 404 那一行從 ApiResults.cs 拿掉、搬到別的檔案：全沙箱只有 `OtherOrigin.cs` 這一處。
      // （401／500 兩行留著，理由同上——這一支要紅在 R4 的位置分支，不是紅在別人。）
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status404NotFound")));
      write(
        sandbox,
        `${ENDPOINTS}/OtherOrigin.cs`,
        ORIGIN("public static IResult NotFound() => Results.Json(new { code = \"x\" }, statusCode: StatusCodes.Status404NotFound);"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R4"));
      expect(result.stderr).toContain("OtherOrigin.cs:7");
      expect(result.stderr).toContain(R4_ELSEWHERE);
      // 訊息要說得出它**該**在哪裡——否則下一個人只知道「位置不對」。
      expect(result.stderr).toContain(API_RESULTS);
      expect(result.stdout).not.toContain(PASS);
    });
  });
});

describe("check-error-codes：R14 的「恰好一處」（401 那一半）", () => {
  // 與上面 R4 那一組逐支對應。**這一組存在的理由是「兩條規則共用一個驅動」**：
  // 驅動若被寫成只認 R4（`GATE_A_R4` 那個舊形狀），這裡的三支會全部變成「exit 0」——
  // 而 R4 那一組照樣全綠。少了它，把驅動退回硬編碼的改動沒有任何測試會響。
  it("兩處 ⇒ exit 1、兩處都被指名", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        `${ENDPOINTS}/SecondOrigin.cs`,
        ORIGIN(
          'public static IResult Unauthorized() => Results.Json(new { code = "x" }, statusCode: StatusCodes.Status401Unauthorized);',
        ),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R14"));
      // 沙箱的 1 處（ApiResults.cs:14）＋ 新的 1 處。
      expect(result.stderr).toContain("ApiResults.cs:14");
      expect(result.stderr).toContain("SecondOrigin.cs:7");
      // 「多於一處」那個分支，不是「位置不對」那個；且**不是** R4 那一支。
      expect(result.stderr).not.toContain(R4_ELSEWHERE);
      expect(result.stderr).not.toContain(R14_ELSEWHERE);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("一處都沒有 ⇒ exit 1、說出「唯一的產生點不見了」，且歸零規則全部沉默", () => {
    withSandbox((sandbox) => {
      // 先把 404 的產生點還原成乾淨的（否則紅燈來自 R4、這一支就白測了），
      // 再把 401 那一行拿掉——沙箱裡一個 `StatusCodes.Status401Unauthorized` 都沒有。
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status401Unauthorized")));
      write(sandbox, `${ENDPOINTS}/Caller.cs`, CALLER);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R14"));
      expect(result.stderr).toContain("唯一的產生點不見了");
      // 判別力：這個形狀之下**沒有任何歸零規則會響**（R8–R13 全都看不到它）。
      expectOnlyRules(result.stderr, []);
      // 也不是「位置不對」那一支。
      expect(result.stderr).not.toContain(R14_ELSEWHERE);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("恰好一處但不在 ApiResults.cs ⇒ exit 1、指出它不在該在的檔案", () => {
    withSandbox((sandbox) => {
      // 404 的產生點留著、401 的搬到別的檔案：全沙箱只有 `OtherOrigin.cs` 那一處。
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status401Unauthorized")));
      write(
        sandbox,
        `${ENDPOINTS}/OtherOrigin.cs`,
        ORIGIN(
          'public static IResult Unauthorized() => Results.Json(new { code = "x" }, statusCode: StatusCodes.Status401Unauthorized);',
        ),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R14"));
      expect(result.stderr).toContain("OtherOrigin.cs:7");
      expect(result.stderr).toContain(R4_ELSEWHERE); // 這條分支共有的字樣
      expect(result.stderr).toContain(R14_ELSEWHERE); // 401 自己的那一句
      expect(result.stderr).toContain(API_RESULTS);
      expect(result.stdout).not.toContain(PASS);
    });
  });
});

// ---- 500 家族（2026-09-21）----------------------------------------------------------

/**
 * 「單一違規檔」的斷言：紅在指定的那一條、`Legacy.cs:7`，**其餘歸零規則與四條「恰好一處」
 * 全部沉默**。
 *
 * 比上面幾組的逐支寫法多做一句「四條恰好一處也不能響」：這幾支的 `clean()` 是完整的
 * （四個產生點各一處），所以 R4／R14／R15／R25 一旦出聲就代表**規則本身被改壞了**（例如 R16 的
 * `\.StatusCode\([^)]*5\d\d` 放寬到會命中別的檔案）——那與「新規則抓到了該抓的東西」在
 * exit code 上長得一模一樣。
 */
const singleFault = (id, line7) => {
  withSandbox((sandbox) => {
    clean(sandbox);
    write(sandbox, LEGACY, offender(line7));

    const result = runGate(sandbox);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(rule(id));
    expect(result.stderr).toContain("Legacy.cs:7");
    expectOnlyRules(result.stderr, [id]);
    for (const exact of EXACT_ONE_RULES) {
      expect(result.stderr).not.toContain(rule(exact));
    }
    expect(result.stdout).not.toContain(PASS);
  });
};

describe("check-error-codes：500 的六種替代形狀（應 exit 1）", () => {
  // 逐條對應上面兩個 describe。**與 401 那一組同樣是「先列舉形狀、再逐條寫規則」**
  // （404 那批是事後補的——`Results.Forbid()` 就是「只數了一種形狀」的代價）。普查結果：
  // 整個 5xx 家族在 `src/` 裡除了 `ApiResults.cs` 自己那一處之外**是 0 處**，所以這六條
  // 今天全部是歸零規則（R15 那一條才有「恰好 1 處」）。
  //
  // **有分支的規則，每一個分支都要有自己的輸入**（F1 的教訓：漏寫一個分支就是一條閘門
  // 靜默通過的形狀）：R16 的兩個前綴、R17／R21 的兩個接收者、R19 的兩個型別、R20 的四種
  // 寫法各一列。**把兩條形狀寫進同一個檔是沒有判別力的**——另一條照樣命中、照樣 exit 1，
  // 那個漏就永遠看不出來。
  //
  // ★ **突變沒讓測試變紅有兩種成因，判準是去讀「突變有沒有改變行為」，不是看燈號**
  // （2026-09-21 這一批用一次代價換來的）：① 測試沒有判別力；② **突變本身是無效的**。
  // 這裡的三個突變（M-A／M-B／M-E：拿掉 `(?:Results|TypedResults)` 的 `TypedResults` 那一支、
  // 或給 R16 加上 `Results.` 前綴）**全部落在②**——`Results\.` 是 `TypedResults\.` 的子字串，
  // 改完的 pattern 與原本**命中完全相同的集合**。綠燈在這裡只說明「行為沒變」，
  // 而不是「這一列是空轉」；**把它讀成後者會讓人刪掉三列有判別力的測試**。
  // 有判別力的是兩個鏡像方向（收成只剩 `TypedResults.`／改成帶詞界的 `\bResults\.`），
  // 兩邊都實測過、各有各的紅燈。**加突變時先問「這個突變改變了什麼行為」**，
  // 答不出來就換一個形狀再問一次。
  it("R16：`Results.StatusCode(500)` ⇒ exit 1、指名它", () =>
    singleFault("R16", "public static IResult Load() => Results.StatusCode(500);"));

  // **這一列原本的理由是錯的，2026-09-21 由突變更正**：原文寫規則「刻意不帶前綴，因為帶了
  // 會把 `TypedResults.` 排除在外」——把 pattern 改成 `/Results\.StatusCode\(…/` 之後
  // **39 支全綠**：`Results\.` 是 `TypedResults\.` 的**子字串**（`TypedResults` 以 `Results`
  // 結尾），那個突變**沒有改變行為** ⇒ 它什麼都證明不了（**無效突變**，不是「測試沒判別力」）。
  //
  // 這一列真正守的是「明確寫出前綴」最自然的那種寫法：**帶詞界**的 `\bResults\.StatusCode\(`
  // ——`\b` 在 `TypedResults` 的 `d` 與 `R` 之間不成立。實測（M-A3）該突變**恰好讓這一列紅**。
  it("R16（`TypedResults.` 拼法）：規則寫成帶詞界的 `Results.` 時就會漏掉它", () =>
    singleFault("R16", "public static IResult Load() => TypedResults.StatusCode(503);"));

  it("R17：`Results.InternalServerError()` ⇒ exit 1、指名它", () =>
    singleFault("R17", "public static IResult Load() => Results.InternalServerError();"));

  // R17 的 `(?:Results|TypedResults)` 裡，`Results` 那一支**是多餘的**（同 R16 的子字串關係：
  // `Results\.InternalServerError` 本身就命中 `TypedResults.InternalServerError`；實測拿掉
  // `TypedResults` 那一支 ⇒ 39 支全綠 ⇒ **無效突變**）。留著只是讓兩個前綴在原始碼裡一眼
  // 看得見（`ApiResults.cs` 的檔頭也是這樣寫的）——**不是**這一列的判別力來源。
  // **兩列各守一邊，各自都有紅燈**（皆實測）：規則收成只剩 `TypedResults.`（M-B2）⇒
  // `Results.` 那一列紅；寫成帶詞界的 `\bResults\.`（M-B3）⇒ **這一列**紅。
  it("R17（`TypedResults.` 拼法）：規則寫成帶詞界的 `Results.` 時就會漏掉它", () =>
    singleFault("R17", "public static IResult Load() => TypedResults.InternalServerError();"));

  it("R18：裸的 `statusCode: 500` ⇒ exit 1、指名它", () =>
    singleFault("R18", 'public static IResult Load() => Results.Json(new { code = "x" }, statusCode: 500);'));

  it("R19：`StatusCodeResult`（MVC 型別）⇒ exit 1", () =>
    singleFault("R19", "public static IResult Load() => new StatusCodeResult(500);"));

  // R19 的 `HttpStatusCode.InternalServerError` 那一格。**只認這一個成員是刻意的**（見閘門
  // 檔頭）：其餘 5xx 成員今天 0 處、不在規則內，所以這一列不能拿 `HttpStatusCode.BadGateway`
  // 之類來測——那會把「不在規則內」寫成契約（今天寬容，不代表明天要繼續寬容）。
  it("R19：`HttpStatusCode.InternalServerError` ⇒ exit 1", () =>
    singleFault("R19", "public static HttpResponseMessage Load() => new HttpResponseMessage(HttpStatusCode.InternalServerError);"));

  it("R20：`UseExceptionHandler` ⇒ exit 1（它會與 `Program.cs` 的中介層搶同一個例外）", () =>
    singleFault("R20", 'public static void Configure(IApplicationBuilder app) => app.UseExceptionHandler("/error");'));

  it("R20：`AddProblemDetails` ⇒ exit 1", () =>
    singleFault("R20", "public static void Configure(IServiceCollection services) => services.AddProblemDetails();"));

  // 這一列是**開發版面專屬**的那一條管線：`WebApplication` 在 Development 下隱式加的就是它
  // （那份隱式的掃不到——它不在原始碼裡，見閘門檔頭）。手寫的那一份因此必須被擋下來：否則
  // 同一個例外會有兩條管線，先攔到的那條決定 body 的形狀。
  it("R20：`UseDeveloperExceptionPage` ⇒ exit 1", () =>
    singleFault("R20", "public static void Configure(IApplicationBuilder app) => app.UseDeveloperExceptionPage();"));

  it("R20：`IExceptionHandler`（自訂處理器的介面本身）⇒ exit 1", () =>
    singleFault("R20", "private sealed class Handler : IExceptionHandler { }"));

  // R21 的兩列刻意**不用字面值當引數**：`Results.Problem("…")` 會先被既有的 `PATTERN`
  // （字面值錯誤訊息）攔下、`process.exit(1)` 之後根本走不到歸零規則的報告 ⇒ 那一列會變成
  // 在測 `PATTERN`。用 `ex.Message` 當引數剛好也是這一條要擋的實例：把例外訊息塞進
  // `ProblemDetails` 的 `detail` 既是前端認不得的 body 形狀，也是一種洩漏。
  it("R21：`Results.Problem(` ⇒ exit 1（body 是 `ProblemDetails`，前端認不得）", () =>
    singleFault("R21", "public static IResult Load(Exception ex) => Results.Problem(ex.Message);"));

  // 同 R16／R17：`Results` 那一支是子字串關係下的冗餘（拿掉 ⇒ 39 支全綠，無效突變），
  // 這一列的判別力同樣來自**帶詞界**的寫法（M-E3 實測 ⇒ 恰好這一列紅）。
  it("R21（`TypedResults.` 拼法）：規則寫成帶詞界的 `Results.` 時就會漏掉它", () =>
    singleFault("R21", "public static IResult Load(Exception ex) => TypedResults.Problem(ex.Message);"));
});

describe("check-error-codes：500 的規則不誤傷 4xx（應 exit 0）", () => {
  // R16（`.StatusCode(…5xx…)`）與 R18（`statusCode: 5xx`）都只認 5xx，而 403 是**手寫站點**
  // 的正當寫法（2026-09-19 的 403 那批就是這樣收斂的）⇒ 必須照綠。少了這一支，「只認 5xx」
  // 與「任何手寫狀態碼都擋」在測試上分不開——而後者的下場是閘門永遠紅，下一個人只會去加
  // 白名單（那正是這個 repo 明文禁止的收場）。
  it("`.StatusCode(403)` 與 `statusCode: StatusCodes.Status403Forbidden` ⇒ exit 0", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 兩條形狀寫在同一行是刻意的：兩者都必須是綠的，這裡不需要把它們分開。
      write(
        sandbox,
        LEGACY,
        offender(
          'public static IResult A() => Results.StatusCode(403); public static IResult B() => Results.Json(new { code = "x" }, statusCode: StatusCodes.Status403Forbidden);',
        ),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
      // 這個 3 是沙箱裡我自己放的檔案數（ApiResults.cs ＋ Caller.cs ＋ Legacy.cs），不是 repo 的數字。
      expect(result.stdout).toContain("3 個後端原始檔");
      for (const id of [...ZERO_RULES, ...EXACT_ONE_RULES]) {
        expect(result.stderr).not.toContain(rule(id));
      }
    });
  });
});

describe("check-error-codes：R15 的「恰好一處」（500 那一半）", () => {
  // 與上面 R4／R14 兩組逐支對應。**這一組是「驅動不是硬編碼」的第二個判別點**：驅動若被
  // 退回只認 R4 的舊形狀，這一組三支會全部變成 exit 0，而 R4 那一組照樣全綠；只認 R4／R14
  // 的形狀同理——R14 那一組擋的是第一種、這一組擋的是第二種，兩者缺一就有回頭路。
  it("兩處 ⇒ exit 1、兩處都被指名", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        `${ENDPOINTS}/SecondOrigin.cs`,
        ORIGIN(
          'public static IResult InternalError() => Results.Json(new { code = "x" }, statusCode: StatusCodes.Status500InternalServerError);',
        ),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R15"));
      // 沙箱的 1 處（ApiResults.cs:17）＋ 新的 1 處。
      expect(result.stderr).toContain("ApiResults.cs:17");
      expect(result.stderr).toContain("SecondOrigin.cs:7");
      // 「多於一處」那個分支，不是「位置不對」那個；且旁邊兩條「恰好一處」沒有被牽連。
      expect(result.stderr).not.toContain(R4_ELSEWHERE);
      expect(result.stderr).not.toContain(R15_ELSEWHERE);
      expect(result.stderr).not.toContain(rule("R4"));
      expect(result.stderr).not.toContain(rule("R14"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("一處都沒有 ⇒ exit 1、說出「唯一的產生點不見了」，且歸零規則全部沉默", () => {
    withSandbox((sandbox) => {
      // 404 與 401 兩個產生點留著（否則紅燈來自 R4／R14，這一支就白測了），只拿掉 500 那一行。
      // `filter` 會連第 6 行那行註解一起濾掉（它也含 `Status500InternalServerError`）——無妨。
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status500InternalServerError")));
      write(sandbox, `${ENDPOINTS}/Caller.cs`, CALLER);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R15"));
      expect(result.stderr).toContain("唯一的產生點不見了");
      // 判別力：這個形狀之下**沒有任何歸零規則會響**——`statusCode: StatusCodes.…` 正是那六條
      // 替代形狀的盲區（它們找的是手寫的形狀），唯一的訊號就是這一條歸零分支。
      expectOnlyRules(result.stderr, []);
      // 也不是「位置不對」那一支，且旁邊兩條「恰好一處」沒有被牽連。
      expect(result.stderr).not.toContain(R15_ELSEWHERE);
      expect(result.stderr).not.toContain(rule("R4"));
      expect(result.stderr).not.toContain(rule("R14"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("恰好一處但不在 ApiResults.cs ⇒ exit 1、指出它不在該在的檔案", () => {
    withSandbox((sandbox) => {
      // 404／401 的產生點留著、500 的搬到別的檔案：全沙箱只有 `OtherOrigin.cs` 那一處。
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status500InternalServerError")));
      write(
        sandbox,
        `${ENDPOINTS}/OtherOrigin.cs`,
        ORIGIN(
          'public static IResult InternalError() => Results.Json(new { code = "x" }, statusCode: StatusCodes.Status500InternalServerError);',
        ),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R15"));
      expect(result.stderr).toContain("OtherOrigin.cs:7");
      expect(result.stderr).toContain(R4_ELSEWHERE); // 這條分支共有的字樣
      expect(result.stderr).toContain(R15_ELSEWHERE); // 500 自己的那一句
      expect(result.stderr).toContain(API_RESULTS);
      expect(result.stdout).not.toContain(PASS);
    });
  });
});

// ---- 429 家族（2026-09-24）----------------------------------------------------------

describe("check-error-codes：429 的替代形狀（應 exit 1）", () => {
  // 與 500 那一組同樣是「先列舉形狀、再逐條寫規則」——但**列舉的來源是當場編譯**
  // （探針專案，結果寫在閘門檔頭），不是從前三個家族推的：`Results.TooManyRequests` 與
  // `TypedResults.TooManyRequests` **不存在**（CS0117）⇒ 這一族沒有「框架方法名」那一類規則，
  // 所以只有三列。**不要**為了對稱補到六列——那是替一個不存在的 API 留守衛。
  it("R22：`Results.StatusCode(429)` ⇒ exit 1、指名它", () =>
    singleFault("R22", "public static IResult Load() => Results.StatusCode(429);"));

  // 與 R3／R10／R16 同一個理由的第二個落點：規則**不帶前綴**，所以 `TypedResults.` 那一支
  // 也必須命中（兩者是同一個被禁的形狀：空的 429）。前三個家族各有一列釘同一個形狀。
  it("R22（`TypedResults.` 拼法）⇒ exit 1", () =>
    singleFault("R22", "public static IResult Load() => TypedResults.StatusCode(429);"));

  it("R23：裸的 `statusCode: 429` ⇒ exit 1、指名它", () =>
    singleFault("R23", 'public static IResult Load() => Results.Json(new { code = "x" }, statusCode: 429);'));

  // **同一個形狀的另一個拼法**（2026-09-24 複閱的 M-1）。`RateLimiterOptions.RejectionStatusCode`
  // 是 `int` ⇒ 空 body 的 429 最自然的寫法其實是**等號**那一種，而它原本**一條規則都不命中**
  // （R22 要 `.StatusCode(`、R23 要冒號、R24 是 `HttpStatusCode.*`、R25 要符號拼法）。
  // ★ 與下面那一列（R25 的 `= StatusCodes.Status429TooManyRequests`）**必須各自一列**：
  // 兩者是同一個屬性的不同寫法，而「哪一條規則接住它」正是這一對要釘住的東西
  // ——寫成同一列的話，閘門把兩種拼法混成同一條也看不出來。
  it("R23：`RejectionStatusCode = 429`（等號拼法）⇒ exit 1、指名它", () =>
    singleFault("R23", "public static void Configure(RateLimiterOptions o) => o.RejectionStatusCode = 429;"));

  it("R24：`HttpStatusCode.TooManyRequests` ⇒ exit 1", () =>
    singleFault("R24", "public static HttpResponseMessage Load() => new HttpResponseMessage(HttpStatusCode.TooManyRequests);"));

  // **反向對照**：這一族只認 429 ⇒ `400`／`403` 這種**手寫但合法**的狀態碼必須照綠
  // （403 的手寫站點是 2026-09-19 那批的正當收斂結果，不是違規）。少了它，「只認 429」與
  // 「任何手寫狀態碼都擋」在測試上分不開，而後者的下場是閘門永遠紅、下一個人只會去加白名單
  // （本 repo 明文禁止的收場）。
  //
  // ★ **刻意避開 5xx 與 404／401**：`Results.StatusCode(503)` 會命中 **R16**（5xx 那條），
  // 拿它當「應該綠」的輸入會讓這一支紅在別人家——第一版就是這樣寫的，當場改成 400。
  it("`.StatusCode(400)`／`.StatusCode(403)` 不是這一族的形狀 ⇒ exit 0", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        LEGACY,
        offender("public static IResult A() => Results.StatusCode(400); public static IResult B() => Results.StatusCode(403);"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
      for (const id of [...ZERO_RULES, ...EXACT_ONE_RULES]) {
        expect(result.stderr).not.toContain(rule(id));
      }
    });
  });

  // R23 的 `(?!\d)` 是**這一族唯一有測到的**數字邊界（R22／R24 沒有那道守衛，與 R3／R6 一致
  // ——歸零規則寧可大聲）。留著它是刻意的：少了它，`statusCode: 4290` 會被當成 429 而永遠紅。
  it("`statusCode: 4290` 不是 429 的形狀 ⇒ exit 0（釘住 R23 的 `(?!\\d)`）", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      write(
        sandbox,
        LEGACY,
        offender('public static IResult Load() => Results.Json(new { code = "x" }, statusCode: 4290);'),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
      for (const id of [...ZERO_RULES, ...EXACT_ONE_RULES]) {
        expect(result.stderr).not.toContain(rule(id));
      }
    });
  });
});

describe("check-error-codes：R25 的「恰好一處」（429 那一半）", () => {
  // 與 R4／R14／R15 三組逐支對應。**這一組是「驅動不是硬編碼」的第三個判別點**：把驅動退回
  // 只認 R4（或只認 R4／R14／R15）的形狀時，這一組三支會全部變成 exit 0，而前三組照樣全綠。
  it("兩處 ⇒ exit 1、兩處都被指名（`RejectionStatusCode` 就是那個具體的退化寫法）", () => {
    withSandbox((sandbox) => {
      clean(sandbox);
      // 違規的內容刻意用**真實世界會寫出來的那一行**，不是隨便一個 `Results.Json`：
      // `options.RejectionStatusCode = StatusCodes.Status429TooManyRequests` 產生的是一個
      // **空的 429**（沒有 body ⇒ 前端唯一的錯誤出口只能退回泛用譯文），那正是這一條要擋的。
      write(
        sandbox,
        `${ENDPOINTS}/RateLimiterSetup.cs`,
        ORIGIN("public static void Configure(RateLimiterOptions o) => o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R25"));
      // 沙箱的 1 處（ApiResults.cs:20）＋ 新的 1 處。
      expect(result.stderr).toContain("ApiResults.cs:20");
      expect(result.stderr).toContain("RateLimiterSetup.cs:7");
      // 「多於一處」那個分支，不是「位置不對」那個；且旁邊三條「恰好一處」沒有被牽連。
      expect(result.stderr).not.toContain(R4_ELSEWHERE);
      expect(result.stderr).not.toContain(R25_ELSEWHERE);
      expect(result.stderr).not.toContain(rule("R4"));
      expect(result.stderr).not.toContain(rule("R14"));
      expect(result.stderr).not.toContain(rule("R15"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("一處都沒有 ⇒ exit 1、說出「唯一的產生點不見了」，且歸零規則全部沉默", () => {
    withSandbox((sandbox) => {
      // 404／401／500 三個產生點留著（否則紅燈來自 R4／R14／R15，這一支就白測了），
      // 只拿掉 429 那一行。`filter` 會連第 6 行那行註解一起濾掉（它也含 429 的 token）——無妨。
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status429TooManyRequests")));
      write(sandbox, `${ENDPOINTS}/Caller.cs`, CALLER);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R25"));
      expect(result.stderr).toContain("唯一的產生點不見了");
      // 判別力：這個形狀之下**沒有任何歸零規則會響**——`statusCode: StatusCodes.…` 正是三條
      // 替代形狀的盲區（它們找的是手寫的形狀），唯一的訊號就是這一條歸零分支。
      expectOnlyRules(result.stderr, []);
      // 也不是「位置不對」那一支，且旁邊三條「恰好一處」沒有被牽連。
      expect(result.stderr).not.toContain(R25_ELSEWHERE);
      expect(result.stderr).not.toContain(rule("R4"));
      expect(result.stderr).not.toContain(rule("R14"));
      expect(result.stderr).not.toContain(rule("R15"));
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("恰好一處但不在 ApiResults.cs ⇒ exit 1、指出它不在該在的檔案", () => {
    withSandbox((sandbox) => {
      // 404／401／500 的產生點留著、429 的搬到別的檔案：全沙箱只有 `OtherOrigin.cs` 那一處。
      write(sandbox, API_RESULTS, API_RESULTS_FILE.filter((line) => !line.includes("Status429TooManyRequests")));
      write(
        sandbox,
        `${ENDPOINTS}/OtherOrigin.cs`,
        ORIGIN(
          'public static IResult TooMany() => Results.Json(new { code = "x" }, statusCode: StatusCodes.Status429TooManyRequests);',
        ),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule("R25"));
      expect(result.stderr).toContain("OtherOrigin.cs:7");
      expect(result.stderr).toContain(R4_ELSEWHERE); // 這條分支共有的字樣
      expect(result.stderr).toContain(R25_ELSEWHERE); // 429 自己的那一句
      expect(result.stderr).toContain(API_RESULTS);
      expect(result.stdout).not.toContain(PASS);
    });
  });
});
