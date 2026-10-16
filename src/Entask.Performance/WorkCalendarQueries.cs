using Microsoft.EntityFrameworkCore;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Performance;

/// <summary>工作日曆例外表的唯一讀取點。</summary>
public static class WorkCalendarQueries
{
    /// <summary>範疇對應的團隊：Team＝自己；Project＝專案所屬團隊；Me＝使用者所屬**所有**團隊（裁定 R3）。
    /// `Distinct()` 必要——`TeamMembers` 的唯一鍵是 (TeamId, UserId, RoleId)，同一個人可以在同一隊有多個角色。</summary>
    public static async Task<List<Guid>> GetScopeTeamIdsAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId) =>
        scope switch
        {
            WorkLogScope.Team => [scopeId],
            WorkLogScope.Project => await db.Projects
                .Where(p => p.Id == scopeId).Select(p => p.TeamId).ToListAsync(),
            WorkLogScope.Me => await db.TeamMembers
                .Where(m => m.UserId == scopeId).Select(m => m.TeamId).Distinct().ToListAsync(),
            _ => [],
        };

    /// <summary>區間 [fromLocal, toLocalExclusive) 內的例外，已依 R4 合併（多團隊時 Holiday 勝）。
    /// 無團隊（例如 `Me` 範疇的新使用者）回空表 ⇒ 判定退回 Mon–Fri。</summary>
    public static async Task<IReadOnlyDictionary<DateOnly, WorkCalendarKind>> GetExceptionMapAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> teamIds, DateOnly fromLocal, DateOnly toLocalExclusive)
    {
        if (teamIds.Count == 0) return new Dictionary<DateOnly, WorkCalendarKind>();
        var rows = await db.WorkCalendarExceptions
            .Where(e => teamIds.Contains(e.TeamId) && e.Date >= fromLocal && e.Date < toLocalExclusive)
            .ToListAsync();
        return WorkCalendar.MergeExceptions(rows);
    }
}
