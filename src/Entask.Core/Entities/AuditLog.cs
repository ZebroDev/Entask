namespace Entask.Core.Entities;

public class AuditLog
{
    public Guid Id { get; set; }
    public Guid? UserId { get; set; }
    public Guid? TeamId { get; set; }
    public Guid? ProjectId { get; set; }
    public string Action { get; set; } = "";
    public string EntityType { get; set; } = "";
    public Guid EntityId { get; set; }
    public string? EntityTitle { get; set; }
    public string? Detail { get; set; } // JSONB
    public DateTime CreatedAt { get; set; }
}
