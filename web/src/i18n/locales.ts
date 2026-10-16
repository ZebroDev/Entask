// 語系清單的單一定義點。
//
// SUPPORTED_LOCALES 與 PSEUDO_LOCALE 刻意分開，且前者永遠不得包含後者：
// 偽語系的語言碼是 en-XA，語言主標籤與英文相同。一旦它進了匹配用的支援清單，
// 每一個英文瀏覽器（navigator.languages 為 en-US 等）都會命中它——整個 app 變成
// 偽語系。它只能是「明確指定」才到得了的狀態。見 detect.ts 的 resolveLocale，
// 以及 detect.test.ts 裡釘住這個理由的測試。
//
// P-B2 起是 ["zh-TW", "en"]；2026-09-16 加入 zh-CN（第三語系，由 zh-TW 逐條轉換＋審閱
// 產生，譯文尚未經母語者審閱，性質見 locales/zh-CN/README.md）；2026-09-20 加入 es-419
// （第四語系，拉美中性西語；**唯一有 one／many／other 三個複數類別**的語系）與 ja
// （第五語系，只有 other 一個複數類別，與 zh-TW 同形）；同日接上 ko（第六語系，
// 同樣只有 other 一個類別；**「工時」一律 공수、「審查」一律 리뷰**，見 locales/ko/README.md）。
// 六個語系至此全數到齊（譯文皆尚未經母語者審閱）。
// 新增語系時要同時在 resources.ts 補上它的 namespace 匯入，
// scripts/check-locale-parity.mjs 會檢查這件事。

// 產品的預設語系（2026-10-07 公開版改為英文優先，由 zh-TW 改來）：所有候選都匹配不到
// 時的落點，也是 fallbackLng。**它與「來源語系」是兩個獨立的決定**——key 的權威與偽語系
// 的變換來源仍是 zh-TW（見 resources.ts 的 zhTW）；測試環境則由 src/test/locale-pin.ts
// 釘成 zh-TW，與它無關。它的值由 i18n.test.ts 的一支斷言釘住（其他斷言都跟著常數走）。
export const DEFAULT_LOCALE = "en";

/**
 * 真正出貨的語系。zh-TW 是來源語系，en 是第二語系、zh-CN 是第三語系、
 * es-419 是第四語系、ja 是第五語系、ko 是第六語系（譯文皆尚未經母語審閱）。
 */
export const SUPPORTED_LOCALES: readonly string[] = ["zh-TW", "en", "zh-CN", "es-419", "ja", "ko"];

/** 偽語系：只有 dev 存在，且只能靠「明確指定」到達。 */
export const PSEUDO_LOCALE = "en-XA";

/** 本次建置是否註冊偽語系。編譯期常數，release bundle 內為 false。 */
export const PSEUDO_ENABLED: boolean = import.meta.env.DEV;

/**
 * 語系選單用的**自稱名**（endonym）：`zh-TW` 在任何語系下都顯示「繁體中文」、
 * `en` 都顯示 `English`。
 *
 * **刻意不放語系檔**——自稱名不隨語系改變，放進去等於讓它被翻譯；而英文使用者正是
 * 靠「English」這串字在中文介面裡找到自己的語言，把它翻成「英文」就毁了這個用途。
 * （`Intl.DisplayNames` 給的是**他稱名**：在 zh-TW 下 `en` → 「英文」，正好是這裡
 * 要避免的那一種，所以不用它。）
 *
 * 偽語系不在這裡——它不是語系，是 dev 的除錯工具，標籤見 `PSEUDO_LOCALE_LABEL`。
 */
export const LOCALE_ENDONYMS: Readonly<Record<string, string>> = {
  "zh-TW": "繁體中文",
  en: "English",
  "zh-CN": "简体中文",
  // 拉美中性西語（不含西班牙）。**寫「(Latinoamérica)」不是「(Latinoamérica y el Caribe)」**
  // 或國名清單：自稱名要短到放得進選單，而 `es-419` 這個 UN M.49 代碼本身的意思就是
  // 「拉丁美洲與加勒比海」。西班牙的 `es-ES` 不在出貨清單內。
  "es-419": "Español (Latinoamérica)",
  ja: "日本語",
  ko: "한국어",
};

/**
 * 偽語系在選單裡的標籤（dev 專用）。**用三元式而不是寫在 `LOCALE_ENDONYMS` 裡**：
 * 常數折疊折掉的是分支，寫在物件字面值裡的話 `en-XA` 仍會進 release bundle。
 * 與 `detect.ts` 的 `PSEUDO_ACTIVE` 同一個手法——「release 不含偽語系」是結構上的
 * 事實，不是靠推論（驗收含 bundle 實測，見設計 §12）。
 */
export const PSEUDO_LOCALE_LABEL: string | null = PSEUDO_ENABLED ? "Pseudo (en-XA)" : null;

/**
 * 偽語系的**值**，release 為 `null`。要判斷「這個已存的值還選得出來嗎」時，
 * 比較的對象必須是**這個常數**，不能是 `PSEUDO_LOCALE`：
 * `stored === PSEUDO_LOCALE` 是一個**活的**參考，常數折疊折不掉，`en-XA` 會進
 * release bundle——B2-7 review 的 L5 修正就是這樣踩到的，由 bundle 掃描擋下。
 * 與 `PSEUDO_LOCALE_LABEL`／`detect.ts` 的 `PSEUDO_ACTIVE` 同一個手法。
 */
export const SELECTABLE_PSEUDO_LOCALE: string | null = PSEUDO_ENABLED ? PSEUDO_LOCALE : null;
