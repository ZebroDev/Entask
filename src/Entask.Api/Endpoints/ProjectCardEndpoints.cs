using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Dtos;
using Entask.Infrastructure.Data;
using Entask.Identity;
using System.Security.Claims;
using Entask.Api.Authorization;
using Entask.Core;

namespace Entask.Api.Endpoints;

public static class ProjectCardEndpoints
{
    public static IEndpointRouteBuilder MapProjectCards(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/projects/{projectId:guid}/cards", GetProjectCards)
           .RequireAuthorization()
           .RequireProjectPermission(PermissionCodes.ProjectRead);
        return app;
    }

    private static async Task<IResult> GetProjectCards(
        Guid projectId,
        [FromQuery] string? dueFrom,
        [FromQuery] string? dueTo,
        [FromQuery] Guid? boardId,
        [FromQuery] Guid? assigneeUserId,
        // 三態：缺席（null）＝不篩選。`true` ＝只看有截止日的，`false` ＝只看無截止日的。
        // 它與 dueFrom／dueTo 的關係見下面的互斥守衛——`false` 與日期區間不可能同時成立。
        [FromQuery] bool? hasDue,
        [FromQuery] bool includeArchived = false,
        [FromQuery] int pageSize = 200,
        [FromQuery] int page = 1,
        EntaskDbContext db = default!,
        ClaimsPrincipal principal = default!)
    {
        if (pageSize > 500) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "pageSize 不可超過 500" });
        if (pageSize < 1) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "pageSize 至少為 1" });
        if (page < 1) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "page 至少為 1" });
        // 互斥輸入回 400 而不是空集合：無到期日的卡片永遠不可能落在日期區間內，
        // 兩者併用必然是空的——而空集合讓呼叫端分不出「真的沒有」與「參數互相抵消」。
        // 判準放在**格式解析之前**（下面的 DateTime.TryParse）：先答結構矛盾、再答格式，
        // 否則 `dueFrom=abc&hasDue=false` 會被報成格式問題，指向錯的方向。
        if (hasDue == false && (dueFrom is not null || dueTo is not null))
            return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "hasDue=false 不可與 dueFrom／dueTo 併用" });

        DateTime? fromDate = null;
        if (dueFrom is not null)
        {
            if (!DateTime.TryParse(dueFrom, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var parsedFrom))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "dueFrom 日期格式無效" });
            fromDate = parsedFrom;
        }

        DateTime? toDate = null;
        if (dueTo is not null)
        {
            if (!DateTime.TryParse(dueTo, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var parsedTo))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "dueTo 日期格式無效" });
            toDate = parsedTo.AddDays(1);
        }

        var cardQuery = db.Cards
            .Where(c => c.List.Board.ProjectId == projectId)
            .Where(c => !includeArchived ? !c.IsArchived : true)
            .Where(c => boardId == null || c.List.BoardId == boardId)
            .Where(c => fromDate == null || (c.DueAt != null && c.DueAt >= fromDate))
            .Where(c => toDate == null || (c.DueAt != null && c.DueAt < toDate))
            // 「有／無截止日」是一個三態述詞，不是兩個獨立的旗標。這一條在**伺服器端**過濾
            // 是關鍵：日曆側欄原本抓未篩選的前 100 筆、在前端 `.filter(c => !c.dueAt)`，
            // 而上面的排序是 null 排最後 ⇒ 專案裡有 100 張以上已排到期日的卡片時，
            // 那一窗裡一張無到期日的都沒有，面板於是靜默空白。
            .Where(c => hasDue == null || (c.DueAt != null) == hasDue.Value);

        if (assigneeUserId.HasValue)
            cardQuery = cardQuery.Where(c => c.Members.Any(m => m.UserId == assigneeUserId));

        var total = await cardQuery.CountAsync();

        var rows = await cardQuery
            .OrderBy(c => c.DueAt == null).ThenBy(c => c.DueAt).ThenBy(c => c.Id)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .AsSplitQuery()
            .Select(c => new
            {
                c.Id, c.Title, c.StartAt, c.DueAt, c.CompletedAt, c.IsArchived,
                c.EstimatedHours,
                BoardId = c.List.BoardId,
                BoardName = c.List.Board.Name,
                ListId = c.ListId,
                ListName = c.List.Name,
                AssigneeIds = c.Members.Select(m => m.UserId).ToList(),
                LabelNames = c.Labels.Select(cl => cl.Label.Name).ToList(),
                LoggedHours = (decimal)c.EffortLogs.Sum(e => (double)e.Hours),
                ChecklistTotal = c.Checklists.SelectMany(ch => ch.Items).Count(),
                ChecklistCompleted = c.Checklists.SelectMany(ch => ch.Items).Count(i => i.IsChecked)
            })
            .ToListAsync();

        var allUserIds = rows.SelectMany(r => r.AssigneeIds).Distinct().ToList();
        var users = await db.Users
            .Where(u => allUserIds.Contains(u.Id))
            .Select(u => new { u.Id, u.UserName, u.DisplayName, u.DeactivatedAt, u.DeletedAt })
            .ToDictionaryAsync(u => u.Id);

        var utcNow = DateTime.UtcNow;
        var items = rows.Select(r => new ProjectCardItem(
            r.Id, r.Title,
            r.BoardId, r.BoardName,
            r.ListId, r.ListName,
            r.StartAt,
            r.DueAt,
            r.CompletedAt,
            IsOverdue: r.DueAt.HasValue && r.DueAt < utcNow && !r.IsArchived && r.CompletedAt == null,
            r.IsArchived,
            r.AssigneeIds.Select(id => users.TryGetValue(id, out var u)
                ? new CardAssigneeSummary(id, u.UserName ?? "", u.DisplayName ?? u.UserName ?? "",
                    u.DeactivatedAt is not null || u.DeletedAt is not null)
                : new CardAssigneeSummary(id, "unknown", "unknown", false)).ToList(),
            r.LabelNames,
            r.EstimatedHours,
            r.LoggedHours,
            new ChecklistProgressSummary(r.ChecklistTotal, r.ChecklistCompleted)
        )).ToList();

        // rollup 在投影**之外**以一次批次查詢補值（設計 §4.4）：寫進上面的 Select
        // 會變成每列一個子查詢——`BoardEndpoints.cs:68-69` 已記錄過這個陷阱。
        var rollups = await ReviewEndpoints.RollupForCardsAsync(db, rows.Select(r => r.Id));
        items = items.Select(i => i with { ReviewState = rollups.GetValueOrDefault(i.Id) }).ToList();

        return Results.Ok(new ProjectCardsResponse(items, total, page, pageSize));
    }
}
