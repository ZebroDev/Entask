import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NotificationPopover } from "./NotificationPopover";
import { useNotificationStore, type NotificationItem } from "@/lib/notificationStore";

const renderPopover = () =>
  render(
    <MemoryRouter>
      <NotificationPopover />
    </MemoryRouter>,
  );

/** Radix 的下拉選單由 pointerdown 開啟（`fireEvent.click` 不會開）。 */
const open = () => fireEvent.pointerDown(screen.getByRole("button", { name: "通知中心" }));

const withNotifications = (...items: NotificationItem[]) =>
  useNotificationStore.setState({ notifications: items });

describe("NotificationPopover", () => {
  beforeEach(() => {
    useNotificationStore.getState().resetNotifications();
  });

  it("依 kind 渲染標題與內文（不是後端的散文欄位）", async () => {
    withNotifications({
      id: "n1",
      type: "assigned",
      kind: "card_assigned",
      payload: { card: "登入頁異常" },
      createdAt: new Date().toISOString(),
      read: false,
      // 刻意留下散文：kind 認得時**不該**用它，否則新舊路徑分不出來
      title: "後端舊標題",
      message: "後端舊內文",
    });

    renderPopover();
    open();

    expect(await screen.findByText("卡片指派通知")).toBeInTheDocument();
    expect(screen.getByText("您已被指派至卡片「登入頁異常」")).toBeInTheDocument();
    expect(screen.queryByText("後端舊標題")).not.toBeInTheDocument();
    // 內文那一半也一起斷言：少了這一行時，把 body 改回讀 `message` 仍是全綠
    expect(screen.queryByText("後端舊內文")).not.toBeInTheDocument();
  });

  it("舊列（kind 為 null）顯示散文", async () => {
    withNotifications({
      id: "n2",
      type: "review",
      kind: null,
      payload: null,
      createdAt: new Date().toISOString(),
      read: true,
      title: "審查通過",
      message: "卡片「A」審查已由 小包 提交，狀態：approved",
    });

    renderPopover();
    open();

    expect(await screen.findByText("審查通過")).toBeInTheDocument();
    expect(screen.getByText("卡片「A」審查已由 小包 提交，狀態：approved")).toBeInTheDocument();
  });

  it("時間是相對時間，不是後端字串", async () => {
    withNotifications({
      id: "n3", type: "system", kind: null, payload: null,
      createdAt: new Date().toISOString(), read: false, title: "t", message: "m",
    });

    renderPopover();
    open();

    expect(await screen.findByText("剛剛")).toBeInTheDocument();
  });
});
