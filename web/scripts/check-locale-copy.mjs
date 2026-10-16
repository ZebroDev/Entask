// 新語系的「有沒有翻」稽核（P1 骨架批次，2026-09-16）。
//
// 偽語系掃頁（pseudo_sweep.cjs）證的是「字串抽乾淨了沒」——那是**語系無關**的性質
// （程式碼呼叫 t() 與當下是哪個語系無關）。新語系要證的是另一件事：**值有沒有真的翻**。
// ja 有漢字、zh-CN 與 zh-TW 同為中文，偽語系那一套對它們完全無效。
//
// 兩段輸出，性質不同：
//   A. 結構——key 集合、複數類別、佔位名、空值、emoji。**有錯即 exit 1。**
//   B. 值與 zh-TW 逐字相同——**報告，不是錯誤**（exit 0）。合法同值很多（專有名詞、
//      兩語同形），做成硬閘門會逼出大量假陽性，而假陽性會讓人追錯方向。
//      例外由 locale-copy-whitelist.json 登記，**條目陳舊即 exit 1**。
//
// 用法：node scripts/check-locale-copy.mjs [locale ...]
//   不給參數 → 掃 SUPPORTED_LOCALES（接線後的常態；缺檔是錯誤）
//   給了參數 → 只掃那幾個語系（**接線前**的用法；缺檔印成進度行，不是錯誤）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src", "i18n", "locales");
const localesTs = join(root, "src", "i18n", "locales.ts");
const whitelistPath = join(root, "scripts", "locale-copy-whitelist.json");

const SOURCE = "zh-TW";
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join("|")})$`);
const BS = String.fromCharCode(92);
const EMOJI = new RegExp(BS + "p{Extended_Pictographic}", "u");
const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

const errors = [];
const fail = (msg) => errors.push(msg);

function readSupportedLocales() {
  const m = readFileSync(localesTs, "utf8").match(
    /export const SUPPORTED_LOCALES[^=]*=\s*\[([^\]]*)\]/,
  );
  if (!m) {
    fail("無法從 src/i18n/locales.ts 解析 SUPPORTED_LOCALES——請確認該宣告仍是一行陣列字面值。");
    return [];
  }
  // 單引號與雙引號都收：只認雙引號時，一條單引號的條目會被**靜默丟掉**，
  // 而 `wired` 是同一份解析的產物——被丟掉的語系不但不被檢查，還會被當成
  // 「尚未接線」印成進度行（本工具用在別處的變體時尤其危險）。
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

function flatten(value, prefix = "", out = []) {
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out.push(path);
  }
  return out;
}
const at = (tree, dotted) => dotted.split(".").reduce((node, part) => node?.[part], tree);
const baseKey = (path) => path.replace(PLURAL_SUFFIX, "");
const placeholders = (value) => new Set([...value.matchAll(PLACEHOLDER)].map((m) => m[1]));

const supported = readSupportedLocales();
const explicit = process.argv.slice(2);
// **來源語系自己不入列**：與自己比對的話每一個值都「與 zh-TW 逐字相同」，B 段會列出全部條目。
// 這裡刻意不寫條數——條數會隨每個階段增減（2026-09-18 移除當時的 931：zh-CN 接線時是 931，
// 該日已 947），要精確值就自己數語系檔，不要拿這裡的數字當來源。
// 這不是理論問題——不給參數時的預設清單（`SUPPORTED_LOCALES`）本來就包含 zh-TW。
const targets = (explicit.length > 0 ? explicit : supported).filter((locale) => locale !== SOURCE);
const wired = new Set(supported);

if (targets.length === 0) {
  console.error("沒有可檢查的語系。");
  process.exit(1);
}

const namespaces = existsSync(join(localesDir, SOURCE))
  ? readdirSync(join(localesDir, SOURCE))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort()
  : [];
if (namespaces.length === 0) {
  console.error(`讀不到來源語系 ${SOURCE} 的 namespace 清單。`);
  process.exit(1);
}

const read = (locale, ns) => JSON.parse(readFileSync(join(localesDir, locale, `${ns}.json`), "utf8"));

const whitelist = existsSync(whitelistPath) ? JSON.parse(readFileSync(whitelistPath, "utf8")) : {};
const usedEntries = new Set();

for (const locale of targets) {
  const structural = [];
  const identical = [];
  const missingFiles = [];
  let scanned = 0;

  let required = null;
  try {
    required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    fail(`"${locale}" 不是 Intl.PluralRules 認得的語系標籤——無法檢查複數類別。`);
    continue;
  }

  for (const ns of namespaces) {
    const file = join(localesDir, locale, `${ns}.json`);
    if (!existsSync(file)) {
      missingFiles.push(ns);
      continue;
    }
    scanned++;
    const src = read(SOURCE, ns);
    const dst = read(locale, ns);
    const srcPaths = flatten(src);
    const dstPaths = flatten(dst);

    // key 集合（剝除複數尾綴後）必須相等
    const srcBases = new Set(srcPaths.map(baseKey));
    const dstBases = new Set(dstPaths.map(baseKey));
    for (const k of srcBases) if (!dstBases.has(k)) structural.push(`[${ns}] ${locale} 缺少 key：${k}`);
    for (const k of dstBases) if (!srcBases.has(k)) structural.push(`[${ns}] ${locale} 多了 key：${k}`);

    // 佔位名逐基底鍵比對**集合**（不比順序——語序本來就可能不同）
    for (const base of srcBases) {
      if (!dstBases.has(base)) continue;
      const srcKeys = srcPaths.filter((p) => baseKey(p) === base);
      const dstKeys = dstPaths.filter((p) => baseKey(p) === base);
      const srcNames = new Set(srcKeys.flatMap((p) => [...placeholders(String(at(src, p)))]));
      for (const p of dstKeys) {
        const value = String(at(dst, p));
        if (value.trim() === "") structural.push(`[${ns}] ${locale} 的 ${p} 是空字串`);
        const emoji = value.match(EMOJI);
        if (emoji) {
          // 不回印 emoji 本身：standing rule 的「檔案內不使用 emoji」在這支工具的輸出上也適用，
          // 而碼位對診斷同樣明確（要 grep 哪個字元一目瞭然），也不會讓終端把訊息渲染成圖。
          const cps = [...emoji[0]]
            .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`)
            .join(" ");
          structural.push(`[${ns}] ${locale} 的 ${p} 值裡有 emoji（${cps}）`);
        }
        for (const name of placeholders(value)) {
          if (!srcNames.has(name)) {
            structural.push(`[${ns}] ${locale} 的 ${p} 有來源沒有的佔位名：{{${name}}}`);
          }
        }
        for (const name of srcNames) {
          if (!placeholders(value).has(name)) {
            structural.push(`[${ns}] ${locale} 的 ${p} 少了來源的佔位名：{{${name}}}`);
          }
        }
      }
    }

    // 複數類別齊全
    //
    // **先以來源的複數基底鍵播種**：目標語系若把某一族整個寫成裸鍵（少了尾綴），
    // `dstPaths` 上根本看不到這一族，於是「缺 _other」永遠不會被列出來——而上面那段
    // key 集合是**剝除尾綴後**比的，所以它也不會紅。
    //
    // **後果到哪裡為止（2026-09-16 以探針實測 i18next 26，矩陣在 ledger）**：裸鍵
    // **不會**讓使用者看到來源語言——`Translator.resolve` 的候選是 `[key, key+尾綴]`
    // 且後進先出，同一個語言內找不到 `_other` 時還會試裸鍵本身（實測：`ko` 只有裸鍵時
    // count=1／2 都拿到該語系自己的值）。真正失去的是**複數類別的變化**：單一類別的
    // `zh-CN`／`ja`／`ko` 看不出差別，**`es-419` 的 `_one`／`_many` 看得出來**——而那是
    // 本階段風險最高的一階。另一條路徑：值裡帶 `{{count}}` 的裸鍵在接線後會被 parity 的
    // 檢查 8 擋下，但**不含 `{{count}}` 的單位型複數族只會被這支工具看到**。
    // 本工具是這個形狀唯一的閘門：`check-locale-parity.mjs` 的檢查 5 **沒有**來源側播種，
    // 目標側的裸鍵族只有本工具看得到（R29）。
    const families = new Map();
    for (const p of srcPaths) {
      if (!PLURAL_SUFFIX.test(p)) continue;
      const base = baseKey(p);
      // 整個鍵都不存在時**不播種**——那已由上面的「缺少 key」負責，播了會一個缺陷兩則訊息
      if (!dstBases.has(base)) continue;
      if (!families.has(base)) families.set(base, new Set());
    }
    for (const p of dstPaths) {
      if (!PLURAL_SUFFIX.test(p)) continue;
      const base = baseKey(p);
      if (!families.has(base)) families.set(base, new Set());
      families.get(base).add(p.slice(base.length + 1));
    }
    for (const [base, have] of families) {
      const miss = required.filter((c) => !have.has(c));
      if (miss.length > 0) {
        structural.push(`[${ns}] ${locale} 的複數鍵 ${base} 缺 ${miss.map((c) => `_${c}`).join("、")}`);
      }
    }

    // B 段：值與 zh-TW 逐字相同（**逐目標路徑**比對；純佔位骨架排除）
    //
    // 逐目標路徑，不是逐來源鍵：來源語系（zh-TW）只有 `_other`，所以目標語系多出來的
    // 類別（`es-419` 的 `_one`／`_many`）在來源**沒有同尾綴的對應**。逐來源鍵的寫法
    // 在找不到對應時 skip，於是那些類別整條留成中文也不會被列出來——而 es-419 正是
    // 唯一有額外類別、spec 判為最危險的一階，這支腳本又是那一階指定的進度訊號。
    // 查不到同尾綴時**退回同族的 `_other`**（＝「這個值是從來源的哪一句複製來的」）。
    //
    // 純佔位骨架（`{{hours}} · {{entries}} · {{cards}} · {{workdays}}`）不算「沒翻」
    // ——六個語系同形，做成報告只會逼出假陽性。**但骨架的判準含「值裡至少有一個佔位名」**：
    // 只看「去掉結構字元後為空」的話，`common:separator.list` 的 `、`（純標點）也會被
    // 當成骨架排除掉，而 GLOSSARY 明講「語系相關的全形標點是例外，屬譯文」
    // ——`es-419` 該寫 `", "`，排除它就等於讓一條真的沒翻的值消失。
    const skeleton = (v) =>
      /\{\{[^}]+\}\}/.test(v) &&
      v.replace(PLACEHOLDER, "").replace(/[\s·、,.:/|()（）「」“”"']/g, "") === "";
    for (const dp of dstPaths) {
      const base = baseKey(dp);
      // 查表的鏈：同尾綴 → 同族的 `_other` → **裸基底鍵**。最後那一階涵蓋「來源那一族
      // 只以裸鍵存在」（來源是同名的非複數鍵、目標卻寫成複數族）——少了它，那種路徑
      // 永遠不會被比對。不會有假陽性：它只可能列出「與來源逐位元組相同」的目標值。
      const sp = srcPaths.includes(dp)
        ? dp
        : srcPaths.includes(`${base}_other`)
          ? `${base}_other`
          : srcPaths.includes(base)
            ? base
            : null;
      if (sp === null) continue; // 來源沒有對應（多出來的 key 已由結構段列出）
      const sv = String(at(src, sp));
      if (skeleton(sv)) continue;
      if (String(at(dst, dp)) !== sv) continue;
      const entry = `${ns}:${base}`;
      if ((whitelist[locale] ?? []).includes(entry)) {
        usedEntries.add(`${locale}|${entry}`);
        continue;
      }
      // 帶尾綴的路徑**自己說出白名單鍵**：報告行就是實作者拿去填白名單的字串，而白名單的鍵
      // 是基名（`board:presence.online_one` → `board:presence.online`）。落差要在錯誤發生的
      // 那一刻看得到，不能只寫在 `_comment` 裡——4 個語系 × 10 個 namespace × 反覆重跑，
      // 這個落差就是人為錯誤的住處。
      // **不改成只印基名**：es-419 的 `_one` 與 `_many` 可能各自命中，兩行必須分得開
      // （只印基名會讓兩行長得一樣、看起來像重複）。
      identical.push(dp === base ? `${ns}:${dp}` : `${ns}:${dp}（白名單鍵：${ns}:${base}）`);
    }
  }

  // **掃到 0 個檔是錯誤，不是「0 條」**：語系目錄不存在（或一個 .json 都沒有）時，
  // 上面每一段都會印出「0 條」而看起來像通過——而沒有正對照的「0」不是證據，
  // 這正是這個專案反覆強調的那條教訓。缺**部分**檔仍是進度行（接線前的常態），
  // 但一個檔都沒有時，這支工具沒有任何東西可以證明。
  if (scanned === 0) {
    fail(
      `[${locale}] 掃到 0 個 namespace 檔（src/i18n/locales/${locale}/ 不存在或沒有 .json）` +
        `——沒有正對照的「0」不是證據，故視為錯誤。`,
    );
    continue;
  }

  const wiredNow = wired.has(locale);
  const ready = namespaces.length - missingFiles.length;
  if (missingFiles.length > 0) {
    if (wiredNow) {
      fail(`[${locale}] 已在 SUPPORTED_LOCALES 中，但缺少 ${missingFiles.length} 個 namespace 檔：${missingFiles.join("、")}`);
    } else {
      console.log(`[${locale}] 進度：${ready}/${namespaces.length} 個 namespace 已就緒（尚未接線：${missingFiles.join("、")}）`);
    }
  } else if (!wiredNow) {
    // 十個檔都在、但還沒進 SUPPORTED_LOCALES。**這一格必須印出來**：
    // 少了它，「做完了」與「工具沒跑到」在輸出上長得一模一樣（一片沉默），
    // 而 L1–L4 每個譯文階段的收尾（Tasks 9／14／19／24）看的正是這一句。
    console.log(`[${locale}] 進度：${ready}/${namespaces.length} 個 namespace 已就緒（尚未接線）`);
  }

  console.log(`\n=== ${locale}：結構 ===`);
  if (structural.length === 0) console.log("0 條。");
  else for (const s of structural) console.log(`  ${s}`);
  for (const s of structural) fail(`[${locale}] ${s}`);

  console.log(`\n=== ${locale}：值與 ${SOURCE} 逐字相同（報告，不是錯誤）===`);
  if (identical.length === 0) console.log("0 條。");
  else {
    console.log(`  ${identical.length} 條。每一條都要能說出理由，否則補進 scripts/locale-copy-whitelist.json（複數族登記基名：xxx.count_other 寫成 xxx.count）：`);
    for (const s of identical) console.log(`    ${s}`);
  }
}

// 白名單陳舊即紅——否則它會無聲腐爛成「全部略過」
//
// **只檢查這一輪真的掃過的語系**（`targets`）：接線前是用明示參數跑的
// （`node scripts/check-locale-copy.mjs ja`），那時 `usedEntries` 只會有 `ja` 的條目——
// 少了這一行，前三個語系已登記的白名單全部會被判成「陳舊」，exit 1 的訊息還指向
// 一個根本沒被掃描的語系。（L2–L4 的譯文任務全部走明示參數，所以這一條一定會踩到。）
for (const [locale, entries] of Object.entries(whitelist)) {
  if (locale.startsWith("_")) continue;
  if (!targets.includes(locale)) continue;
  for (const entry of entries) {
    if (!usedEntries.has(`${locale}|${entry}`)) {
      fail(
        `白名單陳舊：${locale} 的 "${entry}" 不再與 ${SOURCE} 相同（或該鍵已不存在）——請從 scripts/locale-copy-whitelist.json 移除。`,
      );
    }
  }
}

console.log("");
if (errors.length > 0) {
  console.error(`結構錯誤 ${errors.length} 條：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("結構 0 條。");
