namespace Entask.Api.Dtos;

public record SearchCardResult(
    Guid Id,
    Guid BoardId,
    string Title,
    string BoardName,
    string ListName,
    DateTime? DueAt,
    bool IsOverdue,
    string Highlight
);

public record SearchCommentResult(
    Guid Id,
    Guid CardId,
    Guid BoardId,
    string CardTitle,
    string Content,
    string AuthorName,
    DateTime CreatedAt,
    string Highlight
);

public record SearchNodeResult(
    Guid NodeId,
    string Title,
    string? Note,
    Guid? CardId,
    string? CardTitle,
    string Highlight
);

public record SearchResponse(
    IReadOnlyList<SearchCardResult> Cards,
    IReadOnlyList<SearchCommentResult> Comments,
    IReadOnlyList<SearchNodeResult> Nodes
);
