namespace Entask.Core.Entities;

/// <summary>
/// 一列通知。
///
/// `Title` / `Message` 自 2026-09-15（P-C Followups）起**新的列一律為 null**——文案改由前端
/// 依 `Kind` ＋ `Payload` 渲染（系統沒有 per-user 語系，後端在寫入當下無從得知收件者語系）。
/// 兩欄留著是**舊列的回退來源**：Fly 上的既有資料是當時寫入的中文散文，那條路徑會被走到，
/// 不是死碼。欄位由 NOT NULL 放寬為 NULL 是安全方向。
/// </summary>
public class Notification
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    /// <summary>偏好維度，見 <see cref="NotificationTypes"/>。</summary>
    public string Type { get; set; } = "";
    /// <summary>訊息變體，見 <see cref="NotificationKinds"/>。舊列為 null。</summary>
    public string? Kind { get; set; }
    /// <summary>jsonb。只放資料（人名、卡片標題、分數），不放任何譯文。舊列為 null。</summary>
    public string? Payload { get; set; }
    public string? Title { get; set; }
    public string? Message { get; set; }
    public string? Link { get; set; }
    public bool IsRead { get; set; } = false;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
