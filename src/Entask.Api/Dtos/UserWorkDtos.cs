namespace Entask.Api.Dtos;

public record MyWorkCardItem(
    Guid Id,
    string Title,
    Guid ProjectId,
    string ProjectName,
    Guid BoardId,
    string BoardName,
    Guid ListId,
    string ListName,
    DateTime? DueAt,
    DateTime? CompletedAt,
    bool IsOverdue,
    List<string> Labels,
    int ChecklistTotal,
    int ChecklistCompleted
);

public record MyPendingReviewItem(
    Guid CardId,
    string CardTitle,
    Guid ProjectId,
    string ProjectName,
    Guid BoardId,
    string BoardName,
    DateTime? DueAt,
    string Status
);

public record MyWorkStats(
    int TotalAssigned,
    int DueToday,
    int Overdue,
    int InProgress,
    int Completed,
    int PendingReviews
);

public record MyWorkResponse(
    List<MyWorkCardItem> AssignedCards,
    List<MyPendingReviewItem> PendingReviews,
    MyWorkStats Stats
);
