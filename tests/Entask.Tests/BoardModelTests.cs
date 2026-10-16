using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using BoardEntity = Entask.Core.Entities.Board;

namespace Entask.Tests;

public class BoardModelTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public BoardModelTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
    }

    [Fact]
    public async Task BoardModel_AllSixteenTables_Roundtrip()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        // 以既有表為起點：Team 由 seed 資料庫提供（無既有 team 則建立）
        var project = new Project { Id = Guid.NewGuid(), TeamId = Guid.NewGuid(), Name = "P1 專案", CreatedById = Guid.NewGuid(), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Projects.Add(project);
        var board = new BoardEntity { Id = Guid.NewGuid(), ProjectId = project.Id, Name = "開發板", Position = "m", CreatedById = project.CreatedById, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Boards.Add(board);
        var list = new BoardList { Id = Guid.NewGuid(), BoardId = board.Id, Name = "待辦", Position = "m", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Lists.Add(list);
        var card = new Card { Id = Guid.NewGuid(), ListId = list.Id, Title = "第一張卡", Position = "m", CreatedById = project.CreatedById, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Cards.Add(card);
        db.CardMembers.Add(new CardMember { CardId = card.Id, UserId = Guid.NewGuid() });
        var label = new Label { Id = Guid.NewGuid(), BoardId = board.Id, Name = "bug", Color = "#ff0000", Position = "m", CreatedAt = DateTime.UtcNow };
        db.Labels.Add(label);
        db.CardLabels.Add(new CardLabel { CardId = card.Id, LabelId = label.Id });
        var checklist = new Checklist { Id = Guid.NewGuid(), CardId = card.Id, Title = "驗收", Position = "m", CreatedAt = DateTime.UtcNow };
        db.Checklists.Add(checklist);
        db.ChecklistItems.Add(new ChecklistItem { Id = Guid.NewGuid(), ChecklistId = checklist.Id, Text = "測試通過", IsChecked = false, Position = "m" });
        db.ActivityItems.Add(new ActivityItem { Id = Guid.NewGuid(), CardId = card.Id, UserId = project.CreatedById, Type = ActivityTypes.Create, CreatedAt = DateTime.UtcNow });
        db.Attachments.Add(new Attachment { Id = Guid.NewGuid(), CardId = card.Id, UserId = project.CreatedById, FileName = "a.png", ContentType = "image/png", Size = 1, StoragePath = "x.png", CreatedAt = DateTime.UtcNow });
        db.CardReviews.Add(new CardReview { Id = Guid.NewGuid(), CardId = card.Id, ReviewerUserId = Guid.NewGuid(), Status = ReviewStatuses.Pending, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        var loggedAt = DateTime.UtcNow;
        db.EffortLogs.Add(new EffortLog
        {
            Id = Guid.NewGuid(), CardId = card.Id, UserId = project.CreatedById, Hours = 2.5m,
            LoggedAt = loggedAt, LocalDate = DateOnly.FromDateTime(loggedAt),
            LoggedAtLocal = DateTime.SpecifyKind(loggedAt, DateTimeKind.Unspecified),
        });
        var field = new CustomFieldDefinition { Id = Guid.NewGuid(), ScopeType = "project", ScopeId = project.Id, Name = "優先級", Type = CustomFieldTypes.Select, Options = """["高","中","低"]""", Position = "m", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.CustomFieldDefinitions.Add(field);
        db.CardFieldValues.Add(new CardFieldValue { CardId = card.Id, FieldDefinitionId = field.Id, ValueJson = "\"高\"" });
        db.AuditLogs.Add(new AuditLog { Id = Guid.NewGuid(), TeamId = project.TeamId, ProjectId = project.Id, UserId = project.CreatedById, Action = "project.created", EntityType = "Project", EntityId = project.Id, EntityTitle = project.Name, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();

        var reloaded = await db.Cards
            .Where(c => c.Id == card.Id)
            .Select(c => new
            {
                c.Title,
                MemberCount = c.Members.Count,
                LabelCount = c.Labels.Count,
                ChecklistCount = c.Checklists.Count,
                ActivityCount = c.Activities.Count,
                AttachmentCount = c.Attachments.Count,
                ReviewCount = c.Reviews.Count,
                EffortCount = c.EffortLogs.Count,
                FieldValueCount = c.FieldValues.Count,
                AuditProjectId = db.AuditLogs.First(a => a.EntityId == project.Id).ProjectId,
            })
            .FirstAsync();

        Assert.Equal("第一張卡", reloaded.Title);
        Assert.Equal(1, reloaded.MemberCount);
        Assert.Equal(1, reloaded.LabelCount);
        Assert.Equal(1, reloaded.ChecklistCount);
        Assert.Equal(1, reloaded.ActivityCount);
        Assert.Equal(1, reloaded.AttachmentCount);
        Assert.Equal(1, reloaded.ReviewCount);
        Assert.Equal(1, reloaded.EffortCount);
        Assert.Equal(1, reloaded.FieldValueCount);
        Assert.Equal(project.Id, reloaded.AuditProjectId);
    }
}
