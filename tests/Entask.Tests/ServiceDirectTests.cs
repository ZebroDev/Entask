using Microsoft.Extensions.DependencyInjection;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using BoardEntity = Entask.Core.Entities.Board;

namespace Entask.Tests;

public class ServiceDirectTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public ServiceDirectTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
    }

    // 種子只建立 admin 使用者，無團隊；Team.Id/CreatedAt/UpdatedAt 無實體預設值，故直接建一列
    private static async Task<Guid> CreateTeamAsync(EntaskDbContext db, Guid userId)
    {
        var team = new Team
        {
            Id = Guid.NewGuid(),
            Name = "直測團隊",
            CreatedById = userId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
        db.Teams.Add(team);
        await db.SaveChangesAsync();
        return team.Id;
    }

    [Fact]
    public async Task ActivityService_AddAsync_PersistsRow()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var activity = scope.ServiceProvider.GetRequiredService<IActivityService>();
        var userId = db.Users.First().Id;
        var teamId = await CreateTeamAsync(db, userId);
        var project = new Project { TeamId = teamId, Name = "直測專案", CreatedById = userId };
        var board = new BoardEntity { ProjectId = project.Id, Name = "直測板", CreatedById = userId };
        var list = new BoardList { BoardId = board.Id, Name = "直測列表" };
        var card = new Card { ListId = list.Id, Title = "直測卡", CreatedById = userId };
        db.Projects.Add(project);
        db.Boards.Add(board);
        db.Lists.Add(list);
        db.Cards.Add(card);
        await db.SaveChangesAsync();
        await activity.AddAsync(card.Id, userId, "create", "建立卡片");
        var row = db.ActivityItems.Single(a => a.CardId == card.Id);
        Assert.Equal("create", row.Type);
        Assert.Equal(userId, row.UserId);
    }

    [Fact]
    public async Task AuditService_AddAsync_PersistsProjectId()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditService>();
        var userId = db.Users.First().Id;
        var teamId = await CreateTeamAsync(db, userId);
        var projectId = Guid.NewGuid();
        await audit.AddAsync(userId, teamId, "test.action", "Test", Guid.NewGuid(), "標題", null, projectId);
        var row = db.AuditLogs.Single(a => a.Action == "test.action");
        Assert.Equal(projectId, row.ProjectId);
        Assert.Equal(teamId, row.TeamId);
    }
}
