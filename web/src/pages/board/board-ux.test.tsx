import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DndContext } from "@dnd-kit/core";
import { AxiosError, type AxiosResponse } from "axios";
import { axios400, axiosStatus } from "@/test/http-errors";
import type {
  BoardCardResponse,
  BoardDetailResponse,
  CardResponse,
  ListResponse,
} from "@/lib/board-types";
import { CardDescriptionTab } from "./tabs/CardDescriptionTab";
import { BoardListColumn } from "./BoardListColumn";
import { BoardCard } from "./BoardCard";
import { BoardPage } from "./BoardPage";
import { CardDialog } from "./CardDialog";
import { BoardListTab } from "../project/BoardListTab";
import { setLocale } from "@/i18n";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// CardDialog（深連結測試）之 ItemDetailsTab 以 selector 形式呼叫 useAuth
vi.mock("@/stores/auth", () => ({
  useAuth: (sel?: (s: unknown) => unknown) =>
    sel
      ? sel({ user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } })
      : { user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } },
}));

const cardFixture: CardResponse = {
  id: "c1", listId: "l1", title: "測試卡", description: null, position: "h",
  isArchived: false, dueAt: null, estimatedHours: 8, coverAttachmentId: null,
  createdById: "u1", createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z",
  members: [], labels: [], checklists: [], attachments: [],
  customFields: [], reviews: [], reviewState: null, effort: { logs: [], totalHours: 0 }, mindMapNodes: [],
};

const boardCardFixture: BoardCardResponse = {
  id: "c1", listId: "l1", title: "測試卡", position: "h", isArchived: false,
  dueAt: null, coverAttachmentId: null, labels: [], members: [],
  checklistDone: 0, checklistTotal: 0, loggedHours: 0, remainingHours: null,
  reviewState: null,
};

const listFixture: ListResponse = {
  id: "l1", name: "待辦", position: "a", isArchived: false, cards: [],
};

const boardDetailFixture: BoardDetailResponse = {
  id: "b1", projectId: "p1", name: "測試看板", description: null,
  position: "a", isArchived: false, lists: [],
};

describe("CardDescriptionTab 空描述入口", () => {
  it("空描述空態點擊後進入編輯態", () => {
    render(<CardDescriptionTab card={cardFixture} canEdit onSave={vi.fn()} />);
    fireEvent.click(screen.getByText("尚無描述——點此新增"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存" })).toBeInTheDocument();
  });

  it("無編輯權限時空態不可進入編輯", () => {
    render(<CardDescriptionTab card={cardFixture} canEdit={false} onSave={vi.fn()} />);
    fireEvent.click(screen.getByText("尚無描述"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

/** Radix 下拉在 jsdom 走 click 開啟路徑（同 CopyCardDialog.test.tsx 既有手法）。 */
async function pickOption(trigger: HTMLElement, option: string) {
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  await screen.findAllByRole("option");
  fireEvent.click(screen.getByRole("option", { name: option }));
}

function renderColumn(list: ListResponse, onRename?: (name: string) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const cb = onRename ?? vi.fn();
  const ui = (l: ListResponse) => (
    <QueryClientProvider client={qc}>
      <DndContext>
        <BoardListColumn
          list={l}
          showArchived={false}
          canEdit
          canCreateCard={false}
          canDragList
          canDragCards={false}
          onRename={cb}
          onCopy={vi.fn()}
        />
      </DndContext>
    </QueryClientProvider>
  );
  const result = render(ui(list));
  return { ...result, rerenderColumn: (nextList: ListResponse) => result.rerender(ui(nextList)) };
}

describe("BoardListColumn 列表選單", () => {
  it("封存列表呼叫 PUT isArchived true", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    renderColumn(listFixture);
    fireEvent.pointerDown(screen.getByRole("button", { name: "列表選單" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "封存列表" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/lists/l1", { isArchived: true }));
  });

  it("已封存列表選單顯示取消封存並呼叫 isArchived false", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    renderColumn({ ...listFixture, isArchived: true });
    fireEvent.pointerDown(screen.getByRole("button", { name: "列表選單" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "取消封存" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/lists/l1", { isArchived: false }));
  });

  it("刪除列表需 AlertDialog 確認後才呼叫 DELETE", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    renderColumn(listFixture);
    fireEvent.pointerDown(screen.getByRole("button", { name: "列表選單" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "刪除列表" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/lists/l1"));
  });
});

describe("BoardListColumn 列表改名", () => {
  it("Enter 提交恰一次並退出編輯", async () => {
    const onRename = vi.fn();
    renderColumn(listFixture, onRename);
    const input = screen.getByDisplayValue("待辦");
    // 需真實 focus（設定 document.activeElement）——Enter 處理器以 blur() 委派既有存檔路徑，
    // fireEvent.focus 只派發事件不會真正取得焦點，blur() 將成 no-op
    input.focus();
    fireEvent.change(input, { target: { value: "新名稱" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
    expect(onRename).toHaveBeenCalledWith("l1", "新名稱");
    expect(document.activeElement).not.toBe(input);
  });

  it("Escape 不提交且值還原", () => {
    const onRename = vi.fn();
    renderColumn(listFixture, onRename);
    const input = screen.getByDisplayValue("待辦");
    // 真實 focus：Escape 以 blur() 委派 onBlur 的 cancelNameSave ref 路徑，
    // fireEvent.focus 不設 activeElement 會使 blur() no-op、該路徑不被行使
    input.focus();
    fireEvent.change(input, { target: { value: "不存" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("待辦")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("不存")).not.toBeInTheDocument();
  });

  it("IME 組字中 Enter 不觸發提交", async () => {
    const onRename = vi.fn();
    renderColumn(listFixture, onRename);
    const input = screen.getByDisplayValue("待辦");
    input.focus();
    fireEvent.change(input, { target: { value: "新名稱" } });
    // jsdom 的 KeyboardEvent 建構式不帶 isComposing，以 defineProperty 模擬組字中
    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(imeEnter, "isComposing", { value: true });
    fireEvent(input, imeEnter);
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
    expect(onRename).toHaveBeenCalledWith("l1", "新名稱");
  });

  it("改名提交後外部 list.name 更新能同步進輸入框", async () => {
    const onRename = vi.fn();
    const utils = renderColumn(listFixture, onRename);
    const input = screen.getByDisplayValue("待辦");
    input.focus();
    fireEvent.change(input, { target: { value: "新名稱" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
    utils.rerenderColumn({ ...listFixture, name: "新名稱2" });
    expect(screen.getByDisplayValue("新名稱2")).toBeInTheDocument();
  });
});

describe("CardDescriptionTab 儲存時機", () => {
  it("儲存失敗保留編輯態與文字", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("儲存失敗"));
    render(<CardDescriptionTab card={cardFixture} canEdit onSave={onSave} />);
    fireEvent.click(screen.getByText("尚無描述——點此新增"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "珍貴文字" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ description: "珍貴文字" }));
    expect(screen.getByRole("textbox")).toHaveValue("珍貴文字");
    expect(screen.getByRole("button", { name: "儲存" })).toBeInTheDocument();
  });

  it("儲存成功才退出編輯", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CardDescriptionTab card={cardFixture} canEdit onSave={onSave} />);
    fireEvent.click(screen.getByText("尚無描述——點此新增"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "新描述" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });
});

function renderBoardCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
        <DndContext>
          <Routes>
            <Route path="/projects/p1/boards/b1" element={<BoardCard card={boardCardFixture} />} />
            <Route
              path="/projects/:projectId/boards/:boardId/cards/:cardId"
              element={<div>卡片頁</div>}
            />
          </Routes>
        </DndContext>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BoardCard 鍵盤開啟", () => {
  it("Enter 開啟卡片（同 onClick 目標）", async () => {
    renderBoardCard();
    fireEvent.keyDown(screen.getByRole("button", { name: "測試卡" }), { key: "Enter" });
    expect(await screen.findByText("卡片頁")).toBeInTheDocument();
  });

  it("Space 開啟卡片", async () => {
    renderBoardCard();
    fireEvent.keyDown(screen.getByRole("button", { name: "測試卡" }), { key: " " });
    expect(await screen.findByText("卡片頁")).toBeInTheDocument();
  });
});

// 徽章文字取自 common:state.*——與 ReportTab 的 reviewLabel 同一組 key，
// 也就是語系檔的實際值：通過／退回（不是「已通過」「已退回」，那兩個字串不存在）。
describe("BoardCard 的審查狀態徽章", () => {
  function renderCardWithReviewState(reviewState: BoardCardResponse["reviewState"]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <DndContext>
            <BoardCard card={{ ...boardCardFixture, reviewState }} />
          </DndContext>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("reviewState 為 null 時不顯示任何審查狀態徽章", () => {
    renderCardWithReviewState(null);
    expect(screen.queryByText("待審查")).not.toBeInTheDocument();
    expect(screen.queryByText("通過")).not.toBeInTheDocument();
    expect(screen.queryByText("退回")).not.toBeInTheDocument();
  });

  it.each<[BoardCardResponse["reviewState"], string]>([
    ["pending", "待審查"],
    ["approved", "通過"],
    ["rejected", "退回"],
  ])("reviewState=%s 時顯示 %s", (state, label) => {
    renderCardWithReviewState(state);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("BoardListTab 看板卡鍵盤開啟", () => {
  it("Enter 開啟看板（同 onClick 目標）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) =>
      url === "/projects/p1/boards"
        ? Promise.resolve({
            data: [{ id: "b1", projectId: "p1", name: "測試看板", description: null, position: "a", isArchived: false }],
          })
        : Promise.resolve({ data: [] }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1"]}>
          <Routes>
            <Route
              path="/projects/p1"
              element={<BoardListTab projectId="p1" canCreateBoard={false} canReadBoard />}
            />
            <Route path="/projects/:projectId/boards/:boardId" element={<div>看板頁</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(await screen.findByRole("button", { name: /測試看板/ }), { key: "Enter" });
    expect(await screen.findByText("看板頁")).toBeInTheDocument();
  });
});

describe("BoardListColumn 建卡（#12）", () => {
  function renderCreateColumn() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["board", "b1"], { ...boardDetailFixture, lists: [listFixture] });
    render(
      <QueryClientProvider client={qc}>
        <DndContext>
          <BoardListColumn
            list={listFixture}
            showArchived={false}
            canEdit
            canCreateCard
            canDragList
            canDragCards={false}
            onRename={vi.fn()}
            onCopy={vi.fn()}
          />
        </DndContext>
      </QueryClientProvider>,
    );
    return qc;
  }

  it("POST 回應前卡片已樂觀插入 board cache，失敗回滾消失＋toast", async () => {
    const { api } = await import("@/lib/api");
    let rejectPost!: (e: unknown) => void;
    vi.mocked(api.post).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectPost = reject; }),
    );
    const qc = renderCreateColumn();
    const input = screen.getByPlaceholderText("新增卡片…");
    fireEvent.change(input, { target: { value: "新卡" } });
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    // POST 尚未回應，board cache 已出現新卡
    await waitFor(() => {
      const board = qc.getQueryData<BoardDetailResponse>(["board", "b1"])!;
      expect(board.lists[0].cards).toHaveLength(1);
      expect(board.lists[0].cards[0].title).toBe("新卡");
    });
    // `card.titleRequired` 是建卡端點真的會回的錯誤碼；`message` 故意與譯文不同，
    // 才能分辨「顯示譯文」與「顯示伺服器原文／傳輸層字串」。
    rejectPost(axios400({ code: "card.titleRequired", message: "SERVER-RAW" }));
    await waitFor(() =>
      expect(qc.getQueryData<BoardDetailResponse>(["board", "b1"])!.lists[0].cards).toHaveLength(0));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("卡片標題不可為空"));
  });

  it("Enter 新增恰一次、Escape 清空、成功後焦點回輸入框", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.post).mockResolvedValue({ data: boardCardFixture });
    renderCreateColumn();
    const input = screen.getByPlaceholderText("新增卡片…");
    input.focus();
    fireEvent.change(input, { target: { value: "新卡" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // pending 期間重複 Enter 不重送
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/lists/l1/cards", { title: "新卡" });
    // 成功後焦點回輸入框
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Escape 清空不送出
    fireEvent.change(input, { target: { value: "不存" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByPlaceholderText("新增卡片…")).toHaveValue("");
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

describe("BoardPage 建卡樂觀 DOM（#12）", () => {
  it("POST 回應前樂觀卡即出現於列表尾 DOM", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1")
        return Promise.resolve({ data: { ...boardDetailFixture, lists: [{ ...listFixture, cards: [] }] } });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "card.create"] });
      return Promise.resolve({ data: [] });
    });
    let resolvePost!: (v: unknown) => void;
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolvePost = resolve; }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const input = await screen.findByPlaceholderText("新增卡片…");
    fireEvent.change(input, { target: { value: "新卡" } });
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    // POST 尚未回應——樂觀卡已由 board cache 流到列表尾 DOM（BoardPage 以 board.data.lists 渲染）
    expect(await screen.findByText("新卡")).toBeInTheDocument();
    resolvePost({ data: boardCardFixture });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });
});

describe("BoardPage 複製看板", () => {
  it("點擊複製看板呼叫 POST copy、toast 並 invalidate board", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.create"] });
      // 複製對話框的目標專案下拉：少了這一筆，選中的專案不在可見選項裡 ⇒ 確認鈕停用
      if (url === "/projects")
        return Promise.resolve({ data: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }] });
      // 目標專案（p2）也要有 board.create——換過去之後確認鈕才不會停用
      if (url === "/projects/p2/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.create"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockResolvedValue({ data: { ...boardDetailFixture, id: "b2" } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "複製看板" }));
    // 二次確認：僅開啟對話框，尚未確認前不得送出複製請求
    expect(await screen.findByText("確定要複製看板嗎？")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    // 目標刻意選成**別的專案**：選成來源專案時，「失效目標」與「失效來源」是同一個 id，
    // 這一支就分不出那兩種實作（清單複製那一支同理）。
    const dialog = screen.getByTestId("copy-board-dialog");
    await pickOption(within(dialog).getByLabelText("目標專案"), "P2");
    const confirm = within(dialog).getByRole("button", { name: "確定複製" });
    // 目標專案／權限兩支查詢回來前確認鈕是停用的（D7）：不等它啟用就點，點到的是個 no-op
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/boards/b1/copy?locale=zh-TW", {
        targetProjectId: "p2",
        name: "",
      }),
    );
    // 副本落在**目標**專案：失效打在那裡，來源端不動（來源沒有任何一列被改到）
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["boards", "p2"] }),
      ),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["project-cards", "p2"] }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["project-cards", "p1"] }),
    );
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith("看板已複製");
  });

  it("對話框取消則不發出複製請求", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.create"] });
      // 複製對話框的目標專案下拉：少了這一筆，選中的專案不在可見選項裡 ⇒ 確認鈕停用
      if (url === "/projects")
        return Promise.resolve({ data: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }] });
      // 目標專案（p2）也要有 board.create——換過去之後確認鈕才不會停用
      if (url === "/projects/p2/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.create"] });
      return Promise.resolve({ data: [] });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "複製看板" }));
    expect(await screen.findByText("確定要複製看板嗎？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("確定要複製看板嗎？")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  // 語系是**寫入時**的性質：後端拿 `?locale=` 決定複製出來的名稱後綴（`原板（副本）` /
  // `Original (copy)`），存進去之後切語系不會回頭改。所以送出的必須是**當下**語系。
  //
  // 這一支必須以 en 執行：在測試語系（zh-TW）下斷言，分不出「有把當下語系送出去」與「寫死 zh-TW」
  // 這兩種實作——P-C Followups 的匯出 locale 踩過同一個形狀（當時補的正是 setLocale("en")）。
  it("複製看板送出的 locale 是當下語系，不是寫死的 zh-TW", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.create"] });
      // 複製對話框的目標專案下拉：少了這一筆，選中的專案不在可見選項裡 ⇒ 確認鈕停用
      if (url === "/projects")
        return Promise.resolve({ data: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }] });
      // 目標專案（p2）也要有 board.create——換過去之後確認鈕才不會停用
      if (url === "/projects/p2/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.create"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockResolvedValue({ data: { ...boardDetailFixture, id: "b2" } });
    await act(async () => {
      await setLocale("en");
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy board" }));
    const confirm = await screen.findByRole("button", { name: "Copy" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/boards/b1/copy?locale=en", {
        targetProjectId: "p1",
        name: "",
      }),
    );
  });
});

describe("BoardPage 複製清單", () => {
  // 清單複製的落點是**目標**看板：body 帶 `targetBoardId`，失效打在目標側。
  // 這裡的目標刻意跨到 p2/b2——選成清單現址時，「失效來源」與「失效目標」是同一個 id，
  // 紅燈分不出那兩種實作（同檔的看板複製那一支同理）。
  it("選單入口開啟對話框、送出目標看板並失效目標側", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1")
        return Promise.resolve({ data: { ...boardDetailFixture, lists: [listFixture] } });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "card.create"] });
      if (url === "/projects")
        return Promise.resolve({ data: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }] });
      if (url === "/projects/p1/boards")
        return Promise.resolve({ data: [{ id: "b1", name: "B1", isArchived: false }] });
      if (url === "/projects/p2/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit"] });
      if (url === "/projects/p2/boards")
        return Promise.resolve({ data: [{ id: "b2", name: "B2", isArchived: false }] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockResolvedValue({ data: { ...listFixture, id: "l2" } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.pointerDown(await screen.findByRole("button", { name: "列表選單" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "複製列表" }));

    const dialog = await screen.findByTestId("copy-list-dialog");
    await pickOption(within(dialog).getByLabelText("目標專案"), "P2");
    await pickOption(within(dialog).getByLabelText("目標看板"), "B2");
    const confirm = within(dialog).getByRole("button", { name: "確定複製" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/lists/l1/copy?locale=zh-TW", { targetBoardId: "b2" }),
    );
    // 副本落在目標看板：`["board", id]` 只有帶著那個 id 才會命中
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["board", "b2"] }),
      ),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["project-cards", "p2"] }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["board", "b1"] }),
    );
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith("列表已複製");
  });

  // 失敗路徑：訊息的優先序是「錯誤碼的譯文 → 伺服器原文 → 呼叫端的 fallback」。
  // fixture 用 `axios400`——它的 `message` 是**傳輸層字串**、伺服器說的話在 `response.data`，
  // 且 body 的 message 刻意與譯文不同；拿裸 `new Error(...)` 當 fixture 的話，
  // 「走 apiErrorMessage」與「直接讀 error.message」這兩種實作顯示同一個字串、測試恆綠
  // （見 `@/test/http-errors` 的檔頭）。
  it("複製清單失敗時顯示錯誤碼的譯文，不是傳輸層字串", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1")
        return Promise.resolve({ data: { ...boardDetailFixture, lists: [listFixture] } });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "card.create"] });
      if (url === "/projects")
        return Promise.resolve({ data: [{ id: "p1", name: "P1" }] });
      if (url === "/projects/p1/boards")
        return Promise.resolve({ data: [{ id: "b1", name: "B1", isArchived: false }] });
      return Promise.resolve({ data: [] });
    });
    // 目標看板在對話框開著的時候被刪掉——後端回 board.notFound 的 404
    // （`apiErrorMessage` 不看 status ⇒ 判別力不受影響，但情境要對得上：
    //  這條路徑真正的形狀是 `ApiResults.NotFound` 的 404，不是 400。）
    vi.mocked(api.post).mockRejectedValue(
      axiosStatus(404, { code: "board.notFound", message: "SERVER-RAW" }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.pointerDown(await screen.findByRole("button", { name: "列表選單" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "複製列表" }));

    const dialog = await screen.findByTestId("copy-list-dialog");
    const confirm = within(dialog).getByRole("button", { name: "確定複製" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("找不到這個看板，可能已被刪除"));
  });
});

function axios403(): AxiosError {
  return new AxiosError(
    "Request failed with status code 403",
    undefined,
    undefined,
    undefined,
    {
      status: 403,
      statusText: "Forbidden",
      data: null,
      headers: {},
      config: { headers: undefined },
    } as unknown as AxiosResponse,
  );
}

// P-C 之後的錯誤 body：{ code, message }。用真的 AxiosError 帶 response，
// 與 axios 在 400 時實際丟出來的形狀一致。
describe("BoardPage 403 與卡片深連結（#15/#18）", () => {
  function renderBoardRoutes(initial: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />}>
              <Route path="cards/:cardId" element={<CardDialog />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("看板 403 顯示中文權限訊息而非 axios 原文", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.reject(axios403());
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read"] });
      return Promise.resolve({ data: [] });
    });
    renderBoardRoutes("/projects/p1/boards/b1");
    expect(await screen.findByText("你沒有此看板的權限")).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code 403/)).not.toBeInTheDocument();
  });

  it("看板載入失敗顯示重試鈕，點擊後重載成功", async () => {
    const { api } = await import("@/lib/api");
    let fail = true;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") {
        return fail
          ? Promise.reject(new Error("Request failed with status code 500"))
          : Promise.resolve({ data: { ...boardDetailFixture, lists: [listFixture] } });
      }
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    renderBoardRoutes("/projects/p1/boards/b1");
    expect(await screen.findByText(/載入失敗/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(await screen.findByText("待辦")).toBeInTheDocument();
  });

  it("board 403 時深連結卡片路由仍掛載（Outlet）並顯示自身中文錯誤", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.reject(axios403());
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read"] });
      if (url === "/cards/c1")
        return Promise.reject(new Error("Request failed with status code 403"));
      return Promise.resolve({ data: [] });
    });
    renderBoardRoutes("/projects/p1/boards/b1/cards/c1");
    // BoardPage error 狀態仍渲染 Outlet → CardDialog 掛載並顯示自身中文錯誤
    expect(await screen.findByText("你沒有此看板的權限")).toBeInTheDocument();
    expect(
      await screen.findByText("無法載入卡片資料，可能已不存在或無權限。"),
    ).toBeInTheDocument();
  });
});

beforeEach(() => vi.clearAllMocks());

describe("BoardPage 載入骨架（#26）", () => {
  it("看板載入中渲染 Skeleton，載入後渲染列表", async () => {
    const { api } = await import("@/lib/api");
    let resolveBoard!: (v: unknown) => void;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1")
        return new Promise((resolve) => { resolveBoard = resolve; });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("board-skeleton")).toBeInTheDocument();
    resolveBoard({ data: { ...boardDetailFixture, lists: [{ ...listFixture, name: "待辦" }] } });
    expect(await screen.findByText("待辦")).toBeInTheDocument();
    expect(screen.queryByTestId("board-skeleton")).not.toBeInTheDocument();
  });
});

describe("BoardPage 看板資訊編輯與刪除", () => {
  it("點選編輯看板按鈕開啟 EditBoardDialog 並成功 PUT 更新", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.delete"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: { ...boardDetailFixture, name: "已改名看板" } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("測試看板")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "編輯看板名稱與描述" }));

    expect(screen.getByText("編輯看板資訊")).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/看板名稱/);
    fireEvent.change(nameInput, { target: { value: "已改名看板" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/boards/b1", {
        name: "已改名看板",
        description: null,
      });
    });
  });

  it("看板設定選單中點選刪除看板，確認後呼叫 DELETE 並跳轉", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.delete"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
            <Route path="/projects/:projectId" element={<div>專案首頁</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("測試看板")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: /看板設定/ }));

    const deleteItem = await screen.findByRole("menuitem", { name: /刪除看板/ });
    fireEvent.click(deleteItem);

    expect(await screen.findByText("確定要刪除看板嗎？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "確定刪除" }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("/boards/b1");
    });
    expect(await screen.findByText("專案首頁")).toBeInTheDocument();
  });

  // 崩潰類回歸。錯誤 body 自 P-C 起是 { code, message } 物件，而 sonner 的
  // toast.error 收 ReactNode——把整個 body 傳進去 tsc 不會紅，React 直到渲染才拋
  // 「Objects are not valid as a React child」（全站無 ErrorBoundary，直接白畫面）。
  // 兩支都寫兩層斷言：字串斷言驗「譯文有沒有接上」，typeof 斷言驗「傳進去的是不是
  // 字串」——後者才擋得住「換成另一個物件」與「換錯譯文」兩種改法。
  it("編輯看板失敗時 toast 收到譯文字串而非回應 body 物件", async () => {
    const { api } = await import("@/lib/api");
    const { toast } = await import("sonner");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.delete"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockRejectedValue(
      axios400({ code: "board.nameRequired", message: "看板名稱不可為空" }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("測試看板")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "編輯看板名稱與描述" }));
    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("看板名稱不可為空"));
    expect(typeof vi.mocked(toast.error).mock.calls[0][0]).toBe("string");
  });

  it("刪除看板失敗時 toast 收到譯文字串而非回應 body 物件", async () => {
    const { api } = await import("@/lib/api");
    const { toast } = await import("sonner");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardDetailFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "board.edit", "board.delete"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.delete).mockRejectedValue(
      axios400({ code: "board.nameRequired", message: "看板名稱不可為空" }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />} />
            <Route path="/projects/:projectId" element={<div>專案首頁</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("測試看板")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: /看板設定/ }));

    const deleteItem = await screen.findByRole("menuitem", { name: /刪除看板/ });
    fireEvent.click(deleteItem);
    expect(await screen.findByText("確定要刪除看板嗎？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "確定刪除" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("看板名稱不可為空"));
    expect(typeof vi.mocked(toast.error).mock.calls[0][0]).toBe("string");
  });
});

// 同 TableTab.test.tsx 的那一條。BoardCard 的完成鈕是 div[role="checkbox"]，同樣沒有
// 可見文字，名稱來自 title。這條字串與表格視圖的那條**不是同一個 key**：它多帶一個
// X 快捷鍵提示，而那是該快捷鍵唯一的說明處（快捷鍵手冊沒有列它，BoardCard.tsx 的
// keydown 處理器是真的——按 X 會切換完成狀態）。
describe("BoardCard 完成鈕的無障礙名稱跟著語系走", () => {
  it("切到 en 後帶著快捷鍵提示", async () => {
    await act(async () => { await setLocale("en"); });
    renderBoardCard();
    expect(screen.getByTitle("Mark as complete (shortcut X)")).toBeInTheDocument();
  });
});

