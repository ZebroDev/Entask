import { describe, expect, it, vi, beforeEach } from "vitest";
import { useNotificationStore } from "./notificationStore";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

describe("notificationStore API 路徑", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.getState().resetNotifications();
  });

  it("fetchNotifications 以無 /api 前綴呼叫 GET /notifications（axios baseURL 已含 /api）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ id: "n1", type: "comment", title: "新留言", message: "", createdAt: "2026-09-15T12:00:00Z", read: false }],
    });

    await useNotificationStore.getState().fetchNotifications();

    expect(api.get).toHaveBeenCalledWith("/notifications");
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("markAsRead 以無 /api 前綴呼叫 PUT /notifications/{id}/read", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.put).mockResolvedValue({});

    useNotificationStore.setState({
      notifications: [{ id: "n1", type: "comment", title: "t", message: "m", createdAt: "2026-09-15T12:00:00Z", read: false }],
    });
    await useNotificationStore.getState().markAsRead("n1");

    expect(api.put).toHaveBeenCalledWith("/notifications/n1/read");
  });

  it("markAllAsRead 以無 /api 前綴呼叫 PUT /notifications/read-all", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.put).mockResolvedValue({});

    await useNotificationStore.getState().markAllAsRead();

    expect(api.put).toHaveBeenCalledWith("/notifications/read-all");
  });

  it("fetchNotifications 收到非陣列回應（如 SPA fallback 的 HTML）時不污染狀態", async () => {
    const { api } = await import("@/lib/api");
    const existing = { id: "keep", type: "comment", title: "t", message: "m", createdAt: "2026-09-15T12:00:00Z", read: false };
    useNotificationStore.setState({ notifications: [existing] });
    vi.mocked(api.get).mockResolvedValue({ data: "<!doctype html><html>..." });

    await useNotificationStore.getState().fetchNotifications();

    expect(useNotificationStore.getState().notifications).toEqual([existing]);
  });
});
