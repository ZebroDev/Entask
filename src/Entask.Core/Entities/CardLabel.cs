namespace Entask.Core.Entities;

public class CardLabel
{
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid LabelId { get; set; }
    public Label Label { get; set; } = null!;
}
