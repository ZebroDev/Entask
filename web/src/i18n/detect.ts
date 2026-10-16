import { match } from "@formatjs/intl-localematcher";
import { LOCALE_STORAGE_KEY } from "@/lib/storage-keys";
import { DEFAULT_LOCALE, PSEUDO_ENABLED, PSEUDO_LOCALE, SUPPORTED_LOCALES } from "./locales";

// 為何不用 i18next-browser-languagedetector（它已經 R11 核可，仍在 package.json 之外）：
//
// 它只有在「註冊成 i18next 的 languageDetector」時才會回傳完整的語言陣列——detect() 的
// 尾端判斷 services.languageUtils.getBestMatchFromCodes 是否存在，否則只回 detected[0]。
// 而註冊那條路正是我們必須避開的：i18next 會在 languageChanged 時呼叫
// cacheUserLanguage()，把偵測結果寫回 localStorage，等於每次造訪都升級成「明確指定」，
// R6 的兩狀態契約當場失效。
//
// 於是它只剩「讀一個 localStorage 鍵」與「讀 navigator.languages」兩件事——十行不到。
// 為了拿到完整陣列而傳入假的 services 物件去騙那個內部判斷，比自己做更脆弱。
//
// 這裡刻意不做快取：語系是低頻讀取，且快取會讓測試之間互相污染。

/**
 * 讀取「明確指定」。localStorage 不可用（隱私模式等）時視為未指定。
 *
 * 除了候選清單，語系選單本身也要用它：`i18n.resolvedLanguage` 只知道「現在是什麼」，
 * 不知道「這個值是選的還是匹配來的」——而選單必須畫出這兩者的差別（R6 的兩狀態）。
 * 它**不是**「目前語系」的通用查詢入口，那種問題問 `i18n.resolvedLanguage`。
 */
export function explicitLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * R6 的候選清單：明確指定優先，否則用瀏覽器偏好。
 *
 * navigator.languages 是**已依偏好排序的陣列**，必須整份帶進匹配——只取第一個會在
 * 「首選不支援、次選支援」時給出錯誤結果（例如 ["fr-FR", "ja-JP"] 應該落到 ja）。
 *
 * 明確指定的值若無法解析（被手動改成亂碼），不會退回瀏覽器偏好，而是一律落到預設
 * 語系——`resolveLocale` 的唯一出口。這是刻意的：明確指定是一個承諾，不該靜默地
 * 被瀏覽器偏好取代。
 */
export function detectCandidates(): string[] {
  const explicit = explicitLocale();
  if (explicit) return [explicit];

  const languages = navigator.languages;
  if (languages && languages.length > 0) return [...languages];
  return navigator.language ? [navigator.language] : [];
}

/** 逐項正規化；壞掉的標籤單獨丟棄，不讓它毒掉整份候選清單。 */
function canonicalize(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 把瀏覽器標籤對到支援語系。`@formatjs/intl-localematcher` 對畸形標籤會 throw，
 * 故一律包 try/catch 並退回預設語系。
 *
 * supported 的預設值不含偽語系——這是不變量，見 locales.ts。
 */
export function matchLocale(
  candidates: readonly string[],
  supported: readonly string[] = SUPPORTED_LOCALES,
): string {
  if (supported.length === 0) return DEFAULT_LOCALE;
  const valid = candidates.map(canonicalize).filter((tag): tag is string => tag !== null);
  if (valid.length === 0) return DEFAULT_LOCALE;
  try {
    return match(valid, [...supported], DEFAULT_LOCALE);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * 偽語系必須在匹配「之前」攔下：它不能進 supported（否則英文瀏覽器會命中它），
 * 但使用者明確指定時要放行。candidates[0] 即明確指定（見 detectCandidates）。
 *
 * 用「可能為 null 的常數」而非 `pseudoEnabled && candidates[0] === PSEUDO_LOCALE`：
 * 後者雖然在 release 也短路，但 "en-XA" 這個字面值會被保留下來（常數折疊只摺掉分支，
 * 不摺掉運算元）。改成三元式後整段在 release 變成 null，連字串都不進 bundle——
 * 「release 不含偽語系」因此是結構上的事實，不是靠推論。
 */
const PSEUDO_ACTIVE: string | null = PSEUDO_ENABLED ? PSEUDO_LOCALE : null;

export function resolveLocale(
  candidates: readonly string[],
  supported: readonly string[] = SUPPORTED_LOCALES,
  pseudoLocale: string | null = PSEUDO_ACTIVE,
): string {
  if (pseudoLocale !== null && candidates[0] === pseudoLocale) return pseudoLocale;
  return matchLocale(candidates, supported);
}
