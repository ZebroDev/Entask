import "@testing-library/jest-dom";
import { beforeEach } from "vitest";
// 匯入即初始化 i18n，讓所有既有測試取得 zh-TW 資源。
// 這是 R3 的前提：測試語系由 locale-pin 釘成 zh-TW（產品預設語系 2026-10-07 起
// 是 en，與此無關），2,344 行中文斷言才不必改。
import i18n from "@/i18n";
import { LOCALE_STORAGE_KEY } from "@/lib/storage-keys";
import { PINNED_LOCALE } from "@/test/locale-pin";

// Radix Select 開啟時會對選中項呼叫 scrollIntoView——jsdom 未實作此方法，
// 在 passive effect 中呼叫會拋 TypeError 並使 React 卸載整棵樹
Element.prototype.scrollIntoView = () => {};

// 測試之間不得殘留語系（否則切過語系的測試會污染同檔其餘測試的斷言）。
// 只動語系鍵——auth / theme 等其他 localStorage 鍵不碰，否則會破壞依賴它們的既有測試。
// 放在 beforeEach 而非 afterEach：afterEach 會在 RTL 卸載元件之前跑，
// changeLanguage 會對還掛著的元件觸發更新而產生 act 警告。
beforeEach(async () => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  if (i18n.resolvedLanguage !== PINNED_LOCALE) {
    await i18n.changeLanguage(PINNED_LOCALE);
  }
  document.documentElement.lang = PINNED_LOCALE;
});
