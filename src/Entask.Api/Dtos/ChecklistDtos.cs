namespace Entask.Api.Dtos;

public record CreateChecklistRequest(string Title);
public record UpdateChecklistRequest(string? Title, string? Position);
public record ChecklistResponse(Guid Id, string Title, string Position, List<ChecklistItemResponse> Items);
public record ChecklistItemResponse(Guid Id, string Text, bool IsChecked, string Position);
public record CreateChecklistItemRequest(string Text);
public record UpdateChecklistItemRequest(string? Text, bool? IsChecked, string? Position);
