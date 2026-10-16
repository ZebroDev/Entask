namespace Entask.Api.Dtos;

// `Deactivated` 同 `MemberResponse`：卡片視圖保留既有指派者 ＋ 標記（設計 D7）。
public record CardAssigneeSummary(Guid UserId, string Username, string DisplayName, bool Deactivated);
public record ChecklistProgressSummary(int Total, int Completed);

public record ProjectCardItem(
    Guid Id,
    string Title,
    Guid BoardId,
    string BoardName,
    Guid ListId,
    string ListName,
    DateTime? StartAt,
    DateTime? DueAt,
    DateTime? CompletedAt,
    bool IsOverdue,
    bool IsArchived,
    IReadOnlyList<CardAssigneeSummary> Assignees,
    IReadOnlyList<string> LabelNames,
    decimal? EstimatedHours,
    decimal LoggedHours,
    ChecklistProgressSummary ChecklistProgress,
    string? ReviewState = null
);

public record ProjectCardsResponse(
    IReadOnlyList<ProjectCardItem> Items,
    int Total,
    int Page,
    int PageSize
);
