// `lib/label-table-extract.mjs` 的測試。**測試在記憶體裡餵字串，不碰 repo 的檔案。**
//
// 為什麼要有這一支（2026-09-17，Task 8 fix round 2）：`check-label-tables.mjs` 在此之前
// 沒有任何測試，於是「哪些形狀會靜默放行」只能靠一次性探針發掘，而那些探針躺在 gitignored
// 的目錄裡——每修一次就要重新推導一次，而 fix round 1 正是這樣在修好一個洞的同時
// 開了另一個同型的洞（D1）。每一個 case 都對應一次實測到的形狀。

import { describe, expect, it } from "vitest";

import {
  LabelTableParseError,
  extractArrayConst,
  extractBackendValues,
  extractLabelTable,
  extractSupportedLocales,
  maskCSharp,
} from "./lib/label-table-extract.mjs";

/** 把 `{ pairs }` 攤成 `["值", "key"]` 的陣列，斷言比較好讀。 */
const keyed = (src, opts = {}) =>
  extractLabelTable(src, { label: "probe.tsx", fileName: "probe.tsx", ...opts }).pairs.map((p) => [p.value, p.key]);

const linesOf = (src, opts = {}) =>
  extractLabelTable(src, { label: "probe.tsx", fileName: "probe.tsx", ...opts }).pairs.map((p) => p.line);

const switchFn = (name, body, { prefix = "", suffix = "", kw = "function" } = {}) => `${prefix}
${kw} ${name}(value: string) {
  switch (value) {
${body}
  }
}
${suffix}`;

const LIVE_BODY = `    case "approved":
      return t("common:state.approved");
    case "pending":
      return t("card:review.status.pending");`;

describe("extractLabelTable：switch 形狀", () => {
  it("乾淨的函式：值、key、行號都對", () => {
    const src = switchFn("reviewStatusLabel", LIVE_BODY);
    expect(keyed(src)).toEqual([
      ["approved", "common:state.approved"],
      ["pending", "card:review.status.pending"],
    ]);
    // 第 1 行是空行（helper 的前綴）、第 2 行是 function 宣告、第 3 行是 switch，
    // 兩條 `case` 因此落在第 4 與第 6 行——**行號來源是 `case` 關鍵字**，不是 return。
    expect(linesOf(src)).toEqual([4, 6]);
  });

  it("`i18n.t(` 與裸 `t(` 都認（後者見 BoardCard.tsx）", () => {
    const src = switchFn(
      "f",
      `    case "a":
      return i18n.t("x:a");
    case "b":
      return t("x:b");`,
    );
    expect(keyed(src)).toEqual([
      ["a", "x:a"],
      ["b", "x:b"],
    ]);
  });

  it("`t(\"key\", params)` 認；`t(\"key\", { … })` 不認（與舊版一致，落空由檢查 1 大聲報）", () => {
    const src = switchFn(
      "f",
      `    case "a":
      return i18n.t("error:a", params);
    case "b":
      return i18n.t("error:b", { max: 1 });`,
    );
    expect(keyed(src)).toEqual([["a", "error:a"]]);
  });

  it("沒有 scope 時掃整檔：一支檔案裡的兩個 switch 都在（notification-text.ts 的形狀）", () => {
    const src = `${switchFn("titleOf", `    case "review_approved":
      return i18n.t("me:notification.approved.title");`)}
${switchFn("bodyOf", `    case "review_approved":
      return i18n.t("me:notification.approved.body");`)}`;
    expect(keyed(src)).toEqual([
      ["review_approved", "me:notification.approved.title"],
      ["review_approved", "me:notification.approved.body"],
    ]);
  });

  it("scope 指名的是箭頭函式（BoardCard.tsx 的 `const X = (…) => {`）", () => {
    const src = `const reviewBadgeLabel = (state: string) => {
  switch (state) {
    case "pending":
      return t("common:state.pending");
  }
};

const other = (x: string) => {
  switch (x) {
    case "approved":
      return t("common:state.approved");
  }
};`;
    expect(keyed(src, { scope: "reviewBadgeLabel" })).toEqual([["pending", "common:state.pending"]]);
    expect(extractLabelTable(src, { label: "probe.tsx", fileName: "probe.tsx", scope: "reviewBadgeLabel" }).scopeLine).toBe(1);
  });

  it("scope 指名的是 `export function`（ReportTab.tsx 的形狀）", () => {
    const src = `export function reviewLabel(status: string): string {
  switch (status) {
    case "pending":
      return i18n.t("common:state.pending");
  }
}`;
    expect(keyed(src, { scope: "reviewLabel" })).toEqual([["pending", "common:state.pending"]]);
    expect(extractLabelTable(src, { label: "probe.tsx", fileName: "probe.tsx", scope: "reviewLabel" }).scopeLine).toBe(1);
  });

  it("`.ts` 檔（非 TSX）用同一組形狀也抽得到", () => {
    const src = switchFn("typeLabel", `    case "text":
      return i18n.t("common:fieldType.text");`);
    expect(keyed(src, { fileName: "custom-fields.ts" })).toEqual([["text", "common:fieldType.text"]]);
  });
});

describe("extractLabelTable：selectItems 形狀", () => {
  it("`<SelectItem value=\"值\">{t(\"key\")}</SelectItem>`", () => {
    const src = `export const x = (
  <Select>
    <SelectItem value="approved">{t("common:state.approved")}</SelectItem>
    <SelectItem value="rejected">{t("common:state.rejected")}</SelectItem>
  </Select>
);`;
    expect(keyed(src, { shape: "selectItems" })).toEqual([
      ["approved", "common:state.approved"],
      ["rejected", "common:state.rejected"],
    ]);
    expect(linesOf(src, { shape: "selectItems" })).toEqual([3, 4]);
  });

  it("沒有 `t()` 的選項（`__none__`）不算表項", () => {
    const src = `<Select><SelectItem value="__none__">—</SelectItem><SelectItem value="approved">{t("common:state.approved")}</SelectItem></Select>;`;
    expect(keyed(src, { shape: "selectItems" })).toEqual([["approved", "common:state.approved"]]);
  });

  it("**註解裡的**選項不算表項（AST 看不到註解）", () => {
    const src = `// <SelectItem value="stale">{t("common:state.stale")}</SelectItem>
const x = <SelectItem value="approved">{t("common:state.approved")}</SelectItem>;`;
    expect(keyed(src, { shape: "selectItems" })).toEqual([["approved", "common:state.approved"]]);
  });

  it("子節點**多於一個**的選項不算表項（`{t(…)}` ＋ 文字／第二個 `t()`／註解）", () => {
    const src = `export const x = (
  <Select>
    <SelectItem value="approved">{t("common:state.approved")}</SelectItem>
    <SelectItem value="text-after">{t("common:state.textAfter")}（已退回）</SelectItem>
    <SelectItem value="two-calls">{t("common:state.twoCalls")}{t("common:state.twoCalls")}</SelectItem>
    <SelectItem value="comment-after">{t("common:state.commentAfter")}{/* 舊的 */}</SelectItem>
  </Select>
);`;
    // 契約是「子節點**恰好**是一個 `{t("key")}`」（見 lib 的註解）。把子節點數的判斷放鬆成
    // `=== 0` 時，上面三個元素都會各自變成一個表項（值對、key 取第一個 `t()`），
    // 而**被跳過的那一條對檢查 1–7 全部隱形**——所以這裡要釘住「多於一個 ⇒ 不算」。
    expect(keyed(src, { shape: "selectItems" })).toEqual([["approved", "common:state.approved"]]);
  });

  it("一條都沒有 ⇒ fail closed", () => {
    expect(() => extractLabelTable("<Select></Select>", { label: "probe.tsx", shape: "selectItems" })).toThrow(
      LabelTableParseError,
    );
  });
});

describe("extractLabelTable：死碼副本（Task 8 任務審查的 M1 與 fix round 1 的 D1）", () => {
  const deadCopyInComment = `/*
export function reviewStatusLabel(value: string) {
  switch (value) {
    case "approved":
      return t("common:state.approved");
    case "pending":
      return t("card:review.status.pending");
  }
}
*/`;

  it("① 註解副本在**上**：選活碼", () => {
    const src = `${deadCopyInComment}
${switchFn("reviewStatusLabel", LIVE_BODY)}
`;
    expect(keyed(src, { scope: "reviewStatusLabel" })).toEqual([
      ["approved", "common:state.approved"],
      ["pending", "card:review.status.pending"],
    ]);
  });

  it("② 宣告**只**在註解裡：fail closed（AST 看不到那個節點）", () => {
    const src = deadCopyInComment;
    expect(() => extractLabelTable(src, { label: "probe.tsx", scope: "reviewStatusLabel" })).toThrow(
      /找不到 reviewStatusLabel 的本體/,
    );
  });

  it("③ 行內開頭區塊註解（`/* … */ function X`）：選活碼", () => {
    const src = `/* 舊版見下 */ function reviewStatusLabel(value: string) {
  switch (value) {
    case "pending":
      return t("card:review.status.pending");
  }
}`;
    expect(keyed(src, { scope: "reviewStatusLabel" })).toEqual([["pending", "card:review.status.pending"]]);
  });

  it("④ 死副本在**模板字面值**裡：選活碼", () => {
    const dead = "`\n" + switchFn("reviewStatusLabel", `    case "pending":
      return t("card:review.status.dead");`) + "\n`;";
    const src = `${dead}
${switchFn("reviewStatusLabel", LIVE_BODY)}`;
    expect(keyed(src, { scope: "reviewStatusLabel" })).toEqual([
      ["approved", "common:state.approved"],
      ["pending", "card:review.status.pending"],
    ]);
  });

  it("D1 的完整輸入（正則裡的 `'` ＋ 註解裡的撇號 ＋ 下方的死副本）：選**活**碼", () => {
    // fix round 1 的 `skipNonCode` 在這個輸入上把活宣告判成非程式碼、把註解裡的死副本
    // 判成活碼（`1e973d9` exit 0 而活函式指向不存在的 key）。AST 沒有這個自由度。
    const src = `const QUOTE_RE = /['"]/;
const NOTE = "don't";

export function reviewStatusLabel(value: string) {
  switch (value) {
    case "approved":
      return t("common:state.approved");
    case "pending":
      return t("card:review.status.stale");
  }
}
/*
export function reviewStatusLabel(value: string) {
  switch (value) {
    case "approved":
      return t("common:state.approved");
    case "pending":
      return t("card:review.status.pending");
  }
}
*/`;
    expect(keyed(src, { scope: "reviewStatusLabel" })).toEqual([
      ["approved", "common:state.approved"],
      ["pending", "card:review.status.stale"],
    ]);
  });
});

describe("extractLabelTable：本體裡的大括號（註解／字串／正則）", () => {
  it("本體內的 `{`／`}` 在註解、字串、模板與正則裡都不影響結果", () => {
    const src = `export function reviewStatusLabel(value: string) {
  // 說明：本體裡的 { 與 } 常常出現在註解（例如 { count }）
  const a = "{";
  const b = "}";
  const c = \`\${value} }\`;
  const re = /}/;
  switch (value) {
    case "approved":
      return t("common:state.approved");
  }
}

export function after() {
  switch ("x") {
    case "zed":
      return t("common:state.zed");
  }
}`;
    // 只有本體裡那條 case；`after` 的那條不算（本體切對了才成立）。
    expect(keyed(src, { scope: "reviewStatusLabel" })).toEqual([["approved", "common:state.approved"]]);
  });
});

describe("extractLabelTable：fail closed 清單", () => {
  const src = switchFn("reviewStatusLabel", LIVE_BODY);

  it("scope 打錯字 ⇒ 拋錯、訊息指名函式", () => {
    expect(() => extractLabelTable(src, { label: "probe.tsx", scope: "reviewStatusLabell" })).toThrow(
      /probe\.tsx 找不到 reviewStatusLabell 的本體/,
    );
  });

  it("函式不是 switch（一條 case 都沒有）⇒ 拋錯", () => {
    expect(() =>
      extractLabelTable("export function f(x: string) { return x; }", { label: "probe.tsx", scope: "f" }),
    ).toThrow(/本體裡一條「case "值": return t\("key"\)」都沒有/);
  });

  it("scope 指名到一個簡潔本體的箭頭函式 ⇒ 拋錯（不是 block）", () => {
    expect(() => extractLabelTable(`const f = (x: string) => t("a");`, { label: "probe.tsx", scope: "f" })).toThrow(
      /找不到 f 的本體|本體裡一條/,
    );
  });

  it("沒有 scope 又完全沒有 case ⇒ 拋錯", () => {
    expect(() => extractLabelTable("export const x = 1;", { label: "probe.tsx" })).toThrow(/解析不到任何/);
  });
});

describe("extractArrayConst（同一份清單的第二個副本）", () => {
  it("`as const` 後綴不影響", () => {
    expect(
      extractArrayConst(`export const FIELD_TYPES = ["text", "number", "checkbox"] as const;`, {
        label: "custom-fields.ts",
        fileName: "custom-fields.ts",
        name: "FIELD_TYPES",
      }),
    ).toEqual(["text", "number", "checkbox"]);
  });

  it("B1／D8：活陣列少一個值 ＋ **上方**一份完整註解副本 ⇒ 回傳活的那一份，不是註解裡的", () => {
    const src = `/*
export const FIELD_TYPES = ["text", "number", "select", "date", "member", "checkbox"] as const;
*/
export const FIELD_TYPES = ["text", "number", "select", "date", "member"] as const;`;
    expect(extractArrayConst(src, { label: "custom-fields.ts", name: "FIELD_TYPES" })).toEqual([
      "text",
      "number",
      "select",
      "date",
      "member",
    ]);
  });

  it("註解裡的副本不算，宣告只存在於註解時 fail closed", () => {
    expect(() =>
      extractArrayConst(`// export const FIELD_TYPES = ["text"];`, { label: "custom-fields.ts", name: "FIELD_TYPES" }),
    ).toThrow(/找不到 FIELD_TYPES 的陣列字面值/);
  });

  it("陣列名打錯 ⇒ 拋錯", () => {
    expect(() => extractArrayConst(`export const OTHER = ["a"];`, { label: "custom-fields.ts", name: "FIELD_TYPES" })).toThrow(
      /找不到 FIELD_TYPES 的陣列字面值/,
    );
  });

  it("非字串字面值的元素 ⇒ 拋錯、指名**行號與索引**（舊版會靜默丟掉展開或變數）", () => {
    // 訊息帶位置是 Task 8 fix round 3 的 Info-1：同一個檔可能有第二份同名宣告，
    // 只給檔名的訊息沒辦法回答「是哪一個」。
    expect(() => extractArrayConst(`export const X = ["a", ...MORE];`, { label: "x.ts", name: "X" })).toThrow(
      /x\.ts:1 的 X 陣列第 1 個元素不是字串字面值/,
    );
  });
});

describe("extractBackendValues（.cs）", () => {
  const REVIEW = `namespace Entask.Core;

public static class ReviewStatuses
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Rejected = "rejected";

    public static readonly string[] All = [Pending, Approved, Rejected];
    public static readonly string[] Submittable = [Approved, Rejected];
}
`;
  const opts = (arrayName) => ({ label: "src/Entask.Core/ReviewStatuses.cs", arrayName });

  it("全部常數／具名陣列", () => {
    expect(extractBackendValues(REVIEW, opts(undefined))).toEqual(["pending", "approved", "rejected"]);
    expect(extractBackendValues(REVIEW, opts("Submittable"))).toEqual(["approved", "rejected"]);
  });

  it("B2①：活陣列少一個成員 ＋ **上方**一份完整註解副本 ⇒ 拿到活的那一份（少了 rejected）", () => {
    const src = REVIEW.replace(
      "    public static readonly string[] Submittable = [Approved, Rejected];",
      `    /*
    public static readonly string[] Submittable = [Approved, Rejected];
    */
    public static readonly string[] Submittable = [Approved];`,
    );
    expect(extractBackendValues(src, opts("Submittable"))).toEqual(["approved"]);
  });

  it("B2②：活值改名 ＋ **下方**留舊值註解副本 ⇒ 拿到新值（舊版的 Map 讓舊值勝出）", () => {
    const src = REVIEW.replace(
      '    public const string Pending = "pending";',
      `    public const string Pending = "pending_v2";
    // public const string Pending = "pending";`,
    );
    expect(extractBackendValues(src, opts(undefined))).toEqual(["pending_v2", "approved", "rejected"]);
  });

  it("B2③：一條 const 被區塊註解包起來 ⇒ 不在期望集合裡；被引用時大聲", () => {
    const commented = REVIEW.replace(
      '    public const string Rejected = "rejected";',
      `    /*
    public const string Rejected = "rejected";
    */`,
    );
    // 不再被 `All` 引用時：期望集合只剩兩個（舊版仍會收進第三個）。
    expect(extractBackendValues(commented.replace("All = [Pending, Approved, Rejected]", "All = [Pending, Approved]"), opts(undefined))).toEqual([
      "pending",
      "approved",
    ]);
    // 仍被引用時：大聲指名。
    expect(() => extractBackendValues(commented, opts("All"))).toThrow(/引用了 Rejected，但同一檔找不到 public const string Rejected/);
  });

  it("兩個活的同名 const ⇒ fail closed（舊版後者勝出，靜默）", () => {
    const src = REVIEW.replace(
      '    public const string Pending = "pending";',
      `    public const string Pending = "pending";
    public const string Pending = "pending_v2";`,
    );
    expect(() => extractBackendValues(src, opts(undefined))).toThrow(/有兩個活的 public const string Pending/);
  });

  it("逐字字串 `@\"…\"`（`\"\"` 代表一個引號）不影響後面的宣告——fix round 1 的 B3 合成樣本", () => {
    const src = `public static class X
{
    public const string LogRoot = @"C:\\logs\\";
    public const string Alpha = "alpha";
    public const string Beta = "beta";
    public static readonly string[] All = [Alpha, Beta];
}`;
    // 舊版共用 JS 口味的跳略時，這裡 3/3 個宣告都被判成非程式碼。
    expect(extractBackendValues(src, { label: "x.cs", arrayName: "All" })).toEqual(["alpha", "beta"]);
  });

  it("字元字面值 `'.'` 不影響（PermissionCategories.cs:33 的形狀）", () => {
    const src = `public static class X
{
    public const string Team = "team";
    public static string ForCode(string code)
    {
        var dot = code.IndexOf('.');
        return dot < 0 ? code : code[..dot];
    }
}`;
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["team"]);
  });

  it("字元字面值裡有引號（`'\"'`／`'\\''`／`'\\\\'`）不影響後面的宣告——主迴圈的 `readChar` 是承重的", () => {
    const src = `public static class X
{
    public const string Alpha = "alpha";
    public static bool IsQuote(char c) => c == '"';
    public const string Beta = "beta";
    public static char Apostrophe() => '\\'';
    public static char Backslash() => '\\\\';
    public static string Trim(string code) => code.IndexOf('.') < 0 ? code : code[..1];
}`;
    // `'"'` 那個字元字面值（不是 `.` 那種無害的）是這一支的判別力來源：主迴圈少了
    // `readChar` 時，`'` 不被遮、裡面的 `"` 會開一個字串，把後面的 `Beta` 一路吃進去。
    // 實測：突變後這一支拋「字串字面值沒有收尾」（紅），未突變時回 ["alpha","beta"]。
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha", "beta"]);
  });

  // C# 11 的原始字串（2026-09-18，審查者軟刪除 T4 的 R8）：**整段遮成空白**。
  // 舊契約是「遇到 `"""` 一律 fail closed」，而 `src/` 今天有三個檔用到它（`ProjectEndpoints.cs`
  // 是單行，兩支 migration 是多行），查詢篩選破例的閘門因此整支掃不動。原本那一支斷言
  // （`x.cs:2 含 C# 11 的原始字串字面值`）因此換成下面四支；判別力見各支的註解。
  it("C# 11 的單行原始字串 ⇒ 遮成空白，後面的宣告仍看得到", () => {
    // 形狀取自 `ProjectEndpoints.cs`：`Options = """["高","中","低"]"""`——內容裡有一堆引號。
    // 若收尾的那一串引號沒有被**整組**吃掉，餘料會開一個新字串把後面的宣告一路吞掉 ⇒
    // 結果裡就沒有 `Alpha`（而且會落在 `解析不到任何 public const string` 這條上）。
    const src = [
      "public static class X",
      "{",
      '    public static string Options = """["a","b"]""";',
      '    public const string Alpha = "alpha";',
      "}",
    ].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
  });

  it("C# 11 的多行原始字串 ⇒ 遮成空白（收尾引號在別行），後面的宣告仍看得到", () => {
    // 形狀取自兩支 migration 的 `migrationBuilder.Sql("""…""")`：收尾的 `"""` 在好幾行之後，
    // 而那幾行裡有 `"Roles"`／`"Status"` 這種單引號。只認「同一行收尾」的實作在這支紅。
    const src = [
      "public static class X",
      "{",
      '    public static string Sql = """',
      '        SELECT * FROM "CardReviews"',
      "        WHERE \"Status\" <> 'pending';",
      '        """;',
      '    public const string Alpha = "alpha";',
      "}",
    ].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
  });

  it("未收尾的原始字串 ⇒ 仍 fail closed、指名檔案與行號", () => {
    const src = `public const string A = "a";
var s = """
  abc
`;
    expect(() => extractBackendValues(src, { label: "x.cs" })).toThrow(/x\.cs:2 的原始字串字面值沒有收尾/);
  });

  it("**內插的**原始字串 ⇒ fail closed（有幾個 `$` 決定幾個 `{` 才算洞）", () => {
    // 內插的形態不能整段遮掉——洞裡是程式碼。**實查：`src/` 今天一處都沒有**，
    // 所以這條 fail closed 今天不擋任何東西；它擋的是「以後有人寫了 `$"""` 而閘門靜默放行」。
    const src = `public const string A = "a";
var s = $"""
  {x}
  """;
`;
    expect(() => extractBackendValues(src, { label: "x.cs" })).toThrow(/x\.cs:2 含內插的原始字串字面值/);
    // `$$"""`（兩個錢號）走同一條：`stringStart` 是在**第二個** `$` 才認出字串開頭
    // （`$` 後面接 `$` 不符它的形狀），於是仍然 `interp: true` ⇒ 同一個訊息。
    // `$$"""` 本身是合法 C#（SDK 10.0.400 實測），所以這一條是真的 fail closed、不是擋錯。
    expect(() => extractBackendValues('var s = $$"""\n  {x}\n  """;\n', { label: "x.cs" })).toThrow(
      /x\.cs:1 含內插的原始字串字面值/,
    );
  });

  // 逐字字串的內容**可以**以引號開頭（`@""""` 的值是一個 `"`，SDK 10.0.400 實測為合法 C#），
  // 而原始字串不可能有 `@` 前綴——所以 `readString` 的原始字串分支帶著 `!s.verbatim` 守衛
  // （2026-09-18，T4 fix round 1 的 Important）。
  it("逐字字串的值是引號（`@` ＋ 四個引號）⇒ 讀法正確；未收尾的同型仍大聲", () => {
    const src = ['var s = @"""";', 'public const string Alpha = "alpha";', ""].join("\n");
    // 修正前這一支是拋錯（`x.cs:1 的原始字串字面值沒有收尾`）——**大聲**，可接受但不精確；
    // 有守衛之後走逐字分支（`""` 是轉義的引號），讀法正確。
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
    // `@"""` 是「開引號 ＋ 一個轉義的 `""`」而**沒有**收尾 ⇒ 同一條路徑上仍 fail closed。
    expect(() => extractBackendValues('var s = @""";\n', { label: "x.cs" })).toThrow(
      /x\.cs:1 的字串字面值沒有收尾/,
    );
  });

  it("兩個逐字字串（各含四個引號）夾住活程式碼 ⇒ 中間不得被遮掉", () => {
    // **T4 fix round 1 的 Important 的回歸測試。** 少了 `!s.verbatim` 守衛時，第一個字面值
    // 被誤判成原始字串、一路找到第二個的四連引號才收尾 ⇒ 中間整段靜默變空白，而該檔是
    // **完全合法的 C#**（探針檔實測：中間那條宣告整段消失，只有第二個字面值**之後**的
    // 宣告活了下來，閘門也看不到那一行呼叫）。
    const src = [
      'var a = @"""";',
      "var q = db.Cards.IgnoreQueryFilters();",
      'public const string Alpha = "alpha";',
      'var b = @"""";',
    ].join("\n");
    // ① 標籤表這一側：中間的宣告要解析得到（修正前它整段被遮掉 ⇒ 這裡拋「解析不到…」）。
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
    // ② 閘門那一側：`check-query-filter-exceptions.mjs` 讀的是**遮罩結果**，所以那一行必須
    //    還在遮罩後的字串裡——少了這個斷言，「標籤表看得到、閘門看不到」的那半沒人守。
    expect(maskCSharp(src, "x.cs").masked).toContain("IgnoreQueryFilters");
  });

  // CS9000 只要求收尾「自成一行的開頭」——同一行後面接著別的程式碼是**合法**的
  // （`""" + "x"`，SDK 10.0.400 實測）。所以掃描器不能要求收尾後面是空白或行尾。
  it("收尾引號在行首、同一行後面還有程式碼 ⇒ 只遮到收尾為止", () => {
    const src = [
      "public static class X",
      "{",
      '    public static string S = """',
      "        abc",
      '        """ + "x";',
      '    public const string Alpha = "alpha";',
      "}",
    ].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
  });

  // 逐字內插字串（`$@"…"`／`@$"…"`）的洞：**2026-09-18 T4 fix round 2**。這一族在此之前
  // 沒有洞的處理——`{…}` 被當內容整段遮掉、不報錯，而洞裡正好可以放本閘門要抓的那一行。
  it("有洞的逐字內插字串（`$@\"…{…}\"`）⇒ fail closed，訊息指名檔案與行（判別力）", () => {
    const src = [
      'public const string Alpha = "alpha";',
      'var q = $@"{db.Cards.IgnoreQueryFilters()}";',
      "",
    ].join("\n");
    expect(() => extractBackendValues(src, { label: "x.cs" })).toThrow(
      /x\.cs:2 含內插的逐字字串字面值/,
    );
  });

  it("另一種拼法（`@$\"…{…}\"`）走同一條（判別力）", () => {
    expect(() => extractBackendValues('var s = @$"{x}";\n', { label: "x.cs" })).toThrow(
      /x\.cs:1 含內插的逐字字串字面值/,
    );
  });

  it("沒有洞的逐字內插字串 ⇒ 照常遮掉、不 bail（判別力；`{{` 是轉義不是洞）", () => {
    const noBraces = ['var s = $@"no braces here";', 'public const string Alpha = "alpha";', ""].join("\n");
    expect(extractBackendValues(noBraces, { label: "x.cs" })).toEqual(["alpha"]);
    // 遮罩那一側：整個字面值（含內容）都被遮掉，不是只遮引號。
    expect(maskCSharp(noBraces, "x.cs").masked).not.toContain("no braces here");
    // `{{` 是**轉義**的 `{`（逐字與非逐字的轉義規則相同）⇒ 對配對的第一個 `{` 大聲會是
    // 普通字串上的假警報，這一條就是那個守衛。
    const escaped = ['var s = $@"{{escaped}}";', 'public const string Alpha = "alpha";', ""].join("\n");
    expect(extractBackendValues(escaped, { label: "x.cs" })).toEqual(["alpha"]);
  });

  // **契約鎖**（不是本輪 Important 的證據）：fix round 1 的 `!s.verbatim` 守衛讓 `$@""""`
  // 從「拋錯」變成「讀得對」（內容是一個轉義的引號），本輪的洞守衛不得把它退回去。
  it("逐字內插字串的值是引號（`$@\"\"\"\"`）⇒ 仍讀得對（fix round 1 的契約鎖）", () => {
    const src = ['var s = $@"""";', 'public const string Alpha = "alpha";', ""].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
  });

  it("未收尾的逐字內插字串 ⇒ 仍是「沒有收尾」那條訊息（洞的守衛沒有把它吃掉）", () => {
    expect(() => extractBackendValues('var s = $@"abc\n', { label: "x.cs" })).toThrow(
      /x\.cs:1 的字串字面值沒有收尾/,
    );
  });

  // **假警報方向的守衛**（2026-09-18 final fix 任務 4a）：上面兩支釘的是「真洞要 bail」，
  // 這一支釘的是**反向**——逐字（**非內插**）字串 `@"…"` 的 `{`／`}` 是**內容**，不是洞，
  // 只有 `$@"…"`／`@$"…"` 才有洞。把內容當成洞去遞迴的後果不是漏報而是**假警報**：掃描器
  // 深入一段其實是字串的東西去找 `IgnoreQueryFilters`，於是查詢篩選閘門多報一處破例
  // ⇒ exit 1，而那是錯的（方向與上面兩支相反，所以必須各有一支）。
  it("逐字字串裡的 `{…}` 是內容、不是洞 ⇒ 那段識別字不會漏出來（判別力）", () => {
    const src = ['var s = @"a{IgnoreQueryFilters}b";', 'public const string Alpha = "alpha";', ""].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
    // 遮罩那一側才是承重的斷言（閘門掃的是 `masked`）：整段內容（含大括號）都要被遮掉，
    // 不能只遮到第一個 `{` 為止——那正是「洞的遞迴」的失敗形狀。
    expect(maskCSharp(src, "x.cs").masked).not.toContain("IgnoreQueryFilters");
  });

  it("前置處理器指示詞 ⇒ fail closed", () => {
    expect(() => extractBackendValues(`#if DEBUG\npublic const string A = "a";\n#endif\n`, { label: "x.cs" })).toThrow(
      /x\.cs:1 含前置處理器指示詞/,
    );
  });

  // 下面兩支釘住 2026-09-18（軟刪除 T4）新增的放行清單：判準是「**這個指示詞會不會改變
  // 『哪一段是活的』**」。放行 `#nullable`／`#pragma` 是查詢篩選閘門掃得動整個 `src/` 的
  // 前提——那些 EF 產生的 migration／snapshot 開頭就是 `#nullable disable`，不放行的話
  // 閘門對每一個檔拋錯（實測 39 個檔）。
  it("不影響「哪一段是活的」的指示詞（`#nullable`／`#pragma`）⇒ 遮成空白", () => {
    const src = [
      "// <auto-generated />",
      "#nullable disable",
      "",
      "public static class X",
      "{",
      "#pragma warning disable 612, 618",
      '    public const string Alpha = "alpha";',
      "#pragma warning restore 612, 618",
      "}",
    ].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["alpha"]);
  });

  it("清單外的指示詞（`#line`）⇒ 仍 fail closed、訊息指名它", () => {
    const src = '#line 5 "x.cs"\npublic const string A = "a";\n';
    expect(() => extractBackendValues(src, { label: "x.cs" })).toThrow(/x\.cs:1 含前置處理器指示詞 `#line`/);
  });

  it("區塊註解沒有收尾 ⇒ fail closed", () => {
    expect(() => extractBackendValues(`public const string A = "a";\n/* 沒收尾\n`, { label: "x.cs" })).toThrow(
      /區塊註解沒有收尾/,
    );
  });

  it("字串沒有收尾 ⇒ fail closed", () => {
    expect(() => extractBackendValues(`public const string A = "a;\n`, { label: "x.cs" })).toThrow(/字串字面值沒有收尾/);
  });

  it("字元字面值沒有收尾 ⇒ fail closed（`readChar` 的另一半）", () => {
    expect(() => extractBackendValues(`public const string A = "a";\nvar c = 'x;\n`, { label: "x.cs" })).toThrow(
      /字元字面值沒有收尾/,
    );
  });

  it("未收尾且**成對** ⇒ 已知限制（不合法 C#；編不過的樹到不了全綠）：誤閉合的字串會吃掉中間的活宣告", () => {
    // **這不是可接受的行為，是已知限制。** `maskCSharp` 的 fail closed 判準是「一支字串
    // 一路讀到檔尾都沒收尾」，所以落單的 `"` **成對**時會兩兩配對成一個「合法」的字串，
    // 中間那條本文完全正常的 `Last` 就被遮罩吃掉（期望集合靜默縮小、exit 0）。
    // 前提是這個檔案本身**不是合法的 C#**（C# 不接受跨行的非逐字字串）⇒ `dotnet build`
    // 會擋下它：`.cs` 那一側的保證只及於可編譯的 C#。
    // 措辭更正（Task 8 fix round 3 的 Minor-1／2）：原本寫「**CI 會先擋**」。實查
    // `.github/workflows/ci.yml`——`needs:` 出現 **0 次**，兩個 job 是**平行**的，沒有
    // 「先」；而且這個 checkout **沒有 remote**，workflow 今天不會被觸發，真正在擋的是
    // **本機**的 `dotnet build -c Release`。結論不變，只是不再寫成一句絕對句。
    const src = `public static class X
{
    public const string First = "first";
    var a = "x
    public const string Last = "last";
    var c = "y
}
`;
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["first"]);
  });

  // 以下兩支是 Task 8 fix round 3 的 Minor-3：兩條**承重的關鍵分支**原本沒有任何判別力
  // 測試（把該分支關掉，47 支測試全部 exit 0、全綠）。方向都是**大聲**（fail closed），
  // 所以嚴重度低於 F2；但形狀同型——綠燈的涵蓋範圍比它看起來窄。兩個輸入都用
  // `dotnet build -c Release` 證實是**合法 C#**（csproj 為 net10.0 的暫時探針，exit 0）。
  it("內插洞裡的**字元字面值**：洞的走訪要有 `readChar`", () => {
    // 樣本：var s = $"{c == '"'}";（`'"'` 是一個內容為雙引號的字元字面值）
    // 關掉洞迴圈的 `readChar(j)` ⇒ 洞在 `'"'` 裡的 `}` 之前就結束，餘料被當成程式碼，
    // 最後那個 `"` 一路讀到檔尾 ⇒ 拋「字串字面值沒有收尾」。
    const src = [
      'public const string A = "a";',
      'var s = $"{c == \'"\'}";',
      "",
    ].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["a"]);
  });

  it("內插洞裡的**嵌套字串字面值**：洞的走訪要認得字串", () => {
    // 樣本：var s = $"{s.Replace("}", "x")}";
    // 關掉洞迴圈的字串分支 ⇒ 洞在**字串裡**的 `}` 就結束，外層字串提前收尾，
    // 剩下的 `, "x")}"` 被當成程式碼 ⇒ 同一個「沒有收尾」。
    const src = [
      'public const string A = "a";',
      'var s = $"{s.Replace("}", "x")}";',
      "",
    ].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["a"]);
  });

  // **`#` 那條的「行首」條件沒有、也不該有判別力測試**（Minor-3 的第三條，控制器複驗後
  // 更正）：那條條件在**可編譯的 C#** 上不可能改變結果——`#` 在 C# 裡只能是前置處理器
  // 指示詞，而指示詞必須是該行第一個非空白字元；其餘會出現 `#` 的地方（字串、註解、字元
  // 字面值）都在主迴圈走到它之前就被跳略掉了。唯一能判別它的輸入是**不合法**的 C#
  // （實測 `y = 1 # 2;`：帶著條件 ⇒ 放行、拿掉條件 ⇒ 拋「含前置處理器指示詞」），
  // 而那個方向的突變是**更吵**（更安全）——補一支測試等於把保證之外的寬容釘成契約。
  // 所以這一條的正解是「不補」，不是「補不出來」。詳見 ledger 的收尾批次。

  it("值與分號之間可以有空行 ＋ 縮排（合法 C#；舊版的固定 8 字元窗口會誤拒）", () => {
    // Task 8 fix round 3 的 Minor-4。輸入用 `dotnet build -c Release` 證實合法（exit 0）：
    // C# 不在乎初始設定式與分號之間的空行。舊版只看引號後 8 個字元，於是拒絕它，
    // 而且訊息說「結尾不是字串字面值 ＋ 分號」——分號明明在，只是比較遠。
    const src = ['public const string A = "a"', "", "            ;", ""].join("\n");
    expect(extractBackendValues(src, { label: "x.cs" })).toEqual(["a"]);
  });

  it("值與分號之間夾了別的東西 ⇒ 仍然 fail closed（判準是「第一個非空白字元」）", () => {
    // `"a" + "b"` 本身是合法 C#，但那不是**這個掃描器認得的**字面值形狀——不猜。
    expect(() => extractBackendValues('public const string A = "a" + "b";', { label: "x.cs" })).toThrow(
      /結尾不是「字串字面值 ＋ 分號」/,
    );
  });

  it("內插字串當常數值 ⇒ fail closed（不猜它的值）", () => {
    expect(() => extractBackendValues(`public const string A = $"a";`, { label: "x.cs" })).toThrow(/不是字面值字串/);
  });

  it("空陣列 ⇒ 拋錯", () => {
    expect(() =>
      extractBackendValues(`public static readonly string[] All = [];`, { label: "x.cs", arrayName: "All" }),
    ).toThrow(/是空陣列/);
  });

  it("陣列名打錯 ⇒ 拋錯", () => {
    expect(() => extractBackendValues(REVIEW, opts("Nope"))).toThrow(/解析不到 public static readonly string\[\] Nope/);
  });

  it("註解裡的假 array 宣告不算（先出現也沒用）", () => {
    const src = `/*
public static readonly string[] All = [Pending, Approved, Rejected];
*/
public const string Pending = "pending";
public static readonly string[] All = [Pending];
`;
    expect(extractBackendValues(src, { label: "x.cs", arrayName: "All" })).toEqual(["pending"]);
  });
});

// `maskCSharp` 遮罩的兩條性質——**跨檔案的前提**（2026-09-20，Task 5 修訂輪 1 的 I-1）：
// `check-error-codes.mjs` 的 `PATTERN`（字面值錯誤訊息的形狀，`\(\s*"`）跑在遮罩上，
// 「引號本身留在原位、只有內容被遮」是它的前提。遮罩哪天連引號一起吃掉，那個形狀就永遠
// 不命中——`Results.BadRequest("中文")` 會在閘門眼下靜默通過。
//
// **先前的措辭說「其他閘門與測試都不會響」、「這個前提沒有別的地方釘著」——兩句都不對**
// （修訂輪 1／2 的 scoped re-review 更正）：`extractBackendValues` 要求遮罩上看得見開引號
// （`masked[i] === '"'`，看不到就 `bail`），所以引號一被遮掉，**依賴它的測試會跟著紅**
// ——但**不是每一支**：輸入裡本來就沒有引號的、或期望值正好是那條 fail-closed 訊息的，
// 照樣綠。而且那些紅的是**間接目擊者**：牠們釘的是「抽取找得到字面值」，只是經由那條
// fail-closed 順帶紅——**抽取路徑一改寫就整批靜默失效**，而改寫的人不會預期自己動到了
// `PATTERN` 的前提。⇒ 這支斷言釘的是**前提本身**，不是那些間接目擊者。
// 突變實測：紅在下面 `quoteIndices` 那一行（`toHaveLength` 那條照綠）。
describe("maskCSharp 的遮罩性質", () => {
  it("遮罩保留引號本身、長度守恆（被遮的是內容，不是引號）", () => {
    // 刻意只放「引號都是分隔符」的字面值：逸出引號（`\"`）與逐字字串的加倍引號（`""`）
    // 是**內容**，被遮掉是正確行為，放進來會讓這支斷言說錯話。
    const src = [
      'public const string Alpha = "alpha";',
      'var message = "訊息";',
      'var verbatim = @"abc";',
      "",
    ].join("\n");
    const { masked } = maskCSharp(src, "x.cs");
    const quoteIndices = (s) => {
      const at = [];
      for (let i = 0; i < s.length; i++) if (s[i] === '"') at.push(i);
      return at;
    };
    // 長度守恆：`check-error-codes.mjs` 的行號換算（`hitIndex`）也靠這一條。
    expect(masked).toHaveLength(src.length);
    // 每一個 `"` 都在原索引上——`PATTERN` 的 `\(\s*"` 命不命中取決於這一條。
    expect(quoteIndices(masked)).toEqual(quoteIndices(src));
  });
});

describe("extractSupportedLocales", () => {
  it("型別註解夾在中間也可以；**註解副本在上時選活碼**", () => {
    const src = `// export const SUPPORTED_LOCALES: readonly string[] = ["ja"];
export const SUPPORTED_LOCALES: readonly string[] = ["zh-TW", "en", "zh-CN"];
export const PSEUDO_LOCALE = "en-XA";`;
    expect(extractSupportedLocales(src, { label: "src/i18n/locales.ts", fileName: "locales.ts" })).toEqual([
      "zh-TW",
      "en",
      "zh-CN",
    ]);
  });

  it("非字串字面值的元素 ⇒ 拋錯、指名**行號與索引**（Info-1）", () => {
    expect(() =>
      extractSupportedLocales('export const SUPPORTED_LOCALES = ["zh-TW", ...EXTRA];', {
        label: "src/i18n/locales.ts",
        fileName: "locales.ts",
      }),
    ).toThrow(/src\/i18n\/locales\.ts:1 的 SUPPORTED_LOCALES 第 1 個元素不是字串字面值/);
  });

  it("宣告不存在 ⇒ 拋錯", () => {
    expect(() => extractSupportedLocales("export const X = 1;", { label: "src/i18n/locales.ts" })).toThrow(
      /解析不到 SUPPORTED_LOCALES/,
    );
  });
});
