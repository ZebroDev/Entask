import { describe, expect, it } from "vitest";
import { pseudoLocalize, pseudoLocalizeResources, visualWidth } from "./pseudo";

const OPEN = "[!! ";
const CLOSE = " !!]";

/** 標記之內的部分（來源字串＋膨脹用的 ~） */
function bodyOf(pseudo: string): string {
  return pseudo.slice(OPEN.length, pseudo.length - CLOSE.length);
}

describe("visualWidth：以視覺寬度而非字元數計算", () => {
  it("CJK 一字算兩個單位", () => {
    expect(visualWidth("新增卡片")).toBe(8);
  });

  it("ASCII 一字算一個單位", () => {
    expect(visualWidth("PDF")).toBe(3);
  });

  it("混排時兩者相加", () => {
    expect(visualWidth("a卡b")).toBe(4);
  });

  it("空字串為 0", () => {
    expect(visualWidth("")).toBe(0);
  });
});

describe("pseudoLocalize：標記", () => {
  it("以 [!!  !!] 包住原文——沒被包住的文字就是漏抽的硬編碼", () => {
    const out = pseudoLocalize("新增卡片");
    expect(out.startsWith(OPEN)).toBe(true);
    expect(out.endsWith(CLOSE)).toBe(true);
    expect(out).toContain("新增卡片");
  });

  it("空字串也不拋例外", () => {
    expect(pseudoLocalize("")).toBe(`${OPEN}${CLOSE}`);
  });
});

describe("pseudoLocalize：膨脹（模擬英西語比繁中長 15-25%）", () => {
  it("CJK 來源：標記內補 ~ 到來源寬度的 1.35 倍", () => {
    const src = "這是一段比較長的說明文字用來驗證膨脹行為";
    expect(visualWidth(bodyOf(pseudoLocalize(src)))).toBeGreaterThanOrEqual(Math.ceil(visualWidth(src) * 1.35));
  });

  it("ASCII 來源：同樣補到 1.35 倍", () => {
    const src = "Please select a board from the list below";
    expect(visualWidth(bodyOf(pseudoLocalize(src)))).toBeGreaterThanOrEqual(Math.ceil(visualWidth(src) * 1.35));
  });

  it("已達標時不多補", () => {
    const src = "這是一段比較長的說明文字用來驗證膨脹行為";
    const target = Math.ceil(visualWidth(src) * 1.35);
    // 只補到剛好達標，不會無限膨脹
    expect(visualWidth(bodyOf(pseudoLocalize(src)))).toBeLessThan(target + 2);
  });

  it("膨脹只用 ~，不引入其他字元", () => {
    const src = "說明文字";
    const padding = bodyOf(pseudoLocalize(src)).slice(src.length);
    expect(padding).toMatch(/^~*$/);
  });
});

describe("pseudoLocalizeResources：遞迴走 namespace", () => {
  it("只動字串葉節點", () => {
    const out = pseudoLocalizeResources({
      a: { b: "卡片" },
      n: 3,
      f: false,
      nil: null,
      arr: ["清單", "第二項"],
    });
    expect(out.n).toBe(3);
    expect(out.f).toBe(false);
    expect(out.nil).toBeNull();
    expect(out.a.b.startsWith(OPEN)).toBe(true);
    expect(out.arr[0].startsWith(OPEN)).toBe(true);
    expect(out.arr[1].startsWith(OPEN)).toBe(true);
  });

  it("巢狀鍵名不變，只有值變", () => {
    const out = pseudoLocalizeResources({ a: { b: "卡片" } });
    expect(Object.keys(out)).toEqual(["a"]);
    expect(Object.keys(out.a)).toEqual(["b"]);
  });

  it("不變動輸入物件（回傳新物件）", () => {
    const src = { a: { b: "卡片" }, arr: ["清單"] };
    const out = pseudoLocalizeResources(src);
    expect(src.a.b).toBe("卡片");
    expect(src.arr[0]).toBe("清單");
    expect(out.a.b).not.toBe("卡片");
    expect(out.arr[0]).not.toBe("清單");
  });
});
