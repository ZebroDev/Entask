import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickFilter } from "./QuickFilter";

describe("QuickFilter", () => {
  it("renders filter options with counts", () => {
    render(
      <QuickFilter
        value="all"
        onChange={vi.fn()}
        counts={{ all: 10, my: 3, dueToday: 2, overdue: 1 }}
      />
    );

    expect(screen.getByText("全部")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("指派給我")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("今日到期")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("已逾期")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("calls onChange when clicked", () => {
    const handleChange = vi.fn();
    render(<QuickFilter value="all" onChange={handleChange} />);

    fireEvent.click(screen.getByText("指派給我"));
    expect(handleChange).toHaveBeenCalledWith("my");

    fireEvent.click(screen.getByText("今日到期"));
    expect(handleChange).toHaveBeenCalledWith("dueToday");
  });

  it("toggles filter on F shortcut when not in input", () => {
    const handleChange = vi.fn();
    render(<QuickFilter value="all" onChange={handleChange} />);

    fireEvent.keyDown(window, { key: "f" });
    expect(handleChange).toHaveBeenCalledWith("my");
  });

  it("ignores F shortcut when typing inside input field", () => {
    const handleChange = vi.fn();
    render(
      <div>
        <input data-testid="test-input" />
        <QuickFilter value="all" onChange={handleChange} />
      </div>
    );

    const input = screen.getByTestId("test-input");
    input.focus();
    fireEvent.keyDown(input, { key: "f" });
    expect(handleChange).not.toHaveBeenCalled();
  });
});
