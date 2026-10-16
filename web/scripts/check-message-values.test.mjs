// `check-message-values.mjs`（設計 §4.2 的閘門 C）的測試。
//
// **測試在記憶體裡餵字串，不碰 repo 的檔案**（與 `label-table-extract.test.mjs` 同做法）；
// 驅動程式本身另有一支沙箱的端到端（見檔尾）。
//
// 為什麼要有這一支：這道閘門的每一個判準都是「**結構**」，而結構判準的失效方式有兩種，
// 而兩者在綠燈下長得一樣——(a) 認得太多（把 DTO 當成 HTTP body 去比），(b) 認得太少
// （宣告成「認不得」而靜默放行）。所以每個形狀都配一支**正向**與一支**反向**：
// 正向證明它認得，反向證明它**不是靠猜**（`bail` 的那幾支）。
//
// 規則層（R1–R4 與三個守衛）的測試在第二個 describe：每一條規則都有一支「該過」與
// 一支「該紅」，因為**綠燈在「實作正確」與「根本沒被測到」兩種情況下長得一樣**。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanCSharpFile, resolveForwards } from "./lib/csharp-message-sites.mjs";
import { compareSites } from "./lib/message-value-compare.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url)); // web/scripts
const webDir = join(scriptsDir, "..");

/** 測試用的 `ErrorCodes.cs` 對照表。名字刻意用**真的**常數名，出錯時的訊息才讀得懂。 */
const CODES = new Map([
  ["RequestInvalid", "request.invalid"],
  ["CardTitleRequired", "card.titleRequired"],
  ["CardMemberNotProjectMember", "card.memberNotProjectMember"],
  ["CardFieldTextTooLong", "card.fieldTextTooLong"],
  ["RequestBodyTooLarge", "request.bodyTooLarge"],
  ["QueryRangeTooLong", "query.rangeTooLong"],
]);

const scan = (source, codes = CODES) => scanCSharpFile(source, { label: "probe.cs", codes });

/** 把站點壓成好讀的形狀，斷言才不會被無關欄位干擾。 */
const slim = (sites) =>
  sites.map((s) => ({
    line: s.line,
    kind: s.kind,
    code: s.code,
    value: s.value,
    shape: s.shape,
    params: s.params,
    root: s.root,
    guard: s.guard,
  }));

/** 執行 `fn` 並回傳它拋出的訊息；沒拋就回 `null`。 */
const bailMessage = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

const method = (body) => `public static class Probe
{
    public static IResult Run(int n)
    {
${body}
    }
}
`;

describe("scanCSharpFile：認得的形狀", () => {
  it("最簡單的字面值站點：code 常數 ＋ message 字面值", () => {
    const { sites } = scan(
      method(`        return Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "卡片標題不可為空" });`),
    );
    expect(slim(sites)).toEqual([
      {
        line: 5,
        kind: "literal",
        code: "card.titleRequired",
        value: "卡片標題不可為空",
        shape: null,
        params: null,
        root: null,
        guard: null,
      },
    ]);
  });

  it("三種認得的產生器：`Results.*`／`TypedResults.*`／`…WriteAsJsonAsync`", () => {
    const { sites } = scan(
      method(`        if (n > 0) return Results.Conflict(new { code = ErrorCodes.CardTitleRequired, message = "a" });
        if (n > 1) return TypedResults.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "b" });
        await context.Response.WriteAsJsonAsync(new { code = ErrorCodes.CardTitleRequired, message = "c" });`),
    );
    expect(slim(sites).map((s) => s.value)).toEqual(["a", "b", "c"]);
  });

  it("`@params` 的成員名被記下來（R3 的輸入）", () => {
    const { sites } = scan(
      method(`        return Results.BadRequest(new { code = ErrorCodes.CardFieldTextTooLong, message = "太長", @params = new { max = 1000 } });`),
    );
    expect(sites[0].params).toEqual(["max"]);
  });

  it("多行物件與巢狀括號照樣解析", () => {
    const { sites } = scan(
      method(`        return Results.BadRequest(new
        {
            code = ErrorCodes.CardFieldTextTooLong,
            message =
                $"文字欄位必須為 {Max(1, 2)} 個字元以內的字串",
            @params = new { max = Max(1, 2) },
        });`),
    );
    expect(sites[0].code).toBe("card.fieldTextTooLong");
    expect(sites[0].params).toEqual(["max"]);
    // 洞換成 `\u0000`——`{Max(1, 2)}` 是一個洞，**它的內容不會進形狀**（那是值，不是文字）。
    expect(sites[0].shape).toBe("文字欄位必須為 \u0000 個字元以內的字串");
  });

  it("三元式成對：展開成兩個站點，各自的 code 與值", () => {
    const { sites } = scan(
      method(`        await context.Response.WriteAsJsonAsync(new
        {
            code = n > 0 ? ErrorCodes.RequestBodyTooLarge : ErrorCodes.RequestInvalid,
            message = n > 0 ? "請求過大" : "請求格式錯誤",
        });`),
    );
    expect(slim(sites).map((s) => [s.code, s.value])).toEqual([
      ["request.bodyTooLarge", "請求過大"],
      ["request.invalid", "請求格式錯誤"],
    ]);
  });

  it("逐字字串（`@\"…\"`）是字面值，`\"\"` 會還原成一個雙引號", () => {
    const { sites } = scan(
      method(`        return Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = @"他是 ""工程師""" });`),
    );
    expect(sites[0].value).toBe('他是 "工程師"');
  });

  it("生產者：回傳型別 `(bool, string?, string?)` 的方法，三元組各自成站點", () => {
    const { sites } = scan(`public static class Probe
{
    public static (bool Ok, string? Code, string? Message) Validate(int n)
    {
        if (n < 0) return (false, ErrorCodes.CardTitleRequired, "太小");
        if (n > 9) return (false, ErrorCodes.CardTitleRequired, "太大");
        return (true, null, null);
    }
}
`);
    // `(true, null, null)` 不是站點——它沒有訊息，不是「值為空」。
    expect(sites.map((s) => [s.line, s.code, s.value, s.producer])).toEqual([
      [5, "card.titleRequired", "太小", "Validate"],
      [6, "card.titleRequired", "太大", "Validate"],
    ]);
    expect(sites.every((s) => s.kind === "producer")).toBe(true);
  });

  it("轉發：簡寫 `{ code, message }` 與成員 `{ code = v.Code, message = v.Message }`", () => {
    const { sites } = scan(
      method(`        var (ok, code, message) = Validate(n);
        if (!ok) return Results.BadRequest(new { code, message });
        var v = ValidateOne(n);
        if (!v.Ok) return Results.BadRequest(new { code = v.Code, message = v.Message });`),
    );
    expect(slim(sites).map((s) => [s.kind, s.root])).toEqual([
      ["forward", "$shorthand"],
      ["forward", "v"],
    ]);
  });

  it("轉發站點帶 `@params` 時，碼由緊鄰上一行的守衛指名", () => {
    const { sites } = scan(
      method(`        var (ok, code, message) = Validate(n);
        if (!ok)
        {
            if (code == ErrorCodes.CardFieldTextTooLong)
                return Results.BadRequest(new { code, message, @params = new { max = 1000 } });
            return Results.BadRequest(new { code, message });
        }`),
    );
    expect(slim(sites).map((s) => [s.kind, s.guard, s.params])).toEqual([
      ["forward", "card.fieldTextTooLong", ["max"]],
      ["forward", null, null],
    ]);
  });

  it("排除：運算式主體的匿名物件是 DTO，不是 HTTP body", () => {
    const { sites } = scan(`public static class Probe
{
    public static object Push(int n) => new { id = n, message = "通知內容" };
}
`);
    expect(slim(sites)).toEqual([
      { line: 3, kind: "mapper", code: undefined, value: undefined, shape: undefined, params: null, root: null, guard: null },
    ]);
  });

  it("排除：`message = ErrorMessages.For(code)` 交給閘門 B", () => {
    const { sites } = scan(
      method(`        return Results.NotFound(new { code = ErrorCodes.CardTitleRequired, message = ErrorMessages.For(ErrorCodes.CardTitleRequired) });`),
    );
    expect(sites[0].kind).toBe("delegated");
  });

  it("排除：`code = IdentityErrorCodes.Map(…)`", () => {
    const { sites } = scan(
      method(`        return Results.BadRequest(new { code = IdentityErrorCodes.Map(e.Code), message = e.Description });`),
    );
    expect(sites[0].kind).toBe("identity");
  });

  it("註解與字串裡的 `new { code = …, message = … }` 不是站點", () => {
    const { sites } = scan(
      method(`        // 範本：Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "x" })
        var s = "new { code = ErrorCodes.RequestInvalid, message = \\"y\\" }";
        return Results.Ok(s);`),
    );
    expect(sites).toEqual([]);
  });
});

describe("scanCSharpFile：認不得就大聲（fail closed）", () => {
  it("不是認得的產生器的引數 ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(method(`        return Whatever.Build(new { code = ErrorCodes.RequestInvalid, message = "x" });`)),
    );
    expect(message).toContain("probe.cs:5");
    expect(message).toContain("Whatever.Build");
  });

  it("既不是引數也不是運算式主體 ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(method(`        var o = new { code = ErrorCodes.RequestInvalid, message = "x" };`)),
    );
    expect(message).toContain("probe.cs:5");
    expect(message).toContain("既不是");
  });

  it("有 `message` 而沒有 `code` ⇒ 拋（不猜它屬於哪個碼）", () => {
    const message = bailMessage(() =>
      scan(method(`        return Results.BadRequest(new { message = "x" });`)),
    );
    expect(message).toContain("有 `message` 而沒有 `code`");
  });

  it("`@params` 不是 `new { … }` ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(method(`        return Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "x", @params = bag });`)),
    );
    expect(message).toContain("`@params` 不是");
  });

  it("`code` 不是 `ErrorCodes` 的常數 ⇒ 拋（不猜那個變數是什麼）", () => {
    const message = bailMessage(() =>
      scan(method(`        return Results.BadRequest(new { code = someCode, message = "x" });`)),
    );
    expect(message).toContain("不是 ErrorCodes.cs 的常數");
  });

  it("`code` 是 `ErrorCodes` 的常數但它不在對照表裡 ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(method(`        return Results.BadRequest(new { code = ErrorCodes.NotInTable, message = "x" });`)),
    );
    expect(message).toContain("NotInTable");
  });

  it("原始字串（`\"\"\"…\"\"\"`）當訊息 ⇒ 拋（遮罩層不認得它）", () => {
    const message = bailMessage(() =>
      scan(method(`        return Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = """多行""" });`)),
    );
    expect(message).toContain("原始字串");
  });

  it("轉發的兩邊不同源 ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(
        method(`        var v = ValidateOne(n);
        var w = ValidateOne(n);
        if (!v.Ok) return Results.BadRequest(new { code = v.Code, message = w.Message });`),
      ),
    );
    expect(message).toContain("不是同一個");
  });

  it("轉發站點帶 `@params` 而上一行不是守衛 ⇒ 拋（參數對不到碼）", () => {
    const message = bailMessage(() =>
      scan(
        method(`        var (ok, code, message) = Validate(n);
        if (!ok) return Results.BadRequest(new { code, message, @params = new { max = 1000 } });`),
      ),
    );
    expect(message).toContain("守衛");
  });

  it("三元式只有一邊 ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(method(`        return Results.BadRequest(new { code = n > 0 ? ErrorCodes.RequestInvalid : ErrorCodes.CardTitleRequired, message = "x" });`)),
    );
    expect(message).toContain("只有一邊是三元式");
  });

  it("三元式的兩個條件不同 ⇒ 拋（那兩組臂對不起來）", () => {
    const message = bailMessage(() =>
      scan(
        method(`        return Results.BadRequest(new { code = n > 0 ? ErrorCodes.RequestInvalid : ErrorCodes.CardTitleRequired, message = n < 0 ? "a" : "b" });`),
      ),
    );
    expect(message).toContain("條件不同");
  });

  it("生產者三元組的第三個元素不是字串 ⇒ 拋", () => {
    const message = bailMessage(() =>
      scan(`public static class Probe
{
    public static (bool Ok, string? Code, string? Message) Validate(int n)
    {
        if (n < 0) return (false, ErrorCodes.CardTitleRequired, SomeText());
        return (true, null, null);
    }
}
`),
    );
    expect(message).toContain("不是字串字面值");
  });
});

describe("resolveForwards：轉發要接到認得的生產者", () => {
  const filesOf = (source) => {
    const result = scanCSharpFile(source, { label: "probe.cs", codes: CODES });
    return { files: [{ label: "probe.cs", result }], result };
  };

  it("接到生產者 ⇒ 站點被標上生產者名", () => {
    const { files, result } = filesOf(`public static class Probe
{
    public static (bool Ok, string? Code, string? Message) Validate(int n)
    {
        return (false, ErrorCodes.CardTitleRequired, "太小");
    }

    public static IResult Run(int n)
    {
        var (ok, code, message) = Validate(n);
        if (!ok) return Results.BadRequest(new { code, message });
        return Results.Ok();
    }
}
`);
    const producerNames = new Set(result.producers.map((p) => p.name));
    resolveForwards({ files, producerNames });
    expect(result.sites.find((s) => s.kind === "forward").producer).toBe("Validate");
  });

  it("接不到生產者 ⇒ 拋（那條鏈的下游沒有被比對過）", () => {
    const { files } = filesOf(`public static class Probe
{
    public static IResult Run(int n)
    {
        var (ok, code, message) = SomethingElse(n);
        if (!ok) return Results.BadRequest(new { code, message });
        return Results.Ok();
    }
}
`);
    const message = bailMessage(() => resolveForwards({ files, producerNames: new Set() }));
    expect(message).toContain("SomethingElse");
    expect(message).toContain("不是認得的生產者");
  });

  // 同名區域變數在同一個檔的多個方法裡各宣告一次是真實存在的形狀
  // （`CustomFieldEndpoints.cs` 的四個 `validation`）。本檢查**不做** C# 的作用域分析，
  // 改以「候選都指向同一個生產者」判定——那時「哪一個綁定才是它」不影響比對結果。
  const twice = (first, second) => `public static class Probe
{
    public static (bool Ok, string? Code, string? Message) Validate(int n)
    {
        return (false, ErrorCodes.CardTitleRequired, "太小");
    }

    public static (bool Ok, string? Code, string? Message) Other(int n)
    {
        return (false, ErrorCodes.CardTitleRequired, "太大");
    }

    public static IResult One(int n)
    {
        var check = ${first}(n);
        if (!check.Ok) return Results.BadRequest(new { code = check.Code, message = check.Message });
        return Results.Ok();
    }

    public static IResult Two(int n)
    {
        var check = ${second}(n);
        if (!check.Ok) return Results.BadRequest(new { code = check.Code, message = check.Message });
        return Results.Ok();
    }
}
`;

  it("同名的綁定有多個、但都指向同一個生產者 ⇒ 接得上（作用域不影響結果）", () => {
    const { files, result } = filesOf(twice("Validate", "Validate"));
    const producerNames = new Set(result.producers.map((p) => p.name));
    resolveForwards({ files, producerNames });
    const forwards = result.sites.filter((s) => s.kind === "forward");
    expect(forwards).toHaveLength(2);
    expect(forwards.map((s) => s.producer)).toEqual(["Validate", "Validate"]);
  });

  it("同名的綁定分屬不同的生產者 ⇒ 拋（那才是真的猜不出來）", () => {
    const { files, result } = filesOf(twice("Validate", "Other"));
    const producerNames = new Set(result.producers.map((p) => p.name));
    const message = bailMessage(() => resolveForwards({ files, producerNames }));
    expect(message).toContain("2 個不同的生產者");
    expect(message).toContain("Other");
    expect(message).toContain("Validate");
  });
});

const GATE = "check-message-values.mjs";

/** 沙箱：`web/scripts/`（閘門 ＋ `lib/`）＋ `src/` ＋ zh-TW 語系檔 ＋ node_modules 連結。 */
const makeSandbox = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "entask-message-values-gate-"));
  mkdirSync(join(sandbox, "web", "scripts", "lib"), { recursive: true });
  mkdirSync(join(sandbox, "src", "Entask.Api"), { recursive: true });
  mkdirSync(join(sandbox, "web", "src", "i18n", "locales", "zh-TW"), { recursive: true });
  copyFileSync(join(scriptsDir, GATE), join(sandbox, "web", "scripts", GATE));
  for (const lib of ["label-table-extract.mjs", "csharp-message-sites.mjs", "message-value-compare.mjs"]) {
    copyFileSync(join(scriptsDir, "lib", lib), join(sandbox, "web", "scripts", "lib", lib));
  }
  symlinkSync(join(webDir, "node_modules"), join(sandbox, "web", "node_modules"), "junction");
  return sandbox;
};

const cleanup = (sandbox) => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* 連結的目標不在沙箱內，刪不掉就算了——測試的成敗不取決於它。 */
  }
};

/** 沙箱裡的最小後端：`ErrorCodes.cs` ＋ 一個站點檔；語系檔由呼叫端給。 */
const seed = (sandbox, { codes, site, error }) => {
  writeFileSync(
    join(sandbox, "src", "Entask.Api", "ErrorCodes.cs"),
    `namespace Entask.Api;

public static class ErrorCodes
{
${Object.entries(codes)
  .map(([name, value]) => `    public const string ${name} = "${value}";`)
  .join("\n")}
}
`,
  );
  writeFileSync(join(sandbox, "src", "Entask.Api", "Site.cs"), site);
  writeFileSync(
    join(sandbox, "web", "src", "i18n", "locales", "zh-TW", "error.json"),
    `${JSON.stringify(error, null, 2)}\n`,
  );
};

const runGate = (sandbox) =>
  spawnSync(process.execPath, [join(sandbox, "web", "scripts", GATE)], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

describe("check-message-values：端到端", () => {
  it("值一致 ⇒ exit 0", () => {
    const sandbox = makeSandbox();
    try {
      // 一起涵蓋粗粒度碼那條路：宣告過的碼**不比 R1／R2**（兩邊本來就不同句），
      // 但兩個守衛仍然要放行——所以這裡刻意放兩種相異字面值。
      seed(sandbox, {
        codes: { CardTitleRequired: "card.titleRequired", RequestInvalid: "request.invalid" },
        site: `namespace Entask.Api;

public static class Site
{
    public static IResult Run() => Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "卡片標題不可為空" });

    public static IResult One() => Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "title 須為字串" });

    public static IResult Two() => Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "缺少檔案" });
}
`,
        error: { card: { titleRequired: "卡片標題不可為空" }, request: { invalid: "請求內容不正確" } },
      });
      const run = runGate(sandbox);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
    } finally {
      cleanup(sandbox);
    }
  });

  it("值不一致 ⇒ exit 1，訊息指名檔案的站點", () => {
    const sandbox = makeSandbox();
    try {
      seed(sandbox, {
        codes: { CardTitleRequired: "card.titleRequired" },
        site: `namespace Entask.Api;

public static class Site
{
    public static IResult Run() => Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "卡片標題不可為空（舊的措辭）" });
}
`,
        error: { card: { titleRequired: "卡片標題不可為空" } },
      });
      const run = runGate(sandbox);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Site.cs:5");
      expect(run.stderr).toContain("card.titleRequired");
    } finally {
      cleanup(sandbox);
    }
  });
});

// ---- 規則層（R1／R2／R3／R3b 與三個守衛）--------------------------------------
//
// 這裡餵的是**手寫的站點物件**，不走抽取器：要驗的是「規則對這個形狀怎麼判」，
// 走抽取器會把意圖埋進 C# 字串裡（而抽取器自己那 27 支已經在驗形狀了）。
// 兩層的接縫另有一支（本檔最後一支）。
//
// 每一條規則都是**一正一反**：只有「該過」的那支時，把規則整個刪掉也會全綠。

/** 站點物件的預設值；只覆寫要驗的那幾個欄位。 */
const site = (over = {}) => ({
  file: "probe.cs",
  line: 1,
  kind: "literal",
  code: "card.titleRequired",
  codeExpr: null,
  value: null,
  shape: null,
  params: null,
  root: null,
  guard: null,
  ...over,
});

/** 跑規則層：`values` 是碼 ⇒ zh-TW 值的字面物件，`coarse` 是被宣告的粗粒度碼。 */
const compare = (sites, { values = {}, coarse = [] } = {}) =>
  compareSites({ sites, localeValues: new Map(Object.entries(values)), coarseCodes: coarse });

const errorsOf = (sites, options) => compare(sites, options).errors;

describe("compareSites：R1（字面值 ↔ 語系值）", () => {
  const values = { "card.titleRequired": "卡片標題不可為空" };

  it("逐字相同 ⇒ 過", () => {
    expect(errorsOf([site({ value: "卡片標題不可為空" })], { values })).toEqual([]);
  });

  it("差一個字 ⇒ 紅，訊息指名檔案:行號與碼", () => {
    const errors = errorsOf([site({ line: 42, value: "卡片標題不可為空（舊的措辭）" })], { values });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("probe.cs:42");
    expect(errors[0]).toContain("card.titleRequired");
    expect(errors[0]).toContain("卡片標題不可為空（舊的措辭）");
  });

  it("語系值是樣板而 C# 是**填好的成品** ⇒ 過（樣板當樣式，不是先剝再比）", () => {
    // 這一支是「為什麼不剝樣板」的判別力：剝完再比會把它判紅，
    // 而它正是漂移代價最大的那一類（使用者看得到的數字）。
    expect(
      errorsOf([site({ value: "名稱不可超過 1000 個字", params: ["max"] })], {
        values: { "card.titleRequired": "名稱不可超過 {{max}} 個字" },
      }),
    ).toEqual([]);
  });

  it("樣板對得上但措辭漂移 ⇒ 紅（`{{…}}` 之間逐字比對）", () => {
    const errors = errorsOf([site({ value: "名稱不可以超過 1000 個字", params: ["max"] })], {
      values: { "card.titleRequired": "名稱不可超過 {{max}} 個字" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("名稱不可以超過 1000 個字");
  });

  it("生產者三元組也走 R1（它的值在生產者那一側）", () => {
    const producer = site({ kind: "producer", producer: "Fail", code: "card.titleRequired" });
    expect(errorsOf([{ ...producer, value: "卡片標題不可為空" }], { values })).toEqual([]);
    expect(errorsOf([{ ...producer, value: "別的措辭" }], { values })).toHaveLength(1);
  });
});

describe("compareSites：R2（內插字串的形狀）", () => {
  const values = { "card.fieldTextTooLong": "欄位 {{name}} 不可超過 {{max}} 個字" };

  it("形狀相同 ⇒ 過（佔位名與位置都對得上）", () => {
    const shape = "欄位 \u0000 不可超過 \u0000 個字";
    expect(
      errorsOf([site({ kind: "template", code: "card.fieldTextTooLong", shape, params: ["name", "max"] })], {
        values,
      }),
    ).toEqual([]);
  });

  it("形狀不同 ⇒ 紅（兩邊的形狀並排印出來）", () => {
    const shape = "欄位「\u0000」不可超過 \u0000 個字";
    const errors = errorsOf(
      [site({ kind: "template", code: "card.fieldTextTooLong", shape, params: ["name", "max"] })],
      { values },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("形狀不一致");
    expect(errors[0]).toContain(JSON.stringify(shape));
  });
});

describe("compareSites：R3／R3b（`@params` ↔ 佔位名）", () => {
  it("R3：成員名集合相等 ⇒ 過（順序無關）", () => {
    expect(
      errorsOf([site({ value: "小明 不可超過 1000 個字", params: ["max", "name"] })], {
        values: { "card.titleRequired": "{{name}} 不可超過 {{max}} 個字" },
      }),
    ).toEqual([]);
  });

  it("R3：成員名對不上 ⇒ 紅（前端會原樣印出 `{{…}}`）", () => {
    const errors = errorsOf([site({ value: "不可超過 1000 個字", params: ["maks"] })], {
      values: { "card.titleRequired": "不可超過 {{max}} 個字" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("maks");
    expect(errors[0]).toContain("max");
  });

  it("R3b：語系值帶佔位而站點沒有 `@params` ⇒ 紅", () => {
    const errors = errorsOf([site({ value: "不可超過 1000 個字" })], {
      values: { "card.titleRequired": "不可超過 {{max}} 個字" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("R3b");
  });

  it("R3b 的反向：有 `@params` 就不紅（即使 R1 也過）", () => {
    expect(
      errorsOf([site({ value: "不可超過 1000 個字", params: ["max"] })], {
        values: { "card.titleRequired": "不可超過 {{max}} 個字" },
      }),
    ).toEqual([]);
  });

  it("R3b 不涵蓋生產者三元組（它的值不是 body，前端拿不到它的參數）", () => {
    expect(
      errorsOf([site({ kind: "producer", producer: "Fail", value: "不可超過 1000 個字" })], {
        values: { "card.titleRequired": "不可超過 {{max}} 個字" },
      }),
    ).toEqual([]);
  });
});

describe("compareSites：粗粒度碼的三個守衛", () => {
  const two = (code) => [
    site({ line: 1, code, value: "title 須為字串" }),
    site({ line: 2, code, value: "缺少檔案" }),
  ];

  it("宣告了粗粒度 ⇒ 跳過 R1／R2（兩邊本來就不同句）", () => {
    expect(
      errorsOf(two("request.invalid"), {
        values: { "request.invalid": "請求內容不正確" },
        coarse: ["request.invalid"],
      }),
    ).toEqual([]);
  });

  it("沒宣告而有兩種相異字面值 ⇒ 紅（逼你統一或宣告）", () => {
    const errors = errorsOf(two("request.invalid"), { values: { "request.invalid": "請求內容不正確" } });
    // 這條路會**同時**留下每個站點自己的 R1（各自指名 `檔案:行號`）＋一條守衛。
    // 兩者都真的成立，而且守衛那條才是「要做決定」的那一條——所以這裡挑它來斷言。
    const guard = errors.filter((e) => e.includes("沒有被列進粗粒度碼宣告"));
    expect(guard).toHaveLength(1);
    expect(guard[0]).toContain("2 種不同的字面值");
    expect(guard[0]).toContain("title 須為字串");
    expect(guard[0]).toContain("缺少檔案");
    expect(errors.filter((e) => e.includes("probe.cs:1"))).toHaveLength(1);
    expect(errors.filter((e) => e.includes("probe.cs:2"))).toHaveLength(1);
  });

  it("守衛 (a)：宣告了卻只有一種字面值 ⇒ 紅（宣告過期）", () => {
    const errors = errorsOf([site({ code: "request.invalid", value: "缺少檔案" })], {
      values: { "request.invalid": "請求內容不正確" },
      coarse: ["request.invalid"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("宣告已經過期");
  });

  it("守衛 (a)：宣告了而全庫沒有站點用它 ⇒ 紅", () => {
    const errors = errorsOf([], { values: {}, coarse: ["request.invalid"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("全庫沒有任何站點用它");
  });

  it("守衛 (c)：宣告了而語系值與某個字面值逐字相同 ⇒ 紅（放行一個不存在的例外）", () => {
    const errors = errorsOf(two("request.invalid"), {
      values: { "request.invalid": "缺少檔案" },
      coarse: ["request.invalid"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("逐字相同");
  });

  it("守衛 (b) 與 (c) 的前提互斥：宣告了且語系值與兩種都不同 ⇒ 只有守衛放行", () => {
    // 「該過」的那一支——少了它，把三個守衛刪掉也會全綠。
    const { errors, stats } = compare(two("request.invalid"), {
      values: { "request.invalid": "請求內容不正確" },
      coarse: ["request.invalid"],
    });
    expect(errors).toEqual([]);
    expect(stats.coarse).toBe(1);
  });

  it("粗粒度碼的 R3b **不跳**（語系值哪天帶了佔位，餵不出來的站點仍會印出 `{{…}}`）", () => {
    const errors = errorsOf(two("request.invalid"), {
      values: { "request.invalid": "請求內容不正確（{{max}}）" },
      coarse: ["request.invalid"],
    });
    expect(errors.some((e) => e.includes("R3b"))).toBe(true);
  });
});

describe("compareSites：缺值與排除", () => {
  it("碼在語系檔裡沒有對應值 ⇒ 紅，且同一個碼只報一次", () => {
    const errors = errorsOf([site({ line: 1, code: "nope" }), site({ line: 2, code: "nope" })], { values: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nope");
    expect(errors[0]).toContain("沒有對應的值");
  });

  it("三種刻意排除的站點不比值（mapper／delegated／identity）", () => {
    const values = { "card.titleRequired": "卡片標題不可為空" };
    for (const kind of ["mapper", "delegated", "identity"]) {
      expect(errorsOf([site({ kind, value: "完全不同的字" })], { values })).toEqual([]);
    }
  });
});

describe("抽取器 → 規則層的接縫", () => {
  it("抽取器產出的站點物件，規則層讀得到 `kind`／`code`／`value`／`params`", () => {
    // 這一支守的是**兩層之間的欄位契約**：抽取器改了鍵名而規則層沒跟上時，
    // 規則層會把 undefined 當成「沒有值」而**靜默放行**——那正是這道閘門最怕的失效方式。
    const { sites } = scan(
      method(`
        if (n < 0) return Results.BadRequest(new { code = ErrorCodes.CardFieldTextTooLong, message = $"名稱不可超過 {n} 個字", @params = new { max = n } });
        return Results.Ok();`),
    );
    expect(sites).toHaveLength(1);
    const errors = errorsOf(sites, {
      values: { "card.fieldTextTooLong": "名稱不可超過 {{max}} 個字" },
    });
    expect(errors).toEqual([]);
  });
});
