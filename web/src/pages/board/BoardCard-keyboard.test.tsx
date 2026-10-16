import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BoardCardResponse } from "@/lib/board-types";
import { api } from "@/lib/api";
import { BoardCard } from "./BoardCard";

// mock useSortable 提供受控 listeners，以斷言「鍵盤開啟」與「鍵盤拖曳 handoff」的呼叫互斥
const { listeners } = vi.hoisted(() => ({ listeners: { onKeyDown: vi.fn() } }));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    setNodeRef: () => {},
    attributes: { role: "button", tabIndex: 0 },
    listeners,
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const boardCardFixture: BoardCardResponse = {
  id: "c1", listId: "l1", title: "測試卡", position: "h", isArchived: false,
  dueAt: null, coverAttachmentId: null, labels: [], members: [],
  checklistDone: 0, checklistTotal: 0, loggedHours: 0, remainingHours: null,
  reviewState: null,
};

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
        <Routes>
          <Route path="/projects/p1/boards/b1" element={<BoardCard card={boardCardFixture} />} />
          <Route
            path="/projects/:projectId/boards/:boardId/cards/:cardId"
            element={<div>卡片頁</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BoardCard 鍵盤開啟與鍵盤拖曳並存", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Enter 單按開啟卡片且不轉交 dnd", async () => {
    renderCard();
    fireEvent.keyDown(screen.getByRole("button", { name: "測試卡" }), { key: "Enter" });
    expect(await screen.findByText("卡片頁")).toBeInTheDocument();
    expect(listeners.onKeyDown).not.toHaveBeenCalled();
  });

  it("Shift+Enter 轉交 dnd 鍵盤拖曳且不開啟卡片", () => {
    renderCard();
    fireEvent.keyDown(screen.getByRole("button", { name: "測試卡" }), { key: "Enter", shiftKey: true });
    expect(listeners.onKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("卡片頁")).not.toBeInTheDocument();
  });

  it("點擊完成 checkbox 呼叫 completion API 且阻止事件冒泡開卡", async () => {
    (api.put as any).mockResolvedValueOnce({ data: {} });
    renderCard();
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/c1/completion", { isCompleted: true });
    });
    expect(screen.queryByText("卡片頁")).not.toBeInTheDocument();
  });

  it("已完成卡片點擊 checkbox 標記為未完成", async () => {
    (api.put as any).mockResolvedValueOnce({ data: {} });
    const completedFixture: BoardCardResponse = {
      ...boardCardFixture,
      completedAt: "2026-09-01T00:00:00Z",
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <BoardCard card={completedFixture} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/c1/completion", { isCompleted: false });
    });
  });

  it("標籤背景對比色動態切換：淺色字深、深色字淺", async () => {
    (api.get as any).mockImplementation((url: string) => {
      if (url.includes("/labels")) {
        return Promise.resolve({
          data: [
            { id: "lbl-light", name: "淺色標籤", color: "#FFFF00", position: "a" },
            { id: "lbl-dark", name: "深色標籤", color: "#000000", position: "b" },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const labeledCard: BoardCardResponse = {
      ...boardCardFixture,
      labels: ["lbl-light", "lbl-dark"],
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId" element={<BoardCard card={labeledCard} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const lightLabel = await screen.findByText("淺色標籤");
    const darkLabel = await screen.findByText("深色標籤");
    expect(lightLabel).toHaveClass("text-gray-900");
    expect(darkLabel).toHaveClass("text-white");
  });

  it("已完成卡片僅 checkbox 顯示打勾，底部狀態列不重複顯示 check 圖示", () => {
    const completedFixture: BoardCardResponse = {
      ...boardCardFixture,
      completedAt: "2026-09-01T00:00:00Z",
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1"]}>
          <BoardCard card={completedFixture} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const checkSvgs = container.querySelectorAll("svg.lucide-check");
    expect(checkSvgs.length).toBe(1);
  });
});

