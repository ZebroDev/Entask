// 語系檔案的完整性檢查。CI 與本機皆可跑：node scripts/check-locale-parity.mjs
//
// 檢查十二件事，任一不成立即非零退出：
//
//   1. SUPPORTED_LOCALES 的每個語系都有資源目錄，且沒有多餘的目錄。
//   2. resources.ts 匯入的 (語系, namespace) 與磁碟上的檔案完全一致。
//      少了匯入的 namespace 不會有任何徵兆——型別檢查看不到它，i18next 只是
//      靜默地退回 fallback 語系，於是英文使用者看到中文而沒有人知道。
//   3. 逐 namespace 比較各語系的 key 集合**相等**（比 key 集合，不是比檔案內容——
//      譯文本來就不同，內容相等是錯的期待）。
//   4. 沒有空字串的譯文（`i18next-parser` 對「程式碼有 t() 但還沒填譯文」是寫入
//      空字串——畫面一片空白，沒有錯誤、沒有警告、測試也照過）。
//   5. 目標語系裡**已經帶有尾綴的**複數鍵，類別必須齊全（缺一類時 i18next **不會**
//      退回自己的 `_other`，而是往下一個 fallback 語系找——於是英文的 count === 1
//      顯示中文）。家族由目標檔自己的尾綴鍵建構，**沒有來源側播種**，盲區見檢查 5。
//   6. 佔位名集合跨語系一致（`{{nome}}` 這種手滑只會在目標語系顯形）。
//   7. 語系選單的自稱名與 SUPPORTED_LOCALES 對齊。
//   8. 值裡有 `{{count}}` 的鍵必須是複數族（見下方檢查 8）。
//   9. 語系檔的值不得含 emoji（產品內容留在 JSX，見下方檢查 9）。
//  10. 伺服器匯出資源檔（src/Entask.Api/Resources/export.<locale>.json）逐語系 key 集合相等、
//      無空值、佔位名一致。
//  11. ExportKeys 的常數集與 export.zh-TW.json 的 key 集相等。
//  12. 匯出資源檔的三個集合連起來：磁碟上的 export.<locale>.json ↔ SUPPORTED_LOCALES
//      **雙向相等**，且 csproj 仍以 glob（不是逐檔列舉）內嵌它們——收窄成列舉會讓沒有
//      資源檔的語系靜默退回預設語系（`ExportLabels.Resolve` 對認不得的語系回 `Default`，
//      不是 400）。
//
// 5 與 6 是同一類：**只在目標語系顯形**的缺陷，來源語系的測試全綠也擋不住。
// 8 與 9 補的是另外兩種「四道防線同時隱形」的形狀：
//
//   - 8 的**呼叫端**那半邊已經有人守（`i18next-parser --fail-on-update`：呼叫端忘傳
//     count 時，parser 會把 `_other` 判為沒人用而刪掉——B2-6a 的探針實測）。
//     沒人守的是**值**這半邊：手改 JSON 寫了 `{{count}}` 卻沒把它建成複數族——
//     那個語言就不可能依數量變形（實測與機制見下方檢查 8）。
//   - 9 的範圍**刻意只有語系檔**。UI 的 🏆⭐🥇 是產品內容、留在 JSX（B2-6a 裁定），
//     掃原始碼只會製造假陽性；standing rule 禁的是「檔案內使用 emoji」，而在前端
//     專案裡真正會被誤加進去的檔案就是語系檔。
//
// 為何要解析原始碼而不是寫死清單：寫死的清單會在新增語系時忘記更新，而「忘記更新
// 的清單」正是這支腳本要防的東西。解析失敗時直接失敗，不靜默跳過。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "..");
const localesDir = join(root, "src", "i18n", "locales");
const localesTs = join(root, "src", "i18n", "locales.ts");
const resourcesTs = join(root, "src", "i18n", "resources.ts");

const errors = [];
const fail = (msg) => errors.push(msg);

/** 從 locales.ts 取出 SUPPORTED_LOCALES 的內容。取不到就失敗，不猜。 */
function readSupportedLocales() {
  const src = readFileSync(localesTs, "utf8");
  const m = src.match(/export const SUPPORTED_LOCALES[^=]*=\s*\[([^\]]*)\]/);
  if (!m) {
    fail("無法從 src/i18n/locales.ts 解析 SUPPORTED_LOCALES——請確認該宣告仍是一行陣列字面值。");
    return [];
  }
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

/** 從 resources.ts 取出所有 ./locales/<locale>/<ns>.json 的匯入。 */
function readResourceImports() {
  const src = readFileSync(resourcesTs, "utf8");
  return [...src.matchAll(/from\s+"\.\/locales\/([^/"]+)\/([^/"]+)\.json"/g)].map((m) => ({
    locale: m[1],
    ns: m[2],
  }));
}

/** 攤平成點分鍵路徑。空物件（骨架）就是空集合，這是合法的。 */
function flatten(value, prefix = "", out = []) {
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out.push(path);
  }
  return out;
}

/**
 * 複數後綴。清單必須與 `i18next-parser` 的 `pluralSuffixes` 一致
 * （`node_modules/i18next-parser/dist/helpers.js` 的 zero/one/two/few/many/other）——
 * 它用同一組剝除後綴再排序，兩邊不一致會讓 key 順序漂移而 `--fail-on-update` 紅燈。
 */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join("|")})$`);

/**
 * emoji 的判定用 Unicode 屬性，不列字元清單——清單會過期，而漏掉的那個 emoji
 * 正是它存在的原因。反斜線用 fromCharCode 組：這支檔案會經過 heredoc 寫入，
 * 而 `\p` 這種寫法在傳遞途中被收斂過一次（AGENTS.md 的 quirk，實際踩過）。
 */
const BS = String.fromCharCode(92);
const EMOJI = new RegExp(BS + "p{Extended_Pictographic}", "u");

/** 剝掉複數後綴。非複數鍵原樣回傳。 */
const baseKey = (path) => path.replace(PLURAL_SUFFIX, "");

const supported = readSupportedLocales();
const imports = readResourceImports();

if (supported.length === 0) {
  fail("SUPPORTED_LOCALES 是空的。");
}
if (imports.length === 0) {
  fail("無法從 src/i18n/resources.ts 解析出任何語系匯入——請確認匯入寫法仍是一行一個 JSON。");
}

// 檢查 1：支援語系 ↔ 目錄
const dirs = existsSync(localesDir)
  ? readdirSync(localesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
for (const locale of supported) {
  if (!dirs.includes(locale)) fail(`SUPPORTED_LOCALES 有 "${locale}"，但 src/i18n/locales/${locale}/ 不存在。`);
}
for (const dir of dirs) {
  if (!supported.includes(dir)) {
    fail(`src/i18n/locales/${dir}/ 存在，但 "${dir}" 不在 SUPPORTED_LOCALES 中（多餘的語系目錄）。`);
  }
}

// 檢查 2：resources.ts 的匯入 ↔ 磁碟上的檔案
const importedPairs = new Set(imports.map((i) => `${i.locale}/${i.ns}`));
if (importedPairs.size !== imports.length) {
  fail("resources.ts 有重複的語系／namespace 匯入。");
}
const diskPairs = new Set();
for (const locale of dirs) {
  for (const file of readdirSync(join(localesDir, locale))) {
    if (file.endsWith(".json")) diskPairs.add(`${locale}/${file.slice(0, -5)}`);
  }
}
for (const pair of importedPairs) {
  if (!diskPairs.has(pair)) fail(`resources.ts 匯入了 ${pair}.json，但該檔案不存在。`);
}
for (const pair of diskPairs) {
  if (!importedPairs.has(pair)) {
    fail(`src/i18n/locales/${pair}.json 存在，但 resources.ts 沒有匯入它——該 namespace 會靜默地退回 fallback 語系。`);
  }
}

// 檢查 3：key 集合相等
//
// 檢查 4：沒有空字串的譯文。
//
// 空字串是這條管線最安靜的失敗：`i18next-parser` 對「程式碼有 t() 但語系檔還沒有
// 這個 key」的處置是**寫入空字串**，而它對已存在的 key 一律保留原值。兩件事合起來
// 意味著空字串只可能來自「有人加了 key 但沒填譯文」——畫面上一片空白，
// 沒有錯誤、沒有警告、測試也照過（斷言通常比對的是別的東西）。集合相等看不到它，
// 因為兩邊都空得很一致。
const namespaces = new Set([...diskPairs].map((p) => p.split("/")[1]));
let valueCount = 0;
for (const ns of [...namespaces].sort()) {
  let reference = null;
  for (const locale of supported) {
    const file = join(localesDir, locale, `${ns}.json`);
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // 比**剝除複數尾綴後**的鍵集合，不是原始鍵集合：各語系的複數類別本來就不同
    // （zh-TW 只有 `_other`，en 有 `_one`／`_other`），拿原始鍵比會讓正確的 en 檔
    // 被判成「多了 key」。缺漏的那一類由下面的檢查 5 負責——那才是真正該擋的。
    const keys = new Set(flatten(raw).map(baseKey));
    for (const key of flatten(raw)) {
      const value = key.split(".").reduce((node, part) => node?.[part], raw);
      if (typeof value === "string") {
        valueCount++;
        if (value.trim() === "") fail(`[${ns}] ${locale} 的 ${key} 是空字串——沒有人填這個譯文。`);

        // 檢查 8：值裡有 {{count}} ⇒ 這個鍵必須是一個複數族。
        //
        // i18next 靠**選項名稱**決定要不要做複數解析（不是靠值裡有沒有 {{count}}），
        // 而它選不到尾綴時會**退回基底鍵**。兩件事合起來的意思是：值裡有 {{count}} 而
        // 鍵沒有尾綴時，呼叫端傳了 count 就照基底鍵代換——**這個語言不可能依數量變形**。
        //
        // 實測（2026-09-15，i18next 26；腳本與輸出見 SDD ledger）：
        //   { base: "{{count}} days" }        t("base", { count: 1 })  → "1 days"
        //   { base: "{{count}} days" }        t("base", { n: 3 })       → "{{count}} days"
        //   { family_one: "1 day", …_other }  t("family", { n: 1 })     → "family"（裸鍵）
        // 第一列是這一條要擋的：英文的 count === 1 印出 `1 days`，而 zh-TW 只有 `_other`、
        // 本來就不變形，所以來源語系看不出差別。第三列是 B2-6a 已知的另一半。
        if (value.includes("{{count}}") && !PLURAL_SUFFIX.test(key)) {
          fail(
            `[${ns}] ${locale} 的 ${key} 值裡有 {{count}}，但這個鍵不是複數族` +
              `——i18next 靠選項名稱決定要不要做複數解析，值裡的 {{count}} 不會讓它解析。` +
              `請把這個鍵改成基名 ＋ 對應語系的複數類別。`,
          );
        }

        // 檢查 9：語系檔的值不得含 emoji。
        //
        // 沒有守門員時的形狀：一個 emoji 加進語系檔不會有任何徵兆——六個語系都顯示
        // 同一個字元，所以 parity 的集合比對、`i18next-parser` 與 `tsc` 全部照過。
        // 判準是 standing rule「檔案內不使用 emoji」，而 emoji 屬產品內容、留在 JSX。
        const emoji = value.match(EMOJI);
        if (emoji) {
          fail(`[${ns}] ${locale} 的 ${key} 值裡有 emoji（${emoji[0]}）——emoji 是產品內容，請留在 JSX 這一側。`);
        }
      }
    }
    if (reference === null) {
      reference = { locale, keys };
      continue;
    }
    const missing = [...reference.keys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !reference.keys.has(k));
    for (const k of missing) fail(`[${ns}] ${locale} 缺少 key：${k}（${reference.locale} 有）`);
    for (const k of extra) fail(`[${ns}] ${locale} 多了 key：${k}（${reference.locale} 沒有）`);
  }
}

// 檢查 5：目標語系裡**已經帶有尾綴的**複數族，類別必須齊全。
//
// **這條是「英文的計數句在 count === 1 時顯示中文」的守門員**（2026-09-14，B2-2b 實測）。
// i18next 用 `Intl.PluralRules(lng).select(count)` 選尾綴；**選不到時不會退回自己的
// `_other`**，而是往下一個 fallback 語系找——於是英文使用者拿到 zh-TW 的 `_other`，
// 也就是中文。實測：`en` 的 9 個計數鍵在 count=1 時全部顯示中文（`1 未讀`、`卡片 (1)`）。
//
// 為何其他防線都看不到：zh-TW 只有 `other` 一個類別，這條路徑在來源語系上永遠不顯形；
// `i18next-parser` 只管 zh-TW（config 的 `locales`）；而測試把 `navigator.languages`
// 釘在 zh-TW，391 條斷言沒有一條以其他語系執行過。會踩到的是複數類別多於 `other` 的
// 語系——en（`one`）與 es-419（`one`、`many`）都是，後續新增的語系同理。
//
// **本檢查的盲區**：家族是由**目標檔自己帶尾綴的鍵**建構的（下面的 families），
// **沒有來源側播種**——目標語系把一整族寫成**裸鍵**（值不含 `{{count}}`，那是被允許的
// 形狀）時，檢查 3 比的是剝尾綴後的集合、檢查 8 只認「值裡有 `{{count}}`」，**兩邊都過**，
// 這裡則是一個家族都看不到。那一半由 `check-locale-copy.mjs` 負責（它從來源檔的
// 帶尾綴基底播種家族）；**這不是缺口**——`check:copy` 是 CI 的一步，跑 parity 的人
// 不會漏掉它。
for (const locale of supported) {
  let required;
  try {
    required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    fail(`"${locale}" 不是 Intl.PluralRules 認得的語系標籤——無法檢查複數類別。`);
    continue;
  }
  for (const ns of [...namespaces].sort()) {
    const file = join(localesDir, locale, `${ns}.json`);
    if (!existsSync(file)) continue;
    const families = new Map();
    for (const path of flatten(JSON.parse(readFileSync(file, "utf8")))) {
      if (!PLURAL_SUFFIX.test(path)) continue;
      const base = baseKey(path);
      if (!families.has(base)) families.set(base, new Set());
      families.get(base).add(path.slice(base.length + 1));
    }
    for (const [base, have] of families) {
      const missing = required.filter((c) => !have.has(c));
      if (missing.length === 0) continue;
      fail(
        `[${ns}] ${locale} 的複數鍵 ${base} 缺 ${missing.map((c) => `_${c}`).join("、")}` +
          `——${locale} 的複數類別是 ${required.join("/")}，` +
          `缺的那一類在對應數量時會退回 fallback 語系（顯示中文）。`,
      );
    }
  }
}

// 檢查 6：佔位名集合跨語系一致。
//
// `{{name}}` 打成 `{{nome}}` 的後果是**全綠**：key 集合相同、譯文非空、`tsc -b` 與
// 全部 zh-TW 斷言都看不到，只有目標語系的畫面印出未代換的 `{{nome}}`。與檢查 5
// 同一類（只在目標語系顯形），所以放在同一支守門員裡。
//
// 比**集合**不比順序：英文詞序本來就可能不同（`刪除「{{name}}」共 {{count}} 張`
// 在 en 是 `Delete {{count}} cards in "{{name}}"`）。順序只在來源語系這一側有意義
// ——它是「第 n 個運算式 = 第 n 個 {{...}}」的對位依據，由改寫工具逐字元核對。
//
// 基準是第一個有檔案的語系（zh-TW）。其餘語系的**每一個複數形**都要與基準的
// 佔位名集合相同，因為同一個呼叫端對所有語系傳的選項是同一組。
const placeholderSig = (value) =>
  [...value.matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

for (const ns of [...namespaces].sort()) {
  let reference = null;
  for (const locale of supported) {
    const file = join(localesDir, locale, `${ns}.json`);
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const signatures = new Map(); // 基底鍵 -> Set<佔位名簽章>（複數形各一個）
    for (const path of flatten(raw)) {
      const value = path.split(".").reduce((node, part) => node?.[part], raw);
      if (typeof value !== "string") continue;
      const base = baseKey(path);
      if (!signatures.has(base)) signatures.set(base, new Set());
      signatures.get(base).add(placeholderSig(value));
    }
    if (reference === null) {
      reference = { locale, signatures };
      continue;
    }
    for (const [base, sigs] of signatures) {
      const ref = reference.signatures.get(base);
      if (!ref) continue;
      for (const sig of sigs) {
        if (ref.has(sig)) continue;
        fail(
          `[${ns}] ${locale} 的 ${base} 佔位名與 ${reference.locale} 不一致：` +
            `[${sig}] vs [${[...ref].join(" / ")}]——未代換的 {{...}} 會直接印在畫面上。`,
        );
      }
    }
  }
}

// 檢查 7：語系選單的自稱名與 SUPPORTED_LOCALES 對齊。
//
// `LOCALE_ENDONYMS`（locales.ts）是語系選單的顯示來源，而它**刻意不放語系檔**
// ——自稱名不隨語系改變，放進去等於讓它被翻譯。代價是它沒有其他守門員：
// 新增一個語系卻忘了補自稱名時，選單只會顯示裸的語系碼
// （`UserSettingsDialog` 的 `?? code` 會靜默接住），不會紅、也沒有任何提示。
const endonymBlock = readFileSync(localesTs, "utf8").match(
  /export const LOCALE_ENDONYMS[^=]*=\s*\{([^}]*)\}/,
);
if (!endonymBlock) {
  fail("無法從 src/i18n/locales.ts 解析 LOCALE_ENDONYMS——請確認該宣告仍是一個物件字面值。");
} else {
  const declared = [...endonymBlock[1].matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]);
  for (const locale of supported) {
    if (!declared.includes(locale)) {
      fail(
        `SUPPORTED_LOCALES 有 "${locale}"，但 LOCALE_ENDONYMS 沒有它的自稱名` +
          `——語系選單會顯示裸的語系碼 "${locale}"。`,
      );
    }
  }
  for (const locale of declared) {
    if (!supported.includes(locale)) {
      fail(`LOCALE_ENDONYMS 有 "${locale}"，但它不在 SUPPORTED_LOCALES 中（多餘的項目）。`);
    }
  }
}

// 檢查 10：伺服器匯出資源檔的逐語系一致性。
//
// 為什麼由**這一支**守而不是後端測試：這兩個檔案的消費端是 C#（`ExportLabels`），
// 但「各語系 key 集合相等／沒有空值／佔位名一致」正是 parity 已經在對 SPA 語系檔
// 做的事——同一種缺陷、同一種守門員，放在一起才不會有一半的語系檔案沒有人守。
//
// 語系清單直接取 SUPPORTED_LOCALES，**缺檔即失敗**：`?locale=` 是前端從
// `currentLocale()` 帶上來的，使用者在選單裡選得到的語系就必須匯得出對應的檔案。
// 認不得的語系回 zh-TW 是執行期的降級路徑（設計 §6.2），不是「可以不建檔」的許可。
const exportDir = join(repoRoot, "src", "Entask.Api", "Resources");
const exportKeysSrc = join(repoRoot, "src", "Entask.Core", "ExportKeys.cs");

function readExport(locale) {
  const file = join(exportDir, `export.${locale}.json`);
  if (!existsSync(file)) {
    fail(`src/Entask.Api/Resources/export.${locale}.json 不存在——${locale} 的匯出會退回 zh-TW。`);
    return null;
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`export.${locale}.json 不是一個扁平的 key → 字串物件（本檢查不猜形狀）。`);
    return null;
  }
  return raw;
}

{
  let reference = null;
  for (const locale of supported) {
    const raw = readExport(locale);
    if (raw === null) continue;
    const keys = new Set(Object.keys(raw));
    if (keys.size === 0) fail(`export.${locale}.json 是空的。`);
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string") {
        fail(`export.${locale}.json 的 ${key} 不是字串。`);
        continue;
      }
      if (value.trim() === "") fail(`export.${locale}.json 的 ${key} 是空字串——沒有人填這個標籤。`);
      const emoji = value.match(EMOJI);
      if (emoji) fail(`export.${locale}.json 的 ${key} 值裡有 emoji（${emoji[0]}）。`);
    }
    if (reference === null) {
      reference = { locale, keys, raw };
      continue;
    }
    for (const k of reference.keys) {
      if (!keys.has(k)) fail(`export.${locale}.json 缺少 key：${k}（${reference.locale} 有）`);
    }
    for (const k of keys) {
      if (!reference.keys.has(k)) fail(`export.${locale}.json 多了 key：${k}（${reference.locale} 沒有）`);
    }
    for (const k of keys) {
      if (!reference.keys.has(k)) continue;
      const sig = placeholderSig(raw[k]);
      const ref = placeholderSig(reference.raw[k]);
      if (sig !== ref) {
        fail(
          `export.${locale}.json 的 ${k} 佔位名與 ${reference.locale} 不一致：[${sig}] vs [${ref}]` +
            `——未代換的 {{...}} 會直接印在匯出檔裡。`,
        );
      }
    }
  }
}

// 檢查 11：ExportKeys 的常數集 ↔ 來源語系資源檔的 key 集。
//
// 這是**契約比對**（兩個檔案的一對一），與檢查 10 的「語系之間」是兩件事。
// 少一個常數的症狀是匯出檔印出識別碼（`TeamSheet` 那格是空白的）；多一個常數的症狀
// 是那一行永遠不會被用到。兩個方向都不會有紅燈——除非這道檢查存在。
if (!existsSync(exportKeysSrc)) {
  fail("src/Entask.Core/ExportKeys.cs 不存在——請確認匯出標籤的常數仍在該檔。");
} else {
  const src = readFileSync(exportKeysSrc, "utf8");
  const constants = [...src.matchAll(/public\s+const\s+string\s+\w+\s*=\s*"([^"]+)"\s*;/g)].map((m) => m[1]);
  if (constants.length === 0) {
    fail("src/Entask.Core/ExportKeys.cs 解析不到任何 public const string——請確認該檔仍是這個形狀（本檢查不猜）。");
  } else {
    const declared = new Set(constants);
    const zh = readExport(supported[0] ?? "zh-TW");
    if (zh !== null) {
      const keys = new Set(Object.keys(zh));
      for (const k of declared) if (!keys.has(k)) fail(`ExportKeys 有 "${k}"，但 export.${supported[0]}.json 沒有這個 key。`);
      for (const k of keys) if (!declared.has(k)) fail(`export.${supported[0]}.json 有 "${k}"，但 ExportKeys.cs 沒有這個常數——那一行永遠不會被用到。`);
    }
  }
}

// 檢查 12：匯出資源檔的三個集合連起來。
//
// 檢查 10 守「各語系資源檔的內容」、檢查 11 守「ExportKeys ↔ 來源語系」，但
// **磁碟上的 export.<locale>.json ↔ SUPPORTED_LOCALES ↔ csproj 的內嵌宣告**這三者之間
// 沒有任何一條連線——而每一種斷法都是使用者看得到的靜默降級：
//
//   - SUPPORTED_LOCALES 有、磁碟上沒有 ⇒ 該語系的 `?locale=` 匯出退回 zh-TW
//     （檢查 10 的 readExport 也會紅——這裡是集合層的同一個事實，訊息給出兩個修法）。
//   - 磁碟上有、SUPPORTED_LOCALES 沒有 ⇒ 檢查 10 的值迴圈走的是 supported，**掃不到它**；
//     而它仍會被 csproj 的 glob 內嵌、由 `ExportLabels.Available` 服務——一份沒有人
//     守著值的匯出檔。
//   - csproj 的 glob 被收窄成逐檔列舉 ⇒ 沒被列到的語系拿不到資源檔，
//     `ExportLabels.Resolve` 回 `Default`（zh-TW）、**不是 400**：使用者看到中文匯出，
//     而建置與全部測試照綠。
//
// 語系清單用的是上面的 readSupportedLocales()（`supported`），不另寫一份解析。
{
  const diskLocales = new Set(
    existsSync(exportDir)
      ? readdirSync(exportDir)
          .map((f) => f.match(/^export\.([^.]+)\.json$/)?.[1])
          .filter((l) => l !== undefined)
      : [],
  );
  for (const locale of supported) {
    if (!diskLocales.has(locale)) {
      fail(
        `SUPPORTED_LOCALES 有 "${locale}"，但 src/Entask.Api/Resources/export.${locale}.json 不存在` +
          `——${locale} 的匯出會退回 zh-TW。補上這個檔案，或從 SUPPORTED_LOCALES 移除該語系。`,
      );
    }
  }
  for (const locale of diskLocales) {
    if (!supported.includes(locale)) {
      fail(
        `src/Entask.Api/Resources/export.${locale}.json 存在，但 "${locale}" 不在 SUPPORTED_LOCALES 中` +
          `——它會被 csproj 的 glob 內嵌、由 ExportLabels.Available 服務，卻沒有任何檢查守著它的值。` +
          `把它加進 SUPPORTED_LOCALES，或刪掉這個檔案。`,
      );
    }
  }

  // csproj 那一條必須仍是 glob（逐檔列舉的後果見上）。
  const csproj = join(repoRoot, "src", "Entask.Api", "Entask.Api.csproj");
  if (!existsSync(csproj)) {
    fail("src/Entask.Api/Entask.Api.csproj 不存在——無法確認匯出資源檔仍以 glob 內嵌。");
  } else if (!/<EmbeddedResource[^>]*Include="Resources\\export\.\*\.json"/.test(readFileSync(csproj, "utf8"))) {
    fail(
      `Entask.Api.csproj 找不到 <EmbeddedResource Include="Resources\\export.*.json" ...> 這條 glob` +
        `——收窄成逐檔列舉會讓沒被列到的語系**靜默退回 zh-TW**` +
        `（ExportLabels.Resolve 對認不得的語系回 Default，不是 400）。`,
    );
  }
}

if (errors.length > 0) {
  console.error("語系檔案檢查失敗：\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\n共 ${errors.length} 項。`);
  process.exit(1);
}

console.log(
  `語系檔案檢查通過：${supported.join(", ")}；${namespaces.size} 個 namespace、` +
    `${valueCount} 條譯文，key 集合相等且無空值。`,
);
