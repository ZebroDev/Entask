import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditProjectDialog } from "./EditProjectDialog";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog(props: Partial<Parameters<typeof EditProjectDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onUpdated = vi.fn();
  render(
    <EditProjectDialog
      projectId="p1"
      name="專案一"
      description="原敘述"
      open={true}
      onOpenChange={onOpenChange}
      onUpdated={onUpdated}
      {...props}
    />,
  );
  return { onOpenChange, onUpdated };
}

// ===== P18：專案名稱/敘述編輯 =====
describe("EditProjectDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("儲存送出 trimmed 名稱與空字串敘述，關閉對話框並回呼更新", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    const { onOpenChange, onUpdated } = renderDialog();

    fireEvent.change(screen.getByLabelText("專案名稱"), { target: { value: "  新名稱  " } });
    fireEvent.change(screen.getByLabelText("專案敘述"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() => {
      // 後端 patch 語意 null=不變更，清空敘述須送空字串
      expect(api.put).toHaveBeenCalledWith("/projects/p1", { name: "新名稱", description: "" });
      expect(onUpdated).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("名稱為空白時不送 API 並提示錯誤", async () => {
    const { api } = await import("@/lib/api");
    const { toast } = await import("sonner");
    renderDialog();

    fireEvent.change(screen.getByLabelText("專案名稱"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    expect(api.put).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("請輸入專案名稱");
  });

  it("保留名稱時送出未修改的原始值", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/projects/p1", {
        name: "專案一",
        description: "原敘述",
      }),
    );
  });

  it("API 失敗時提示錯誤且不關閉對話框", async () => {
    const { api } = await import("@/lib/api");
    const { toast } = await import("sonner");
    vi.mocked(api.put).mockRejectedValue(new Error("更新失敗"));
    const { onOpenChange, onUpdated } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("更新失敗"));
    expect(onUpdated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
