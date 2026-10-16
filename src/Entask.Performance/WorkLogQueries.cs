using Microsoft.EntityFrameworkCore;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Performance;

public enum WorkLogScope { Me, Project, Team }

/// <summary>
/// 工作日誌聚合查詢（純查詢、零寫入、零新實體）。
/// 回傳 row records，由 Api 端點組裝線路 DTO＋兩步補名。
/// 不變量：一律排除封存卡片（與 ProjectReportQueries 一致）。
/// </summary>
public static class WorkLogQueries
{
    public const int MaxRangeDays = 366;

    public record WorkLogRow(
        Guid LogId, Guid UserId, DateOnly LocalDate, DateTime LoggedAtLocal, decimal Hours, string? Note,
        Guid CardId, string CardTitle, DateTime? CardCompletedAt, decimal? CardEstimatedHours,
        Guid BoardId, string BoardName, Guid ListId, string ListName,
        Guid ProjectId, string ProjectName);
    // 無 TeamName：Project 實體沒有 Team 導覽屬性（EntaskDbContext 只設 HasIndex(p => p.TeamId)），
    // 改由 GetProjectTeamNamesAsync 兩步查補齊。

    private static IQueryable<EffortLog> Scoped(EntaskDbContext db, WorkLogScope scope, Guid scopeId) =>
        scope switch
        {
            WorkLogScope.Me => db.EffortLogs.Where(e => e.UserId == scopeId),
            WorkLogScope.Project => db.EffortLogs.Where(e => e.Card.List.Board.ProjectId == scopeId),
            WorkLogScope.Team => db.EffortLogs.Where(e => e.Card.List.Board.Project.TeamId == scopeId),
            _ => db.EffortLogs.Where(_ => false),
        };

    /// <summary>窗界與排序都是**凍結的本地日**（`LocalDate`，2026-10-08 批次的 Q1／R5）：
    /// 讀取端不再做時區換算，篩選與分桶都只看寫入當下凍結的那一天。
    /// 窗內同日以 `LoggedAt`（UTC 瞬時）為次序——那是「先填的在前」的穩定鍵，不是歸屬日。</summary>
    public static async Task<List<WorkLogRow>> GetRowsAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId, DateOnly from, DateOnly toExclusive) =>
        await Scoped(db, scope, scopeId)
            .Where(e => !e.Card.IsArchived && e.LocalDate >= from && e.LocalDate < toExclusive)
            .OrderBy(e => e.LocalDate).ThenBy(e => e.LoggedAt)
            .Select(e => new WorkLogRow(
                e.Id, e.UserId, e.LocalDate, e.LoggedAtLocal, e.Hours, e.Note,
                e.CardId, e.Card.Title, e.Card.CompletedAt, e.Card.EstimatedHours,
                e.Card.List.BoardId, e.Card.List.Board.Name,
                e.Card.ListId, e.Card.List.Name,
                e.Card.List.Board.ProjectId, e.Card.List.Board.Project.Name))
            .ToListAsync();

    /// <summary>範疇內應納入報表的成員（含零工時者），供管理範圍補齊用。</summary>
    public static async Task<List<Guid>> GetScopeMemberIdsAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId) =>
        scope switch
        {
            WorkLogScope.Me => [scopeId],
            WorkLogScope.Project => await db.ProjectMembers
                .Where(m => m.ProjectId == scopeId).Select(m => m.UserId).ToListAsync(),
            WorkLogScope.Team => await db.TeamMembers
                .Where(m => m.TeamId == scopeId).Select(m => m.UserId).ToListAsync(),
            _ => [],
        };

    /// <summary>範圍成員的到職日（**凍結的本地日**，取 Min——`TeamMembers` 的鍵是
    /// (TeamId, UserId, RoleId)，同一人可有多列）。`Me` 範圍沒有成員列 ⇒ 回空字典（不夾）。
    /// 只靠工時紀錄入列（無成員列）的使用者也不在字典裡 ⇒ 呼叫端不夾。
    /// **不得**改讀 `JoinedAt`（UTC 瞬時）——那是舊制的換算來源，`JoinedLocalDate` 才是凍結值。</summary>
    public static async Task<Dictionary<Guid, DateOnly>> GetScopeMemberJoinDatesAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId) =>
        scope switch
        {
            WorkLogScope.Project => await db.ProjectMembers
                .Where(m => m.ProjectId == scopeId)
                .GroupBy(m => m.UserId)
                .Select(g => new { UserId = g.Key, JoinedLocalDate = g.Min(m => m.JoinedLocalDate) })
                .ToDictionaryAsync(x => x.UserId, x => x.JoinedLocalDate),
            WorkLogScope.Team => await db.TeamMembers
                .Where(m => m.TeamId == scopeId)
                .GroupBy(m => m.UserId)
                .Select(g => new { UserId = g.Key, JoinedLocalDate = g.Min(m => m.JoinedLocalDate) })
                .ToDictionaryAsync(x => x.UserId, x => x.JoinedLocalDate),
            _ => new Dictionary<Guid, DateOnly>(),
        };

    /// <summary>兩步查：projectId → teamName（與既有兩步查 User 同模式）。</summary>
    public static async Task<Dictionary<Guid, string>> GetProjectTeamNamesAsync(
        EntaskDbContext db, IEnumerable<Guid> projectIds)
    {
        var ids = projectIds.Distinct().ToList();
        if (ids.Count == 0) return [];
        return await db.Projects.Where(p => ids.Contains(p.Id))
            .Join(db.Teams, p => p.TeamId, t => t.Id, (p, t) => new { p.Id, t.Name })
            .ToDictionaryAsync(x => x.Id, x => x.Name);
    }
}
