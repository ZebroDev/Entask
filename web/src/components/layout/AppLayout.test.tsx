import { describe, expect, it, vi, beforeEach } from "vitest";
import { type ComponentType, lazy } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "./AppLayout";
import { useAuth } from "@/stores/auth";
import { usePresenceStore } from "@/lib/collaboration";
import { HubConnectionState } from "@microsoft/signalr";
import i18n from "@/i18n";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
  },
}));

vi.mock("@/lib/collaboration", async () => {
  const actual = await vi.importActual<typeof import("@/lib/collaboration")>("@/lib/collaboration");
  return {
    ...actual,
    useCollaboration: vi.fn(),
    getCollaborationHub: vi.fn().mockResolvedValue({}),
  };
});

function renderWithRoute(route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AppLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppLayout 團隊管理導覽保護", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
  });

  it("一般工程師（無 team.read）在專案頁時，麵包屑不出現團隊連結且頭像選單不含選擇團隊", async () => {
    useAuth.setState({
      user: { userId: "u-eng", username: "engineer", displayName: "工程師", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams/my-permissions")
        return Promise.resolve({ data: [{ teamId: "t1", codes: ["card.read", "card.edit"] }] });
      return Promise.resolve({ data: [] });
    });

    renderWithRoute("/projects");

    // 麵包屑僅顯示我的專案，無「團隊」
    expect(await screen.findByText("我的專案")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "團隊" })).not.toBeInTheDocument();

    // 點擊頭像打開下拉選單 (Radix PointerDown)
    fireEvent.pointerDown(screen.getByRole("button", { name: "使用者選單" }));

    // 選單不包含「選擇團隊」，但包含「我的專案」
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "我的專案" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("menuitem", { name: "選擇團隊" })).not.toBeInTheDocument();
  });

  it("管理員在專案頁時，麵包屑包含團隊連結且頭像選單包含選擇團隊", async () => {
    useAuth.setState({
      user: { userId: "u-admin", username: "admin", displayName: "系統管理員", isAdmin: true },
      tokens: null,
      teamId: null,
    });

    renderWithRoute("/projects");

    // 麵包屑顯示「團隊 / 我的專案」
    expect(screen.getByRole("link", { name: "團隊" })).toBeInTheDocument();
    expect(screen.getByText("我的專案")).toBeInTheDocument();

    // 點擊頭像打開下拉選單 (Radix PointerDown)
    fireEvent.pointerDown(screen.getByRole("button", { name: "使用者選單" }));

    // 選單包含「選擇團隊」
    expect(await screen.findByRole("menuitem", { name: "選擇團隊" })).toBeInTheDocument();
  });
});

describe("AppLayout 的 Source offer（AGPL-3.0 §13）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
    useAuth.setState({
      user: { userId: "u-admin", username: "admin", displayName: "系統管理員", isAdmin: true },
      tokens: null,
      teamId: null,
    });
  });

  // 這一項補的是登入頁那一行涵蓋不到的人：session 常駐、回不到登入頁的使用者。
  it("已登入使用者的選單提供一條指向對應原始碼的連結", async () => {
    renderWithRoute("/projects");

    fireEvent.pointerDown(screen.getByRole("button", { name: "使用者選單" }));

    const item = await screen.findByRole("menuitem", { name: "原始碼 (AGPL-3.0)" });
    expect(item).toHaveAttribute("href", "https://github.com/ZebroDev/Entask");
    expect(item).toHaveAttribute("target", "_blank");
    expect(item.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("AppLayout 的 lazy 邊界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
    useAuth.setState({
      user: { userId: "u-eng", username: "engineer", displayName: "工程師", isAdmin: false },
      tokens: null,
      teamId: null,
    });
  });

  it("子路由 suspends 時外殼仍在（邊界在外殼內，不是包住外殼）", async () => {
    // 永不解析的 lazy：就是「第一次導覽到還沒下載完的頁面」那個瞬間。
    const NeverResolves = lazy(() => new Promise<{ default: ComponentType }>(() => {}));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/my-tasks"]}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/my-tasks" element={<NeverResolves />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 頁首導覽（外殼）必須還在——邊界若擺錯位置（包住外殼而不是被外殼包住），
    // 這裡會連導覽一起消失，而那正是「切換頁面時整個 app 閃一下」的成因。
    expect(
      screen.getByRole("link", { name: i18n.t("common:nav.myTasks") }),
    ).toBeInTheDocument();
    // 內容區才是 fallback
    expect(await screen.findByRole("status")).toHaveTextContent(i18n.t("common:state.loading"));
  });
});

// 走查 F 的另一半：光有邊界不夠——**長命的邊界要靠 `key` 重掛才離得開錯誤狀態**。
// 這一層橫跨每一次路由切換，少了 `key={location.pathname}`，一次 chunk 失敗會讓內容區
// 永久停在錯誤畫面：外殼活著、連結點得動，但按下去什麼都不會發生（連本來沒問題的
// 路由都進不去）。下面的點擊就是那個「什麼都不會發生」。
describe("AppLayout 的 lazy 邊界在導覽後退場", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
    useAuth.setState({
      user: { userId: "u-eng", username: "engineer", displayName: "工程師", isAdmin: false },
      tokens: null,
      teamId: null,
    });
  });

  it("子路由的 chunk 失敗後導覽到別的路由，錯誤畫面要退場", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // `import()` 失敗的形狀：payload 進 Rejected，之後每次 render 都拋同一個錯誤。
    const Broken = lazy(
      () => Promise.reject(new Error("chunk 載入失敗")) as Promise<{ default: ComponentType }>,
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/broken"]}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/broken" element={<Broken />} />
              <Route path="/my-tasks" element={<div>我的任務頁</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 前提：真的進了錯誤狀態——不是還在載入時就往下斷言（那樣後半段會恆真）。
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // 外殼還在：這一格同時是「邊界擺在外殼裡面」的守門員（擺錯層級會連導覽一起消失）。
    const navLink = screen.getByRole("link", { name: i18n.t("common:nav.myTasks") });

    fireEvent.click(navLink);

    expect(await screen.findByText("我的任務頁")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
