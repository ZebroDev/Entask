namespace Entask.Board.Positioning;

public static class PositionValidator
{
    public const int MaxLength = 100;
    private const string Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    public static bool IsValid(string? position) =>
        !string.IsNullOrWhiteSpace(position) &&
        position.Length <= MaxLength &&
        position.All(Digits.Contains);
}
