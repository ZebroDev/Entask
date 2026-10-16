namespace Entask.Core.Entities;

public class ChecklistItem
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ChecklistId { get; set; }
    public Checklist Checklist { get; set; } = null!;
    public string Text { get; set; } = "";
    public bool IsChecked { get; set; }
    public string Position { get; set; } = "m";
}
