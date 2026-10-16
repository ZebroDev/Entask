// `REVIEW_BADGE_CLASS`（徽章：看板卡片／卡片對話框／表格）與 `REVIEW_ICON_CLASS`
// （圖示：月曆／甘特／心智圖）是同一個狀態的兩種呈現，**色彩家族必須一致**。
//
// 這一條在此之前沒有任何閘門（2026-09-17 的殘餘清單第 1 條）：把
// `REVIEW_ICON_CLASS.approved` 改成 amber 而徽章不動 ⇒ 同一個狀態徽章是綠的、圖示是黃的，
// 而 `tsc -b` 看不到（兩邊都還是合法字串）、四道閘門也看不到（它們比 key 集合與譯文，
// 不看顏色常數）。
//
// **key 的存在性刻意不在本檔的守衛範圍**：那是 `tsc -b` 的事，理由與五個索引點寫在
// `review-badge.ts` 的檔頭。原本要在這裡加一條 key parity 斷言，實測（M1）之後拿掉了
// ——少一個 key 時 `tsc -b` 一定先紅，那條斷言永遠不會是唯一變紅的東西。
import { describe, expect, it } from "vitest";

import cssText from "../index.css?raw";
import { REVIEW_EXPORT_COLOR } from "../pages/project/mindmap/mindmap-export";
import { REVIEW_BADGE_CLASS, REVIEW_ICON_CLASS, type ReviewVerdict } from "./review-badge";

const STATES: readonly ReviewVerdict[] = ["pending", "approved", "rejected"];

// Tailwind 的色彩 utility：`<屬性>-<家族>[-<色階>][/<透明度>]`，允許 `dark:` 之類的變體前綴。
// 這裡刻意自己寫而**不裝 Tailwind 的解析器**——本檔只需要家族名，不需要窄化成 px 值。
const COLOR_UTILITY = /^(?:bg|text|border|ring|from|to|via)-([a-z]+)(?:-\d+)?(?:\/\d+)?$/;

function colorFamilies(classes: string): Set<string> {
  const families = new Set<string>();
  for (const token of classes.split(/\s+/)) {
    if (!token) continue;
    // 變體前綴（`dark:`／`sm:hover:`）只影響套用時機，不影響家族——切掉再看。
    const utility = token.slice(token.lastIndexOf(":") + 1);
    const matched = COLOR_UTILITY.exec(utility);
    if (matched) families.add(matched[1]);
  }
  return families;
}

function sortedFamilies(classes: string): string[] {
  return [...colorFamilies(classes)].sort();
}

describe("review-badge 的兩個 class map", () => {
  // 抽取函式本身的契約鎖。它**可以單獨變紅**：例如把變體前綴的處理拿掉之後，
  // 真實 map 裡的家族仍抽得出來（`text-amber-900` 這種沒前綴的還在）⇒ 下面兩組
  // 斷言全綠，只有這一條會響。
  it("色彩家族的抽取：認得變體前綴、色階與透明度，不誤認其他 utility", () => {
    expect(sortedFamilies("bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100")).toEqual(["amber"]);
    expect(sortedFamilies("text-destructive bg-destructive/15")).toEqual(["destructive"]);
    expect(sortedFamilies("shrink-0 flex items-center gap-1.5")).toEqual([]);
  });

  it.each(STATES)("%s：徽章與圖示的色彩家族一致", (state) => {
    const badge = sortedFamilies(REVIEW_BADGE_CLASS[state]);
    const icon = sortedFamilies(REVIEW_ICON_CLASS[state]);

    // 非空守衛是**必要**的，不是加分項：抽取一旦失配就回空集合，而空集合＝空集合
    // ⇒ 下面那條斷言恆真，整個檔案會在「什麼都沒驗到」的狀態下全綠。
    expect(badge, `${state} 的 REVIEW_BADGE_CLASS 抽不到色彩家族（樣式改寫過？抽取正則失配？）`).not.toEqual([]);
    expect(icon, `${state} 的 REVIEW_ICON_CLASS 抽不到色彩家族（樣式改寫過？抽取正則失配？）`).not.toEqual([]);

    expect(icon, `${state} 的徽章與圖示不同色系`).toEqual(badge);
  });

  // 只釘徽章那一側：圖示那一側的兩兩相異是**推論**出來的
  // （逐狀態相等 ＋ 徽章側相異 ⇒ 圖示側必相異），所以不必也不能再多一條
  // ——它不會是唯一變紅的東西。
  it("三個狀態的徽章色彩家族兩兩相異（approved 與 rejected 同色 ⇒ 使用者分不出來）", () => {
    // 只放家族字串進 Set——訊息那一份才帶狀態名（帶了狀態名就永遠不會重複，
    // 斷言會恆真）。
    const families = STATES.map((state) => sortedFamilies(REVIEW_BADGE_CLASS[state]).join("+"));
    const labeled = STATES.map((state, i) => `${state}=${families[i]}`).join(", ");
    expect(new Set(families).size, `三個狀態抽出來的色彩家族有重複：${labeled}`).toBe(STATES.length);
  });
});

// ── 第三份副本：匯出的 SVG 底色（2026-09-28）──────────────────────────────────
//
// `mindmap-export.ts` 的 `REVIEW_EXPORT_COLOR` 是同一組語意的第三份。SVG 的 `fill` 只能
// 吃色值、不能吃 Tailwind utility ⇒ 它**必須**是 hex，沒辦法共用 `REVIEW_ICON_CLASS`。
// 在此之前它與前兩份之間**零連結**：把 `REVIEW_ICON_CLASS.approved` 的 `green-600` 改成
// `green-500`（家族仍是 green ⇒ 上面那條「家族一致」照綠），匯出的 hex 仍是 `#16a34a`
// ⇒ 畫布上的圖示與匯出的 SVG 不同色，**全程靜默**（`docs/STATE.md` 的 INFO-1）。
//
// 這條契約把三份連起來：`REVIEW_ICON_CLASS` 的**淺色** token →（Tailwind 色票 ／
// `--destructive` 這個 CSS 變數）→ hex，必須等於 `REVIEW_EXPORT_COLOR`。
// ★ **匯出固定是淺色**（`mindmap-export.ts` 檔頭：底色 `#f8fafc`）⇒ `dark:` 的 token
//   **不參與**比對。這件事用一支對照組突變釘住（改 dark 的色階 ⇒ 這裡必須照綠）；
//   若哪天匯出改成跟著主題走，這一條與那個突變要一起重寫。

// Tailwind 的色票值（**第三方事實**，不是我們的語意），只放今天用到的那幾格。
// 表中查不到就**當場拋錯**——那正是「色階被改掉而匯出沒跟上」的形狀，而訊息要指名去哪裡
// 查、以及下一步做什麼。刻意不收滿整個色票：收滿了，「換色階」這件事就不會經過這裡。
const TAILWIND_HEX: Record<string, string> = {
  "amber-600": "#d97706",
  "green-600": "#16a34a",
};

// 家族名 → CSS 變數（`index.css` 的 `:root`）。不在此表的裸家族名一律大聲。
const CSS_VAR_FAMILIES: Record<string, string> = { destructive: "destructive" };

// 淺色那一側的 `text-*`：帶變體前綴的（`dark:`）先切掉，剩下**恰好一個**。
function lightTextToken(classes: string): string {
  const plain = classes.split(/\s+/).filter((token) => token && !token.includes(":"));
  const texts = plain.filter((token) => token.startsWith("text-"));
  if (texts.length !== 1) {
    throw new Error(`${classes} 的淺色 text-* token 應該恰好一個，實得 ${texts.length}`);
  }
  return texts[0].slice("text-".length);
}

// `index.css` 的 `H S% L%`（Tailwind 的 `hsl(var(--x))` 慣例）。
function hslTripletToHex(triplet: string): string {
  const matched = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triplet.trim());
  if (!matched) throw new Error(`認不得的 HSL 三元組：${JSON.stringify(triplet)}`);
  const hue = (((Number(matched[1]) % 360) + 360) % 360) / 60;
  const sat = Number(matched[2]) / 100;
  const lum = Number(matched[3]) / 100;
  const chroma = (1 - Math.abs(2 * lum - 1)) * sat;
  const second = chroma * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] =
    hue < 1 ? [chroma, second, 0]
    : hue < 2 ? [second, chroma, 0]
    : hue < 3 ? [0, chroma, second]
    : hue < 4 ? [0, second, chroma]
    : hue < 5 ? [second, 0, chroma]
    : [chroma, 0, second];
  const base = lum - chroma / 2;
  return (
    "#" +
    [r, g, b].map((v) => Math.round((v + base) * 255).toString(16).padStart(2, "0")).join("")
  );
}

// 取 `index.css` 的某個區塊（`:root` 是淺色、`.dark` 是深色），大括號配對到收尾為止。
function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`index.css 找不到 ${selector} 區塊`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`index.css 的 ${selector} 區塊沒有收尾`);
}

function cssVarIn(css: string, selector: string, name: string): string {
  const found = [...cssBlock(css, selector).matchAll(new RegExp(`--${name}\\s*:\\s*([^;]+);`, "g"))];
  if (found.length !== 1) throw new Error(`${selector} 的 --${name} 應該恰好一條，實得 ${found.length}`);
  return found[0][1].trim();
}

function exportHexFor(state: ReviewVerdict): string {
  const token = lightTextToken(REVIEW_ICON_CLASS[state]);
  const palette = TAILWIND_HEX[token];
  if (palette) return palette;
  const variable = CSS_VAR_FAMILIES[token];
  if (variable) return hslTripletToHex(cssVarIn(cssText, ":root", variable));
  throw new Error(
    `${state} 的淺色 token「${token}」既不在 Tailwind 色票表、也不是已知的 CSS 變數家族。` +
      `改色階時請查 Tailwind 的色票值、決定匯出的 hex 要不要跟著換，兩者一致之後把那一格補進 TAILWIND_HEX。`,
  );
}

describe("匯出底色與圖示色階的契約（第三份副本）", () => {
  // 轉換器自己的契約鎖：少了它，「匯出 hex 等於圖示色階」那條可能因為轉換器壞掉而恆真
  // （例如它一律回 `#000000` 時，下面那三條會紅——但錯的理由不對）；這裡釘住它的邊界。
  it("HSL 三元組轉 hex：認得邊界值與進位，認不得就拋", () => {
    expect(hslTripletToHex("0 0% 100%")).toBe("#ffffff");
    expect(hslTripletToHex("0 0% 0%")).toBe("#000000");
    expect(hslTripletToHex("120 100% 50%")).toBe("#00ff00");
    expect(hslTripletToHex("240 100% 50%")).toBe("#0000ff");
    // 實測值：#ef4444 與 `0 84.2% 60.2%` 逐位元組相等，不是近似。
    expect(hslTripletToHex("0 84.2% 60.2%")).toBe("#ef4444");
    expect(() => hslTripletToHex("0 84.2%")).toThrow();
    expect(() => hslTripletToHex("hsl(0 84.2% 60.2%)")).toThrow();
  });

  it("只取不帶變體前綴的那個 text-* token（`dark:` 不參與）", () => {
    expect(lightTextToken("text-green-600 dark:text-green-400")).toBe("green-600");
    expect(lightTextToken("text-destructive")).toBe("destructive");
    // 非空守衛：抽不到就拋，不是回空字串讓下游查表恆真
    expect(() => lightTextToken("dark:text-green-400")).toThrow();
    expect(() => lightTextToken("text-amber-600 text-amber-900")).toThrow();
  });

  // 讀到的必須是**原始檔**，不是 Tailwind 的產物——否則比對的對象就換了一個。
  // `@tailwind` 指令只有原始檔有（管線會把它換掉）；`css: true`（`vite.config.ts`）被拿掉時
  // `?raw` 回空字串、下面每一條都會紅，而這一條說得出**為什麼**。
  it("讀到的是 index.css 的原始檔（`?raw`，不是管線的產物）", () => {
    expect(cssText).toContain("@tailwind base;");
  });

  // 對照組：**讀錯區塊**（拿到深色那份）在今天也會有答案 ⇒ 少了這一條，把 `:root` 寫成
  // `.dark` 的突變不會有紅燈。兩者相同時這條會紅——那時請改寫讀取方式，不要只是刪掉它。
  it("`:root` 與 `.dark` 的 --destructive 是不同色（否則上面那條讀錯區塊也會過）", () => {
    const light = hslTripletToHex(cssVarIn(cssText, ":root", "destructive"));
    const dark = hslTripletToHex(cssVarIn(cssText, ".dark", "destructive"));
    expect(light, "兩個主題的 --destructive 同色 ⇒ 這條對照組失去判別力").not.toBe(dark);
  });

  it.each(STATES)("%s：匯出的 hex 等於圖示淺色 token 的色值", (state) => {
    const hex = REVIEW_EXPORT_COLOR[state];
    expect(hex, `${state} 的匯出色彩不是六碼小寫 hex`).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex, `${state} 的匯出 hex 與 REVIEW_ICON_CLASS 的淺色色階不同色`).toBe(exportHexFor(state));
  });
});
