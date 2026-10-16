import { create } from "zustand";
import { api } from "@/lib/api";
import { useNotificationStore } from "@/lib/notificationStore";
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
    // 寫入失敗（隱私模式/配額滿）僅降級為記憶體內更新，不讓已成功的個人資料更新失敗。
    try {
      localStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({ user: newUser, tokens: state.tokens, teamId: state.teamId }),
      );
    } catch {
      // 記憶體 session 仍可用
    }
    return { user: newUser };
  }),

  login: async (username, password) => {
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
      // 記憶體 session 仍可用，重新整理後需重登
    }
    set({ user, tokens, teamId: null });
    useNotificationStore.getState().resetNotifications();
  },

  logout: async () => {
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
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // 忽略
    }
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
        parsed.teamId = teamId;
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(parsed));
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
