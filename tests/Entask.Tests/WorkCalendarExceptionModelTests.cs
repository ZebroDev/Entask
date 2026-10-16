using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

/// <summary>模型層：這一類直接開 scope 拿 DbContext（測的是約束，不必繞 HTTP）。
/// 建 client ＝ 建 host，`WithDbReset()` 的旗標在第一次建置時生效（見 ApiWebApplicationFactory）。</summary>
public class WorkCalendarExceptionModelTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public WorkCalendarExceptionModelTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        _factory.WithDbReset();
        _factory.CreateClient();
    }

    [Fact]
    public async Task UniqueIndex_RejectsDuplicateTeamAndDate()
    {
        var teamId = Guid.NewGuid();
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        // 例外有 FK 指向 Teams：孤兒列會先撞 23503（FK）而不是 23505（唯一索引），
        // 那麼這一支就測不到它要測的東西（實測：沒有這一段時第一支 SaveChangesAsync 就紅）。
        db.Teams.Add(new Team
        {
            Id = teamId, Name = "日曆測試隊",
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });

        db.WorkCalendarExceptions.Add(New(teamId, new DateOnly(2026, 10, 5)));
        await db.SaveChangesAsync();

        db.WorkCalendarExceptions.Add(New(teamId, new DateOnly(2026, 10, 5)));
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }

    [Fact]
    public async Task DeletingTeam_CascadesToExceptions()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var team = new Team
        {
            Id = Guid.NewGuid(), Name = "日曆測試隊",
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        };
        db.Teams.Add(team);
        db.WorkCalendarExceptions.Add(New(team.Id, new DateOnly(2026, 10, 5)));
        await db.SaveChangesAsync();

        db.Teams.Remove(team);
        await db.SaveChangesAsync();

        Assert.False(await db.WorkCalendarExceptions.AnyAsync(e => e.TeamId == team.Id));
    }

    private static WorkCalendarException New(Guid teamId, DateOnly date) => new()
    {
        Id = Guid.NewGuid(), TeamId = teamId, Date = date,
        Kind = WorkCalendarKind.Holiday, Name = "國慶日",
        CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
    };
}
