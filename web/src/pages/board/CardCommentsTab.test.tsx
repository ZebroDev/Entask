// 「留言」分頁（`CardCommentsTab`）的測試。
//
// 2026-09-21 自單一檔的 CardDialog.test.tsx 按分頁拆出（見
// `.superpowers/sdd/2026-09-21-entask-carddialog-test-split/progress.md`）。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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

describe("留言/審查 Enter 與 isPending（#14）", () => {
  it("留言 input Enter 送出恰一次，提交中按鈕 disabled", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url.includes("/activity"))
        return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    let resolvePost!: (v: unknown) => void;
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolvePost = resolve; }),
    );
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "留言" }));
    fireEvent.click(screen.getByRole("tab", { name: "留言" }));
    const input = await screen.findByPlaceholderText("寫下留言…");
    fireEvent.change(input, { target: { value: "哈囉" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // pending 期間重複 Enter 不重送
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/cards/c1/comments", { text: "哈囉" });
    await waitFor(() => expect(screen.getByRole("button", { name: "送出" })).toBeDisabled());
    resolvePost({ data: {} });
    // 成功後清空輸入（按鈕因空輸入回復 disabled 為既有語義）
    await waitFor(() => expect(screen.getByPlaceholderText("寫下留言…")).toHaveValue(""));
  });

  it("有 card.comment 而無 card.edit 的使用者（測試工程師）仍看得到留言輸入框", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.read", "card.comment"] });
      if (url.includes("/activity"))
        return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "留言" }));
    fireEvent.click(screen.getByRole("tab", { name: "留言" }));
    expect(await screen.findByPlaceholderText("寫下留言…")).toBeInTheDocument();
  });

  it("既無 card.comment 也無 card.edit 時不顯示留言輸入框", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.read", "card.review"] });
      if (url.includes("/activity"))
        return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "留言" }));
    fireEvent.click(screen.getByRole("tab", { name: "留言" }));
    await screen.findByRole("tab", { name: "留言" });
    expect(screen.queryByPlaceholderText("寫下留言…")).not.toBeInTheDocument();
  });

  // 錯誤路徑收斂（2026-09-19）：`comment.bodyRequired` 是這個端點真的會回的錯誤碼
  // （`POST /api/cards/{cardId}/comments`），body 的 `message` 刻意與譯文不同。
  it("留言送出失敗（後端回錯誤碼）時顯示譯文，不是傳輸層字串", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url.includes("/activity"))
        return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockRejectedValue(
      axios400({ code: "comment.bodyRequired", message: "SERVER-RAW" }),
    );
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "留言" }));
    fireEvent.click(screen.getByRole("tab", { name: "留言" }));
    const input = await screen.findByPlaceholderText("寫下留言…");
    fireEvent.change(input, { target: { value: "哈囉" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("留言不可為空"));
  });
});

// 分頁（`state/45`）：留言牆與活動牆共用同一個端點，第二頁同樣以 `cursor=` 續接。
describe("留言分頁", () => {
  it("載入更多以 cursor 打第二趟，留言接在後面", async () => {
    const { api } = await getApi();
    const cursor = "2026-01-01T00:00:00.0000000Z|3f2a1b4c-0000-0000-0000-000000000000";
    const comment = (id: string, text: string, createdAt: string) => ({
      id, cardId: "c1", userId: "u1", username: "admin", displayName: "admin",
      type: "comment", text, detail: null, createdAt,
    });
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/cards/c1/activity?filter=comments_only")
        return Promise.resolve({ data: { items: [comment("a1", "第一頁留言", "2026-08-15T00:00:00Z")], nextCursor: cursor } });
      if (url === `/cards/c1/activity?filter=comments_only&cursor=${encodeURIComponent(cursor)}`)
        return Promise.resolve({ data: { items: [comment("a2", "第二頁留言", "2026-08-14T00:00:00Z")], nextCursor: null } });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      // 未知的**活動** URL 回空頁（理由同 CardActivityTab.test.tsx 的同一段）：
      // 非活動 URL 仍回空陣列——`/projects/p1/members` 的 `.map` 在 CardDialog 的預設
      // 分頁上，回一個物件會讓整個 dialog 在 render 時炸掉。
      if (url.includes("/activity")) return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "留言" }));
    fireEvent.click(screen.getByRole("tab", { name: "留言" }));

    expect(await screen.findByText("第一頁留言")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "載入更多" }));

    expect(await screen.findByText("第二頁留言")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(
      `/cards/c1/activity?filter=comments_only&cursor=${encodeURIComponent(cursor)}`,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "載入更多" })).toBeNull(),
    );
  });
});
