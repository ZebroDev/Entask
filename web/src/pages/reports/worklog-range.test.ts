import { describe, expect, it } from "vitest";
import { buildRange, shiftAnchor, isoWeekNumber } from "./worklog-range";

// 一律以本地時間建構 Date，避免測試受執行環境時區影響
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("buildRange", () => {
  it("日模式取當日 00:00 至隔日 00:00，標題含星期", () => {
    const r = buildRange("day", d(2026, 9, 10));
    expect(r.from).toEqual(d(2026, 9, 10));
    expect(r.to).toEqual(d(2026, 9, 11));
    expect(r.label).toBe("2026/09/10（四）");
  });

  it("週模式以週一為週首，跨月正確", () => {
    // 2026-09-10 是週四 → 該週週一為 09-07
    const r = buildRange("week", d(2026, 9, 10));
    expect(r.from).toEqual(d(2026, 9, 7));
    expect(r.to).toEqual(d(2026, 9, 14));
    expect(r.label).toContain("09/07 – 09/13");
  });

  it("週模式對週日取樣仍歸前一週（週一為首）", () => {
    // 2026-09-13 是週日 → 該週週一仍是 09-07
    expect(buildRange("week", d(2026, 9, 13)).from).toEqual(d(2026, 9, 7));
  });

  it("月模式取月初至次月一日，跨年正確", () => {
    const r = buildRange("month", d(2026, 12, 20));
    expect(r.from).toEqual(d(2026, 12, 1));
    expect(r.to).toEqual(d(2027, 1, 1));
    expect(r.label).toBe("2026年12月");
  });
});

describe("shiftAnchor", () => {
  it("日模式加減一天", () => {
    expect(shiftAnchor("day", d(2026, 9, 10), -1)).toEqual(d(2026, 9, 9));
  });
  it("週模式加減七天", () => {
    expect(shiftAnchor("week", d(2026, 9, 10), 1)).toEqual(d(2026, 9, 17));
  });
  it("月模式加減一個月並落在月初", () => {
    expect(shiftAnchor("month", d(2026, 9, 10), -1)).toEqual(d(2026, 8, 1));
    expect(shiftAnchor("month", d(2026, 12, 10), 1)).toEqual(d(2027, 1, 1));
  });
});

describe("isoWeekNumber", () => {
  it("2026-09-07 為第 37 週", () => {
    expect(isoWeekNumber(d(2026, 9, 7))).toBe(37);
  });
});
