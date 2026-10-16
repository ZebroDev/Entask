import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { detectCandidates, resolveLocale } from "@/i18n/detect";
import { SUPPORTED_LOCALES } from "@/i18n/locales";
import { PINNED_LOCALE } from "@/test/locale-pin";

// 這幾支不是在測功能，是在釘住 src/test/locale-pin.ts 存在的理由本身。
// 拿掉那個釘子時，這幾支會單獨變紅並直說原因——而不是讓 386 支一起紅，
// 且紅得毫無線索。與 P-B1 的「en-XA 不得進匹配清單」是同一類設計。
describe("測試環境的語系釘", () => {
  it("navigator 被釘成 zh-TW（jsdom 的預設是 en-US）", () => {
    expect(navigator.languages).toEqual(["zh-TW"]);
    expect(navigator.language).toBe("zh-TW");
  });

  it("偵測鏈從頭走一遍也得到 zh-TW", () => {
    expect(resolveLocale(detectCandidates())).toBe(PINNED_LOCALE);
  });

  it("i18n 實例的解析語系是 zh-TW", () => {
    expect(i18n.resolvedLanguage).toBe(PINNED_LOCALE);
  });

  // 釘住「為何需要這個釘子」：en 自 P-B2 起是支援語系，所以 jsdom 的預設值
  // 不再是被忽略的雜訊，而是一個會被解析成英文的合法候選。
  it("若用 jsdom 的預設值（en-US），解析結果會是 en——386 支中文斷言會一起紅", () => {
    const jsdomDefault = ["en-US", "en"];
    expect(SUPPORTED_LOCALES).toContain("en");
    expect(resolveLocale(jsdomDefault)).toBe("en");
    expect(resolveLocale(jsdomDefault)).not.toBe(PINNED_LOCALE);
  });
});
