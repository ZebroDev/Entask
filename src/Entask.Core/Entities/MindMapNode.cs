namespace Entask.Core.Entities;

public class MindMapNode
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid MindMapId { get; set; }
    public MindMap MindMap { get; set; } = null!;
    public Guid? ParentId { get; set; }
    public MindMapNode? Parent { get; set; }
    public string Title { get; set; } = "";
    public string? Note { get; set; }
    public string Position { get; set; } = "m";
    public double? PositionX { get; set; }
    public double? PositionY { get; set; }
    public Guid? CardId { get; set; }
    public Card? Card { get; set; }
    public Guid CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public ICollection<MindMapNode> Children { get; set; } = [];
}
