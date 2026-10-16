import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCanManageTeam, useHasTeamManagement } from "./use-has-team-management";
import { useAuth } from "@/stores/auth";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
  },
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useHasTeamManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("管理員一律為 true 且不發送 API 請求", () => {
    useAuth.setState({
      user: { userId: "u-admin", username: "admin", displayName: "管理員", isAdmin: true },
      tokens: null,
      teamId: null,
    });

    const { result } = renderHook(() => useHasTeamManagement(), {
      wrapper: createWrapper(),
    });

    expect(result.current.canManageTeams).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("一般使用者且擁有 team.read 權限時回傳 true", async () => {
    useAuth.setState({
      user: { userId: "u-mgr", username: "manager", displayName: "團隊經理", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ teamId: "t1", codes: ["team.read", "project.create"] }],
    });

    const { result } = renderHook(() => useHasTeamManagement(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.canManageTeams).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it("一般使用者（如工程師）無 team.read 時回傳 false", async () => {
    useAuth.setState({
      user: { userId: "u-eng", username: "engineer", displayName: "工程師", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ teamId: "t1", codes: ["project.read", "card.read", "card.edit"] }],
    });

    const { result } = renderHook(() => useHasTeamManagement(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canManageTeams).toBe(false);
  });

  it("使用者未加入任何團隊時回傳 false", async () => {
    useAuth.setState({
      user: { userId: "u-new", username: "newbie", displayName: "新進成員", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [],
    });

    const { result } = renderHook(() => useHasTeamManagement(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canManageTeams).toBe(false);
  });
});

describe("useCanManageTeam（per-team 語意）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("管理員一律放行且不發送 API 請求", () => {
    useAuth.setState({
      user: { userId: "u-admin", username: "admin", displayName: "管理員", isAdmin: true },
      tokens: null,
      teamId: null,
    });

    const { result } = renderHook(() => useCanManageTeam("t1"), {
      wrapper: createWrapper(),
    });

    expect(result.current.canManage).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("非 admin 且該隊有 team.read 時放行", async () => {
    useAuth.setState({
      user: { userId: "u-mgr", username: "manager", displayName: "團隊經理", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ teamId: "t1", codes: ["team.read", "project.create"] }],
    });

    const { result } = renderHook(() => useCanManageTeam("t1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.canManage).toBe(true));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("非 admin 的 team.read 屬別隊時不放行", async () => {
    useAuth.setState({
      user: { userId: "u-mgr", username: "manager", displayName: "團隊經理", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ teamId: "t2", codes: ["team.read"] }],
    });

    const { result } = renderHook(() => useCanManageTeam("t1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.canManage).toBe(false);
  });

  it("查詢失敗時 isError 為 true、不放行且不再載入中", async () => {
    useAuth.setState({
      user: { userId: "u-mgr", username: "manager", displayName: "團隊經理", isAdmin: false },
      tokens: null,
      teamId: null,
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(() => useCanManageTeam("t1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.canManage).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });
});
