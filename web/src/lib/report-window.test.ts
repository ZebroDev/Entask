import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOW_ALL,
  WINDOW_CUSTOM,
  dayToIso,
  nextDay,
  parseDay,
  rangeOfYear,
  reportWindowLabel,
  windowKey,
  windowParams,
  windowQuery,
  windowSuffix,
  withFrom,
  withTo,
  yearOptions,
} from "./report-window";

/**
 * 把 query string 裡的 `from=`／`to=` 解回**本地日**（`yyyy-MM-dd`）。
 *
 * 斷言走這一條而不是寫死 ISO 字面值：`new Date(2026, 0, 1).toISOString()` 的結果
 * **取決於執行機器的時區**（UTC+8 是 `2025-12-31T16:00:00.000Z`），寫死等於把測試綁在
 * 這台機器上。而「哪一天」才是契約——解回本地日再比，在任何時區都成立。
 *
 * **刻意不用** `TeamReportTab.test.tsx` 的 `windowOf()` 那個 helper：它與實作是同一條
 * 算式，實作算錯時它會一起算錯（那正是本模組要消滅的那種「自己跟自己一致」的測試）。
 */
function localDayOf(params: string, key: "from" | "to"): string {
  const raw = new RegExp(`${key}=([^&]+)`).exec(params)?.[1];
  if (!raw) throw new Error(`query string 裡沒有 ${key}：${params}`);
  const d = new Date(decodeURIComponent(raw));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 同上，但取的是**瞬間**（用來分辨「本地午夜」與「UTC 午夜」）。 */
function instantOf(params: string, key: "from" | "to"): number {
  const raw = new RegExp(`${key}=([^&]+)`).exec(params)?.[1];
  if (!raw) throw new Error(`query string 裡沒有 ${key}：${params}`);
  return new Date(decodeURIComponent(raw)).getTime();
}

describe("windowParams", () => {
  it("全期＝空字串（兩個界線都不送，後端把兩個 null 讀成全期）", () => {
    expect(windowParams({ kind: "all" })).toBe("");
  });

  it("年份的兩個界線是該年頭尾的本地午夜", () => {
    const params = windowParams({ kind: "year", year: 2026 });
    expect(localDayOf(params, "from")).toBe("2026-01-01");
    expect(localDayOf(params, "to")).toBe("2027-01-01");
    // 「本地午夜」不是「UTC 午夜」——UTC 以東這兩者差 8 小時，而畫面上完全看不出來
    // （`new Date("2026-01-01")` 會得到 UTC 午夜，本地日期在 UTC+8 仍是 1/1 ⇒ 只比日期
    // 抓不到它）。瞬間相等才是這條契約。
    expect(instantOf(params, "from")).toBe(new Date(2026, 0, 1).getTime());
    expect(instantOf(params, "to")).toBe(new Date(2027, 0, 1).getTime());
  });

  // ★ H1 的守門員。上界排他（`[from, to)`）而 UI 的結束日含當日，所以「選 2026 年」與
  // 「自訂 2026-01-01 ~ 2026-12-31」**必須產生同一個窗**。少了 `to` 的 `+1`，
  // 區間模式會少掉 12/31 一整天，而年份模式正常——不對稱的少一天讀起來像資料有問題。
  it("年 ≡ 等效區間，逐位元相同（上界排他的守門員）", () => {
    for (const year of [2026, 2024, 1999]) {
      expect(windowParams({ kind: "year", year }))
        .toBe(windowParams({ kind: "range", from: `${year}-01-01`, to: `${year}-12-31` }));
    }
  });

  it("自訂區間的結束日是**隔天**的本地午夜（結束日含當日）", () => {
    const params = windowParams({ kind: "range", from: "2026-03-01", to: "2026-06-30" });
    expect(localDayOf(params, "from")).toBe("2026-03-01");
    expect(localDayOf(params, "to")).toBe("2026-07-01");
    expect(instantOf(params, "to")).toBe(new Date(2026, 6, 1).getTime());
  });

  it("跨月跨年的 +1 由 Date 正規化（12/31 → 隔年 1/1）", () => {
    const params = windowParams({ kind: "range", from: "2026-12-01", to: "2026-12-31" });
    expect(localDayOf(params, "to")).toBe("2027-01-01");
  });

  it("不含前導的 ?／&（分隔符留給呼叫端：xls 那顆自己帶著 ?locale=）", () => {
    expect(windowParams({ kind: "range", from: "2026-03-01", to: "2026-06-30" })).not.toContain("?");
    expect(windowParams({ kind: "year", year: 2026 })).not.toContain("?");
  });
});

describe("windowQuery / windowKey", () => {
  it("windowQuery 只在有參數時加 ?", () => {
    expect(windowQuery({ kind: "all" })).toBe("");
    expect(windowQuery({ kind: "year", year: 2026 })).toBe(`?${windowParams({ kind: "year", year: 2026 })}`);
  });

  it("窗框進 query key（否則切期間會拿到前一格的快取）", () => {
    expect(windowKey({ kind: "all" })).not.toBe(windowKey({ kind: "year", year: 2026 }));
    expect(windowKey({ kind: "year", year: 2026 })).not.toBe(windowKey({ kind: "year", year: 2025 }));
  });
});

describe("windowSuffix", () => {
  it("三種模式各自的檔名後綴", () => {
    expect(windowSuffix({ kind: "all" })).toBe("");
    expect(windowSuffix({ kind: "year", year: 2026 })).toBe("-2026");
    expect(windowSuffix({ kind: "range", from: "2026-03-01", to: "2026-06-30" }))
      .toBe("-20260301-20260630");
  });
});

describe("rangeOfYear", () => {
  it("播種值是一整年，且與年份模式產生同一個窗（往返）", () => {
    const seeded = rangeOfYear(2026);
    expect(seeded).toEqual({ kind: "range", from: "2026-01-01", to: "2026-12-31" });
    expect(windowParams(seeded)).toBe(windowParams({ kind: "year", year: 2026 }));
  });
});

describe("parseDay / dayToIso / nextDay", () => {
  it("壞值**當場拋**，不靜默退回今天或全期", () => {
    // 每一種都各是一個獨立的坑：空字串（打字途中）、非日期、少了補零、
    // 還有一個**形狀對但不存在**的日子（`new Date(2026, 1, 31)` 會正規化成 3/3）。
    for (const bad of ["", "2026-3-1", "20260301", "2026/03/01", "2026-02-31", "abcd-ef-gh"]) {
      expect(() => parseDay(bad), bad).toThrow();
    }
  });

  it("nextDay 走的是本地日（跨月跨年由 Date 正規化）", () => {
    expect(nextDay("2026-06-30")).toBe("2026-07-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    // 閏年：2/28 的隔天是 2/29，不是 3/1。
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
  });

  it("dayToIso 是本地午夜", () => {
    expect(new Date(dayToIso("2026-03-01")).getTime()).toBe(new Date(2026, 2, 1).getTime());
  });
});

describe("withFrom / withTo", () => {
  it("改起始日越過結束日時，把結束日一起帶走", () => {
    const r = withFrom({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, "2026-09-15");
    expect(r).toEqual({ kind: "range", from: "2026-09-15", to: "2026-09-15" });
  });

  it("改結束日越過起始日時，把起始日一起帶走", () => {
    const r = withTo({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, "2026-01-05");
    expect(r).toEqual({ kind: "range", from: "2026-01-05", to: "2026-01-05" });
  });

  it("沒越過就只改那一邊", () => {
    expect(withFrom({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, "2026-04-01"))
      .toEqual({ kind: "range", from: "2026-04-01", to: "2026-06-30" });
    expect(withTo({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, "2026-05-01"))
      .toEqual({ kind: "range", from: "2026-03-01", to: "2026-05-01" });
  });

  // 空字串是 `<input type="date">` 在使用者還沒選完時的正常值。放它過去會走到
  // `parseDay("")` 當場拋 ⇒ 在事件處理裡把畫面炸掉。
  it("空字串被忽略（回傳同一個值，不拋）", () => {
    const v = { kind: "range", from: "2026-03-01", to: "2026-06-30" } as const;
    expect(withFrom(v, "")).toEqual(v);
    expect(withTo(v, "")).toEqual(v);
  });

  it("壞值拋（與 parseDay 同一條 fail-closed 規則）", () => {
    expect(() => withFrom({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, "2026-13-01")).toThrow();
    expect(() => withTo({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, "x")).toThrow();
  });
});

describe("yearOptions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("三來源聯集、由大到小、去重", () => {
    const years = yearOptions({ kind: "year", year: 2025 }, [2024, 2023, 2024]);
    expect(years).toEqual([...new Set(years)]);                       // 去重
    expect(years).toEqual([...years].sort((a, b) => b - a));          // 降冪
    expect(years).toContain(new Date().getFullYear());                // 今年由前端併入
    expect(years).toContain(2025);                                    // 選定年
    expect(years).toContain(2024);                                    // 資料年
  });

  // `<select>` 的 value 對不到任何 option 時**靜默變空白**——那是取數失敗當下唯一能
  // 救回畫面的控件，而 `availableYears` 在那時正是空的（舊後端則恆為 undefined）。
  it("availableYears 缺席時，選定年仍在清單裡（空白守衛）", () => {
    expect(yearOptions({ kind: "year", year: 1999 })).toContain(1999);
    expect(yearOptions({ kind: "year", year: 1999 }, [])).toContain(1999);
  });

  it("UTC 以東時，資料年的本地候選多一年（後端給的是 UTC 曆年）", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);   // UTC+8
    const years = yearOptions({ kind: "all" }, [2020]);
    expect(years).toContain(2020);
    expect(years).toContain(2021);
  });

  it("UTC 以西時，資料年的本地候選少一年", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);    // UTC-5
    const years = yearOptions({ kind: "all" }, [2020]);
    expect(years).toContain(2020);
    expect(years).toContain(2019);
  });

  it("自訂區間模式下，選定的年份不進清單（選中的是 custom，不是某一年）", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    expect(yearOptions({ kind: "range", from: "1998-01-01", to: "1998-12-31" }, []))
      .toEqual([new Date().getFullYear()]);
  });
});

describe("reportWindowLabel", () => {
  const labels = { all: "全期", range: (from: string, to: string) => `${from} – ${to}` };

  it("三種模式各自的文字", () => {
    expect(reportWindowLabel({ kind: "all" }, labels)).toBe("全期");
    expect(reportWindowLabel({ kind: "year", year: 2026 }, labels)).toBe("2026");
    expect(reportWindowLabel({ kind: "range", from: "2026-03-01", to: "2026-06-30" }, labels))
      .toBe("2026-03-01 – 2026-06-30");
  });

  it("年份不經千分位（它是識別碼不是數量）", () => {
    expect(reportWindowLabel({ kind: "year", year: 2026 }, labels)).not.toContain(",");
  });
});

describe("哨兵值", () => {
  it("select 的兩個非年份 value 是哨兵，不是文案", () => {
    expect(WINDOW_ALL).toBe("all");
    expect(WINDOW_CUSTOM).toBe("custom");
    // `Number("custom")` 是 NaN ⇒ select 空白且無錯誤。哨兵值必須永遠 parse 不出數字。
    expect(Number.isNaN(Number(WINDOW_CUSTOM))).toBe(true);
  });
});
