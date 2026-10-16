import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, PSEUDO_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { detectCandidates, matchLocale, resolveLocale } from "./detect";
import { LOCALE_STORAGE_KEY } from "@/lib/storage-keys";

// jsdom 把 navigator.languages 定義在 Navigator.prototype 上，所以 stub 是在實例上
// 加一個自有屬性去遮蔽它。還原必須「刪除自有屬性」——只還原 prototype 的話，
// 遮蔽層仍在，會污染同檔後續的測試。
function stubNavigatorLanguages(languages: string[]) {
  Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).languages;
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("matchLocale：把瀏覽器的語系標籤對到我們支援的語系", () => {
  it("繁中變體都落到 zh-TW", () => {
    expect(matchLocale(["zh-HK"])).toBe("zh-TW");
    expect(matchLocale(["zh-Hant"])).toBe("zh-TW");
    expect(matchLocale(["zh-Hant-TW"])).toBe("zh-TW");
  });

  it("簡中變體落到 zh-CN", () => {
    expect(matchLocale(["zh-Hans"])).toBe("zh-CN");
    expect(matchLocale(["zh-SG"])).toBe("zh-CN");
  });

  it("候選為空時回預設語系", () => {
    expect(matchLocale([])).toBe(DEFAULT_LOCALE);
  });

  it("支援清單為空時不拋例外", () => {
    expect(matchLocale(["ja-JP"], [])).toBe(DEFAULT_LOCALE);
  });

  it("畸形標籤不拋例外（intl-localematcher 對壞標籤會 throw）", () => {
    expect(matchLocale(["!!not a locale!!"])).toBe(DEFAULT_LOCALE);
    expect(matchLocale(["zh_TW"])).toBe(DEFAULT_LOCALE);
  });

  it("單一壞標籤不得讓整份候選清單失效", () => {
    // 這支是判別性的：若壞標籤毒掉整個清單，結果會是 zh-TW 而非 en
    expect(matchLocale(["!!bad!!", "en-US"], ["zh-TW", "en"])).toBe("en");
  });

  it("英文瀏覽器落到 en——但不落到偽語系", () => {
    expect(matchLocale(["en-US", "en"], SUPPORTED_LOCALES)).toBe("en");
    expect(matchLocale(["en-US", "en"], SUPPORTED_LOCALES)).not.toBe(PSEUDO_LOCALE);
  });

  // 這支是「必須整份候選帶進匹配」的理由：只取第一個候選會在首選不支援時給出錯誤結果。
  it("首選不支援時退而用次選，而不是直接落到預設", () => {
    expect(matchLocale(["fr-FR", "ja-JP"], ["zh-TW", "ja"])).toBe("ja");
  });

  it("契約鎖：偽語系不得出現在匹配用的支援清單中", () => {
    expect(SUPPORTED_LOCALES).not.toContain(PSEUDO_LOCALE);
  });

  // 這支不是在測 bug，是在釘住「為何 en-XA 必須與 SUPPORTED_LOCALES 分開」這個理由本身。
  //
  // 候選必須用 en-GB 而不是 en-US：P-B2 加了之後，en-US 會精確命中 en 而看不出危險，
  // 但 en-GB 在 en-XA 也在清單裡時會被最佳匹配挑到 en-XA——英國英文的使用者會直接看到偽語系。
  // 這比 P-B1 寫的更嚴重：危險不只在「英文沒有被支援」時才存在。
  it("若把 en-XA 混進支援清單，部分英文瀏覽器（en-GB）就會命中偽語系", () => {
    expect(matchLocale(["en-GB"], [...SUPPORTED_LOCALES, PSEUDO_LOCALE])).toBe(PSEUDO_LOCALE);
    // 同一個候選在正確的設定下必須落到 en
    expect(matchLocale(["en-GB"], SUPPORTED_LOCALES)).toBe("en");
  });
});

describe("resolveLocale：明確指定優先，且偽語系只能靠明確指定到達", () => {
  it("候選清單的第一個元素即明確指定，壓過其餘候選", () => {
    expect(resolveLocale(["ja", "en-US"], ["zh-TW", "ja"])).toBe("ja");
  });

  it("明確指定偽語系時放行（dev：偽語系已啟用）", () => {
    expect(resolveLocale([PSEUDO_LOCALE], SUPPORTED_LOCALES, PSEUDO_LOCALE)).toBe(PSEUDO_LOCALE);
  });

  it("非 dev 環境下（偽語系未啟用）明確指定偽語系不會生效", () => {
    // 偽語系先被 resolveLocale 的前置檢查擋下（第三個參數為 null），接著落到一般的匹配：
    // en-XA 是格式良好但不受支援的標籤，最佳匹配的結果是 en。
    // 這與「格式壞掉的明確指定落到預設語系」是兩件事（後者由 canonicalize 擋下，見下一組）。
    expect(resolveLocale([PSEUDO_LOCALE], SUPPORTED_LOCALES, null)).toBe("en");
    expect(resolveLocale([PSEUDO_LOCALE], SUPPORTED_LOCALES, null)).not.toBe(PSEUDO_LOCALE);
  });

  it("未指定時沿用瀏覽器候選", () => {
    expect(resolveLocale(["zh-HK"], SUPPORTED_LOCALES, PSEUDO_LOCALE)).toBe("zh-TW");
  });
});

describe("detectCandidates：R6 的優先序", () => {
  it("localStorage 有值時該值排第一（明確指定）", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "ja");
    expect(detectCandidates()[0]).toBe("ja");
  });

  it("localStorage 無值時改用 navigator.languages（跟隨瀏覽器）", () => {
    stubNavigatorLanguages(["ja-JP", "en-US"]);
    expect(detectCandidates()).toEqual(["ja-JP", "en-US"]);
  });

  it("瀏覽器偏好是整份陣列，不是只有第一個", () => {
    stubNavigatorLanguages(["ja-JP", "en-US", "zh-HK"]);
    expect(detectCandidates()).toHaveLength(3);
  });

  it("被手動改成亂碼的明確指定，不會退回瀏覽器偏好（明確指定是承諾）", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "!!broken!!");
    stubNavigatorLanguages(["ja-JP"]);
    expect(resolveLocale(detectCandidates())).toBe(DEFAULT_LOCALE);
  });
});

  // 加 `zh-CN` 之前，裸 `zh` 落回 zh-TW（清單裡剛好只有繁體）；加了之後它解析成 zh-CN
  // ——依 CLDR，`zh` 的預設腳本本來就是簡體。這是**接受的行為變化**（設計文件 §3.5／§10.2），
  // 但要有斷言釘住，否則未來有人調整 SUPPORTED_LOCALES 的順序時不會知道自己改了什麼。
  it("裸 zh 解析成 zh-CN，而 zh-HK／zh-Hant 仍是 zh-TW", () => {
    expect(resolveLocale(["zh"], SUPPORTED_LOCALES)).toBe("zh-CN");
    expect(resolveLocale(["zh-HK"], SUPPORTED_LOCALES)).toBe("zh-TW");
    expect(resolveLocale(["zh-Hant"], SUPPORTED_LOCALES)).toBe("zh-TW");
  });
