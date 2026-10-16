namespace Entask.Core.Entities;

public class Label
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BoardId { get; set; }
    public Board Board { get; set; } = null!;
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#4f46e5";
    public string Position { get; set; } = "m";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
