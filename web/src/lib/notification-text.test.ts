import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationBody, notificationTime, notificationTitle } from "./notification-text";
import type { NotificationItem } from "./notificationStore";
import { setLocale } from "@/i18n";

const item = (over: Partial<NotificationItem>): NotificationItem => ({
  id: "n1",
  type: "comment",
  createdAt: new Date().toISOString(),
  read: false,
  ...over,
});

describe("notification-text", () => {
  afterEach(async () => {
    await setLocale(null);
  });

  it("五個 kind 各有標題與內文", () => {
    expect(notificationTitle(item({ kind: "comment_created", payload: { actor: "小包", card: "登入頁異常" } }))).toBe("新留言通知");
    expect(notificationBody(item({ kind: "comment_created", payload: { actor: "小包", card: "登入頁異常" } }))).toBe("小包 在卡片「登入頁異常」留了言");

    expect(notificationTitle(item({ kind: "card_assigned", payload: { card: "登入頁異常" } }))).toBe("卡片指派通知");
    expect(notificationBody(item({ kind: "card_assigned", payload: { card: "登入頁異常" } }))).toBe("您已被指派至卡片「登入頁異常」");

    expect(notificationTitle(item({ kind: "review_requested", payload: { card: "登入頁異常" } }))).toBe("審查請求");
    expect(notificationBody(item({ kind: "review_requested", payload: { card: "登入頁異常" } }))).toBe("您被指派審查卡片「登入頁異常」");

    expect(notificationTitle(item({ kind: "review_approved", payload: { actor: "小包", card: "登入頁異常", score: 5 } }))).toBe("審查通過");
    expect(notificationBody(item({ kind: "review_approved", payload: { actor: "小包", card: "登入頁異常", score: 5 } }))).toBe("卡片「登入頁異常」審查已由 小包 提交，評分 5");

    expect(notificationTitle(item({ kind: "review_rejected", payload: { actor: "小包", card: "登入頁異常" } }))).toBe("審查被退回");
    expect(notificationBody(item({ kind: "review_rejected", payload: { actor: "小包", card: "登入頁異常" } }))).toBe("卡片「登入頁異常」審查已由 小包 退回");
  });

  it("沒有分數時不留下空的評分尾綴", () => {
    const body = notificationBody(item({ kind: "review_approved", payload: { actor: "小包", card: "A" } }));
    expect(body).toBe("卡片「A」審查已由 小包 提交");
    expect(body).not.toContain("評分");
  });

  it("認不得的 kind 走舊列散文回退", () => {
    expect(notificationTitle(item({ kind: null, title: "舊標題", message: "舊內文" }))).toBe("舊標題");
    expect(notificationBody(item({ kind: null, title: "舊標題", message: "舊內文" }))).toBe("舊內文");
  });

  it("kind 認不得且散文也空時走 fallback", () => {
    expect(notificationTitle(item({ kind: null }))).toBe("通知");
    expect(notificationBody(item({ kind: null }))).toBe("您有一則通知");
  });

  describe("相對時間", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const at = (msAgo: number) => item({ createdAt: new Date(Date.now() - msAgo).toISOString() });

    it("一分鐘內是「剛剛」", () => {
      expect(notificationTime(at(0))).toBe("剛剛");
      expect(notificationTime(at(59_000))).toBe("剛剛");
    });

    it("一分鐘以上交給 formatRelativeTime", () => {
      expect(notificationTime(at(60_000))).toBe("1 分鐘前");
      expect(notificationTime(at(3 * 3_600_000))).toBe("3 小時前");
      expect(notificationTime(at(2 * 86_400_000))).toBe("2 天前");
    });

    it("七天以上是絕對日期", () => {
      expect(notificationTime(at(30 * 86_400_000))).not.toContain("前");
    });
  });

  it("en 之下同樣的五個 kind 是英文（zh-TW 全綠擋不住寫死中文）", async () => {
    await setLocale("en");

    expect(notificationTitle(item({ kind: "comment_created" }))).toBe("New comment");
    expect(notificationBody(item({ kind: "comment_created", payload: { actor: "Bob", card: "Login" } }))).toBe("Bob commented on “Login”");
    expect(notificationTitle(item({ kind: "review_rejected" }))).toBe("Review rejected");
    // 標題與內文必須用同一個詞指同一件事：zh 兩處都是「退回」，英文卻一度是標題
    // rejected、內文 returned（zh-TW 斷言全綠也看不到，因為中文沒有這個區別）。
    expect(notificationBody(item({ kind: "review_rejected", payload: { actor: "Bob", card: "Login" } }))).toBe("“Login” was rejected by Bob");
    // 「您被指派審查」是明確的指派動作（同檔 me:review.open.action 是 Open review），
    // 不是邀請——所以是 assigned，不是 asked。
    expect(notificationBody(item({ kind: "review_requested", payload: { card: "Login" } }))).toBe("You were assigned to review “Login”");
    expect(notificationBody(item({ kind: "review_approved", payload: { actor: "Bob", card: "Login", score: 5 } }))).toBe("“Login” was approved by Bob, score 5");
    expect(notificationTime(item({ createdAt: new Date().toISOString() }))).toBe("Just now");
  });
});
