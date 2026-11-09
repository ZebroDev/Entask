import axios from "axios";
import { useAuth } from "@/stores/auth";
import { queryClient } from "@/lib/query-client";
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

// H-2（安全審查 2026-11-09）：refresh 是模組層 single-flight，但發起它的 session 可能在
// 回應抵達前就被替換（登出、直接開 /login 重新登入、其他分頁切帳號）。login/logout/
// 跨分頁同步都會遞增世代號；refresh 的續傳與失敗處置只在世代號未變時才可寫回或清除，
// 否則 A 的 refresh 結果會蓋掉 B 剛建立的 session。
let sessionEpoch = 0;

/** 在 session 被替換時呼叫：丟棄所有在途 refresh 的結果，並讓後續 refresh 另起新請求。 */
export function invalidateInFlightRefresh(): void {
  sessionEpoch += 1;
  refreshing = null;
}

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
  // F-04：記憶體 session 才是請求憑證的唯一來源。隱私模式/配額滿時登入的 setItem 會失敗，
  // token 只存在 Zustand；若只讀 storage，登入成功後的第一個請求就沒有 Authorization
  // （401 → 被導回登入頁）。反向也不回退 storage：記憶體已登出時讀 storage 會讓舊憑證
  // 復活（M-2）；跨分頁登入／登出由 `registerAuthStorageSync` 同步到記憶體。
  const { tokens, teamId } = useAuth.getState();
  if (tokens) config.headers.Authorization = `Bearer ${tokens.accessToken}`;
  // 請求已自帶 X-Team-Id 時不覆寫（跨團隊操作如建立專案、專案複製以請求層 header 指定團隊）
  if (teamId && !config.headers["X-Team-Id"]) config.headers["X-Team-Id"] = teamId;
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
      const epochAtStart = sessionEpoch;
      try {
        // F-04：與請求攔截器同一原則——憑證只取記憶體 session，storage 僅為持久化。
        const initiatingRefreshToken = useAuth.getState().tokens?.refreshToken ?? null;
        if (!initiatingRefreshToken) throw error;
        if (!refreshing) {
          const request = api
            .post("/auth/refresh", { refreshToken: initiatingRefreshToken })
            .then((r) => ({
              accessToken: r.data.accessToken as string,
              refreshToken: r.data.refreshToken as string,
            }))
            .finally(() => {
              // 只清掉自己：invalidateInFlightRefresh 可能已換上新的 promise
              if (refreshing === request) refreshing = null;
            });
          refreshing = request;
        }
        const { accessToken, refreshToken: newRefreshToken } = await refreshing;
        // H-2：session 已被替換時丟棄這組憑證——寫回等於把 A 的 token 套進 B 的登入狀態。
        if (epochAtStart !== sessionEpoch) throw error;
        // L-4：畸形回應不得在 store 種下 "Bearer undefined"。
        if (!accessToken || !newRefreshToken) throw error;
        refreshSucceeded = true;
        // 持久化是盡力而為：storage 寫入/讀取失敗不得把已成功的 refresh 當成 session 失效。
        // 身份守衛（M-2）：storage 記錄屬於另一個帳號時不覆寫，避免做出
        // `{user: B, tokens: A}` 這種混合記錄——重新載入會變成 B 的身分帶 A 的憑證。
        try {
          const current = useAuth.getState();
          const rawStore = localStorage.getItem(AUTH_STORAGE_KEY);
          const stored = rawStore ? JSON.parse(rawStore) : null;
          if (current.user && (!stored?.user || stored.user.userId === current.user.userId)) {
            localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
              user: current.user,
              tokens: { accessToken, refreshToken: newRefreshToken },
              teamId: current.teamId,
            }));
          }
        } catch {
          // 記憶體 session 仍可用
        }
        useAuth.setState({ tokens: { accessToken, refreshToken: newRefreshToken } });
        original.headers.Authorization = `Bearer ${accessToken}`;
        return await api(original);
      } catch (retryError) {
        // H-2：session 已換 ⇒ 這次 refresh（無論成敗）都不屬於目前 session，
        // 不得清除或覆寫它；把原始 401 還給呼叫端。
        if (epochAtStart !== sessionEpoch) throw error;
        if (!refreshSucceeded) {
          // refresh 本身失敗：session 已失效，清除並導向登入。
          // 查詢快取也要清（F-01／L-10）：強制登出後不得留著前一帳號的資料。
          try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* 忽略 */ }
          useAuth.setState({ user: null, tokens: null, teamId: null });
          queryClient.clear();
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
