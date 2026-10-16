using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Api.Hubs;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Identity;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class CopyEndpoints
{
    public static IEndpointRouteBuilder MapCopy(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/cards/{cardId:guid}/copy", async (Guid cardId, CopyCardRequest req, string? locale,
            ClaimsPrincipal principal,
            EntaskDbContext db, IBoardCopyService copy, IPermissionChecker checker,
            IHubContext<CollaborationHub> hub) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            var targetListId = req.TargetListId ?? card.ListId;
            // 一次投影同時取看板與專案：`Card` 實體沒有 BoardId，而廣播的兩個群組名稱兩者都要。
            // 分兩次查會多一個 roundtrip，而 `l.Board` 本來就在原本的投影路徑上。
            var target = await db.Lists.Where(l => l.Id == targetListId)
                .Select(l => new { l.BoardId, ProjectId = (Guid?)l.Board.ProjectId }).FirstOrDefaultAsync();
            if (target is null || target.ProjectId is null) return ApiResults.NotFound(ErrorCodes.ListNotFound);
            var targetBoardId = target.BoardId;
            var targetProjectId = target.ProjectId.Value;
            if (!await checker.HasProjectPermissionAsync(userId, targetProjectId, PermissionCodes.CardCreate))
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var newId = await copy.CopyCardAsync(cardId, req.TargetListId, userId, ExportLabels.CopyNameFormat(locale));

            // 複製出來的卡片對用戶端而言就是「多了一張卡」：不廣播的話，其他人得重新整理才看得到。
            // 群組用**目標**看板／專案（跨看板或跨專案複製時與來源不同），payload 與 `CardEndpoints`
            // 的 CardCreated 逐字相同。`CopyCardAsync` 回來時交易已在 `BoardCopyService` 內 commit
            // ⇒ 在這裡廣播即為「commit 之後」，故不需要動 `TransactionGuard`。
            var payload = new { cardId = newId, listId = targetListId, boardId = targetBoardId, projectId = targetProjectId };
            await hub.Clients.Group($"board:{targetBoardId}").SendAsync("CardCreated", payload);
            await hub.Clients.Group($"project:{targetProjectId}").SendAsync("CardCreated", payload);

            return Results.Ok(await CardEndpoints.GetCardResponseAsync(db, newId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        app.MapPost("/api/lists/{listId:guid}/copy", async (Guid listId, CopyListRequest req, string? locale,
            ClaimsPrincipal principal,
            EntaskDbContext db, IBoardCopyService copy, IPermissionChecker checker) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            var list = await db.Lists.FirstOrDefaultAsync(l => l.Id == listId);
            if (list is null) return ApiResults.NotFound(ErrorCodes.ListNotFound);

            var targetBoardId = req.TargetBoardId ?? list.BoardId;
            var targetProjectId = await db.Boards.Where(b => b.Id == targetBoardId)
                .Select(b => (Guid?)b.ProjectId).FirstOrDefaultAsync();
            if (targetProjectId is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);
            if (!await checker.HasProjectPermissionAsync(userId, targetProjectId.Value, PermissionCodes.BoardEdit))
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var newId = await copy.CopyListAsync(listId, req.TargetBoardId, userId, ExportLabels.CopyNameFormat(locale));
            var newList = await db.Lists.Where(l => l.Id == newId)
                .Select(l => new { l.Id, l.Name, l.Position, l.IsArchived })
                .FirstAsync();
            var cards = await db.Cards.Where(c => c.ListId == newId).OrderBy(c => c.Position).ThenBy(c => c.Id)
                .Select(c => new BoardCardResponse(
                    c.Id, c.ListId, c.Title, c.Position, c.IsArchived, c.DueAt, c.CompletedAt, c.CoverAttachmentId,
                    c.Labels.Select(cl => cl.LabelId).ToList(),
                    c.Members.Select(m => m.UserId).ToList(),
                    c.Checklists.SelectMany(ch => ch.Items).Count(i => i.IsChecked),
                    c.Checklists.SelectMany(ch => ch.Items).Count(),
                    c.EffortLogs.Sum(e => e.Hours),
                    c.EstimatedHours == null ? (decimal?)null : c.EstimatedHours - c.EffortLogs.Sum(e => e.Hours)))
                .ToListAsync();
            return Results.Ok(new ListResponse(newList.Id, newList.Name, newList.Position, newList.IsArchived, cards));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardRead);

        app.MapPost("/api/boards/{boardId:guid}/copy", async (Guid boardId, CopyBoardRequest req, string? locale,
            ClaimsPrincipal principal,
            EntaskDbContext db, IBoardCopyService copy, IPermissionChecker checker) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);

            var targetProjectId = req.TargetProjectId ?? board.ProjectId;
            var exists = await db.Projects.AnyAsync(p => p.Id == targetProjectId);
            if (!exists) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);
            if (!await checker.HasProjectPermissionAsync(userId, targetProjectId, PermissionCodes.BoardCreate))
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var newId = await copy.CopyBoardAsync(boardId, req.TargetProjectId, req.Name, userId,
                ExportLabels.CopyNameFormat(locale));
            var newBoard = await db.Boards.Where(b => b.Id == newId)
                .Select(b => new BoardSummaryResponse(b.Id, b.ProjectId, b.Name, b.Description, b.Position, b.IsArchived))
                .FirstAsync();
            return Results.Ok(newBoard);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardRead);

        app.MapPost("/api/projects/{projectId:guid}/copy", async (Guid projectId, CopyProjectRequest req,
            string? locale, HttpContext context,
            EntaskDbContext db, IBoardCopyService copy, IPermissionChecker checker, IAuditService audit) =>
        {
            var userId = BoardEndpoints.CurrentUserId(context.User);
            var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            var teamHeader = context.Request.Headers["X-Team-Id"].FirstOrDefault();
            if (!Guid.TryParse(teamHeader, out var targetTeamId))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "缺少 X-Team-Id header" });
            var isAdmin = context.User.FindFirstValue(AdminClaim.Type) == AdminClaim.Value;
            if (!isAdmin && !await checker.HasPermissionAsync(userId, targetTeamId, PermissionCodes.ProjectCreate))
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            // 到職日凍結（Q1／R6）：新專案的成員列以**發起人**的時區換算。認不得的 ID 不
            // fallback（猜一個時區等於讓錯誤的日界線靜默生效）⇒ 400；沒帶／空白 ⇒ UTC（D8）。
            if (!TimeZones.TryResolveOptional(req.TimeZoneId, out var tz))
                return Results.BadRequest(new { code = ErrorCodes.TimeZoneInvalid, message = "時區識別碼無效" });

            var newId = await copy.CopyProjectAsync(projectId, targetTeamId, req.Name, userId,
                ExportLabels.CopyNameFormat(locale), tz);
            var newProject = await db.Projects.Where(p => p.Id == newId)
                .Select(p => new ProjectResponse(p.Id, p.TeamId, p.Name, p.Description,
                    db.ProjectMembers.Count(m => m.ProjectId == p.Id),
                    db.Boards.Count(b => b.ProjectId == p.Id), p.CreatedAt))
                .FirstAsync();
            await audit.AddAsync(userId, targetTeamId, AuditActions.ProjectCreated, "Project", newId, newProject.Name, null, newId);
            return Results.Ok(newProject);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectRead);

        return app;
    }
}
