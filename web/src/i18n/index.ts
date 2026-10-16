import { createInstance, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { LOCALE_STORAGE_KEY } from "@/lib/storage-keys";
import { detectCandidates, resolveLocale } from "./detect";
import { DEFAULT_LOCALE, PSEUDO_ENABLED, PSEUDO_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { pseudoLocalizeResources } from "./pseudo";
import { resources as staticResources } from "./resources";

// 資源直接內嵌，不用 backend——首次 render 前就緒，沒有語系 FOUC。
// 偽語系由來源語系在記憶體變換而來，所以永遠與 zh-TW 同步，不會有生成檔漂移的問題。
// （來源語系是字面指定的 zh-TW，**不跟 DEFAULT_LOCALE 走**——2026-10-07 預設改 en 後，
// 變換來源仍然是 zh-TW。）
// 變換吃的是整份 bundle（pseudoLocalizeResources 會遞迴走 namespace），
// 所以新增 namespace 時這裡不必跟著改。
const pseudoResources: Resource = PSEUDO_ENABLED
  ? { [PSEUDO_LOCALE]: pseudoLocalizeResources(staticResources["zh-TW"]) }
  : {};
const resources: Resource = { ...staticResources, ...pseudoResources };

// 偽語系只在 dev 進 supportedLngs，且永遠不進偵測用的 SUPPORTED_LOCALES。
const supportedLngs = PSEUDO_ENABLED
  ? [...SUPPORTED_LOCALES, PSEUDO_LOCALE]
  : [...SUPPORTED_LOCALES];

const i18n = createInstance();

// 啟動路徑上不能有未捕捉的例外——壞掉的 localStorage 值或環境異常都不該讓整個 app
// 白畫面（P16 的教訓：一個未預期的酬載就讓全樹 crash）。失敗一律退回 DEFAULT_LOCALE 硬上。
function initialLocale(): string {
  try {
    return resolveLocale(detectCandidates());
  } catch {
    return DEFAULT_LOCALE;
  }
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  // 必須與 i18next-parser.config.js 的 defaultNamespace 一致。不一致時 i18next 會去找
  // 它自己的預設 namespace（translation），每個 t() 都靜默地回傳 key 本身——
  // 不拋錯、不警告，畫面直接顯示 "nav.logout"。i18next.d.ts 的 defaultNS 只影響型別，
  // 不影響 runtime。
  defaultNS: "common",
  supportedLngs,
  // 匹配由我們自己做（R6）。不讓 i18next 自行推導 zh-Hant → zh 這類父語系，
  // 否則 supportedLngs 的檢查會被繞過。
  load: "currentOnly",
  // 資源已在記憶體，同步完成＝首次 render 前就緒，沒有語系 FOUC。
  // （i18next 26 起這個選項叫 initAsync；舊名 initImmediate 在 v26 已移除。）
  initAsync: false,
  // React 已自帶逸出，再逸出一次會把中文標點變成實體
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/**
 * `document.documentElement.lang` 必須隨語系改變：螢幕閱讀器、`Intl` 的預設值、
 * 瀏覽器的翻譯提示都依賴它。index.html 的靜態值是首次載入前的預設。
 */
function syncHtmlLang(): void {
  document.documentElement.lang = i18n.resolvedLanguage ?? DEFAULT_LOCALE;
}

i18n.on("languageChanged", syncHtmlLang);
syncHtmlLang();

/**
 * 切換語系。`null` 表示「跟隨瀏覽器」。
 *
 * **「跟隨瀏覽器」與「明確指定」是兩個狀態**，以「localStorage 有沒有這個鍵」編碼：
 * 改回跟隨瀏覽器時必須**刪除鍵**，不可存 `"null"` 字串。任何「寫入一個代表空的值」
 * 的實作都會讓狀態機多出一個錯誤狀態——與 AGENTS.md 的「auth.ts 的 setTeamId 不得
 * 正規化」屬同一類陷阱。
 */
export async function setLocale(locale: string | null): Promise<void> {
  try {
    if (locale === null) localStorage.removeItem(LOCALE_STORAGE_KEY);
    else localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // localStorage 不可用（隱私模式等）時，本次 session 仍應切換語系
  }
  await i18n.changeLanguage(locale ?? resolveLocale(detectCandidates()));
}

export default i18n;
