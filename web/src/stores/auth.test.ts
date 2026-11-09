import { afterEach, beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { registerAuthStorageSync, useAuth } from "./auth";
import { api } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import { AUTH_STORAGE_KEY } from "@/lib/storage-keys";

vi.mock("@/lib/api", () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
  // auth store 在 login/logout/跨分頁同步時呼叫；mock 必須提供，否則 dynamic import 後
  // 的 ESM namespace 取值會拋 "No export is defined"。
  invalidateInFlightRefresh: vi.fn(),
}));

describe("useAuth", () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
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

  // F-01：登出必須清除共用的 TanStack Query 快取。查詢鍵（如 ["projects"]）不含
  // 使用者身分，而 QueryClientProvider 掛在 SPA 根部、登出不會重建；少了這一清，
  // 同一頁面工作階段改由 B 登入時，B 會吃到 A 尚未過期（staleTime 30s）的專案清單。
  it("logout 清除前一使用者的查詢快取", async () => {
    useAuth.setState({ user: { username: "a" } as never, tokens: { accessToken: "at", refreshToken: "rt" } });
    queryClient.setQueryData(["projects"], [{ id: "a-project", name: "A 的專案" }]);

    await useAuth.getState().logout();

    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
  });

  // 直接開 /login 重新登入（未經 logout）也是切換身分：登入成功後不得沿用前一帳號的快取。
  it("login 切換身分時清除前一使用者的查詢快取", async () => {
    queryClient.setQueryData(["projects"], [{ id: "a-project", name: "A 的專案" }]);
    vi.mocked(api.post).mockResolvedValueOnce({
      data: {
        accessToken: "bt",
        refreshToken: "brt",
        userId: "u2",
        username: "b",
        displayName: "B",
        isAdmin: false,
      },
    });

    await useAuth.getState().login("b", "pw");

    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
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

  // M-2：登入新帳號時若 storage 寫入失敗（配額滿／隱私模式），舊帳號的記錄必須清掉，
  // 否則重新載入時 hydrate 會把前一個帳號「復活」成目前登入者。
  it("login 寫入 storage 失敗時清掉前一個帳號的殘留記錄", async () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        user: { userId: "u1", username: "a" },
        tokens: { accessToken: "a-at", refreshToken: "a-rt" },
        teamId: null,
      }),
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    vi.mocked(api.post).mockResolvedValueOnce({
      data: {
        accessToken: "b-at",
        refreshToken: "b-rt",
        userId: "u2",
        username: "b",
        displayName: "B",
        isAdmin: false,
      },
    });

    await useAuth.getState().login("b", "pw");

    expect(useAuth.getState().user?.userId).toBe("u2");
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});

// F-04：請求攔截器以記憶體為準後，其他分頁的 token 輪替／登出必須透過 storage 事件
// 同步進本頁記憶體，否則本頁會拿舊 refresh token 重放（伺服器判定重放 ⇒ 撤銷所有 session）。
describe("跨分頁 session 同步（F-04）", () => {
  beforeAll(() => {
    registerAuthStorageSync();
  });

  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
    useAuth.setState({ user: null, tokens: null, teamId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const dispatchStorage = (newValue: string | null) =>
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_STORAGE_KEY, newValue }));

  const userA = { userId: "u1", username: "a", displayName: "A", isAdmin: false };

  it("同帳號的 token 輪替會同步到本頁記憶體", () => {
    useAuth.setState({
      user: userA,
      tokens: { accessToken: "at0", refreshToken: "rt0" },
      teamId: null,
    });

    dispatchStorage(JSON.stringify({
      user: userA,
      tokens: { accessToken: "at1", refreshToken: "rt1" },
      teamId: "t1",
    }));

    expect(useAuth.getState().tokens).toEqual({ accessToken: "at1", refreshToken: "rt1" });
    expect(useAuth.getState().teamId).toBe("t1");
  });

  it("其他分頁登出時，本頁同步失效並清除查詢快取", () => {
    useAuth.setState({
      user: userA,
      tokens: { accessToken: "at0", refreshToken: "rt0" },
      teamId: null,
    });
    queryClient.setQueryData(["projects"], [{ id: "a-project" }]);

    dispatchStorage(null);

    expect(useAuth.getState().user).toBeNull();
    expect(useAuth.getState().tokens).toBeNull();
    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
  });

  it("其他分頁切換帳號時，清除前一身分的查詢快取並套用新 session", () => {
    useAuth.setState({
      user: userA,
      tokens: { accessToken: "at0", refreshToken: "rt0" },
      teamId: null,
    });
    queryClient.setQueryData(["projects"], [{ id: "a-project" }]);

    dispatchStorage(JSON.stringify({
      user: { userId: "u2", username: "b", displayName: "B", isAdmin: false },
      tokens: { accessToken: "bt", refreshToken: "brt" },
      teamId: null,
    }));

    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
    expect(useAuth.getState().user?.userId).toBe("u2");
    expect(useAuth.getState().tokens).toEqual({ accessToken: "bt", refreshToken: "brt" });
  });
});
