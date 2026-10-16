namespace Entask.Core.Entities;

public class RefreshToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string TokenHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    /// <summary>撤銷原因（`RevokedReasons` 之一）。**既有列為 null**＝原因不明 ⇒ 不給寬限窗。</summary>
    public string? RevokedReason { get; set; }
    public string? CreatedByIp { get; set; }
    public DateTime CreatedAt { get; set; }
}
