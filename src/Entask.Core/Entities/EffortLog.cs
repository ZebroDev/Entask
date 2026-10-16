namespace Entask.Core.Entities;

public class EffortLog
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid UserId { get; set; }
    public decimal Hours { get; set; }
    public string? Note { get; set; }
    public DateTime LoggedAt { get; set; } = DateTime.UtcNow;

    /// <summary>工作日（凍結）：寫入當下的作者本地日；補登時為使用者指定的那一天。
    /// 報告的分桶與區間篩選從此用它，不再從 `LoggedAt` 推導（Q1／R5）。</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>填報牆鐘（凍結）：寫入當下的作者本地時間（`Kind=Unspecified`）。
    /// 補登時仍是**填報當下**，不是補登的那一天。匯出的「填報時間」欄用它。</summary>
    public DateTime LoggedAtLocal { get; set; }
}
