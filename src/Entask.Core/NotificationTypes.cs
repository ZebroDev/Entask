namespace Entask.Core;

/// <summary>
/// 通知的**偏好維度**——`NotificationPreference.Type` 用的就是這組值。
///
/// 與 <see cref="NotificationKinds"/> 是兩個維度，刻意分開：`review` 這個 type 同時承載
/// 「審查請求」與「審查結果」兩種句子，而偏好的顆粒度不該跟著句子走（使用者要的是
/// 「審查相關通知」一個開關）。前端 `UserSettingsDialog` 的偏好清單列的也是這四個。
///
/// **值不可重新命名**：它們已經寫進 `Notifications.Type` 與 `NotificationPreferences.Type`
/// 兩張表。
/// </summary>
public static class NotificationTypes
{
    public const string Comment  = "comment";
    public const string Assigned = "assigned";
    public const string Review   = "review";
    public const string System   = "system";

    public static readonly string[] All = [Comment, Assigned, Review, System];
}
