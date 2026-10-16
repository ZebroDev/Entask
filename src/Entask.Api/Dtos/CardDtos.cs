namespace Entask.Api.Dtos;

public record CreateCardRequest(string Title, string? Description);
public record UpdateCardMembersRequest(List<Guid> UserIds);
public record UpdateCardLabelsRequest(List<Guid> LabelIds);
public record CardResponse(Guid Id, Guid ListId, Guid BoardId, string Title, string? Description, string Position, bool IsArchived, DateTime? StartAt, DateTime? DueAt, DateTime? CompletedAt, decimal? EstimatedHours, Guid? CoverAttachmentId, Guid CreatedById, DateTime CreatedAt, DateTime UpdatedAt, List<Guid> Members, List<LabelResponse> Labels, List<ChecklistResponse> Checklists, List<AttachmentResponse> Attachments, List<CardFieldValueResponse> CustomFields, List<ReviewResponse> Reviews, string? ReviewState, EffortListResponse Effort, IReadOnlyList<MindMapNodeResponse> MindMapNodes);
public record AttachmentResponse(Guid Id, string FileName, string ContentType, long Size, DateTime CreatedAt);
public record MoveCardRequest(Guid ListId, string Position);
