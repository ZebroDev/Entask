namespace Entask.Core;

/// <summary>
/// 通知的**訊息變體維度**——前端 `notification-text.ts` 的 switch 依這個值選句子。
///
/// 與 <see cref="NotificationTypes"/> 的差別是「一列通知要講哪句話」。審查結果直接編碼進
/// kind（`review_approved` / `review_rejected` 而不是 `review_decided` ＋ payload.status）：
/// 前端因此不必在 kind 之內再 switch 一次，標籤表也維持「一列一個 kind」的形狀。
///
/// 守門員是 `web/scripts/check-label-tables.mjs` 的第十張表（與前端的 switch 集合相等）。
/// 前端漏一個 case 時的症狀是**靜默**的：`default` 回空字串 → 走舊列回退 → 顯示
/// `me:notification.fallback.*`，不會印出識別碼、不會紅、也沒有日誌。
///
/// **值不可重新命名**：它們已經寫進 `Notifications.Kind`。
/// </summary>
public static class NotificationKinds
{
    public const string CommentCreated  = "comment_created";
    public const string CardAssigned    = "card_assigned";
    public const string ReviewRequested = "review_requested";
    public const string ReviewApproved  = "review_approved";
    public const string ReviewRejected  = "review_rejected";

    public static readonly string[] All =
        [CommentCreated, CardAssigned, ReviewRequested, ReviewApproved, ReviewRejected];
}
