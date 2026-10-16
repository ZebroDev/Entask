namespace Entask.Core.Entities;

public class Permission
{
    public Guid Id { get; set; }
    public string Code { get; set; } = "";
    public string Category { get; set; } = "";
    public string Description { get; set; } = "";
}
