using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

/// <summary>跨測試類別共用的種子資料（避免第二份「團隊→專案→成員」形狀漂移）。</summary>
internal static class TestSeed
{
    /// <summary>直接寫 DB 建「團隊 → 專案 → 專案成員」；回傳 (projectId, userId)。</summary>
    public static async Task<(Guid ProjectId, Guid UserId)> ProjectWithMemberAsync(
        ApiWebApplicationFactory factory, string username)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var user = await db.Users.FirstAsync(u => u.UserName == username);
        var role = await db.Roles.FirstAsync(r => r.TeamId == null && r.Code != null);
        var teamId = Guid.NewGuid();
        db.Teams.Add(new Entask.Core.Entities.Team
        {
            Id = teamId, Name = "名冊測試團隊", CreatedById = user.Id,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });
        var projectId = Guid.NewGuid();
        db.Projects.Add(new Entask.Core.Entities.Project
        {
            Id = projectId, TeamId = teamId, Name = "名冊測試專案", CreatedById = user.Id,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });
        var joinedAt = DateTime.UtcNow;
        db.ProjectMembers.Add(new Entask.Core.Entities.ProjectMember
        {
            Id = Guid.NewGuid(), ProjectId = projectId, UserId = user.Id, RoleId = role.Id,
            JoinedAt = joinedAt, JoinedLocalDate = DateOnly.FromDateTime(joinedAt),
        });
        await db.SaveChangesAsync();
        return (projectId, user.Id);
    }
}
