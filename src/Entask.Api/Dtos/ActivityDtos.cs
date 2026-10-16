namespace Entask.Api.Dtos;

public record ActivityResponse(Guid Id, Guid CardId, Guid UserId, string Username, string DisplayName, string Type, string? Text, string? Detail, DateTime CreatedAt);
public record CreateCommentRequest(string Text);
