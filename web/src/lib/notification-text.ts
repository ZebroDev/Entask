// 通知的文案。與 `error-messages.ts`／`custom-fields.ts` 同一個寫法：非元件的模組直接呼叫
// `i18n.t`，**在每次呼叫時求值**——`notificationStore.addNotification` 的 toast 在 React
// 之外執行，用不了 hook。
//
// 為什麼是 switch ＋ 字面值而不是查表（P-B2-2b 定案）：`i18next-parser` 只認字面值引數，
// 而它的 `keepRemoved: false` 會把「原始碼裡找不到」的 key 從語系檔刪掉——畫面只顯示 key
// 本身，沒有錯誤、沒有警告、測試也不會紅。查表等於把整份通知文案變成靜默失效。
//
// **這一類不在「譯文不得穿過不隨語系重算的邊界」的轄區**：通知是事件不是狀態
// （與 `error-messages.ts` 同源）。`NotificationPopover` 自己呼叫 `useTranslation`，
// 所以切換語系時清單會重繪；toast 一旦顯示就是那個字串。
import i18n from "@/i18n";
import { formatRelativeTime } from "@/lib/format";
import type { NotificationItem, NotificationPayload } from "@/lib/notificationStore";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * kind → 標題。認不得回空字串，由呼叫端決定回退。
 * **`check-label-tables.mjs` 的第十張表鎖的就是這個 switch 與 `NotificationKinds.All` 的集合相等。**
 */
function titleFor(kind: string): string {
  switch (kind) {
    case "comment_created":
      return i18n.t("me:notification.comment.title");
    case "card_assigned":
      return i18n.t("me:notification.assigned.title");
    case "review_requested":
      return i18n.t("me:notification.review.title");
    case "review_approved":
      return i18n.t("me:notification.approved.title");
    case "review_rejected":
      return i18n.t("me:notification.rejected.title");
    default:
      return "";
  }
}

/** kind → 內文。第十張表也涵蓋這個 switch（它掃的是整檔的 case）。 */
function bodyFor(kind: string, params: Record<string, string | number>): string {
  switch (kind) {
    case "comment_created":
      return i18n.t("me:notification.comment.body", params);
    case "card_assigned":
      return i18n.t("me:notification.assigned.body", params);
    case "review_requested":
      return i18n.t("me:notification.review.body", params);
    case "review_approved":
      return i18n.t("me:notification.approved.body", params);
    case "review_rejected":
      return i18n.t("me:notification.rejected.body", params);
    default:
      return "";
  }
}

/** 標題：kind 優先，其次舊列散文，最後通用文案。 */
export function notificationTitle(item: NotificationItem): string {
  return titleFor(item.kind ?? "") || item.title || i18n.t("me:notification.fallback.title");
}

/** 內文：同上。`{{score}}` 先算成字串再傳進外層訊息（巢狀的呼叫不會被 parser 抽出）。 */
export function notificationBody(item: NotificationItem): string {
  const p: NotificationPayload = item.payload ?? {};
  const score =
    typeof p.score === "number" ? i18n.t("me:notification.scoreSuffix", { score: p.score }) : "";
  const params = { actor: str(p.actor), card: str(p.card), score };
  return bodyFor(item.kind ?? "", params) || item.message || i18n.t("me:notification.fallback.body");
}

/**
 * 時間：一分鐘內是「剛剛」，其餘交給 `formatRelativeTime`。
 *
 * 門檻留在這一支而不是 `format.ts`：`format.ts` 是全站通用的格式化出口，
 * 讓它去讀 `me` namespace 的譯文會讓通用模組依賴某個功能（與 `formatDay` 例外地
 * 呼叫 `common:date.dayWithWeekday` 不同——那是 `common`，是全站共用的詞）。
 */
export function notificationTime(item: NotificationItem): string {
  const then = new Date(item.createdAt).getTime();
  if (!Number.isFinite(then)) return "";
  if (Date.now() - then < 60_000) return i18n.t("me:notification.time.justNow");
  return formatRelativeTime(item.createdAt);
}
