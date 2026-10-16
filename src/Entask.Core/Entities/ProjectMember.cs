namespace Entask.Core.Entities;

public class ProjectMember
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public Guid UserId { get; set; }
    public Guid RoleId { get; set; }
    public Role Role { get; set; } = null!;
    public DateTime JoinedAt { get; set; }

    /// <summary>到職的本地日（凍結）：寫入當下以**動作發起人**的時區換算（Q1／R6）。
    /// 讀取端的預期工作日夾擠用它，不再對 `JoinedAt` 做時區換算。</summary>
    public DateOnly JoinedLocalDate { get; set; }
}
