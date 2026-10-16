using System.Globalization;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Performance;

namespace Entask.Api.Endpoints;

public static class WorkLogEndpoints
{
    public static IEndpointRouteBuilder MapWorkLogs(this IEndpointRouteBuilder app)
    {
        // 區間是**本地日**（`yyyy-MM-dd`、`to` 排他、**必填**）；沒有 `tzOffsetMinutes`——
        // 沒有 viewer 時區之後「預設今天」無法誠實定義（D5，2026-10-08 裁定）。
        app.MapGet("/api/me/worklog", (DateOnly? from, DateOnly? to,
                EntaskDbContext db, ClaimsPrincipal principal) =>
                HandleAsync(db, WorkLogScope.Me, BoardEndpoints.CurrentUserId(principal), from, to))
            .RequireAuthorization();

        app.MapGet("/api/projects/{projectId:guid}/worklog", (Guid projectId,
                DateOnly? from, DateOnly? to, EntaskDbContext db) =>
                HandleAsync(db, WorkLogScope.Project, projectId, from, to))
            .RequireAuthorization().RequireProjectPermission(PermissionCodes.ReportView);

        app.MapGet("/api/teams/{teamId:guid}/worklog", (Guid teamId,
                DateOnly? from, DateOnly? to, EntaskDbContext db) =>
                HandleAsync(db, WorkLogScope.Team, teamId, from, to))
            .RequireAuthorization().RequirePermission(PermissionCodes.ReportView);

        app.MapGet("/api/me/worklog/export", (DateOnly? from, DateOnly? to, string? locale,
                EntaskDbContext db, ClaimsPrincipal principal) =>
                ExportAsync(db, WorkLogScope.Me, BoardEndpoints.CurrentUserId(principal), from, to, locale))
            .RequireAuthorization();

        app.MapGet("/api/projects/{projectId:guid}/worklog/export", (Guid projectId,
                DateOnly? from, DateOnly? to, string? locale, EntaskDbContext db) =>
                ExportAsync(db, WorkLogScope.Project, projectId, from, to, locale))
            .RequireAuthorization().RequireProjectPermission(PermissionCodes.ReportView);

        app.MapGet("/api/teams/{teamId:guid}/worklog/export", (Guid teamId,
                DateOnly? from, DateOnly? to, string? locale, EntaskDbContext db) =>
                ExportAsync(db, WorkLogScope.Team, teamId, from, to, locale))
            .RequireAuthorization().RequirePermission(PermissionCodes.ReportView);

        return app;
    }

    private record RangeResult(DateOnly From, DateOnly ToExclusive, IResult? Error);

    /// <summary>
    /// JSON 與匯出兩條路徑共用的護欄：必填參數 → 範疇存在性 → from&lt;to → 366 天上限。
    /// 抽出為單一來源，避免兩條路徑的驗證語意漂移。
    /// </summary>
    private static async Task<RangeResult> ResolveRangeAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId, DateOnly? from, DateOnly? to)
    {
        // 先內容、後存在性（與其他端點同一順序）：少參數就是 400，不管範疇存不存在。
        if (from is null || to is null)
            return new(default, default, Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 與 to 為必填（本地日期 yyyy-MM-dd）" }));

        if (scope == WorkLogScope.Project && !await db.Projects.AnyAsync(p => p.Id == scopeId))
            return new(default, default, ApiResults.NotFound(ErrorCodes.ProjectNotFound));
        if (scope == WorkLogScope.Team && !await db.Teams.AnyAsync(t => t.Id == scopeId))
            return new(default, default, ApiResults.NotFound(ErrorCodes.TeamNotFound));

        if (to.Value <= from.Value) return new(default, default, Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" }));
        if (to.Value.DayNumber - from.Value.DayNumber > WorkLogQueries.MaxRangeDays)
            return new(default, default, Results.BadRequest(new
            {
                code = ErrorCodes.QueryRangeTooLong,
                message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                @params = new { max = WorkLogQueries.MaxRangeDays }
            }));

        return new(from.Value, to.Value, null);
    }

    internal static async Task<IResult> HandleAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId, DateOnly? from, DateOnly? to)
    {
        var range = await ResolveRangeAsync(db, scope, scopeId, from, to);
        if (range.Error is not null) return range.Error;
        return Results.Ok(await ComposeAsync(db, scope, scopeId, range.From, range.ToExclusive));
    }

    /// <summary>匯出：與 JSON 端點共用同一組護欄與同一份組裝，只有最後的呈現形式不同。
    /// `locale` 只影響標籤（工作表名與表頭），認不得的值回預設語系、不是 400。</summary>
    private static async Task<IResult> ExportAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId,
        DateOnly? from, DateOnly? to, string? locale)
    {
        var range = await ResolveRangeAsync(db, scope, scopeId, from, to);
        if (range.Error is not null) return range.Error;

        var report = await ComposeAsync(db, scope, scopeId, range.From, range.ToExclusive);
        var bytes = WorkLogExport.Build(report, ExportLabels.For(locale));
        // 檔名插值同樣受 CurrentCulture 影響：非西曆主機文化（泰曆／回曆）會印出 2569 這種年份。
        var name = string.Create(CultureInfo.InvariantCulture,
            $"worklog-{scope.ToString().ToLowerInvariant()}-{range.From:yyyyMMdd}.xls");
        return Results.File(bytes, "application/vnd.ms-excel", name);
    }

    internal static async Task<WorkLogReportResponse> ComposeAsync(
        EntaskDbContext db, WorkLogScope scope, Guid scopeId, DateOnly from, DateOnly toExclusive)
    {
        var rows = await WorkLogQueries.GetRowsAsync(db, scope, scopeId, from, toExclusive);
        var scopeMemberIds = await WorkLogQueries.GetScopeMemberIdsAsync(db, scope, scopeId);
        // 到職日（凍結本地日，逐員 Min）。`Me` 範圍回空字典 ⇒ 不夾（那是自己的報告，且沒有成員列）。
        var joinDates = await WorkLogQueries.GetScopeMemberJoinDatesAsync(db, scope, scopeId);
        var teamNames = await WorkLogQueries.GetProjectTeamNamesAsync(db, rows.Select(r => r.ProjectId));

        var allUserIds = scopeMemberIds.Concat(rows.Select(r => r.UserId)).Distinct().ToList();
        var users = await ActivityEndpoints.GetUsersAsync(db, allUserIds);   // 兩步查 User（Core 不引用 Identity）

        // Workdays 由本地日區間展開——前端唯一的「什麼是工作日」來源。
        // 日曆掛在 team（R1）；Me 範疇取使用者所屬團隊的聯集（R3，衝突時 Holiday 勝＝R4）。
        // 例外一律以**本地日**比對——窗界本來就是本地日，讀取端不再有任何 offset 換算。
        var calendarTeamIds = await WorkCalendarQueries.GetScopeTeamIdsAsync(db, scope, scopeId);
        var exceptions = await WorkCalendarQueries.GetExceptionMapAsync(db, calendarTeamIds, from, toExclusive);
        var workdays = WorkCalendar.WorkdaysBetween(from, toExclusive, exceptions);
        // 日期字串同時餵給前端 formatDay 與匯出的「日期」欄：非西曆主機文化（如泰曆／回曆）會讓
        // ToString 產出不同年份，故一律 InvariantCulture（與 WorkLogExport 的資料格寫法一致）。
        var workdayKeys = workdays.Select(d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)).ToHashSet();

        // 卡片交付是**事件**（`Card.CompletedAt` 是瞬時，沒有本地日可凍結）⇒ 這一欄的窗界只能取
        // UTC 日界。本欄的窗界是 UTC 日、不是本地日——已知近似，記在 2026-10-08 的歷史檔。
        var completedFromUtc = from.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var completedToUtc = toExclusive.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);

        var byUser = rows.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => g.ToList());
        var members = new List<WorkLogMember>();
        foreach (var uid in allUserIds)
        {
            var mine = byUser.GetValueOrDefault(uid) ?? [];
            // 分桶只看凍結的 `LocalDate`（升冪原樣）——不得從瞬時＋任何 offset 推導。
            var days = mine
                .GroupBy(r => r.LocalDate)
                .OrderBy(g => g.Key)
                .Select(g => new WorkLogDay(g.Key.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), g.Sum(r => r.Hours), g.Count(),
                    g.Select(r => ToEntry(r, teamNames)).ToList()))
                .ToList();
            var reportedWorkdays = days.Count(d => workdayKeys.Contains(d.Date));
            var reportedDates = days.Select(d => d.Date).ToHashSet();

            // 到職日前的工作日不算「預期要填」——Join 日是**凍結的本地日**，直接比即可；
            // 到職**當天**仍算在內（`>=`）。無成員列者（只靠工時紀錄入列）不夾：沒有資料可夾。
            var memberWorkdays = joinDates.TryGetValue(uid, out var joinedLocalDate)
                ? workdays.Where(d => d >= joinedLocalDate).ToList()
                : workdays;
            // 升冪（memberWorkdays 已是升冪）——前端逐日列出時要的是日序，不是雜湊序。
            var missingDays = memberWorkdays
                .Select(d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))
                .Where(k => !reportedDates.Contains(k))
                .ToList();

            var slices = mine.GroupBy(r => r.ProjectId)
                .Select(g => new WorkLogProjectSlice(g.Key, g.First().ProjectName, g.Sum(r => r.Hours), g.Count()))
                .OrderByDescending(s => s.Hours).ThenBy(s => s.ProjectName).ToList();
            var completedCards = mine
                .Where(r => r.CardCompletedAt is not null && r.CardCompletedAt >= completedFromUtc && r.CardCompletedAt < completedToUtc)
                .Select(r => r.CardId).Distinct().Count();

            members.Add(new WorkLogMember(uid,
                users.GetValueOrDefault(uid)?.UserName ?? "",
                users.GetValueOrDefault(uid)?.DisplayName ?? "",
                users.GetValueOrDefault(uid)?.AvatarUrl,
                mine.Sum(r => r.Hours), mine.Count, mine.Select(r => r.CardId).Distinct().Count(),
                days.Count, reportedWorkdays,
                // MissingWorkdays 與 MissingDays 是**同一個集合**的兩個出口，兩者必然相等
                // （不再各自從 workdays.Count 推導——那條算式把到職前的日子算了進去）。
                missingDays.Count, memberWorkdays.Count, missingDays.ToArray(),
                completedCards, slices, days));
        }
        members = members.OrderByDescending(m => m.TotalHours).ThenBy(m => m.DisplayName).ToList();

        var summary = new WorkLogSummary(
            members.Sum(m => m.TotalHours), members.Count, rows.Count,
            rows.Select(r => r.CardId).Distinct().Count(), workdays.Count);

        return new WorkLogReportResponse(scope.ToString(),
            from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            toExclusive.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            workdays.Select(d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)).ToList(), summary, members);
    }

    private static WorkLogEntry ToEntry(WorkLogQueries.WorkLogRow r, Dictionary<Guid, string> teamNames) =>
        new(r.LogId, r.LoggedAtLocal, r.Hours, r.Note,
            r.CardId, r.CardTitle, r.CardCompletedAt, r.CardEstimatedHours,
            teamNames.GetValueOrDefault(r.ProjectId, ""), r.ProjectId, r.ProjectName,
            r.BoardId, r.BoardName, r.ListId, r.ListName);
}
