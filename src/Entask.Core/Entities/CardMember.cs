namespace Entask.Core.Entities;

public class CardMember
{
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid UserId { get; set; }
}
