namespace Entask.Api.Dtos;

public record CreateBoardRequest(string Name, string? Description);
public record UpdateBoardRequest(string? Name, string? Description, string? Position, bool? IsArchived);
public record BoardSummaryResponse(Guid Id, Guid ProjectId, string Name, string? Description, string Position, bool IsArchived);
public record BoardDetailResponse(Guid Id, Guid ProjectId, string Name, string? Description, string Position, bool IsArchived, List<ListResponse> Lists);
public record ListResponse(Guid Id, string Name, string Position, bool IsArchived, List<BoardCardResponse> Cards);
public record BoardCardResponse(Guid Id, Guid ListId, string Title, string Position, bool IsArchived, DateTime? DueAt, DateTime? CompletedAt, Guid? CoverAttachmentId, List<Guid> Labels, List<Guid> Members, int ChecklistDone, int ChecklistTotal, decimal LoggedHours, decimal? RemainingHours, string? ReviewState = null);
public record CreateListRequest(string Name);
public record UpdateListRequest(string? Name, string? Position, bool? IsArchived);
public record CreateLabelRequest(string Name, string Color);
public record UpdateLabelRequest(string? Name, string? Color, string? Position);
public record LabelResponse(Guid Id, string Name, string Color, string Position);

