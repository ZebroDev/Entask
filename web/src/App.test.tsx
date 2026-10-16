import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { HubConnectionState } from "@microsoft/signalr";
import i18n from "@/i18n";
import App from "./App";
import { useAuth } from "@/stores/auth";
import { usePresenceStore } from "@/lib/collaboration";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/collaboration", async () => {
  const actual = await vi.importActual<typeof import("@/lib/collaboration")>("@/lib/collaboration");
  return {
    ...actual,
    useCollaboration: vi.fn(),
    getCollaborationHub: vi.fn().mockResolvedValue({}),
  };
});

const USER = { userId: "u1", username: "admin", displayName: "測試員", isAdmin: true };

const myWorkFixture = {
  assignedCards: [],
  pendingReviews: [],
  stats: { totalAssigned: 0, dueToday: 0, overdue: 0, inProgress: 0, completed: 0, pendingReviews: 0 },
};

const worklogFixture = {
  scope: "me",
  fromDate: "2026-09-01",
  toDate: "2026-09-27",
  workdays: [],
  members: [],
  summary: { totalHours: 0, memberCount: 0, entryCount: 0, cardCount: 0, workdayCount: 0 },
};

function renderApp(route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function mockApi(overrides: Record<string, unknown> = {}) {
  const { api } = await import("@/lib/api");
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url in overrides) return Promise.resolve({ data: overrides[url] });
    if (url === "/me/work") return Promise.resolve({ data: myWorkFixture });
    if (url.startsWith("/me/worklog")) return Promise.resolve({ data: worklogFixture });
    return Promise.resolve({ data: [] });
  });
}

// App.tsx 的頁面全部改走 lazy 之後，「哪一條路由掛得上」不再由 import 保證
// （型別只保證**那個名字**在模組裡，不保證**路由**指到它）。這一份走訪就是那張網：
// 少了任何一條 Suspense 邊界，整棵樹會以
// "A component suspended while rendering, but no fallback UI was specified" 收場。
describe("App 的路由走訪", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
  });

  it("未登入時 /projects 導向登入頁，且 fallback 不殘留", async () => {
    useAuth.setState({ user: null, tokens: null, teamId: null });
    await mockApi();

    renderApp("/projects");

    expect(
      await screen.findByRole("button", { name: i18n.t("auth:login.action") }),
    ).toBeInTheDocument();
    // lazy chunk 到位後 fallback 必須退場——留著就是「載入中」永遠不結束
    expect(screen.queryByText(i18n.t("common:state.loading"))).not.toBeInTheDocument();
  });

  it("已登入時 /projects 渲染專案清單", async () => {
    useAuth.setState({ user: USER, tokens: null, teamId: null });
    await mockApi({
      "/projects": [
        {
          id: "p1",
          teamId: "t1",
          name: "lazy 專案",
          description: null,
          memberCount: 1,
          boardCount: 0,
          createdAt: "2026-08-15T00:00:00Z",
        },
      ],
    });

    renderApp("/projects");

    expect(await screen.findByText("lazy 專案")).toBeInTheDocument();
  });

  it("已登入時 /my-tasks 渲染我的任務", async () => {
    useAuth.setState({ user: USER, tokens: null, teamId: null });
    await mockApi();

    renderApp("/my-tasks");

    expect(
      await screen.findByRole("heading", { name: i18n.t("common:nav.myTasks") }),
    ).toBeInTheDocument();
  });

  it("已登入時 /my-worklog 渲染工作日誌", async () => {
    useAuth.setState({ user: USER, tokens: null, teamId: null });
    await mockApi();

    renderApp("/my-worklog");

    expect(
      await screen.findByRole("heading", { name: i18n.t("common:nav.myWorklog") }),
    ).toBeInTheDocument();
  });

  it("未知路徑渲染 404", async () => {
    useAuth.setState({ user: USER, tokens: null, teamId: null });
    await mockApi();

    renderApp("/no-such-page");

    expect(await screen.findByText(i18n.t("common:notFound.title"))).toBeInTheDocument();
  });
});
