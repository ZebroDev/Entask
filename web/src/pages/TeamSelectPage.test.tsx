import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TeamSelectPage } from "./TeamSelectPage";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
}));
let mockUser = { userId: "u1", username: "admin", displayName: "系統管理員", isAdmin: true };
let mockTeamId: string | null = null;

vi.mock("@/stores/auth", () => ({
  useAuth: () => ({
    user: mockUser,
    teamId: mockTeamId,
    setTeamId: vi.fn(),
    logout: vi.fn(),
  }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TeamSelectPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TeamSelectPage R24（#24 bulk 端點）", () => {
  beforeEach(() => {
    mockUser = { userId: "u1", username: "admin", displayName: "系統管理員", isAdmin: true };
    mockTeamId = null;
    vi.clearAllMocks();
  });

  // 回歸釘（B2-6a）：`visibleTeams.map((t) => …)` 的參數叫 `t` 時，裡面兩個 `t(...)`
  // 會被當成呼叫 TeamDto（TypeError）。**「進入」那顆鈕已有測試涵蓋**（權限碼一到就會
  // 呼叫 `t("team:select.enter.action")`，實測把遮蔽放回去會讓 4 支紅）；這支補的是
  // **另一條分支**——`目前團隊` 徽章只在 `t.id === teamId` 時求值，先前沒有任何斷言。
  it("目前團隊顯示「目前團隊」徽章", async () => {
    const { api } = await import("@/lib/api");
    mockTeamId = "t1";
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams") return Promise.resolve({ data: [{ id: "t1", name: "有權團隊" }] });
      if (url === "/teams/my-permissions")
        return Promise.resolve({ data: [{ teamId: "t1", codes: ["team.read"] }] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByText("目前團隊")).toBeInTheDocument();
  });

  it("隱藏無 team.read 權限的團隊（單次 bulk 請求）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams")
        return Promise.resolve({ data: [{ id: "t1", name: "有權團隊" }, { id: "t2", name: "無權團隊" }] });
      if (url === "/teams/my-permissions")
        return Promise.resolve({
          data: [
            { teamId: "t1", codes: ["team.read"] },
            { teamId: "t2", codes: [] },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByText("有權團隊")).toBeInTheDocument();
    // 權限碼到後無權團隊被過濾（render-as-you-go 中間態可能存在，以 waitFor 收斂）
    await waitFor(() => expect(screen.queryByText("無權團隊")).not.toBeInTheDocument());
  });

  

  it("權限查詢失敗顯示載入失敗與重試而非誤導空態，重試後載入", async () => {
    const { api } = await import("@/lib/api");
    let calls = 0;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams")
        return Promise.resolve({ data: [{ id: "t1", name: "有權團隊" }] });
      if (url === "/teams/my-permissions") {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("403"))
          : Promise.resolve({ data: [{ teamId: "t1", codes: ["team.read"] }] });
      }
      return Promise.resolve({ data: [] });
    });
    renderPage();
    // 權限查詢失敗 → 顯示錯誤而非過濾後的空團隊清單
    expect(await screen.findByText("載入失敗")).toBeInTheDocument();
    expect(screen.queryByText("尚無團隊，請聯絡系統管理員")).not.toBeInTheDocument();
    expect(screen.queryByText("有權團隊")).not.toBeInTheDocument();
    // 重試後成功載入團隊
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(await screen.findByText("有權團隊")).toBeInTheDocument();
  });

  it("render-as-you-go：團隊名先渲染，不發逐團隊權限請求", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams")
        return Promise.resolve({ data: [{ id: "t1", name: "有權團隊" }] });
      // 權限回應懸置——render-as-you-go：團隊名先渲染，權限碼後到
      if (url === "/teams/my-permissions") return new Promise(() => {});
      return Promise.resolve({ data: [] });
    });
    renderPage();
    // 權限碼未回前團隊名已渲染
    expect(await screen.findByText("有權團隊")).toBeInTheDocument();
    // 僅一次 bulk 請求，無每團隊 /permissions/mine 呼叫
    expect(api.get).toHaveBeenCalledWith("/teams/my-permissions");
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("/permissions/mine"));
    expect(vi.mocked(api.get).mock.calls.filter(([u]) => u === "/teams/my-permissions")).toHaveLength(1);
  });

  it("權限碼驅動「進入」按鈕", async () => {
    const { api } = await import("@/lib/api");
    let resolvePerms!: (v: unknown) => void;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams")
        return Promise.resolve({ data: [{ id: "t1", name: "有權團隊" }] });
      if (url === "/teams/my-permissions")
        return new Promise((resolve) => { resolvePerms = resolve; });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await screen.findByText("有權團隊");
    // 權限碼未到 → 無「進入」按鈕
    expect(screen.queryByRole("button", { name: "進入" })).not.toBeInTheDocument();
    resolvePerms({ data: [{ teamId: "t1", codes: ["team.read"] }] });
    // 權限碼到 →「進入」按鈕出現
    expect(await screen.findByRole("button", { name: "進入" })).toBeInTheDocument();
  });

  it("載入中渲染 Skeleton（#26）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation(
      () => new Promise(() => {}),
    );
    renderPage();
    expect(await screen.findByTestId("team-select-skeleton")).toBeInTheDocument();
  });

  it("非管理員（工程師）有團隊但無 team.read 時，顯示未開放團隊管理權限與導向按鈕", async () => {
    mockUser = { userId: "u2", username: "engineer", displayName: "工程師", isAdmin: false };
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams")
        return Promise.resolve({ data: [{ id: "t1", name: "開發團隊" }] });
      if (url === "/teams/my-permissions")
        return Promise.resolve({ data: [{ teamId: "t1", codes: ["project.read", "card.read"] }] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByText("您所屬的角色未開放團隊管理權限")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往我的專案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "個人工作台" })).toBeInTheDocument();
    expect(screen.queryByText("尚無團隊，請聯絡系統管理員")).not.toBeInTheDocument();
  });

  it("非管理員未加入任何團隊時，顯示尚未加入任何團隊提示", async () => {
    mockUser = { userId: "u3", username: "newbie", displayName: "新人", isAdmin: false };
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/teams")
        return Promise.resolve({ data: [] });
      if (url === "/teams/my-permissions")
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByText("尚未加入任何團隊")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往我的專案" })).toBeInTheDocument();
    expect(screen.queryByText("尚無團隊，請聯絡系統管理員")).not.toBeInTheDocument();
  });
});

