import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentLocale,
  formatDate,
  formatDateTime,
  formatDay,
  formatDecimal,
  formatFullDay,
  formatHours,
  formatMonthDay,
  formatMonthYear,
  formatPercent,
  formatRelativeTime,
  formatWeekdayNarrow,
  formatWeekOfYear,
  hourUnit,
  monthLabelCandidates,
  pickMonthLabel,
} from "./format";

// 一律以本地時間建構 Date，避免測試受執行環境時區影響
const d = (y: number, m: number, day: number, h = 12, min = 0, s = 0) =>
  new Date(y, m - 1, day, h, min, s);

// formatDate/formatDateTime 收 ISO 字串並以「執行環境本地時區」呈現，
// 故取本地正午當瞬間——任何時區下都落在同一個日曆日。
const iso = (y: number, m: number, day: number, h = 12, min = 0, s = 0) =>
  d(y, m, day, h, min, s).toISOString();

describe("currentLocale", () => {
  it("測試環境語系是 zh-TW（locale-pin 釘住；R3）", () => {
    expect(currentLocale()).toBe("zh-TW");
  });

  // P-B1 的接點：整個前端只有這一個函式決定格式化語系，而它只讀 i18n。
  // 這支同時證明 Intl 接受偽語系的標籤（en-XA 會解析為 en），
  // 所以格式化不會在偽語系下炸掉。
  it("跟隨 i18n 的目前語系", async () => {
    const i18n = (await import("@/i18n")).default;
    await i18n.changeLanguage("en-XA");
    expect(currentLocale()).toBe("en-XA");
    expect(formatHours(12.5)).toBe("12.5 hr");
  });
});

describe("formatDate / formatDateTime", () => {
  it("formatDate 輸出與改動前逐字元相同", () => {
    expect(formatDate(iso(2026, 9, 10))).toBe("2026年9月10日");
  });

  it("formatDate 對 null/undefined 回破折號", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("formatDateTime 輸出與改動前逐字元相同（含時分秒）", () => {
    expect(formatDateTime(iso(2026, 9, 10, 12, 0, 0))).toBe("2026/9/10 下午12:00:00");
  });

  it("formatDateTime 對 null/undefined 回破折號", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });
});

describe("formatMonthYear", () => {
  it("zh-TW 無空格（與 Intl 一致，改動前為「2026 年 9 月」）", () => {
    expect(formatMonthYear(d(2026, 9, 10))).toBe("2026年9月");
  });

  it("12 月不進位到下一年", () => {
    expect(formatMonthYear(d(2026, 12, 31))).toBe("2026年12月");
  });
});

describe("formatMonthDay / formatFullDay / formatDay", () => {
  it("formatMonthDay 補零", () => {
    expect(formatMonthDay(d(2026, 1, 5))).toBe("01/05");
  });

  it("formatFullDay 補零", () => {
    expect(formatFullDay(d(2026, 9, 10))).toBe("2026/09/10");
  });

  it("formatDay 收 YYYY-MM-DD 字串", () => {
    expect(formatDay("2026-09-10")).toBe("09/10（四）");
  });

  it("formatDay 收 Date（worklog-range 用），與字串形式同結果", () => {
    expect(formatDay(d(2026, 9, 10))).toBe("09/10（四）");
  });

  it("formatDay 逐字元等同改動前的 worklog-format.ts", () => {
    // 2026-01-04 是週日
    expect(formatDay("2026-01-04")).toBe("01/04（日）");
  });
});

describe("formatWeekdayNarrow / formatWeekOfYear", () => {
  it("formatWeekdayNarrow 與既有的 WEEKDAY_LABELS 逐字元相同", () => {
    // 2026-09-06 是週日，往後七日剛好涵蓋日一二三四五六
    const got = [0, 1, 2, 3, 4, 5, 6].map((i) => formatWeekdayNarrow(d(2026, 9, 6 + i)));
    expect(got).toEqual(["日", "一", "二", "三", "四", "五", "六"]);
  });

  it("formatWeekOfYear", () => {
    expect(formatWeekOfYear(38)).toBe("第 38 週");
  });
});

describe("formatHours / hourUnit", () => {
  it("保留一位小數（與 .toFixed(1) 相同），單位由 Intl 提供", () => {
    expect(formatHours(12.5)).toBe("12.5 小時");
    expect(formatHours(8)).toBe("8.0 小時");
    expect(formatHours(0)).toBe("0.0 小時");
  });

  it("千分位由 Intl 提供（改動前 toFixed(1) 不帶千分位）", () => {
    expect(formatHours(1234.5)).toBe("1,234.5 小時");
  });

  it("hourUnit 回傳裸單位，供單位獨立的版面使用", () => {
    expect(hourUnit()).toBe("小時");
  });

  it("formatHours 以 hourUnit 結尾（兩者不得漂移）", () => {
    expect(formatHours(3.5).endsWith(hourUnit())).toBe(true);
  });
});

describe("formatDecimal / formatPercent", () => {
  it("formatDecimal 保留一位小數", () => {
    expect(formatDecimal(12.5)).toBe("12.5");
    expect(formatDecimal(0)).toBe("0.0");
  });

  it("formatPercent 預設零位小數，與 Math.round(x*100)+'%' 相同", () => {
    expect(formatPercent(0.8567)).toBe("86%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("formatPercent 可指定一位小數，與 (x*100).toFixed(1)+'%' 相同", () => {
    expect(formatPercent(0.8567, 1)).toBe("85.7%");
  });
});

describe("monthLabelCandidates", () => {
  const sep = d(2026, 9, 10);

  it("zh-TW 三段：年月／月／裸數字", () => {
    expect(monthLabelCandidates(sep)).toEqual(["2026年9月", "9月", "9"]);
  });

  it("ja 的 narrow 等於 long，去重後只剩兩段", () => {
    expect(monthLabelCandidates(sep, "ja")).toEqual(["2026年9月", "9月"]);
  });

  it("en 三段且互異", () => {
    expect(monthLabelCandidates(sep, "en")).toEqual(["September 2026", "September", "S"]);
  });
});

describe("pickMonthLabel", () => {
  const cands = ["2026年9月", "9月", "9"];
  // 決定性量測：每個字元固定 10px
  const measure = (s: string) => s.length * 10;

  it("寬度足夠時取最長候選", () => {
    expect(pickMonthLabel(cands, 200, measure)).toBe("2026年9月");
  });

  it("放不下最長時退一級", () => {
    expect(pickMonthLabel(cands, 25, measure)).toBe("9月");
  });

  it("再放不下時退到最短", () => {
    expect(pickMonthLabel(cands, 15, measure)).toBe("9");
  });

  it("連最短都放不下時仍回最短（不裁切、不空白）", () => {
    expect(pickMonthLabel(cands, 5, measure)).toBe("9");
  });

  it("寬度恰好等於文字寬度時視為放得下", () => {
    expect(pickMonthLabel(cands, 20, measure)).toBe("9月");
  });

  it("候選為空時回空字串", () => {
    expect(pickMonthLabel([], 100, measure)).toBe("");
  });

  it("單一候選時無條件採用", () => {
    expect(pickMonthLabel(["9月"], 1, measure)).toBe("9月");
  });

  it("只在需要時量測（最長候選放得下則不量其餘）", () => {
    const seen: string[] = [];
    pickMonthLabel(cands, 200, (s) => {
      seen.push(s);
      return s.length * 10;
    });
    expect(seen).toEqual(["2026年9月"]);
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const ago = (ms: number) => formatRelativeTime(new Date(Date.now() - ms).toISOString());

  it("59 秒前的時間仍由呼叫端處理（此函式只管 60 秒以上）", () => {
    // 這一格刻意不擋：門檻由 notificationTime 攔，這裡證明「1 分鐘」是它的下界
    expect(ago(60_000)).toBe("1 分鐘前");
  });

  it("分鐘級", () => {
    expect(ago(5 * 60_000)).toBe("5 分鐘前");
    expect(ago(59 * 60_000)).toBe("59 分鐘前");
  });

  it("小時級", () => {
    expect(ago(60 * 60_000)).toBe("1 小時前");
    expect(ago(23 * 3_600_000)).toBe("23 小時前");
  });

  it("天級", () => {
    expect(ago(24 * 3_600_000)).toBe("1 天前");
    expect(ago(6 * 86_400_000)).toBe("6 天前");
  });

  it("七天以上回絕對日期（不再說「8 天前」）", () => {
    expect(ago(7 * 86_400_000)).toBe(formatDate(new Date(Date.now() - 7 * 86_400_000).toISOString()));
  });

  it("時鐘偏差（未來時間）不會印出負數", () => {
    // 伺服器與瀏覽器的時鐘差幾秒是常態，不能讓畫面出現「-1 分鐘前」
    expect(ago(-30_000)).toBe("1 分鐘前");
  });

  it("無法解析的字串回空字串，不拋錯", () => {
    expect(formatRelativeTime("")).toBe("");
  });
});
