namespace Entask.Core.Entities;

public class Checklist
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public string Title { get; set; } = "";
    public string Position { get; set; } = "m";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public ICollection<ChecklistItem> Items { get; set; } = [];
}
