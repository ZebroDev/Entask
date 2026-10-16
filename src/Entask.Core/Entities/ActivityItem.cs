namespace Entask.Core.Entities;

public class ActivityItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid UserId { get; set; }
    public string Type { get; set; } = "";
    public string? Text { get; set; }
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
