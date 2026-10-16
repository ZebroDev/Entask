namespace Entask.Core.Entities;

public class Attachment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid UserId { get; set; }
    public string FileName { get; set; } = "";
    public string ContentType { get; set; } = "";
    public long Size { get; set; }
    public string StoragePath { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
