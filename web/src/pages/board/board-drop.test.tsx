import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ComponentProps } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { BoardDetailResponse } from "@/lib/board-types";
import { BoardPage } from "./BoardPage";

// 攔截 DndContext 捕捉 BoardPage 內部的 onDragEnd，直接以合成事件模擬 drop 目標
// （真實指標拖曳在 jsdom 下所有 rect 為零、碰撞解析不可靠；此處單元測 onDragEnd 語意）
const dndHandlers = vi.hoisted(() => ({
  onDragEnd: null as null | ((event: DragEndEvent) => void),
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndHandlers.onDragEnd = props.onDragEnd ?? null;
      return <actual.DndContext {...props} />;
    },
  };
});
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const boardCard = (id: string, listId: string, title: string, position: string) => ({
  id, listId, title, position, isArchived: false,
  dueAt: null, coverAttachmentId: null, labels: [], members: [],
  checklistDone: 0, checklistTotal: 0, loggedHours: 0, remainingHours: null,
  reviewState: null,
});

const boardFixture: BoardDetailResponse = {
  id: "b1", projectId: "p1", name: "測試看板", description: null, position: "a", isArchived: false,
  lists: [
    {
      id: "l1", name: "待辦", position: "a", isArchived: false,
      cards: [boardCard("c1", "l1", "卡1", "a")],
    },
    {
      id: "l2", name: "進行中", position: "b", isArchived: false,
      cards: [boardCard("c2", "l2", "卡2", "a"), boardCard("c3", "l2", "卡3", "b")],
    },
    {
      id: "l3", name: "已封存列表", position: "c", isArchived: true,
      cards: [boardCard("c4", "l3", "封存卡", "a")],
    },
  ],
};

function renderBoard() {
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
  return qc;
}

beforeEach(() => vi.clearAllMocks());

// ===== P3 Task 5：#21 封存列表 drop toast＋尾端 drop 語意 =====
describe("BoardPage 封存列表 drop（#21）", () => {
  it("drop 至封存列表卡片上 → toast「已封存列表不可接收卡片」且不送出移動", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    renderBoard();
    await screen.findByText("卡1");
    // 模擬 drop 至封存列表 l3 內的卡片 c4 上（over.id 為該卡）
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "c1" }, over: { id: "c4" } } as unknown as DragEndEvent);
    });
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith("已封存列表不可接收卡片");
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe("BoardPage 尾端 drop 語意（#21）", () => {
  it("drop 至列表 body（最末卡下方）→ 卡片 append 至列表尾", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    // PUT 保持 pending：invalidate 後 refetch 會以原看板覆寫 cache，
    // 須於回應前斷言樂觀 append（同 Task 3 建卡樂觀測試模式）
    let resolvePut!: (v: unknown) => void;
    vi.mocked(api.put).mockImplementation(
      () => new Promise((resolve) => { resolvePut = resolve; }),
    );
    const qc = renderBoard();
    await screen.findByText("卡1");
    // over.id 為 `{listId}-body` → 尾端 append
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "c1" }, over: { id: "l2-body" } } as unknown as DragEndEvent);
    });
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/cards/c1/position", { listId: "l2", position: expect.any(String) }));
    // 樂觀 cache：c1 已 append 至 l2 尾（位置在 c3 之後）
    const board = qc.getQueryData<BoardDetailResponse>(["board", "b1"])!;
    const l2 = board.lists.find((l) => l.id === "l2")!;
    expect(l2.cards.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    resolvePut({ data: {} });
  });

  it("每個未封存列表註冊 body drop 區（最末卡之後）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    renderBoard();
    await screen.findByText("卡1");
    // 封存列表（l3）未顯示，未封存的 l1、l2 各註冊一個 body drop 區
    expect(document.querySelectorAll('[data-type="list-body"]')).toHaveLength(2);
  });
});

describe("BoardPage 同列表尾端 body drop（M-3）", () => {
  it("同列表末位卡 drop 至 body → 無位移，不送出冗餘 PUT", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    renderBoard();
    await screen.findByText("卡1");
    // l2 末位卡 c3 drop 至 l2-body：同列表且已末位 → 不送 PUT
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "c3" }, over: { id: "l2-body" } } as unknown as DragEndEvent);
    });
    await act(async () => {});
    expect(api.put).not.toHaveBeenCalled();
  });

  it("同列表非末位卡 drop 至 body → 移至尾端送出 PUT", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/boards/b1") return Promise.resolve({ data: boardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["board.read", "card.edit"] });
      return Promise.resolve({ data: [] });
    });
    renderBoard();
    await screen.findByText("卡1");
    // l2 非末位卡 c2 drop 至 l2-body → append 至尾（c3 之後），送出 PUT
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "c2" }, over: { id: "l2-body" } } as unknown as DragEndEvent);
    });
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/cards/c2/position", { listId: "l2", position: expect.any(String) }));
  });
});
