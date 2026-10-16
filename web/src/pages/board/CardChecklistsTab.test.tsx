// 「檢查清單」分頁（`CardChecklistsTab`）的測試。
//
// 2026-09-21 自單一檔的 CardDialog.test.tsx 按分頁拆出（見
// `.superpowers/sdd/2026-09-21-entask-carddialog-test-split/progress.md`）。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { BoardDetailResponse, CardResponse } from "@/lib/board-types";
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

const cardWithChecklists: CardResponse = {
  ...cardFixture,
  checklists: [
    { id: "cl1", title: "清單", position: "a", items: [{ id: "it1", text: "項目", isChecked: false, position: "a" }] },
  ],
};

const boardWithCard: BoardDetailResponse = {
  id: "b1", projectId: "p1", name: "測試看板", description: null, position: "a", isArchived: false,
  lists: [{
    id: "l1", name: "待辦", position: "a", isArchived: false,
    cards: [{
      id: "c1", listId: "l1", title: "測試卡", position: "h", isArchived: false,
      dueAt: null, coverAttachmentId: null, labels: [], members: [],
      checklistDone: 0, checklistTotal: 1, loggedHours: 0, remainingHours: null,
      reviewState: null,
    }],
  }],
};

describe("checklist 樂觀（#11）", () => {
  async function renderChecklistsTab(qc: QueryClient) {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithChecklists });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "檢查清單" }));
    fireEvent.click(screen.getByRole("tab", { name: "檢查清單" }));
    return api;
  }

  it("toggle 後 checkbox 立即翻動（PUT 回應前）；PUT 失敗回滾＋toast", async () => {
    const api = await renderChecklistsTab(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    let rejectPut!: (e: unknown) => void;
    vi.mocked(api.put).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectPut = reject; }),
    );
    const checkbox = (await screen.findAllByRole("checkbox"))[1];
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    // 樂觀：PUT 尚未回應 checkbox 已翻動
    await waitFor(() => expect(screen.getAllByRole("checkbox")[1]).toBeChecked());
    // `checklistItem.textRequired` 是這個端點真的會回的錯誤碼（項目文字不可為空）。
    rejectPut(axios400({ code: "checklistItem.textRequired", message: "SERVER-RAW" }));
    // 失敗回滾
    await waitFor(() => expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked());
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("項目文字不可為空"));
  });

  it("toggle 成功後 board cache 該卡 checklistDone 計數已 patch", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["board", "b1"], boardWithCard);
    const api = await renderChecklistsTab(qc);
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    fireEvent.click((await screen.findAllByRole("checkbox"))[1]);
    await waitFor(() => {
      const board = qc.getQueryData<BoardDetailResponse>(["board", "b1"])!;
      expect(board.lists[0].cards[0].checklistDone).toBe(1);
      expect(board.lists[0].cards[0].checklistTotal).toBe(1);
    });
  });

  // `checklist.titleRequired` 是建立端點真的會回的錯誤碼（`ChecklistEndpoints.cs:21`）。
  it("新增檢查清單失敗（後端回錯誤碼）時顯示譯文，不是傳輸層字串", async () => {
    const api = await renderChecklistsTab(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    vi.mocked(api.post).mockRejectedValue(
      axios400({ code: "checklist.titleRequired", message: "SERVER-RAW" }),
    );
    const input = await screen.findByPlaceholderText("新檢查清單名稱");
    fireEvent.change(input, { target: { value: "待辦" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("檢查清單名稱不可為空"));
  });
});

describe("靜默失敗 toast（#13）", () => {
  it("checklist 刪除失敗出現 toast", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithChecklists });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    // 刪除路徑的錯誤有碼：404 帶 `ErrorCodes.CardNotFound`（`CardEndpoints` 的 DELETE
    // 守衛）、403 帶篩選器的 `permission.denied`
    // （`Authorization/RequireProjectPermissionAttribute.cs`）——這裡用一個帶錯誤碼的
    // 400 當代表——本測試的主體是**顯示路徑**，不是後端的驗證分支。
    vi.mocked(api.delete).mockRejectedValue(
      axios400({ code: "concurrency.conflict", message: "SERVER-RAW" }),
    );
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "檢查清單" }));
    fireEvent.click(screen.getByRole("tab", { name: "檢查清單" }));
    // 確認對話框（#20）：觸發 → dialog → 確認才呼叫 DELETE
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("並發更新衝突，請重試"));
  });
});

describe("進度條 a11y（#27）", () => {
  it("CardChecklistsTab 檢查清單進度條 role=progressbar＋aria-valuenow", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithChecklists });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "檢查清單" }));
    fireEvent.click(screen.getByRole("tab", { name: "檢查清單" }));
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("checklist item 刪除/改名/重排（P20）", () => {
  const cardWithThreeItems: CardResponse = {
    ...cardFixture,
    checklists: [
      { id: "cl1", title: "清單", position: "a", items: [
        { id: "it1", text: "項目一", isChecked: false, position: "a" },
        { id: "it2", text: "項目二", isChecked: false, position: "m" },
        { id: "it3", text: "項目三", isChecked: false, position: "z" },
      ] },
    ],
  };

  async function renderItemsTab() {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithThreeItems });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "檢查清單" }));
    fireEvent.click(screen.getByRole("tab", { name: "檢查清單" }));
    await screen.findByText("項目一");
    return api;
  }

  it("刪除 item：觸發確認框，確認後呼叫 DELETE", async () => {
    const api = await renderItemsTab();
    fireEvent.click(screen.getByRole("button", { name: "刪除項目二" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/cards/c1/checklists/cl1/items/it2"),
    );
  });

  it("改名 item：點文字出現輸入框，blur 送出 PUT text", async () => {
    const api = await renderItemsTab();
    fireEvent.click(screen.getByText("項目一"));
    const input = await screen.findByDisplayValue("項目一");
    fireEvent.change(input, { target: { value: "項目一改" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/cards/c1/checklists/cl1/items/it1", { text: "項目一改" }),
    );
  });

  it("重排 item：新 position 必須越過鄰項，首末項按鈕 disabled", async () => {
    const api = await renderItemsTab();
    expect(screen.getByRole("button", { name: "上移項目一" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移項目三" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "上移項目二" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    // 關鍵語意：上移必須排到「原第一項（a）之前」；若只夾在 a 與 m 之間，等於原位不動
    const upArgs = vi.mocked(api.put).mock.calls[0]![1] as { position: string };
    expect(upArgs.position < "a").toBe(true);
    expect(upArgs.position).toBe("I");

    fireEvent.click(screen.getByRole("button", { name: "下移項目二" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    // 對稱：下移必須排到「原末項（z）之後」
    const downArgs = vi.mocked(api.put).mock.calls[1]![1] as { position: string };
    expect(downArgs.position > "z").toBe(true);
    expect(downArgs.position).toBe("zU");
  });

  it("改名：文字未變更時不送 PUT", async () => {
    const api = await renderItemsTab();
    fireEvent.click(screen.getByText("項目一"));
    const input = await screen.findByDisplayValue("項目一");
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByDisplayValue("項目一")).toBeNull());
    expect(api.put).not.toHaveBeenCalled();
  });

  it("改名：Escape 取消不儲存", async () => {
    const api = await renderItemsTab();
    fireEvent.click(screen.getByText("項目一"));
    const input = await screen.findByDisplayValue("項目一");
    fireEvent.change(input, { target: { value: "被取消的名字" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText("項目一")).toBeInTheDocument());
    expect(api.put).not.toHaveBeenCalled();
  });
});
