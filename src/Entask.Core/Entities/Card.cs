namespace Entask.Core.Entities;

public class Card
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ListId { get; set; }
    public BoardList List { get; set; } = null!;
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string Position { get; set; } = "m";
    public DateTime? StartAt { get; set; }
    public DateTime? DueAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public decimal? EstimatedHours { get; set; }
    public Guid? CoverAttachmentId { get; set; }
    public bool IsArchived { get; set; }
    public Guid CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public ICollection<CardMember> Members { get; set; } = [];
    public ICollection<CardLabel> Labels { get; set; } = [];
    public ICollection<Checklist> Checklists { get; set; } = [];
    public ICollection<ActivityItem> Activities { get; set; } = [];
    public ICollection<Attachment> Attachments { get; set; } = [];
    public ICollection<CardReview> Reviews { get; set; } = [];
    public List<CardReviewEntry> ReviewEntries { get; set; } = [];
    public ICollection<EffortLog> EffortLogs { get; set; } = [];
    public ICollection<CardFieldValue> FieldValues { get; set; } = [];
}
