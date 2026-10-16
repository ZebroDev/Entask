// Gate B（設計 §5）：`ErrorMessages.For` 的值 ↔ zh-TW 語系檔的值。CI 與本機皆可跑：
// `node scripts/check-error-messages.mjs`（或 `npm run check:error-messages`）。
//
// 為什麼需要這支：`src/Entask.Core/ErrorMessages.cs` 的字面值與
// `web/src/i18n/locales/zh-TW/error.json` 的同批 key 是**同一個語意的兩份副本**——一份給
// 舊前端與日誌（`{code, message}` body 的 `message`），一份給新前端（錯誤碼的譯文）。
// 改了一邊沒改另一邊 ⇒ **新前端顯示新措辭、舊前端顯示舊措辭**（版本 skew 的憑據失效），
// 而**全部測試照綠**：測試斷言的是 C# 那份；`check:labels` 連的是 **key**（第八張表）、
// `check:errors` 只看**形狀**——兩者都不比對**值**。這支補的就是那個洞。
//
// 方向：**單向**。`ErrorMessages` 的每一個 code ⇒ 都要在 zh-TW/error.json 找到同名 key、
// 且值逐字相等（先剝 `{{...}}` 佔位再比）。
//
//   **反向不驗，這是刻意的**：zh-TW/error.json 的葉節點遠多於訊息表（其餘是 400／403
//   那些**不走 `ApiResults.NotFound`**、由各站點內嵌字面值產生的碼）。寫成集合相等 ⇒
//   這道閘門第一天就紅一大片，而下一步就是白名單——一開白名單它就沒了。
//   **key 集合**的三個方向（ErrorCodes 常數 ↔ 前端 case ↔ 各語系都有 key）已經由
//   `check:labels` 的第八張表守著；Gate B 守的是**值**。
//
//   **先剝 `{{...}}` 再比**（P-C 的不變量：樣板與成品永遠不可能逐字相等，`attachment.tooLarge`
//   那一類的 C# 是填好的成品、語系值是 `{{max}}` 樣板）。今天這張表**一條佔位都沒有**，
//   閘門從第一天就照那個判準寫，免得未來第一條帶佔位的訊息進來時被迫開白名單。
//
// **數字別寫死、也別從註解抄**：臂數（＝訊息表的 code 數）與葉節點數都會隨每個新錯誤碼長大
// ——本階段自己就長了 16 個。要量就當場數（成功訊息印的是實測值）：
//   python -c "import json;leaf=lambda o:sum(leaf(v) for v in o.values()) if isinstance(o,dict) else 1;print(leaf(json.load(open('web/src/i18n/locales/zh-TW/error.json',encoding='utf-8'))))"
//
// **已知盲區（誠實記載）**：
//   1. 本檢查只認 `ErrorMessages.For` 那**一個** `switch`（抽取器認不得就拋，見
//      `lib/error-message-table.mjs`）——別處若又長出第二張訊息表，本檢查看不到。
//      在那之前那份字面值不進 `{code, message}` body，也就沒有版本 skew 的問題。
//   2. 其餘語系（`en`／`zh-CN`）的**值**不在本檢查範圍：它們由 `i18n:parity` 守 key 集合、
//      由人工複閱守意思。這裡守的是**兩份 zh-TW 副本**之間的漂移。
//   3. 值「相等但兩邊都錯」看不出來——那是複閱的事，不是閘門的事。
//
// 認不得（抽取器拋、key 找不到、值不等）⇒ exit 1，訊息指名 code 與檔案。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LabelTableParseError, extractBackendValues } from "./lib/label-table-extract.mjs";
import { extractErrorMessageTable } from "./lib/error-message-table.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // web/
const repoRoot = join(root, "..");

const ERROR_MESSAGES_FILE = "src/Entask.Core/ErrorMessages.cs";
const ERROR_CODES_FILE = "src/Entask.Core/ErrorCodes.cs";
const LOCALE_FILE = "web/src/i18n/locales/zh-TW/error.json";

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

// 先剝掉 `{{...}}` 佔位再比（見檔頭：樣板 vs 成品永遠不可能逐字相等）。
const stripPlaceholders = (value) => value.replaceAll(/\{\{[^}]*\}\}/g, "");

// `card.notFound` ⇒ error.json 裡的 `["card"]["notFound"]`（實查：葉節點深度 2、
// JSON 的鍵本身不含點——`key.split(".")` 的走法成立）。
const lookup = (json, dottedKey) =>
  dottedKey
    .split(".")
    .reduce((node, part) => (node !== null && typeof node === "object" ? node[part] : undefined), json);

let codes;
let table;
try {
  codes = extractBackendValues(read(ERROR_CODES_FILE), {
    label: "ErrorCodes.cs",
    withNames: true,
  });
  table = extractErrorMessageTable(read(ERROR_MESSAGES_FILE), { codes, label: "ErrorMessages.cs" });
} catch (error) {
  // 抽不到 ≠ 比對失敗：這裡的訊息要指對方向（見 lib/error-message-table.mjs 的檔頭）。
  if (error instanceof LabelTableParseError) {
    console.error("錯誤訊息表檢查無法完成——抽取器遇到它認不得的形狀（本檢查不猜）：\n");
    console.error(`  - ${error.message}`);
    console.error(
      "\n請改寫該檔讓它回到抽取器認得的形狀，或更新 web/scripts/lib/error-message-table.mjs。" +
        "\n（回一張空表或半張表會讓比對也 exit 1，但訊息會指錯方向——說「語系檔少了 key」而不是" +
        "「抽取器認不得這個檔」，所以抽取器選擇當場拋。）",
    );
    process.exit(1);
  }
  throw error;
}

const locale = JSON.parse(read(LOCALE_FILE));
const mismatches = [];
for (const [code, csharpValue] of table) {
  const localeValue = lookup(locale, code);
  if (typeof localeValue !== "string") {
    mismatches.push(`${code}：${LOCALE_FILE} 找不到這個 key（ErrorMessages.cs 有這一條）`);
    continue;
  }
  if (stripPlaceholders(csharpValue) !== stripPlaceholders(localeValue)) {
    mismatches.push(
      `${code}：值不一致\n` +
        `      ${ERROR_MESSAGES_FILE}：${csharpValue}\n` +
        `      ${LOCALE_FILE}：${localeValue}`,
    );
  }
}

if (mismatches.length > 0) {
  console.error(`錯誤訊息表與 zh-TW 語系值不符（${mismatches.length}／${table.size} 條）：\n`);
  for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
  console.error(
    `\n兩邊是**同一個語意的兩份副本**，改了哪一邊就同步另一邊：\n` +
      `  - 改了 ${ERROR_MESSAGES_FILE} ⇒ 同步 ${LOCALE_FILE}（其餘語系由 i18n:parity 追 key、由複閱追值）。\n` +
      `  - 改了 ${LOCALE_FILE} ⇒ 同步 ${ERROR_MESSAGES_FILE}（否則舊前端與日誌顯示舊措辭）。\n` +
      `  這條契約刻意不設白名單：一開白名單，這道閘門就沒了。`,
  );
  process.exit(1);
}

console.log(
  `錯誤訊息表檢查通過：ErrorMessages.cs 的 ${table.size} 個 code 全部相符` +
    `（${LOCALE_FILE} 都有同名 key、值逐字相等；先剝 {{...}} 佔位再比）。\n` +
    `  方向是單向：語系檔其餘的葉節點不走這張表（400／403 那些由各站點內嵌字面值產生），刻意不驗。`,
);
