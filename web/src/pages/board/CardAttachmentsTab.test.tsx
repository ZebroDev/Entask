// 「附件」分頁（`CardAttachmentsTab`）的測試。
//
// 2026-09-21 自單一檔的 CardDialog.test.tsx 按分頁拆出（見
// `.superpowers/sdd/2026-09-21-entask-carddialog-test-split/progress.md`）。
// 只有一支（靜默失敗 toast）；其餘附件行為由後端測試與手動驗收涵蓋。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { CardResponse } from "@/lib/board-types";
import { axios400 } from "@/test/http-errors";
import { cardFixture, getApi, renderDialog } from "./card-dialog-test-utils";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// ItemDetailsTab 以 zustand selector 形式呼叫 useAuth((s) => s.user?.userId)——
// mock 須支援 selector 引數，selector 形式回傳 "u1"（真實 AuthUser 欄位為 userId）
vi.mock("@/stores/auth", () => ({
  useAuth: (sel?: (s: unknown) => unknown) =>
    sel
      ? sel({ user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } })
      : { user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } },
}));

beforeEach(() => vi.clearAllMocks());

const cardWithAttachment: CardResponse = {
  ...cardFixture,
  attachments: [{ id: "a1", fileName: "photo.png", contentType: "image/png", size: 10, createdAt: "2026-08-15T00:00:00Z" }],
};

describe("靜默失敗 toast（#13）", () => {
  it("附件刪除失敗出現 toast", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithAttachment });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    // 同上一支：刪除路徑的錯誤有碼（見上），這裡用一個帶錯誤碼的 400 當代表。
    vi.mocked(api.delete).mockRejectedValue(
      axios400({ code: "request.invalid", message: "SERVER-RAW" }),
    );
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "附件" }));
    fireEvent.click(screen.getByRole("tab", { name: "附件" }));
    // 確認對話框（#20）：觸發 → dialog → 確認才呼叫 DELETE
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("請求內容不正確"));
  });
});
