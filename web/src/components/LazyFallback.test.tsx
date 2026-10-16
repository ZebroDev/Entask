import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { LazyFallback } from "./LazyFallback";

describe("LazyFallback", () => {
  it("顯示 t() 的載入文案，而不是 key 本身", () => {
    render(<LazyFallback />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(i18n.t("common:state.loading"));
    // defaultNS 三處不一致時 t() 會**靜默回傳 key 字串本身**（畫面顯示 common:loading）。
    // 少了這一行，上一個斷言在「語系有設好」與「根本沒設好」兩種情況下都會過
    // ——因為它比的是同一個 t()。
    expect(status).not.toHaveTextContent("common:state.loading");
  });

  it("給了 className 時覆寫預設樣式，其餘預設樣式留著", () => {
    render(<LazyFallback className="min-h-[240px]" />);

    const status = screen.getByRole("status");
    // 覆寫生效——靠的是 `cn()` 的 `twMerge`（同一個 tailwind 群組只留最後一個）。
    // 把 `cn()` 換成純 `clsx` 的話這一行會紅：兩個 min-h 會同時留著。
    expect(status.className).toContain("min-h-[240px]");
    expect(status.className).not.toContain("min-h-[50vh]");
    // 其餘預設樣式不受影響——否則「覆寫」就變成了「取代整串」
    expect(status.className).toContain("items-center");
    expect(status.className).toContain("text-muted-foreground");
  });

  it("沒給 className 時預設樣式原樣留著", () => {
    render(<LazyFallback />);

    expect(screen.getByRole("status").className).toContain("min-h-[50vh]");
  });
});
