import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosHeaders, type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { api, navigation } from "@/lib/api";
import { registerAuthStorageSync, useAuth } from "@/stores/auth";
import { queryClient } from "@/lib/query-client";
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
    queryClient.clear();
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

  it("refresh 失敗時清除 storage、查詢快取、重置 store、導向 /login，並將原始錯誤回傳給呼叫端", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    queryClient.setQueryData(["projects"], [{ id: "a-project" }]);
    vi.spyOn(api, "post").mockRejectedValue(new Error("refresh 失敗"));
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

    const error = make401Error("/teams", okAdapter);
    await expect(rejected()(error)).rejects.toBe(error);

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(useAuth.getState()).toMatchObject({ user: null, tokens: null, teamId: null });
    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
    expect(redirectSpy).toHaveBeenCalledWith();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  // M-2：storage 記錄屬於另一個帳號時（跨分頁切帳號的空窗），refresh 只能更新記憶體，
  // 不得把 A 的 token 併進 B 的記錄——重新載入會變成 B 的身分帶 A 的憑證。
  it("refresh 持久化不覆寫另一個帳號的 storage 記錄", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      user: { userId: "u2", username: "b", displayName: "B", isAdmin: false },
      tokens: { accessToken: "b-at", refreshToken: "b-rt" },
      teamId: null,
    }));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: "t1" });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);

    await rejected()(make401Error("/teams", okAdapter));

    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.user.userId).toBe("u2");
    expect(stored.tokens).toEqual({ accessToken: "b-at", refreshToken: "b-rt" });
    expect(useAuth.getState().tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
  });

  // M-3（code review）：持久化要寫入完整的記憶體 session，不是把 token 併進一份
  // 可能過期的 storage 記錄——否則 teamId 會停留在舊值，跨團隊請求失去團隊脈絡。
  it("refresh 持久化寫入完整的記憶體 session（teamId 以記憶體為準）", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ ...SESSION, teamId: "t-stale" }));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: "t-mem" });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);

    await rejected()(make401Error("/teams", okAdapter));

    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.user).toEqual(SESSION.user);
    expect(stored.teamId).toBe("t-mem");
    expect(stored.tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
  });

  // L-4：refresh 的 200 回應欄位未經驗證時，`{accessToken: "x"}` 會讓 store 變成
  // `{accessToken: "x", refreshToken: undefined}`，後續請求送出 "Bearer x" 且 refresh 路徑被抑制。
  it("refresh 回應缺少 token 欄位時視為失敗，不種下 undefined 憑證", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    vi.spyOn(api, "post").mockResolvedValue({ data: { accessToken: "new-at" } } as never);
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

    const error = make401Error("/teams", okAdapter);
    await expect(rejected()(error)).rejects.toBe(error);

    expect(useAuth.getState().tokens).toBeNull();
    expect(redirectSpy).toHaveBeenCalledWith();
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

  // H-2：在途 refresh 不屬於發起它的 session——A 的 refresh 在 B 登入後才完成時，
  // 不得把 A 的 token 寫回 store／storage（B 的 UI 會帶著 A 的憑證看到 A 的資料）。
  it("refresh 在登入新帳號後才完成時，丟棄結果且不覆寫新 session", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((res) => { resolveRefresh = res; });
    vi.spyOn(api, "post")
      .mockImplementationOnce(() => refreshPromise as never)
      .mockResolvedValueOnce({
        data: {
          accessToken: "b-at", refreshToken: "b-rt", userId: "u2",
          username: "b", displayName: "B", isAdmin: false,
        },
      } as never);

    const error = make401Error("/teams", okAdapter);
    const pending = rejected()(error);
    await new Promise((r) => setTimeout(r, 0));
    await useAuth.getState().login("b", "pw");

    resolveRefresh({ data: { accessToken: "a2-at", refreshToken: "a2-rt" } });

    await expect(pending).rejects.toBe(error);
    expect(useAuth.getState().tokens).toEqual({ accessToken: "b-at", refreshToken: "b-rt" });
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.user.userId).toBe("u2");
    expect(stored.tokens).toEqual({ accessToken: "b-at", refreshToken: "b-rt" });
  });

  // H-2：反向情境——A 的 refresh 失敗也不得清掉 B 剛建立的 session 或把 B 導回登入。
  it("refresh 在登入新帳號後才失敗時，不清除新 session、不導向登入", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });
    let rejectRefresh!: (reason: unknown) => void;
    const refreshPromise = new Promise((_res, rej) => { rejectRefresh = rej; });
    vi.spyOn(api, "post")
      .mockImplementationOnce(() => refreshPromise as never)
      .mockResolvedValueOnce({
        data: {
          accessToken: "b-at", refreshToken: "b-rt", userId: "u2",
          username: "b", displayName: "B", isAdmin: false,
        },
      } as never);
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

    const error = make401Error("/teams", okAdapter);
    const pending = rejected()(error);
    await new Promise((r) => setTimeout(r, 0));
    await useAuth.getState().login("b", "pw");

    rejectRefresh(new Error("refresh failed"));

    await expect(pending).rejects.toBe(error);
    expect(useAuth.getState().tokens).toEqual({ accessToken: "b-at", refreshToken: "b-rt" });
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  // HIGH（code review 2026-11-09）：login 在 set 之前有兩個 await（動態 import、
  // cancelQueries），舊 session 的 token 仍留在記憶體。窗內新起的 401 會用舊 refresh
  // token 發 refresh；只在 login 開頭 bump 一次的話，它會在 set 之後才完成並覆寫 B。
  it("login 等待期間新起的 refresh 也不得覆寫新 session", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });

    let resolveLogin!: (value: unknown) => void;
    let resolveRefresh!: (value: unknown) => void;
    const loginPromise = new Promise((res) => { resolveLogin = res; });
    const refreshPromise = new Promise((res) => { resolveRefresh = res; });
    vi.spyOn(api, "post")
      .mockImplementationOnce(() => loginPromise as never)
      .mockImplementationOnce(() => refreshPromise as never);

    const loginPending = useAuth.getState().login("b", "pw");
    // login 仍卡在它的 POST；此時舊 session 的請求 401 並開始 refresh。
    const error = make401Error("/teams", okAdapter);
    const pending = rejected()(error);
    await new Promise((r) => setTimeout(r, 0));

    resolveLogin({
      data: {
        accessToken: "b-at", refreshToken: "b-rt", userId: "u2",
        username: "b", displayName: "B", isAdmin: false,
      },
    });
    await loginPending;

    resolveRefresh({ data: { accessToken: "a2-at", refreshToken: "a2-rt" } });

    await expect(pending).rejects.toBe(error);
    expect(useAuth.getState().tokens).toEqual({ accessToken: "b-at", refreshToken: "b-rt" });
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!);
    expect(stored.user.userId).toBe("u2");
    expect(stored.tokens).toEqual({ accessToken: "b-at", refreshToken: "b-rt" });
  });

  // MEDIUM（code review 2026-11-09）：storage 事件不只代表換 session——其他分頁的
  // setTeamId／updateProfile 也寫同一個 key。憑證沒變時不得丟棄本頁在途的 refresh。
  it("其他分頁只更新 teamId 時，不丟棄本頁在途的 refresh", async () => {
    registerAuthStorageSync();
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: SESSION.user, tokens: SESSION.tokens, teamId: SESSION.teamId });

    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((res) => { resolveRefresh = res; });
    vi.spyOn(api, "post").mockImplementationOnce(() => refreshPromise as never);

    const pending = rejected()(make401Error("/teams", okAdapter));
    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(new StorageEvent("storage", {
      key: AUTH_STORAGE_KEY,
      newValue: JSON.stringify({ ...SESSION, teamId: "t2" }),
    }));

    resolveRefresh({ data: { accessToken: "new-at", refreshToken: "new-rt" } });

    const result = await pending;
    expect(result.data).toEqual({ ok: true });
    expect(useAuth.getState().tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(useAuth.getState().teamId).toBe("t2");
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

describe("api request 攔截器（F-04 儲存失敗降級）", () => {
  beforeEach(() => {
    localStorage.clear();
    useAuth.setState({ user: null, tokens: null, teamId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 隱私模式／配額滿時，登入流程的 localStorage.setItem 會失敗，token 只存在 Zustand。
  // 請求憑證必須以記憶體 session 為準，否則登入成功後的第一個請求就沒有 Authorization。
  it("storage 為空時，Authorization 與 X-Team-Id 取自記憶體 session", async () => {
    useAuth.setState({
      user: { userId: "u1", username: "a", displayName: "A", isAdmin: false },
      tokens: { accessToken: "mem-at", refreshToken: "mem-rt" },
      teamId: "t-mem",
    });

    const res = await api.get("/notifications", { adapter: okAdapter });

    expect(res.config.headers.Authorization).toBe("Bearer mem-at");
    expect(res.config.headers["X-Team-Id"]).toBe("t-mem");
  });

  // 真正模擬 storage 被封鎖（私有模式／政策）：讀取拋例外時仍以記憶體憑證送出請求。
  it("storage 讀取拋例外時，Authorization 仍取自記憶體 session", async () => {
    useAuth.setState({
      user: { userId: "u1", username: "a", displayName: "A", isAdmin: false },
      tokens: { accessToken: "mem-at", refreshToken: "mem-rt" },
      teamId: "t-mem",
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const res = await api.get("/notifications", { adapter: okAdapter });

    expect(res.config.headers.Authorization).toBe("Bearer mem-at");
    expect(res.config.headers["X-Team-Id"]).toBe("t-mem");
  });

  // F-04 的身分隔離核心：storage 記錄與記憶體身分衝突時，記憶體是唯一可信來源；
  // 讀 storage 會把上一個帳號的 token 帶進目前使用者的請求。
  it("storage 與記憶體身分衝突時，憑證以記憶體為準", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      user: { userId: "u1", username: "a", displayName: "A", isAdmin: false },
      tokens: { accessToken: "a-at", refreshToken: "a-rt" },
      teamId: "t-a",
    }));
    useAuth.setState({
      user: { userId: "u2", username: "b", displayName: "B", isAdmin: false },
      tokens: { accessToken: "b-at", refreshToken: "b-rt" },
      teamId: "t-b",
    });

    const res = await api.get("/notifications", { adapter: okAdapter });

    expect(res.config.headers.Authorization).toBe("Bearer b-at");
    expect(res.config.headers["X-Team-Id"]).toBe("t-b");
  });

  // M-2：記憶體已登出（tokens 為 null）時不得從 storage 復活舊憑證——
  // 登出流程的 removeItem 若失敗，請求攔截器的 fallback 會讓已登出的分頁繼續帶著 token。
  it("記憶體已登出時，不從 storage 復活憑證", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION));
    useAuth.setState({ user: null, tokens: null, teamId: null });

    const res = await api.get("/notifications", { adapter: okAdapter });

    expect(res.config.headers.Authorization).toBeUndefined();
    expect(res.config.headers["X-Team-Id"]).toBeUndefined();
  });

  // 同一個降級情境也適用於 refresh：只讀 localStorage 會讓記憶體 session 直接失效、
  // 被導回登入頁，即使 Zustand 手上握有可用的 refresh token。
  it("localStorage 不可用時，401 refresh 使用記憶體 refresh token 並更新記憶體 session", async () => {
    useAuth.setState({
      user: { userId: "u1", username: "a", displayName: "A", isAdmin: false },
      tokens: { accessToken: "old-at", refreshToken: "mem-rt" },
      teamId: null,
    });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});

    const error = make401Error("/teams", okAdapter);
    const result = await rejected()(error);

    expect(result.data).toEqual({ ok: true });
    expect(api.post).toHaveBeenCalledWith("/auth/refresh", { refreshToken: "mem-rt" });
    expect(useAuth.getState().tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(error.config!.headers.Authorization).toBe("Bearer new-at");
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  // 持久化只是盡力而為：storage 在 refresh 期間失效（隱私模式切換、配額滿）時，
  // 不能把已成功的 refresh 誤判成 session 失效——使用者會莫名被登出。
  it("refresh 成功但持久化失敗時，仍以記憶體 token 完成重試且不導回登入", async () => {
    useAuth.setState({
      user: { userId: "u1", username: "a", displayName: "A", isAdmin: false },
      tokens: { accessToken: "old-at", refreshToken: "mem-rt" },
      teamId: null,
    });
    vi.spyOn(api, "post").mockResolvedValue({
      data: { accessToken: "new-at", refreshToken: "new-rt" },
    } as never);
    const redirectSpy = vi.spyOn(navigation, "redirectToLogin").mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const result = await rejected()(make401Error("/teams", okAdapter));

    expect(result.data).toEqual({ ok: true });
    expect(useAuth.getState().tokens).toEqual({ accessToken: "new-at", refreshToken: "new-rt" });
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});

describe("api dev 防護", () => {
  it("dev 環境下請求路徑再帶 /api 前綴時直接拒絕（axios baseURL 已含 /api）", async () => {
    // request 攔截器主動 reject，錯誤應原樣到達呼叫端（response 攔截器對無 config 的錯誤直接放行）
    await expect(api.get("/api/notifications")).rejects.toThrow(/Double \/api prefix/);
  });
});
