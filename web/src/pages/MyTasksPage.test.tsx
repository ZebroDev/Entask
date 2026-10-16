import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MyTasksPage } from "./MyTasksPage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import { axiosStatus } from "@/test/http-errors";
import { toast } from "sonner";
import type { Mock } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

// 錯誤路徑的斷言要看 toast 的內容（2026-09-19 錯誤路徑收斂）。
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockData = {
  assignedCards: [
    {
      id: "c1",
      title: "設計登入頁面",
      projectId: "p1",
      projectName: "Entask 專案",
      boardId: "b1",
      boardName: "前端看板",
      listId: "l1",
      listName: "進行中",
      dueAt: new Date().toISOString(),
      completedAt: null,
      isOverdue: false,
      labels: ["UI"],
      checklistTotal: 2,
      checklistCompleted: 1,
    },
    {
      id: "c2",
      title: "修復後端連線問題",
      projectId: "p1",
      projectName: "Entask 專案",
      boardId: "b1",
      boardName: "後端看板",
      listId: "l1",
      listName: "待處理",
      dueAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      isOverdue: true,
      labels: ["Bug"],
      checklistTotal: 0,
      checklistCompleted: 0,
    },
  ],
  pendingReviews: [
    {
      cardId: "c3",
      cardTitle: "效能優化 PR",
      projectId: "p1",
      projectName: "Entask 專案",
      boardId: "b1",
      boardName: "後端看板",
      dueAt: null,
      status: "pending",
    },
  ],
  stats: {
    totalAssigned: 2,
    dueToday: 1,
    overdue: 1,
    inProgress: 2,
    completed: 0,
    pendingReviews: 1,
  },
};

const renderWithProviders = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
};

const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"]';

// 互動元素不可互相嵌套：外層若為 role="button" 而內含真正的 <button>，ARIA 上
// 是無效結構，螢幕閱讀器可能不暴露內層控制項（P22 批次二遺留的擬真按鈕變體）。
function expectNoNestedInteractives() {
  document.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
    const nested = el.querySelector(INTERACTIVE_SELECTOR);
    expect(
      nested,
      `巢狀互動元素：<${el.tagName.toLowerCase()}> 內含 <${nested?.tagName.toLowerCase()}>`
    ).toBeNull();
  });
}

describe("MyTasksPage", () => {
  beforeEach(() => {
    (api.get as Mock).mockResolvedValue({ data: mockData });
    (api.put as Mock).mockResolvedValue({ data: {} });
    (toast.error as Mock).mockClear();
  });

  it("renders KPI cards and task list correctly", async () => {
    renderWithProviders(<MyTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("個人工作台")).toBeInTheDocument();
      expect(screen.getByText("設計登入頁面")).toBeInTheDocument();
      expect(screen.getByText("修復後端連線問題")).toBeInTheDocument();
    });

    expect(screen.getAllByText(/今日到期/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已逾期/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/待我審查/).length).toBeGreaterThan(0);
  });

  it("switches to reviews tab and shows pending reviews", async () => {
    renderWithProviders(<MyTasksPage />);

    await waitFor(() => {
      expect(screen.queryByText("效能優化 PR")).not.toBeInTheDocument();
    });

    const reviewsTab = screen.getAllByRole("button", { name: /待我審查/ })[0];
    fireEvent.click(reviewsTab);

    await waitFor(() => {
      expect(screen.getByText("效能優化 PR")).toBeInTheDocument();
      expect(screen.getByText("待您審查")).toBeInTheDocument();
    });
  });

  it("toggles card completion on checkbox click", async () => {
    renderWithProviders(<MyTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("設計登入頁面")).toBeInTheDocument();
    });

    const completeButtons = screen.getAllByTitle("標記為完成");
    fireEvent.click(completeButtons[0]);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/cards/c1/completion", {
        isCompleted: true,
      });
    });
  });

  // 錯誤路徑收斂（2026-09-19，final review 的 F-1）：這一頁的 onError 屬於**家族 B**
  // （舊寫法是 `err?.response?.data?.message || t(…)`）——伺服器**沒有回 body** 時，
  // 舊寫法的 `||` 取的是譯文；換成 `apiErrorMessage` 之後若退回 `error.message`，
  // 這裡就會變成 `Request failed with status code 403`，正是本階段要消滅的字串。
  //
  // `axiosStatus(403)` 造的是「伺服器沒說話」的形狀（**空 body**）——403／404 自
  // 2026-09-19／20 起都帶 `{code, message}`，這種回應仍在（如 `Results.Unauthorized()`
  // 的 401，量測指令見 `web/src/test/http-errors.ts`）——只造得出帶 body 的 400 時，
  // 這條路徑沒有任何測試看著。
  it("切換完成狀態失敗（空 body 403）時顯示譯文，不是傳輸層字串", async () => {
    (api.put as Mock).mockRejectedValue(axiosStatus(403));
    renderWithProviders(<MyTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("設計登入頁面")).toBeInTheDocument();
    });
    fireEvent.click(screen.getAllByTitle("標記為完成")[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("操作失敗");
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Request failed with status code"),
    );
  });

  it("renders no nested interactive elements in task and review rows", async () => {
    renderWithProviders(<MyTasksPage />);

    await waitFor(() => {
      expect(screen.getByText("設計登入頁面")).toBeInTheDocument();
    });
    // 卡片列：外框為滑鼠點擊範圍，列內獨立控制項為完成勾選、標題、開啟看板
    expectNoNestedInteractives();

    fireEvent.click(screen.getAllByRole("button", { name: /待我審查/ })[0]);
    await waitFor(() => {
      expect(screen.getByText("效能優化 PR")).toBeInTheDocument();
    });
    // 待審查列：列內的「進入審查」是唯一控制項
    expectNoNestedInteractives();
  });
});
