import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";

describe("ShortcutsHelpDialog", () => {
  it("renders shortcut items when open is true", () => {
    render(<ShortcutsHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("鍵盤快捷鍵手冊")).toBeInTheDocument();
    expect(screen.getByText("全域搜尋 / 命令面板")).toBeInTheDocument();
    expect(screen.getByText("快速新增卡片")).toBeInTheDocument();
    expect(screen.getByText("切換個人任務篩選 (指派給我)")).toBeInTheDocument();
  });

  it("triggers onOpenChange on question mark keydown", () => {
    const handleOpenChange = vi.fn();
    render(<ShortcutsHelpDialog open={false} onOpenChange={handleOpenChange} />);

    fireEvent.keyDown(window, { key: "?" });
    expect(handleOpenChange).toHaveBeenCalledWith(true);
  });

  it("does not trigger when typing question mark in input", () => {
    const handleOpenChange = vi.fn();
    render(
      <div>
        <input data-testid="chat-input" />
        <ShortcutsHelpDialog open={false} onOpenChange={handleOpenChange} />
      </div>
    );

    const input = screen.getByTestId("chat-input");
    input.focus();
    fireEvent.keyDown(input, { key: "?" });
    expect(handleOpenChange).not.toHaveBeenCalled();
  });
});
