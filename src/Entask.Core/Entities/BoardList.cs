using System.ComponentModel.DataAnnotations.Schema;

namespace Entask.Core.Entities;

[Table("Lists")]
public class BoardList
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid BoardId { get; set; }
    public Board Board { get; set; } = null!;
    public string Name { get; set; } = "";
    public string Position { get; set; } = "m";
    public bool IsArchived { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
