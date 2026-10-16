import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReportWindowPicker } from "./ReportWindowPicker";
import { windowParams, type ReportWindowValue } from "@/lib/report-window";

/**
 * 受控元件的宿主：`onChange` 接回 state，行為才觀察得到（單獨餵 `vi.fn()` 只能看到
 * 「被呼叫了」，看不到「夾住之後畫面長什麼樣」——而夾住的**重點**就是使用者看得到
 * 另一個欄位跟著動）。
 */
function Harness({ initial, availableYears }: { initial: ReportWindowValue; availableYears?: number[] }) {
  const [value, setValue] = useState<ReportWindowValue>(initial);
  return (
    <ReportWindowPicker
      id="win"
      value={value}
      onChange={setValue}
      availableYears={availableYears}
      labels={{ period: "期間", all: "全期", custom: "自訂期間", from: "起始日期", to: "結束日期" }}
    />
  );
}

const select = () => screen.getByRole("combobox") as HTMLSelectElement;
const fromInput = () => screen.getByLabelText("起始日期") as HTMLInputElement;
const toInput = () => screen.getByLabelText("結束日期") as HTMLInputElement;

describe("ReportWindowPicker", () => {
  it("option 值＝年份遞減 ＋ 全期 ＋ 自訂；非數字的那兩個恰好是哨兵值", () => {
    render(<Harness initial={{ kind: "year", year: 2024 }} availableYears={[2023, 2022]} />);

    const values = Array.from(select().options).map((o) => o.value);
    const numeric = values.filter((v) => !Number.isNaN(Number(v)));
    // 數字項由大到小（不寫死今年是哪一年——那會讓這支測試在跨年當天紅）。
    expect(numeric).toEqual([...numeric].sort((a, b) => Number(b) - Number(a)));
    expect(values.filter((v) => Number.isNaN(Number(v)))).toEqual(["all", "custom"]);
  });

  // `<select>` 的 `value` 對不到任何 option 時**靜默變成空字串**——沒有任何錯誤、
  // 沒有紅燈，只有那顆下拉自己空掉。取數失敗時 `availableYears` 是空的，而這個控件
  // 正是那時唯一能救回畫面的東西。
  it("availableYears 缺席時，選定年仍在選項裡（下拉不空白）", () => {
    render(<Harness initial={{ kind: "year", year: 1999 }} availableYears={[]} />);
    expect(select().value).toBe("1999");
    expect(Array.from(select().options).map((o) => o.value)).toContain("1999");
  });

  it("選「自訂期間」時播種出完整的一年，且與剛才那個年份是同一個窗", () => {
    const year: ReportWindowValue = { kind: "year", year: 2024 };
    render(<Harness initial={year} />);

    fireEvent.change(select(), { target: { value: "custom" } });

    expect(fromInput().value).toBe("2024-01-01");
    expect(toInput().value).toBe("2024-12-31");
    // 播種值與「剛才那一年」產生同一個窗（上界排他 ⇒ 12/31 要推到 2025-01-01）。
    expect(windowParams({ kind: "range", from: fromInput().value, to: toInput().value }))
      .toBe(windowParams(year));
  });

  it("切到全期時收起兩個日期欄位", () => {
    render(<Harness initial={{ kind: "range", from: "2026-03-01", to: "2026-06-30" }} />);
    expect(screen.queryByLabelText("起始日期")).toBeInTheDocument();

    fireEvent.change(select(), { target: { value: "all" } });

    expect(select().value).toBe("all");
    expect(screen.queryByLabelText("起始日期")).not.toBeInTheDocument();
  });

  // UI **永遠送不出顛倒的窗框**：改一邊越過另一邊時把另一邊一起帶走。
  // 使用者看到另一個欄位跟著動，而不是兩個欄位無聲地不一致。
  it("改起始日越過結束日時，結束日跟著被帶走", () => {
    render(<Harness initial={{ kind: "range", from: "2026-03-01", to: "2026-06-30" }} />);

    fireEvent.change(fromInput(), { target: { value: "2026-09-15" } });

    expect(fromInput().value).toBe("2026-09-15");
    expect(toInput().value).toBe("2026-09-15");
  });

  it("改結束日越過起始日時，起始日跟著被帶走", () => {
    render(<Harness initial={{ kind: "range", from: "2026-03-01", to: "2026-06-30" }} />);

    fireEvent.change(toInput(), { target: { value: "2026-01-05" } });

    expect(fromInput().value).toBe("2026-01-05");
    expect(toInput().value).toBe("2026-01-05");
  });

  // `<input type="date">` 在使用者還沒選完時給的是**空字串**。放它過去會走到
  // `parseDay("")` 當場拋 ⇒ 白畫面。
  it("日期欄位被清空時忽略，不炸掉畫面", () => {
    render(<Harness initial={{ kind: "range", from: "2026-03-01", to: "2026-06-30" }} />);

    fireEvent.change(fromInput(), { target: { value: "" } });

    expect(fromInput().value).toBe("2026-03-01");
    expect(toInput().value).toBe("2026-06-30");
  });

  // WCAG 2.5.3 Label in Name：無障礙名稱必須來自**可見**文字，不得另寫一份 aria-label
  // （那會覆蓋可見文字，六個語系下的名稱都會是英文——CardDialog 的「詳細資訊」踩過）。
  it("兩個日期欄位的無障礙名稱來自可見的 label", () => {
    render(<Harness initial={{ kind: "range", from: "2026-03-01", to: "2026-06-30" }} />);
    // `getByLabelText` 本身就是那條斷言：名稱對不上就找不到元素。
    expect(fromInput()).toBeInTheDocument();
    expect(toInput()).toBeInTheDocument();
    expect(screen.getByText("期間")).toBeInTheDocument();
  });
});
