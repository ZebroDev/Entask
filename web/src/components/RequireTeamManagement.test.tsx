import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireTeamManagement } from "./RequireTeamManagement";
import { useAuth } from "@/stores/auth";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
  },
}));

function setUser(isAdmin: boolean, sessionTeamId: string | null = null) {
  useAuth.setState({
    user: { userId: "u1", username: "tester", displayName: "測試者", isAdmin },
    tokens: null,
    teamId: sessionTeamId,
  });
}

// children 每次 render 時看到的 session teamId：用來證明 X-Team-Id（來自 session）歸位前不渲染 children
let observedSessionTeamIds: (string | null)[] = [];

function ProbeChild() {
  const sessionTeamId = useAuth((s) => s.teamId);
  observedSessionTeamIds.push(sessionTeamId);
  return <div>團隊設定內容</div>;
}

function renderGuard(teamId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/teams/${teamId}`]}>
        <Routes>
          <Route
            path="/teams/:teamId"
            element={
              <RequireTeamManagement>
                <ProbeChild />
              </RequireTeamManagement>
            }
          />
          <Route path="/teams" element={<div>團隊選擇頁</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RequireTeamManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUser(false);
  });

  it("非 admin 且該隊無 team.read 時重導至 /teams", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ teamId: "t1", codes: ["card.read", "card.edit"] }],
    });

    renderGuard("t1");

    expect(await screen.findByText("團隊選擇頁")).toBeInTheDocument();
    expect(screen.queryByText("團隊設定內容")).not.toBeInTheDocument();
  });

  it("非 admin 且該隊有 team.read 時渲染 children", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ teamId: "t1", codes: ["team.read"] }],
    });

    renderGuard("t1");

    expect(await screen.findByText("團隊設定內容")).toBeInTheDocument();
    expect(screen.queryByText("團隊選擇頁")).not.toBeInTheDocument();
  });

  it("非 admin 有 team.read 但屬別隊時重導至 /teams（per-team 語意）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ teamId: "t2", codes: ["team.read"] }],
    });

    renderGuard("t1");

    expect(await screen.findByText("團隊選擇頁")).toBeInTheDocument();
    expect(screen.queryByText("團隊設定內容")).not.toBeInTheDocument();
  });

  it("admin 直接放行且不發出權限請求", async () => {
    setUser(true);
    const { api } = await import("@/lib/api");

    renderGuard("t1");

    expect(await screen.findByText("團隊設定內容")).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("權限載入中不重導也不渲染 children", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));

    renderGuard("t1");

    expect(api.get).toHaveBeenCalledWith("/teams/my-permissions");
    expect(screen.queryByText("團隊選擇頁")).not.toBeInTheDocument();
    expect(screen.queryByText("團隊設定內容")).not.toBeInTheDocument();
  });

  it("權限載入失敗時顯示重試且不重導，重試成功後渲染 children", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get)
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({ data: [{ teamId: "t1", codes: ["team.read"] }] });

    renderGuard("t1");

    expect(await screen.findByText("載入失敗")).toBeInTheDocument();
    expect(screen.queryByText("團隊選擇頁")).not.toBeInTheDocument();
    expect(screen.queryByText("團隊設定內容")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重試" }));

    expect(await screen.findByText("團隊設定內容")).toBeInTheDocument();
  });
});

describe("RequireTeamManagement 團隊脈絡同步（route vs session）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observedSessionTeamIds = [];
    setUser(false, "t0");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("session 團隊與 route 不同且可管理時：先切換 teamId，children 首個 render 已見新值", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ teamId: "t1", codes: ["team.read"] }],
    });
    const setTeamIdSpy = vi.spyOn(useAuth.getState(), "setTeamId");

    renderGuard("t1");

    expect(await screen.findByText("團隊設定內容")).toBeInTheDocument();
    expect(setTeamIdSpy).toHaveBeenCalledWith("t1");
    expect(useAuth.getState().teamId).toBe("t1");
    // 承載性斷言：children 第一次 render 時 header 來源已歸位（閘門擋住舊 header 先行）
    expect(observedSessionTeamIds[0]).toBe("t1");
  });

  it("session 團隊與 route 相同時：直接渲染且不切換 teamId", async () => {
    setUser(false, "t1");
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ teamId: "t1", codes: ["team.read"] }],
    });
    const setTeamIdSpy = vi.spyOn(useAuth.getState(), "setTeamId");

    renderGuard("t1");

    expect(await screen.findByText("團隊設定內容")).toBeInTheDocument();
    expect(setTeamIdSpy).not.toHaveBeenCalled();
    expect(observedSessionTeamIds[0]).toBe("t1");
  });

  it("非管理者且 session 團隊與 route 不同時：仍重導且不改動 teamId", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ teamId: "t1", codes: ["card.read"] }],
    });
    const setTeamIdSpy = vi.spyOn(useAuth.getState(), "setTeamId");

    renderGuard("t1");

    expect(await screen.findByText("團隊選擇頁")).toBeInTheDocument();
    expect(screen.queryByText("團隊設定內容")).not.toBeInTheDocument();
    expect(setTeamIdSpy).not.toHaveBeenCalled();
  });

  it("admin 且 session 團隊為 null 時：仍切換 teamId 後才渲染", async () => {
    setUser(true, null);
    const { api } = await import("@/lib/api");
    const setTeamIdSpy = vi.spyOn(useAuth.getState(), "setTeamId");

    renderGuard("t1");

    expect(await screen.findByText("團隊設定內容")).toBeInTheDocument();
    expect(setTeamIdSpy).toHaveBeenCalledWith("t1");
    expect(observedSessionTeamIds[0]).toBe("t1");
    expect(api.get).not.toHaveBeenCalled();
  });
});
