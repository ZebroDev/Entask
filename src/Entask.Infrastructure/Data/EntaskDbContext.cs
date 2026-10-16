using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Entask.Core.Entities;
using Entask.Identity.Models;

namespace Entask.Infrastructure.Data;

public class EntaskDbContext : IdentityDbContext<ApplicationUser, IdentityRole<Guid>, Guid>
{
    public EntaskDbContext(DbContextOptions<EntaskDbContext> options) : base(options) { }

    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<Permission> Permissions => Set<Permission>();
    // new：刻意隱藏 IdentityDbContext 的 Roles（IdentityRole<Guid>），兩者為不同資料表
    public new DbSet<Role> Roles => Set<Role>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<Team> Teams => Set<Team>();
    public DbSet<TeamMember> TeamMembers => Set<TeamMember>();
    public DbSet<WorkCalendarException> WorkCalendarExceptions => Set<WorkCalendarException>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<Board> Boards => Set<Board>();
    public DbSet<BoardList> Lists => Set<BoardList>();
    public DbSet<Card> Cards => Set<Card>();
    public DbSet<CardMember> CardMembers => Set<CardMember>();
    public DbSet<Label> Labels => Set<Label>();
    public DbSet<CardLabel> CardLabels => Set<CardLabel>();
    public DbSet<Checklist> Checklists => Set<Checklist>();
    public DbSet<ChecklistItem> ChecklistItems => Set<ChecklistItem>();
    public DbSet<ActivityItem> ActivityItems => Set<ActivityItem>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<CardReview> CardReviews => Set<CardReview>();
    public DbSet<CardReviewEntry> CardReviewEntries => Set<CardReviewEntry>();
    public DbSet<EffortLog> EffortLogs => Set<EffortLog>();
    public DbSet<CustomFieldDefinition> CustomFieldDefinitions => Set<CustomFieldDefinition>();
    public DbSet<CardFieldValue> CardFieldValues => Set<CardFieldValue>();
    public DbSet<MindMap> MindMaps => Set<MindMap>();
    public DbSet<MindMapNode> MindMapNodes => Set<MindMapNode>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<NotificationPreference> NotificationPreferences => Set<NotificationPreference>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.Entity<ApplicationUser>().Property(u => u.DisplayName).HasMaxLength(100);
        builder.Entity<Permission>().HasIndex(p => p.Code).IsUnique();
        builder.Entity<RolePermission>().HasKey(rp => new { rp.RoleId, rp.PermissionId });
        builder.Entity<Role>().HasIndex(r => new { r.TeamId, r.Name }).IsUnique();
        builder.Entity<TeamMember>().HasIndex(m => new { m.TeamId, m.UserId, m.RoleId }).IsUnique();
        // 同一個團隊的同一天最多一列——PUT 是冪等更新（先查再寫），這條是最後一道防線
        builder.Entity<WorkCalendarException>().HasIndex(e => new { e.TeamId, e.Date }).IsUnique();
        builder.Entity<WorkCalendarException>()
            .HasOne(e => e.Team).WithMany().HasForeignKey(e => e.TeamId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<AuditLog>().Property(a => a.Detail).HasColumnType("jsonb");
        // 兩個稽核端點的唯一查詢形狀＝「某個範圍、依 CreatedAt／Id 遞減取前 n 列」
        // （`AuditLogEndpoints.QueryAsync`）⇒ 複合索引讓篩選、排序、截斷一次解完
        // （btree 反向掃即得遞減序，欄位一律 ASC 就夠）。
        // 前綴 TeamId 同時罩住系統範圍那一條（`TeamId IS NULL`）——**推論（未實測）**：
        // 本批的 `EXPLAIN` 只量了 `TeamId = @t` 那一種形狀（見 `docs/history/2026-10-11-*.md` §四）。
        // `Id` 必須進索引：它是 PK，但 btree 的葉節點存的是 heap TID、不是其他欄位
        // ⇒ 少了它，`ORDER BY` 的第二個鍵仍要額外排序。
        builder.Entity<AuditLog>().HasIndex(a => new { a.TeamId, a.CreatedAt, a.Id });
        builder.Entity<ActivityItem>().Property(a => a.Detail).HasColumnType("jsonb");
        builder.Entity<CustomFieldDefinition>().Property(f => f.Options).HasColumnType("jsonb");
        builder.Entity<CardFieldValue>().Property(v => v.ValueJson).HasColumnType("jsonb");

        builder.Entity<ProjectMember>()
            .HasIndex(m => new { m.ProjectId, m.UserId, m.RoleId }).IsUnique();
        builder.Entity<CardMember>().HasKey(m => new { m.CardId, m.UserId });
        builder.Entity<CardLabel>().HasKey(l => new { l.CardId, l.LabelId });
        builder.Entity<CardFieldValue>().HasKey(v => new { v.CardId, v.FieldDefinitionId });

        builder.Entity<NotificationPreference>().HasKey(np => new { np.UserId, np.Type });
        builder.Entity<Notification>().HasIndex(n => new { n.UserId, n.IsRead });
        builder.Entity<Notification>().Property(n => n.Payload).HasColumnType("jsonb");

        builder.Entity<Project>().HasIndex(p => p.TeamId);
        builder.Entity<Board>().HasIndex(b => b.ProjectId);
        builder.Entity<BoardList>().HasIndex(l => l.BoardId);
        builder.Entity<Card>().HasIndex(c => c.ListId);
        // 看板內標籤名唯一（2026-10-09）：權威在 DB。複合索引的前綴涵蓋原本
        // BoardId 單欄索引的查詢用途，所以是取代、不是新增。
        builder.Entity<Label>().HasIndex(l => new { l.BoardId, l.Name }).IsUnique();
        builder.Entity<Checklist>().HasIndex(c => c.CardId);
        builder.Entity<ChecklistItem>().HasIndex(i => i.ChecklistId);
        // 活動牆的查詢形狀＝「某張卡、依 CreatedAt／Id 遞減取前 n 列」（cursor 分頁把 Id
        // 帶進排序與述詞，state/45）⇒ 複合索引讓 WHERE 與 ORDER BY 吃同一棵樹。
        // 取代原本的 (CardId, CreatedAt)：那是本索引的前綴，留著只是每次 insert 多寫一棵樹。
        builder.Entity<ActivityItem>().HasIndex(a => new { a.CardId, a.CreatedAt, a.Id });
        builder.Entity<Attachment>().HasIndex(a => a.CardId);
        builder.Entity<CardReview>().HasIndex(r => r.CardId);
        // 複合索引（設計 §5.4）：歷史查詢的唯一形狀是「某張卡的 entry、依時間排序」，
        // 而 FPY 逐卡取第一筆 entry 正是那個形狀（`ProjectReportQueries.GetFirstPassYieldAsync`）。
        // 前綴仍是 CardId，所以原本那條單欄索引的用途（FK 查找、卡片 cascade）不變。
        builder.Entity<CardReviewEntry>().HasIndex(e => new { e.CardId, e.CreatedAt });
        builder.Entity<EffortLog>().HasIndex(e => e.CardId);
        // 填報牆鐘（`LoggedAtLocal`）存的是**本地牆鐘**，不是瞬時：它承載 `Kind=Unspecified`
        // （`TimeZones.LocalWallClock` 的產物），而 Npgsql 會拒收寫進 `timestamp with time zone`
        // 的 Unspecified 值（`ReportEndpoints.cs:32` 有同型前例）⇒ 型別必須是 without time zone。
        // 少了這一行，EF 的預設對映會給出 with time zone，寫入端當場 500（plan D1／line 40）。
        builder.Entity<EffortLog>().Property(e => e.LoggedAtLocal).HasColumnType("timestamp without time zone");
        builder.Entity<CustomFieldDefinition>().HasIndex(f => new { f.ScopeType, f.ScopeId });
        builder.Entity<MindMap>().HasIndex(m => m.ProjectId).IsUnique();
        builder.Entity<MindMapNode>().HasIndex(n => n.MindMapId);
        builder.Entity<MindMapNode>().HasIndex(n => n.CardId);

        builder.Entity<Card>()
            .HasOne(c => c.List).WithMany().HasForeignKey(c => c.ListId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<CardMember>()
            .HasOne(m => m.Card).WithMany(c => c.Members).HasForeignKey(m => m.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<CardLabel>()
            .HasOne(l => l.Card).WithMany(c => c.Labels).HasForeignKey(l => l.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Checklist>()
            .HasOne(c => c.Card).WithMany(c => c.Checklists).HasForeignKey(c => c.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<ChecklistItem>()
            .HasOne(i => i.Checklist).WithMany(c => c.Items).HasForeignKey(i => i.ChecklistId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<ActivityItem>()
            .HasOne(a => a.Card).WithMany(c => c.Activities).HasForeignKey(a => a.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Attachment>()
            .HasOne(a => a.Card).WithMany(c => c.Attachments).HasForeignKey(a => a.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<CardReview>()
            .HasOne(r => r.Card).WithMany(c => c.Reviews).HasForeignKey(r => r.CardId).OnDelete(DeleteBehavior.Cascade);
        // 軟刪除（2026-09-18 設計 §4.3）：預設所有查詢都排除已移除的指派，未來新增的查詢
        // 自動正確。全庫唯一的破例是 FPY 的分母（`ProjectReportQueries` 以
        // `IgnoreQueryFilters()` 取「曾指派過」）——那一行是設計的本體，拿掉它整個設計失效。
        builder.Entity<CardReview>().HasQueryFilter(r => r.RemovedAt == null);
        builder.Entity<CardReviewEntry>()
            .HasOne(e => e.Card).WithMany(c => c.ReviewEntries).HasForeignKey(e => e.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<EffortLog>()
            .HasOne(e => e.Card).WithMany(c => c.EffortLogs).HasForeignKey(e => e.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<CardFieldValue>()
            .HasOne(v => v.Card).WithMany(c => c.FieldValues).HasForeignKey(v => v.CardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<CardFieldValue>()
            .HasOne(v => v.FieldDefinition).WithMany().HasForeignKey(v => v.FieldDefinitionId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Board>()
            .HasOne(b => b.Project).WithMany().HasForeignKey(b => b.ProjectId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<BoardList>()
            .HasOne(l => l.Board).WithMany().HasForeignKey(l => l.BoardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Label>()
            .HasOne(l => l.Board).WithMany().HasForeignKey(l => l.BoardId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<MindMap>()
            .HasOne(m => m.Project).WithMany().HasForeignKey(m => m.ProjectId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<MindMapNode>()
            .HasOne(n => n.MindMap).WithMany(m => m.Nodes).HasForeignKey(n => n.MindMapId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<MindMapNode>()
            .HasOne(n => n.Parent).WithMany(n => n.Children).HasForeignKey(n => n.ParentId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<MindMapNode>()
            .HasOne(n => n.Card).WithMany().HasForeignKey(n => n.CardId).OnDelete(DeleteBehavior.SetNull);
    }
}
