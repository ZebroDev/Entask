import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import { notificationBody, notificationTitle } from "@/lib/notification-text";

let _navigate: ((path: string) => void) | null = null;
export function setNotificationNavigate(fn: (path: string) => void) { _navigate = fn; }

/** 通知的 payload。只放資料（人名、卡片標題、分數），不放任何譯文。 */
export interface NotificationPayload {
  actor?: string;
  card?: string;
  score?: number;
}

export interface NotificationItem {
  id: string;
  /** 偏好維度（後端 NotificationTypes）。 */
  type: string;
  /** 訊息變體（後端 NotificationKinds）。舊列為 null。 */
  kind?: string | null;
  payload?: NotificationPayload | null;
  /** ISO 8601 UTC。 */
  createdAt: string;
  read: boolean;
  link?: string | null;
  /** 舊列（payload 為 null）的散文回退來源；新列為 null。 */
  title?: string | null;
  message?: string | null;
}

/** SignalR 推播的酬載：欄位與 REST 相同，但傳輸途中沒有型別檢查，所以每一欄都可能缺席。 */
export type NotificationPush = Partial<NotificationItem> & { id?: string };

interface NotificationState {
  notifications: NotificationItem[];
  unreadCount: () => number;
  fetchNotifications: () => Promise<void>;
  addNotification: (item: NotificationItem) => void;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  resetNotifications: () => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: () => get().notifications.filter((n) => !n.read).length,
  resetNotifications: () => set({ notifications: [] }),
  fetchNotifications: async () => {
    try {
      const { data } = await api.get("/notifications");
      // 回應形狀守護：非陣列（如代理/fallback 回傳的 HTML）不得寫入狀態，否則 .filter/.map 會崩潰整棵 React 樹
      if (!Array.isArray(data)) throw new Error("unexpected notifications payload");
      set({ notifications: data });
    } catch (error) {
      console.error("Failed to fetch notifications", error);
    }
  },
  addNotification: (item) => {
    set((state) => {
      const updated = [item, ...state.notifications.filter((n) => n.id !== item.id)].slice(0, 50);
      return { notifications: updated };
    });

    // 文案在**這裡**求值：toast 是事件不是狀態，一旦顯示就是那個字串
    // （與 `error-messages.ts` 同源）。清單那一側由 popover 自己重繪。
    const title = notificationTitle(item);
    const toastKey = item.link || `${item.type}-${title}`;
    toast(title, {
      id: toastKey,
      description: notificationBody(item),
      action: item.link
        ? {
            label: i18n.t("common:action.view"),
            onClick: () => {
              if (_navigate) _navigate(item.link!);
              else window.location.href = item.link!;
            },
          }
        : undefined,
    });
  },
  markAsRead: async (id) => {
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
    }));
    try {
      await api.put(`/notifications/${id}/read`);
    } catch (error) {
      console.error("Failed to mark as read", error);
    }
  },
  markAllAsRead: async () => {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    }));
    try {
      await api.put("/notifications/read-all");
    } catch (error) {
      console.error("Failed to mark all as read", error);
    }
  },
}));
