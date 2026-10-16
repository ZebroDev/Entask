// 文字寬度量測。甘特圖的月份標頭要判斷候選標籤放不放得進某個像素寬度，
// 這件事只能靠實際量測——每個語系的字寬不同，硬編門檻等於把某個語系的
// 字寬寫死。
//
// 正式路徑用 canvas measureText（與瀏覽器渲染同一套字型度量）；環境不支援
// （jsdom、無 canvas）時退回字寬估算。估算只影響「退到哪一級」的邊界情形，
// 不影響正確性。

// CJK 漢字／假名／諺文／全形標點約 1em 寬，其餘約 0.55em。
const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/;

const cache = new Map<string, number>();
let cachedCtx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (cachedCtx === undefined) {
    try {
      cachedCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      cachedCtx = null;
    }
  }
  return cachedCtx;
}

function fontSizePx(font: string): number {
  const match = /([0-9]+(?:\.[0-9]+)?)px/.exec(font);
  return match ? Number(match[1]) : 12;
}

function estimate(text: string, font: string): number {
  const em = fontSizePx(font);
  let width = 0;
  for (const ch of text) width += (WIDE.test(ch) ? 1 : 0.55) * em;
  return width;
}

/**
 * 量測 text 在 font 下的像素寬。font 為 CSS font shorthand
 * （例如 "600 12px ui-sans-serif, system-ui, sans-serif"）。
 *
 * 結果以 (font, text) 快取——甘特圖每次捲動都會重繪，同一組標籤會反覆量到。
 */
export function measureTextWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const ctx = context();
  let width: number;
  if (ctx) {
    ctx.font = font;
    width = ctx.measureText(text).width;
  } else {
    width = estimate(text, font);
  }
  cache.set(key, width);
  return width;
}
