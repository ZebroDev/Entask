import { create } from "zustand";
import { api, invalidateInFlightRefresh } from "@/lib/api";
import { useNotificationStore } from "@/lib/notificationStore";
import { queryClient } from "@/lib/query-client";
import { AUTH_STORAGE_KEY } from "@/lib/storage-keys";

export interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  avatarUrl?: string;
}

interface Tokens { accessToken: string; refreshToken: string; }

interface AuthState {
  user: AuthUser | null;
  tokens: Tokens | null;
  teamId: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setTeamId: (teamId: string) => void;
  hydrate: () => void;
  updateProfile: (profile: Partial<AuthUser>) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  tokens: null,
  teamId: null,
  updateProfile: (profile) => set((state) => {
    if (!state.user) return state;
    const newUser = { ...state.user, ...profile };
    // teamId 必須一併寫回：請求攔截器由 storage 的 teamId 補 X-Team-Id，漏寫會使跨團隊操作失去團隊脈絡。
    // 請求攔截器以記憶體為準；storage 只負責持久化與跨分頁同步。
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      const stored = raw ? JSON.parse(raw) : null;
      // M-2：跨分頁切帳號期間（storage 事件尚未送達）不覆寫另一個帳號的記錄。
      if (!stored?.user || stored.user.userId === newUser.userId) {
        localStorage.setItem(
          AUTH_STORAGE_KEY,
          JSON.stringify({ user: newUser, tokens: state.tokens, teamId: state.teamId }),
        );
      }
    } catch {
      // 寫入失敗（隱私模式/配額滿）僅降級為記憶體內更新，不讓已成功的個人資料更新失敗
    }
    return { user: newUser };
  }),

  login: async (username, password) => {
    // 第一次 bump：讓登入開始前就在途的 refresh 失效（它屬於舊 session）。
    invalidateInFlightRefresh();
    const { data } = await api.post("/auth/login", { username, password });
    const user: AuthUser = {
      userId: data.userId,
      username: data.username,
      displayName: data.displayName,
      isAdmin: data.isAdmin,
      avatarUrl: data.avatarUrl,
    };
    const tokens: Tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
    // 寫入失敗（隱私模式/配額滿）只降級為 session 內存，不拒絕已成功的登入
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, tokens, teamId: null }));
    } catch {
      // 記憶體 session 仍可用，重新整理後需重登。
      // 舊帳號的記錄可能還在 storage：盡力清掉，否則重新載入會復活前一個帳號（M-2）。
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* 忽略 */ }
    }
    // 直接開 /login 重新登入（未經 logout）也是切換身分：先停掉前一帳號的 SignalR 連線
    // （連線建立時綁的是舊 token，getCollaborationHub 也不會因 token 變更而重建），
    // 再取消進行中請求、清空共用快取，避免新帳號看到舊帳號的私人資料。
    try {
      const { stopCollaboration } = await import("@/lib/collaboration");
      stopCollaboration();
    } catch {
      // 模組載入失敗不阻斷登入
    }
    try {
      await queryClient.cancelQueries();
    } catch {
      // 取消失敗不阻斷登入
    }
    queryClient.clear();
    // 第二次 bump：舊 session 的記憶體狀態一直保留到這一行（上面有動態 import 與
    // cancelQueries 兩個 await），期間新起的 401 仍會用舊 refresh token 發 refresh。
    // 在 `set` 之前再遞增一次，讓那些在窗內開始的 refresh 全部失效（H-2）。
    invalidateInFlightRefresh();
    set({ user, tokens, teamId: null });
    useNotificationStore.getState().resetNotifications();
  },

  logout: async () => {
    // 登出取代任何在途 refresh 的結果：它不得在使用者已登出後寫回憑證（H-2）。
    invalidateInFlightRefresh();
    const { tokens } = get();
    if (tokens) {
      try { await api.post("/auth/logout", { refreshToken: tokens.refreshToken }); } catch { /* 忽略 */ }
    }
    // 停止 SignalR 協作連線：登出後不得繼續收到協作事件/toast，presence 亦需清空
    try {
      const { stopCollaboration } = await import("@/lib/collaboration");
      stopCollaboration();
    } catch {
      // 模組載入失敗不阻斷登出
    }
    // F-01：查詢鍵（["projects"] 等）不含使用者身分，而 QueryClientProvider 掛在 SPA 根部、
    // 登出不會重建。不清快取的話，同一頁面工作階段改由另一帳號登入時，會先看到前一帳號
    // 尚未過期（staleTime 30s）的私人資料。先取消進行中的請求，再整批清除。
    try {
      await queryClient.cancelQueries();
    } catch {
      // 取消失敗不阻斷登出
    }
    queryClient.clear();
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // 忽略
    }
    // 同 login：登出 POST 與動態 import 的 await 期間可能新起 refresh，這裡再封一次窗。
    invalidateInFlightRefresh();
    set({ user: null, tokens: null, teamId: null });
    useNotificationStore.getState().resetNotifications();
  },

  // 不變量：必須逐字原樣儲存參數，不得正規化（lowercase/trim 等）。
  // RequireTeamManagement.tsx 的閘門依賴「useParams teamId === session teamId」做字串比對；
  // 若此處對輸入做任何轉換，needsTeamSwitch 會永遠為 true → 閘門永久空白，且無任何錯誤訊息。
  setTeamId: (teamId) => {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // M-2：不把團隊寫進另一個帳號的記錄（跨分頁切帳號的空窗）。
        const currentUserId = get().user?.userId;
        if (!parsed.user || !currentUserId || parsed.user.userId === currentUserId) {
          parsed.teamId = teamId;
          localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(parsed));
        }
      }
    } catch {
      // 儲存不可用時僅更新記憶體
    }
    set({ teamId });
  },

  hydrate: () => {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw) {
        const { user, tokens, teamId } = JSON.parse(raw);
        set({ user, tokens, teamId });
      }
    } catch {
      // 內容損壞：清除後以未登入狀態啟動，避免白屏
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* 忽略 */ }
    }
  },
}));

let storageSyncRegistered = false;

function stopCollaborationQuietly(): void {
  void import("@/lib/collaboration")
    .then(({ stopCollaboration }) => stopCollaboration())
    .catch(() => { /* 模組載入失敗不阻斷同步 */ });
}

/**
 * 跨分頁 session 同步（F-04 配套）。
 *
 * 請求攔截器以記憶體為準是身分隔離的前提；但 localStorage 是多分頁共享的輪替來源。
 * 沒有這個 listener，另一個分頁 refresh 後本頁記憶體仍是舊 token：請求會多一次 401，
 * 更糟的是舊 refresh token 一旦超過 5 秒寬限窗就會被伺服器判定為重放，撤銷該使用者
 * **所有** session（JwtTokenService 的 Replayed 分支）。跨分頁登出也會失效。
 *
 * 只訂閱 storage 事件（瀏覽器只會在其他分頁寫入時觸發，不會回彈自己）。
 */
export function registerAuthStorageSync(): void {
  if (storageSyncRegistered || typeof window === "undefined") return;
  storageSyncRegistered = true;

  window.addEventListener("storage", (event) => {
    if (event.key !== AUTH_STORAGE_KEY) return;

    if (event.newValue === null) {
      // 其他分頁登出：本頁同步失效，不留下可用的憑證與前一帳號的快取。
      invalidateInFlightRefresh();
      useAuth.setState({ user: null, tokens: null, teamId: null });
      queryClient.clear();
      useNotificationStore.getState().resetNotifications();
      stopCollaborationQuietly();
      return;
    }

    try {
      const parsed = JSON.parse(event.newValue) as {
        user: AuthUser | null;
        tokens: Tokens | null;
        teamId: string | null;
      };
      const current = useAuth.getState();
      const identityChanged = !!current.user && !!parsed.user
        && current.user.userId !== parsed.user.userId;
      // 只有憑證或身分改變才代表 session 基準變了。其他分頁的 updateProfile／setTeamId
      // 也會寫同一個 key；一律視為換 session 會誤丟本頁正在跑的 refresh（H-2 誤報），
      // 輕則原請求白失敗一次，重則把可用的 401 重試路徑打斷。
      const tokensChanged = parsed.tokens?.refreshToken !== current.tokens?.refreshToken;
      if (identityChanged || tokensChanged) invalidateInFlightRefresh();

      // 身分改變（跨分頁切帳號）：前一帳號的快取、通知與協作連線都不得沿用。
      if (identityChanged) {
        queryClient.clear();
        useNotificationStore.getState().resetNotifications();
        stopCollaborationQuietly();
      }

      // 同帳號的 token 輪替／teamId 變更也在這裡吸收：本頁記憶體跟上其他分頁的最新狀態。
      useAuth.setState({ user: parsed.user, tokens: parsed.tokens, teamId: parsed.teamId });
    } catch {
      // 損壞內容：保留本頁 session，等待下一次寫入
    }
  });
}
