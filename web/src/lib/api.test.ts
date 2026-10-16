import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosHeaders, type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { api, navigation } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { AUTH_STORAGE_KEY } from "@/lib/storage-keys";

const SESSION = {
  user: { userId: "u1", username: "admin", displayName: "系統管理員", isAdmin: true },
  tokens: { accessToken: "old-at", refreshToken: "old-rt" },
  teamId: "t1",
};

const rejected = () => api.interceptors.response.handlers![0].rejected!;

function make401Error(url: string, adapter?: InternalAxiosRequestConfig["adapter"]): AxiosError {
  const config = {
    url,
    method: "get",
    headers: new AxiosHeaders(),
    adapter,
  } as unknown as InternalAxiosRequestConfig;
  return {
    name: "AxiosError",
    message: "Request failed with status code 401",
    config,
    response: { status: 401 } as AxiosResponse,
  } as AxiosError;
}

const okAdapter: InternalAxiosRequestConfig["adapter"] = async (config) => ({
  data: { ok: true },
  status: 200,
  statusText: "OK",
  headers: {},
  config,
});

describe("api 401 refresh 攔截器", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuth.setState({ user: null, tokens: null, teamId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("401 觸發 refresh，持久化新的 access 與 refresh token（含 store），並重試原請求", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);

    const error = make401Error("/teams", okAdapter);
    const result = await rejected()(error);

    expect(result.data).toEqual({ ok: true });
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(stored.user).toEqual(SESSION.user);
    expect(stored.teamId).toBe("t1");
    expect(useAuth.getState().tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(useAuth.getState().user).toEqual(SESSION.user);
    expect(useAuth.getState().teamId).toBe("t1");
    expect(error.config!.headers.Authorization).toBe("Bearer new-at");
    expect(api.post).toHaveBeenCalledWith("/auth/refresh", { refreshToken: "old-rt" });
  });

  it("並發多個 401 只觸發一次 refresh（single-flight）", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    let resolveRefresh!: (value: { accessToken: string; refreshToken: string }) => void;
    const refreshPromise = new Promise<{ accessToken: string; refreshToken: string }>((res) => {
      resolveRefresh = res;
    });
    vi.spyOn(api, "post").mockImplementation(
      () => refreshPromise.then((tokens) => ({ data: tokens })) as never
    );

    const e1 = make401Error("/teams", okAdapter);
    const e2 = make401Error("/users", okAdapter);
    const p1 = rejected()(e1);
    const p2 = rejected()(e2);
    await new Promise((r) => setTimeout(r, 0));

    expect(api.post).toHaveBeenCalledTimes(1);
    resolveRefresh({ accessToken: "new-at", refreshToken: "new-rt" });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.data).toEqual({ ok: true });
    expect(r2.data).toEqual({ ok: true });
    expect(e1.config!.headers.Authorization).toBe("Bearer new-at");
    expect(e2.config!.headers.Authorization).toBe("Bearer new-at");
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
  });

  it.each(["/auth/login", "/auth/refresh", "/auth/logout"])(
    "%s 的 401 不觸發 refresh 攔截（直接回傳錯誤，不 refresh、不導向）",
    async (url) => {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
      const postSpy = vi.spyOn(api, "post");
      // vitest 的 spyOn 預設會呼叫原函式，需置換為 no-op 避免 jsdom 實際導航
      const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

      const error = make401Error(url, okAdapter);
      await expect(rejected()(error)).rejects.toBe(error);

      expect(postSpy).not.toHaveBeenCalled();
      expect(redirectSpy).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!)).toEqual(SESSION);
    }
  );

  it("refresh 失敗時清除 storage、重置 store、導向 /login，並將原始錯誤回傳給呼叫端", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    vi.spyOn(api, "post").mockRejectedValue(new Error("refresh 失敗"));
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

    const error = make401Error("/teams", okAdapter);
    await expect(rejected()(error)).rejects.toBe(error);

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(useAuth.getState()).toMatchObject({ user: null, tokens: null, teamId: null });
    expect(redirectSpy).toHaveBeenCalledWith();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("refresh 成功後，重試請求以 500 失敗時保留 session 與 store 狀態並回傳重試錯誤", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

    const failAdapter: InternalAxiosRequestConfig["adapter"] = async (config) => {
      throw {
        name: "AxiosError",
        message: "Request failed with status code 500",
        config,
        response: { status: 500 },
      };
    };

    const error = make401Error("/teams", failAdapter);
    await expect(rejected()(error)).rejects.toMatchObject({ response: { status: 500 } });

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(redirectSpy).not.toHaveBeenCalled();
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(stored.user).toEqual(SESSION.user);
    expect(useAuth.getState().tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(useAuth.getState().user).toEqual(SESSION.user);
  });

  it("refresh 後的重試請求若仍 401，不再無限重試（_retry 防護）", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);
    const failAdapter: InternalAxiosRequestConfig["adapter"] = async (config) => {
      // 自訂 adapter 不經 axios settle，需自行 reject 模擬 adapter 收到 401
      throw {
        name: "AxiosError",
        message: "Request failed with status code 401",
        config,
        response: { status: 401 },
      };
    };

    const error = make401Error("/teams", failAdapter);
    await expect(rejected()(error)).rejects.toMatchObject({ response: { status: 401 } });

    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

describe("api dev 防護", () => {
  it("dev 環境下請求路徑再帶 /api 前綴時直接拒絕（axios baseURL 已含 /api）", async () => {
    // request 攔截器主動 reject，錯誤應原樣到達呼叫端（response 攔截器對無 config 的錯誤直接放行）
    await expect(api.get("/api/notifications")).rejects.toThrow(/Double \/api prefix/);
  });
});
