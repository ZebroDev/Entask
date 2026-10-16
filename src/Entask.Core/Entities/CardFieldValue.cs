namespace Entask.Core.Entities;

public class CardFieldValue
{
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid FieldDefinitionId { get; set; }
    public CustomFieldDefinition FieldDefinition { get; set; } = null!;
    public string ValueJson { get; set; } = "";
}
