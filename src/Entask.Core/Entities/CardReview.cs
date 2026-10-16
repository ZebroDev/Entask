namespace Entask.Core.Entities;

public class CardReview
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid ReviewerUserId { get; set; }
    public string Status { get; set; } = ReviewStatuses.Pending;
    public int? Score { get; set; }
    public string? Comment { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // 軟刪除（2026-09-18 設計 §4.1）：移除審查者改為設此欄位，null ＝現任。
    // **不動 UpdatedAt**——它的語意是「立場最後一次改變」。
    public DateTime? RemovedAt { get; set; }
}
