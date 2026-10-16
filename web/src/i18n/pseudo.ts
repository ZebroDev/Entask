// 偽語系（R5）：一個沒有人說的假語系，用來實證「到底漏抽了多少條硬編碼」。
//
// 只在 dev 執行（資源由 index.ts 以 import.meta.env.DEV 守衛決定是否註冊），
// 不進 release bundle、不進語系選單。
//
// 內容由 zh-TW 變換而來，所以長得像 [!! 登出 !!] 而不是英文。這是刻意的：
// 漏抽偵測靠括號，版面膨脹靠 ~，兩者都不需要真的英文。

import { PSEUDO_LOCALE } from "./locales";

/**
 * 全形／寬字元（CJK、諺文、全形標點等）計 2 個視覺寬度單位，其餘計 1。
 *
 * 用「視覺寬度」而非字元數是必要的：繁中一字佔的寬度是 ASCII 的兩倍，
 * 用字元數算會讓中文的膨脹量少一半，測不出真正的溢出。
 */
const WIDE =
  /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

const OPEN = "[!! ";
const CLOSE = " !!]";


/** 英西語相對繁中的膨脹幅度。繁中是最緊湊的設計基準。 */
const EXPANSION = 1.35;

export function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

/**
 * 標記＋膨脹。標記之外的內容（原文＋`~`）補到來源寬度的 1.35 倍；
 * 短字串因標記本身已超過目標而不補。
 *
 * 補的是 `~` 而不是重複原文：`~` 是單一 ASCII 字元，測的是「寬度溢出」
 * （分頁標籤、表頭、月份標頭都是這類），不是斷詞換行。
 */
export function pseudoLocalize(source: string): string {
  const target = Math.ceil(visualWidth(source) * EXPANSION);
  const padding = Math.max(0, target - visualWidth(source));
  return `${OPEN}${source}${"~".repeat(padding)}${CLOSE}`;
}

/** 遞迴走 namespace，只變字串葉節點；數字、布林、null 原樣通過。 */
function pseudoLocalizeValue<T>(value: T): T {
  if (typeof value === "string") return pseudoLocalize(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => pseudoLocalizeValue(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = pseudoLocalizeValue(item);
    return out as T;
  }
  return value;
}

/**
 * 複數類別。偽語系的鍵**繼承自 zh-TW，只有 `_other` 一個類別**，但它的語言標籤是
 * `en-XA`——`Intl.PluralRules("en-XA").select(1)` 是 `one`。
 *
 * i18next 找不到 `key_one` 時**不會退回自己的 `key_other`**，而是往下一個 fallback
 * 語系找（實測當時是 zh-TW；2026-10-07 起 DEFAULT_LOCALE 改 en，同型破壞會改顯示
 * 英文）。於是偽語系在**數量恰好為 1** 時顯示**沒有 `[!! !!]` 包住的未變換譯文**
 * ——那正是「漏抽字串」的長相。2026-09-14 實測：`me:tab.inProgress` 在 count=1 時
 * 得到 `進行中 (1)`，而 count=0／2 得到 `[!! 進行中 (0)~~~~~~~ !!]`。
 * （上述字面值是當時的實測原樣；該值自 2026-09-21 起改用全形括號 `進行中（1）`。）
 *
 * §12 的偽語系掃頁是 B2-7 的頭號驗收，這個假陽性會讓它追錯方向（去追一個已經抽好的
 * 字串）。**補的是類別不是翻譯**——偽語系的內容本來就是假的，各類別同值即可。
 */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join("|")})$`);

function addPluralCategories(value: unknown, locale: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;

  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) out[key] = addPluralCategories(item, locale);

  const families = new Map<string, Set<string>>();
  for (const key of Object.keys(node)) {
    const suffix = key.match(PLURAL_SUFFIX);
    if (!suffix) continue;
    const base = key.slice(0, -suffix[0].length);
    let have = families.get(base);
    if (!have) families.set(base, (have = new Set()));
    have.add(suffix[1]);
  }
  // 這一層沒有複數鍵就提早結束——絕大多數節點都是這樣，不必去問 Intl。
  if (families.size === 0) return out;

  let required: readonly string[];
  try {
    required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return out; // 認不得的語系標籤：維持原狀，不在啟動路徑上拋錯
  }
  for (const [base, have] of families) {
    const source = out[`${base}_other`];
    if (typeof source !== "string") continue;
    for (const category of required) {
      if (!have.has(category)) out[`${base}_${category}`] = source;
    }
  }
  return out;
}

/**
 * 遞迴走 namespace：先變換文案，再補齊偽語系需要的複數類別。
 *
 * `locale` 有預設值是刻意的——這個函式只為偽語系而存在，預設值就是它唯一的合理值，
 * 呼叫端不必（也不該）傳別的。
 */
export function pseudoLocalizeResources<T>(value: T, locale: string = PSEUDO_LOCALE): T {
  return addPluralCategories(pseudoLocalizeValue(value), locale) as T;
}
