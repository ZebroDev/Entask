namespace Entask.Core.Entities;

public class NotificationPreference
{
    public Guid UserId { get; set; }
    public string Type { get; set; } = "";
    public bool InAppEnabled { get; set; } = true;
    public bool EmailEnabled { get; set; } = false;
}
