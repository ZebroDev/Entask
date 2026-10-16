import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";
import { FolderPlus } from "lucide-react";

describe("EmptyState", () => {
  it("renders title, description and action button", () => {
    const handleAction = vi.fn();
    render(
      <EmptyState
        icon={<FolderPlus className="h-6 w-6" />}
        title="尚無看板"
        description="建立第一個看板開始管理任務"
        actionText="建立看板"
        onAction={handleAction}
      />
    );

    expect(screen.getByText("尚無看板")).toBeInTheDocument();
    expect(screen.getByText("建立第一個看板開始管理任務")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: /建立看板/ });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(handleAction).toHaveBeenCalledTimes(1);
  });

  it("renders secondary action if provided", () => {
    const handleSecondary = vi.fn();
    render(
      <EmptyState
        title="無符合條件的卡片"
        description="請嘗試調整篩選條件"
        secondaryActionText="清除篩選"
        onSecondaryAction={handleSecondary}
      />
    );

    const secondaryBtn = screen.getByRole("button", { name: /清除篩選/ });
    fireEvent.click(secondaryBtn);
    expect(handleSecondary).toHaveBeenCalledTimes(1);
  });
});
