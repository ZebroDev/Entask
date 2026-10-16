// 測試環境的語系釘。必須在 vitest.config.ts 的 setupFiles 中排在 setup.ts **之前**。
//
// 為什麼需要它：jsdom 的 navigator.language 是 "en-US"、navigator.languages 是
// ["en-US", "en"]。P-B1 時 SUPPORTED_LOCALES 只有 zh-TW，候選匹配不到任何語系，
// 退回 DEFAULT_LOCALE，測試自然拿到中文——**那是巧合，不是設計**。
//
// P-B2 把 en 加進 SUPPORTED_LOCALES 之後巧合消失：模組載入時 resolveLocale 就會
// 解析成 en，386 支測試全部以英文啟動。而「2,344 行中文斷言不必改」正是 R3 與整個
// 遷移策略的基礎——這個階段把字串抽進語系檔的可行性，全靠它。
//
// 2026-10-07：DEFAULT_LOCALE 由 zh-TW 改為 en（公開版英文優先）。這個釘子因此更吃重
// ——不只「en 在支援清單裡」，連「全都匹配不到」的落點（DEFAULT_LOCALE）本身也變成
// 英文。產品預設語系與測試語系自此是兩個獨立的決定；測試這一邊由本檔（PINNED_LOCALE）
// 釘住，產品那一邊由 i18n.test.ts 的「產品預設語系是 en」那一支釘住。
//
// src/test/setup.ts 的 beforeEach 恰好會救回來，但那不是它存在的理由（它是為了
// 「測試之間不得殘留語系」而寫的）。少了這個釘子，刪掉那段 beforeEach 的人不會知道
// 自己在刪什麼，他只會看到 386 支紅燈，而紅的原因不會出現在任何訊息裡。
//
// 因此理由由一支測試釘住：src/test/locale-pin.test.ts。
//
// 順序為何不能靠「寫在同一個檔案裡」解決：每個 setup 檔是獨立的 ES module，順序由
// setupFiles 陣列決定；寫在一起的話，import i18n 會被 ES module 的匯入提升（hoisting）
// 搶在 stub 執行之前跑完，i18n 已經解析成 en 了。
//
// 用 defineProperty 而非賦值：jsdom 把 languages / language 定義在 Navigator.prototype
// 上，賦值會被 setter 吃掉。自有屬性可以遮蔽它，configurable 則讓既有的
// detect.test.ts 能沿用它的 delete 還原寫法。
import { beforeEach } from "vitest";

/** 測試環境釘住的語系。setup.ts 的重置與斷言都指回這裡，不要在他處另寫一份。 */
export const PINNED_LOCALE = "zh-TW";

const PINNED_LANGUAGES = [PINNED_LOCALE];

function pin(): void {
  Object.defineProperty(navigator, "languages", { value: [...PINNED_LANGUAGES], configurable: true });
  Object.defineProperty(navigator, "language", { value: PINNED_LANGUAGES[0], configurable: true });
}

pin();

// 每個測試前重新釘一次。這不是儀式：測試若刪除或改寫 navigator.languages（既有的
// detect.test.ts 就是這樣還原它自己的 stub），該檔案後續的測試就會退回 jsdom 的預設值。
// 那個預設值在 en 成為支援語系之後會被解析成英文——於是「某支測試刪了 navigator 屬性」
// 會表現成「同一檔案後面幾支無關的測試變紅」，而錯誤訊息完全指不到原因。
beforeEach(pin);
