import axios from "axios";
import { useAuth } from "@/stores/auth";
import { AUTH_STORAGE_KEY } from "@/lib/storage-keys";

// axios 的 InternalAxiosRequestConfig 沒有 _retry 欄位，擴充型別供 refresh 攔截器使用
declare module "axios" {
  export interface InternalAxiosRequestConfig {
    _retry?: boolean;
  }
}

export const api = axios.create({ baseURL: "/api" });

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

let refreshing: Promise<TokenPair> | null = null;

// 導向抽成物件方法，讓測試可 spy 驗證 redirect 而不觸發 jsdom 的實際導航
export const navigation = {
  redirectToLogin: () => {
    window.location.href = "/login";
  },
};

api.interceptors.request.use((config) => {
  // dev 防護：路徑不可再帶 /api 前綴（baseURL 已含）。
  // 生產環境此類錯誤路徑會被 SPA fallback 以 200 回傳 index.html，造成狀態污染與白畫面
  if (import.meta.env.DEV && config.url?.startsWith("/api/")) {
    return Promise.reject(new Error(`Double /api prefix: ${config.url}（axios baseURL 已含 /api）`));
  }
  // localStorage 存取防護：隱私模式/內容損壞時僅跳過 header，不阻斷請求
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (raw) {
      const { tokens, teamId } = JSON.parse(raw) as {
        tokens: { accessToken: string } | null;
        teamId: string | null;
      };
      if (tokens) config.headers.Authorization = `Bearer ${tokens.accessToken}`;
      // 請求已自帶 X-Team-Id 時不覆寫（跨團隊操作如建立專案、專案複製以請求層 header 指定團隊）
      if (teamId && !config.headers["X-Team-Id"]) config.headers["X-Team-Id"] = teamId;
    }
  } catch {
    // 讀取失敗視為未登入 header
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    // request 攔截器主動拒絕（如 dev 雙前綴防護）時 error.config 為 undefined，直接原樣回傳
    if (!original) return Promise.reject(error);
    const isAuthEndpoint = original.url?.includes("/auth/");
    if (error.response?.status === 401 && !original._retry && !isAuthEndpoint) {
      original._retry = true;
      // 追蹤 refresh 是否成功：僅 refresh 本身失敗代表 session 失效，才清空並導向登入；
      // refresh 成功後的重試失敗（如 500 / 網路錯誤）保留 session，只回傳重試錯誤
      let refreshSucceeded = false;
      try {
        const raw = localStorage.getItem(AUTH_STORAGE_KEY);
        const { tokens } = raw ? JSON.parse(raw) : { tokens: null };
        if (!tokens?.refreshToken) throw error;
        refreshing ??= api
          .post("/auth/refresh", { refreshToken: tokens.refreshToken })
          .then((r) => ({
            accessToken: r.data.accessToken as string,
            refreshToken: r.data.refreshToken as string,
          }))
          .finally(() => { refreshing = null; });
        const { accessToken, refreshToken } = await refreshing;
        refreshSucceeded = true;
        const rawStore = localStorage.getItem(AUTH_STORAGE_KEY);
        if (rawStore) {
          const store = JSON.parse(rawStore);
          store.tokens = { accessToken, refreshToken };
          localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(store));
        }
        useAuth.setState({ tokens: { accessToken, refreshToken } });
        original.headers.Authorization = `Bearer ${accessToken}`;
        return await api(original);
      } catch (retryError) {
        if (!refreshSucceeded) {
          // refresh 本身失敗：session 已失效，清除並導向登入
          try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* 忽略 */ }
          useAuth.setState({ user: null, tokens: null, teamId: null });
          navigation.redirectToLogin();
          throw error;
        }
        // refresh 成功但重試失敗：session 仍健康，僅回傳重試錯誤
        throw retryError;
      }
    }
    return Promise.reject(error);
  }
);
