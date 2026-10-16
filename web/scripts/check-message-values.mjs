// 閘門 C（設計 §4.2）：C# 的 `message` 字面值 ↔ zh-TW 語系檔的值。
// CI 與本機皆可跑：`node scripts/check-message-values.mjs`（或 `npm run check:message-values`）。
//
// 為什麼需要這支：`{code, message}` body 的 `message` 是**遷移當下字面值的逐字凍結副本**
// （`ErrorCodes.cs` 的檔頭是權威出處：`code` 是機器契約、`message` 是除錯與後備、
// 語系固定 zh-TW），而 zh-TW `error.json` 的同一條值是**給新前端看的**那一份。
// 改了其中一邊而沒改另一邊 ⇒ **新前端顯示新措辭、舊前端與日誌顯示舊措辭**
// （版本 skew 的憑據失效——那正是把 `message` 放進 body 的用途之一），而
// **全部測試照綠**：測試斷言的是 C# 那一份；`check:labels` 連的是 **key**；
// `check:errors` 只看**形狀**——兩者都不比對**值**。這支補的就是那個洞。
//
// 與閘門 B（`check-error-messages.mjs`）的關係：B 守 `ErrorMessages.cs` 那張表
// （**單向**、先剝 `{{…}}` 再比）；C 守**各站點內嵌的字面值**（雙向的值比對，
// 語系值當樣式）。兩者的聯集＝今天所有會進 `{code, message}` body 的字面值。
//
// ## 這道閘門只抓措辭——數字漂移不歸它
//
// 語系值的 `{{max}}` 是 `(.*?)`，**C# 送 1000、語系檔寫 2000 也照過**。數字的一致性由
// **同源機制**擁有：`@params` 的值與 C# 的內插變數是同一個變數（W8），不是兩份副本。
// R3／R3b 守的是**佔位名**對得上（名字錯了前端會原樣印出 `{{…}}`），不是值對得上。
//
// ## 已知盲區（誠實記載）
//
//   1. **`identity.*` 的十個碼**（`IdentityErrorCodes.Map(e.Code)` 那兩個站點）：
//      訊息來自 ASP.NET Identity 自己的 describer，**兩邊在語法上不可比**（C# 那一側
//      根本沒有字面值）。抽取器把它們標成 `identity` 並跳過。
//   2. **401 的空 body**（`Results.Unauthorized()` 與 auth middleware 的結構性 401）：
//      沒有 `message`，不進這道閘門。它們由前端的 `apiErrorMessage` 的 `fallback` 接手。
//   3. **值「相等但兩邊都錯」**看不出來——那是複閱的事，不是閘門的事。
//   4. **其餘語系**（`en`／`zh-CN`）的值不在範圍：`i18n:parity` 守 key 集合、人工複閱守意思。
//
// ## 粗粒度碼（唯一被宣告的資料）
//
// `COARSE_CODES` 是「一句泛用訊息蓋住多種具體情況」的碼——兩邊本來就不會逐字相等。
// **沒有值白名單**（一開白名單這道閘門就沒了）；宣告由 `message-value-compare.mjs` 的
// 三個守衛釘住（宣告了卻只有一種字面值 ⇒ 紅；沒宣告卻有多種 ⇒ 紅；宣告了而語系值與
// 某個字面值相同 ⇒ 紅）。
//
// **數字別寫死、也別從註解抄**：站點數與碼數都會隨每個新錯誤碼長大。要量就當場跑
// （成功訊息印的是實測值，那些數字才是來源）：
//   cd web && npm run check:message-values
//
// 認不得（抽取器拋、碼不在對照表、缺語系值、值不等、守衛響）⇒ exit 1，訊息指名 `檔案:行號`。

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LabelTableParseError, extractBackendValues } from "./lib/label-table-extract.mjs";
import { resolveForwards, scanCSharpFile } from "./lib/csharp-message-sites.mjs";
import { compareSites } from "./lib/message-value-compare.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const repoRoot = join(root, "..");

const SRC_DIR = "src";
const LOCALE_FILE = "web/src/i18n/locales/zh-TW/error.json";

/**
 * 被宣告為粗粒度的碼。**每一條都要附理由**——沒有理由的宣告就是橡皮圖章。
 *
 * - `request.invalid`：ASP.NET 的模型繫結失敗（`Results.ValidationProblem` 的來源）
 *   在 `Program.cs` 與各端點上蓋成一句泛用訊息；同一句話要蓋住幾十種具體的繫結錯誤，
 *   兩邊逐字相等本來就不成立（守衛 b 的數字會告訴你現在有幾種）。
 */
const COARSE_CODES = ["request.invalid"];

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/** `src/` 之下的每一個 `.cs`（相對路徑，`/` 分隔，排序後穩定）。 */
const walkCSharp = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkCSharp(full));
    else if (entry.name.endsWith(".cs")) found.push(full);
  }
  return found.sort();
};

/** 語系值 ⇒ 點分碼 ⇒ 值（葉節點；`card.notFound` ⇒ `error.json` 的 `["card"]["notFound"]`）。 */
const flatten = (node, prefix, out) => {
  for (const [key, value] of Object.entries(node)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object") flatten(value, dotted, out);
    else out.set(dotted, String(value));
  }
  return out;
};

let codes;
let files;
try {
  // 檔名要比**整個** `basename`：`endsWith("ErrorCodes.cs")` 連 `IdentityErrorCodes.cs`
  // 一起撿進來（實測：那正是第一次跑就會撞到的形狀，而「恰好一個」的守衛當場擋下）。
  const codeFiles = walkCSharp(join(repoRoot, SRC_DIR)).filter(
    (f) => basename(f) === "ErrorCodes.cs",
  );
  if (codeFiles.length !== 1) {
    // 認不得就大聲：憑檔名找常數表，0 個或 ≥2 個都不猜。
    console.error(
      `錯誤訊息值檢查無法完成——\`${SRC_DIR}/\` 之下找到 ${codeFiles.length} 個 \`ErrorCodes.cs\`` +
        `（要有恰好一個）。本檢查不猜。`,
    );
    process.exit(1);
  }
  codes = extractBackendValues(readFileSync(codeFiles[0], "utf8"), {
    label: "ErrorCodes.cs",
    withNames: true,
  });

  files = [];
  const producerNames = new Set();
  for (const full of walkCSharp(join(repoRoot, SRC_DIR))) {
    const label = full.slice(repoRoot.length + 1).split("\\").join("/");
    const result = scanCSharpFile(readFileSync(full, "utf8"), { label, codes });
    for (const producer of result.producers) producerNames.add(producer.name);
    files.push({ label, result });
  }
  resolveForwards({ files, producerNames });
} catch (error) {
  // 抽不到 ≠ 比對失敗：這裡的訊息要指對方向（見 `lib/csharp-message-sites.mjs` 的檔頭）。
  if (error instanceof LabelTableParseError) {
    console.error("錯誤訊息值檢查無法完成——抽取器遇到它認不得的形狀（本檢查不猜）：\n");
    console.error(`  - ${error.message}`);
    console.error(
      "\n請改寫該站點讓它回到抽取器認得的形狀，或更新 web/scripts/lib/csharp-message-sites.mjs。" +
        "\n（靜默跳過一個站點等於放行它的漂移——所以抽取器選擇當場拋。）",
    );
    process.exit(1);
  }
  throw error;
}

const localeValues = flatten(
  JSON.parse(read(LOCALE_FILE)),
  "",
  new Map(),
);

const sites = files.flatMap(({ result }) => result.sites);
const { errors, stats } = compareSites({ sites, localeValues, coarseCodes: COARSE_CODES });

if (errors.length > 0) {
  console.error(`C# 的 message 字面值與 zh-TW 語系值不符（${errors.length} 條）：\n`);
  for (const error of errors) console.error(`  - ${error}\n`);
  console.error(
    `兩邊是**同一個語意的兩份副本**（設計 §4.2），改了哪一邊就同步另一邊：\n` +
      `  - 改了 C# 的字面值 ⇒ 同步 ${LOCALE_FILE}（其餘語系由 i18n:parity 追 key、由複閱追值）。\n` +
      `  - 改了 ${LOCALE_FILE} ⇒ 同步 C# 的字面值（否則舊前端與日誌顯示舊措辭）。\n` +
      `  這條契約刻意不設值白名單：一開白名單，這道閘門就沒了。粗粒度碼是唯一被宣告的資料，` +
      `宣告本身由三個守衛釘住（見 web/scripts/lib/message-value-compare.mjs 的檔頭）。`,
  );
  process.exit(1);
}

console.log(
  `錯誤訊息值檢查通過：掃過 ${files.length} 個 .cs、${stats.sites} 個帶 \`message\` 的站點，` +
    `其中 ${stats.compared} 個值與 ${stats.codes} 個碼的 zh-TW 語系值逐字相符` +
    `（語系值的 \`{{…}}\` 當樣式，其餘逐字；先化約形狀再比）。\n` +
    `  粗粒度碼 ${stats.coarse} 個（${COARSE_CODES.join("、")}）——三個守衛都通過。\n` +
    `  方向是雙向的：C# 改了要同步語系檔，語系檔改了要同步 C#（版本 skew 的憑據）。`,
);
