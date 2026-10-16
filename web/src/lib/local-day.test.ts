import { expect, it } from "vitest";
import { localDayString } from "./local-day";

// 本地日字串。**不得走 toISOString()**——UTC 以東（本機 +08）用 toISOString 會少一天。
it("以本地欄位組字串（午夜前後同一天）", () => {
  expect(localDayString(new Date(2026, 8, 7, 0, 5))).toBe("2026-09-07");
  expect(localDayString(new Date(2026, 8, 7, 23, 55))).toBe("2026-09-07");
});
it("補零", () => {
  expect(localDayString(new Date(2026, 0, 3))).toBe("2026-01-03");
});
// 判別力：本機是 UTC+8 ⇒ 誤用 toISOString() 的實作在上面第一支就會紅（09-06）。
it("localTimeZoneId 非空", async () => {
  const { localTimeZoneId } = await import("./local-day");
  expect(typeof localTimeZoneId()).toBe("string");
  expect(localTimeZoneId().length).toBeGreaterThan(0);
});
