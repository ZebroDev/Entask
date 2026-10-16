import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuth } from "./auth";
import { api } from "@/lib/api";
import { AUTH_STORAGE_KEY } from "@/lib/storage-keys";

vi.mock("@/lib/api", () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

describe("useAuth", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuth.setState({ user: null, tokens: null, teamId: null });
  });

  it("login 成功後儲存 user 與 tokens", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      data: {
        accessToken: "at",
        refreshToken: "rt",
        userId: "u1",
        username: "admin",
        displayName: "系統管理員",
        isAdmin: true,
      },
    });

    await useAuth.getState().login("admin", "pw");

    const state = useAuth.getState();
    expect(state.user?.username).toBe("admin");
    expect(state.tokens?.accessToken).toBe("at");
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });

  it("login 失敗時不儲存任何狀態", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error("401"));

    await expect(useAuth.getState().login("admin", "wrong")).rejects.toThrow();
    expect(useAuth.getState().user).toBeNull();
  });

  it("logout 清除狀態與 localStorage", async () => {
    useAuth.setState({ user: { username: "admin" } as never, tokens: { accessToken: "at", refreshToken: "rt" } });
    await useAuth.getState().logout();
    expect(useAuth.getState().user).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it("updateProfile 保留 teamId 與 tokens（攔截器靠 teamId 補 X-Team-Id）", () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        user: { username: "admin", displayName: "舊名" },
        tokens: { accessToken: "at", refreshToken: "rt" },
        teamId: "t1",
      }),
    );
    useAuth.setState({
      user: { username: "admin", displayName: "舊名" } as never,
      tokens: { accessToken: "at", refreshToken: "rt" },
      teamId: "t1",
    });

    useAuth.getState().updateProfile({ displayName: "新名" });

    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.user.displayName).toBe("新名");
    expect(stored.tokens).toEqual({ accessToken: "at", refreshToken: "rt" });
    expect(stored.teamId).toBe("t1");
  });

  it("hydrate 由 localStorage 還原登入狀態", () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        user: { username: "admin" },
        tokens: { accessToken: "at", refreshToken: "rt" },
        teamId: "t1",
      }),
    );
    useAuth.getState().hydrate();
    const state = useAuth.getState();
    expect(state.user?.username).toBe("admin");
    expect(state.tokens?.accessToken).toBe("at");
    expect(state.teamId).toBe("t1");
  });

  it("hydrate 遇到損壞內容時清除並維持未登入（避免白屏）", () => {
    localStorage.setItem(AUTH_STORAGE_KEY, "{ 壞掉的內容");
    useAuth.getState().hydrate();
    expect(useAuth.getState().user).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});
