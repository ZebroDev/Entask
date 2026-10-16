import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ComponentType, type ReactNode, lazy } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import { BoardPage } from "./BoardPage";
import { useAuth } from "@/stores/auth";
import type { BoardDetailResponse } from "@/lib/board-types";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// 預取是效能最佳化、不是正確性。這裡只斷言「看板掛載時要求了它」；
// 至於它內部走 requestIdleCallback 還是 setTimeout 不是契約，不該被斷言釘住。
vi.mock("@/lib/lazy-route", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lazy-route")>("@/lib/lazy-route");
  return { ...actual, prefetchCardDialog: vi.fn() };
});

const boardFixture: BoardDetailResponse = {
  id: "b1",
  projectId: "p1",
  name: "測試看板",
  description: null,
  position: "a",
  isArchived: false,
  lists: [{ id: "l1", name: "待辦清單", position: "a", isArchived: false, cards: [] }],
};

// 永不解析的 lazy：模擬「第一次走到這條路由，chunk 還沒下載完」。
const NeverResolves = lazy(() => new Promise<{ default: ComponentType }>(() => {}));

function renderBoard(children?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/p1/boards/b1/cards/c1"]}>
        <Routes>
          <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />}>
            <Route path="cards/:cardId" element={children ?? <div>卡片對話框</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  useAuth.setState({
    user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false },
    tokens: null,
    teamId: "t1",
  });
  const { api } = await import("@/lib/api");
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/boards/b1") return Promise.resolve({ data: boardFixture });
    if (url === "/projects/p1/permissions/mine")
      return Promise.resolve({ data: ["board.read", "board.edit"] });
    return Promise.resolve({ data: [] });
  });
});

describe("BoardPage 的 lazy 邊界", () => {
  it("巢狀路由 suspends 時看板仍在畫面上（邊界在 BoardPage 自己，不是最外層那個）", async () => {
    renderBoard(<NeverResolves />);

    // 少了 BoardPage 自己的邊界，最近的界是 AppLayout 那個 ⇒ 整個看板會被
    // fallback 換掉，而這一支就是唯一看得見那件事的地方。
    // 清單名稱在 `canEdit` 時是**常駐的 `<Input>`**、不是文字節點
    // （`BoardListColumn.tsx:174-177`），所以查的是 display value 而不是 text。
    expect(await screen.findByDisplayValue("待辦清單")).toBeInTheDocument();
    // 而且沒有把載入中的外觀渲染到看板上（BoardPage 的 fallback 是 null）。
    // 這裡比對**文案**而不是 `role="status"`：dnd-kit 自己會渲染一個
    // `role="status"` 的無障礙 live region（`DndLiveRegion-0`），用 role 查會撞到它。
    expect(screen.queryByText(i18n.t("common:state.loading"))).not.toBeInTheDocument();
  });

  it("巢狀路由正常時照樣渲染", async () => {
    renderBoard();

    expect(await screen.findByDisplayValue("待辦清單")).toBeInTheDocument();
    expect(screen.getByText("卡片對話框")).toBeInTheDocument();
  });
});

describe("BoardPage 的卡片對話框預取", () => {
  it("掛載時要求預取卡片對話框的 chunk", async () => {
    const { prefetchCardDialog } = await import("@/lib/lazy-route");

    renderBoard();

    await waitFor(() => expect(prefetchCardDialog).toHaveBeenCalled());
  });
});
