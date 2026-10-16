using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using BoardEntity = Entask.Core.Entities.Board;

namespace Entask.Api.Endpoints;

public static class BoardEndpoints
{
    public static IEndpointRouteBuilder MapBoards(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/projects/{projectId:guid}/boards", async (Guid projectId, EntaskDbContext db) =>
        {
            var projectExists = await db.Projects.AnyAsync(p => p.Id == projectId);
            if (!projectExists) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);
            var boards = await db.Boards.Where(b => b.ProjectId == projectId).OrderBy(b => b.Position).ThenBy(b => b.Id)
                .Select(b => new BoardSummaryResponse(b.Id, b.ProjectId, b.Name, b.Description, b.Position, b.IsArchived))
                .ToListAsync();
            return Results.Ok(boards);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectRead);

        app.MapPost("/api/projects/{projectId:guid}/boards", async (Guid projectId, CreateBoardRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.BoardNameRequired, message = "看板名稱不可為空" });
            var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            var last = await db.Boards.Where(b => b.ProjectId == projectId).OrderBy(b => b.Position).ThenBy(b => b.Id)
                .Select(b => b.Position).LastOrDefaultAsync();
            var board = new BoardEntity
            {
                ProjectId = projectId, Name = req.Name.Trim(), Description = req.Description,
                Position = FractionalPosition.After(last), CreatedById = CurrentUserId(principal),
            };
            db.Boards.Add(board);
            await db.SaveChangesAsync();
            await audit.AddAsync(CurrentUserId(principal), project.TeamId, AuditActions.BoardCreated, "Board", board.Id, board.Name, null, projectId);
            return Results.Ok(new BoardSummaryResponse(board.Id, board.ProjectId, board.Name, board.Description, board.Position, board.IsArchived));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardCreate);

        app.MapGet("/api/boards/{boardId:guid}", async (Guid boardId, EntaskDbContext db) =>
        {
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);

            var lists = await db.Lists.Where(l => l.BoardId == boardId).OrderBy(l => l.Position).ThenBy(l => l.Id)
                .Select(l => new { l.Id, l.Name, l.Position, l.IsArchived }).ToListAsync();
            var listIds = lists.Select(l => l.Id).ToList();
            var cards = await db.Cards.Where(c => listIds.Contains(c.ListId)).OrderBy(c => c.Position).ThenBy(c => c.Id)
                .AsSplitQuery()
                .Select(c => new BoardCardResponse(
                    c.Id, c.ListId, c.Title, c.Position, c.IsArchived, c.DueAt, c.CompletedAt, c.CoverAttachmentId,
                    c.Labels.Select(cl => cl.LabelId).ToList(),
                    c.Members.Select(m => m.UserId).ToList(),
                    c.Checklists.SelectMany(ch => ch.Items).Count(i => i.IsChecked),
                    c.Checklists.SelectMany(ch => ch.Items).Count(),
                    c.EffortLogs.Sum(e => e.Hours),
                    c.EstimatedHours == null ? (decimal?)null : c.EstimatedHours - c.EffortLogs.Sum(e => e.Hours)))
                .ToListAsync();
            // rollup 在投影**之外**以一次批次查詢補值（設計 §6.4）：寫進上面的 Select
            // 會變成每列一個子查詢，而這條查詢已經有 AsSplitQuery() 的歷史（P7／P13）。
            var rollups = await ReviewEndpoints.RollupForCardsAsync(db, cards.Select(c => c.Id));
            cards = cards.Select(c => c with { ReviewState = rollups.GetValueOrDefault(c.Id) }).ToList();
            var cardsByList = cards.GroupBy(c => c.ListId).ToDictionary(g => g.Key, g => g.ToList());
            var response = new BoardDetailResponse(board.Id, board.ProjectId, board.Name, board.Description, board.Position, board.IsArchived,
                lists.Select(l => new ListResponse(l.Id, l.Name, l.Position, l.IsArchived,
                    cardsByList.TryGetValue(l.Id, out var cs) ? cs : [])).ToList());
            return Results.Ok(response);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardRead);

        app.MapPut("/api/boards/{boardId:guid}", async (Guid boardId, UpdateBoardRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit) =>
        {
            if (req.Name is not null && string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.BoardNameRequired, message = "看板名稱不可為空" });
            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);
            if (req.Name is not null) board.Name = req.Name.Trim();
            if (req.Description is not null) board.Description = req.Description;
            if (req.Position is not null) board.Position = req.Position;
            if (req.IsArchived is not null) board.IsArchived = req.IsArchived.Value;
            board.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            var teamId = await db.Projects.Where(p => p.Id == board.ProjectId).Select(p => (Guid?)p.TeamId).FirstOrDefaultAsync();
            if (teamId is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);
            await audit.AddAsync(CurrentUserId(principal), teamId.Value, AuditActions.BoardUpdated, "Board", board.Id, board.Name, null, board.ProjectId);
            return Results.Ok(new BoardSummaryResponse(board.Id, board.ProjectId, board.Name, board.Description, board.Position, board.IsArchived));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapDelete("/api/boards/{boardId:guid}", async (Guid boardId, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit, IAttachmentStore store) =>
        {
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);
            var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == board.ProjectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);
            var storagePaths = await db.Attachments
                .Where(a => a.Card.List.BoardId == boardId)
                .Select(a => a.StoragePath)
                .ToListAsync();
            await audit.AddAsync(CurrentUserId(principal), project.TeamId, AuditActions.BoardDeleted, "Board", board.Id, board.Name, null, board.ProjectId);
            db.Boards.Remove(board);
            await db.SaveChangesAsync();
            foreach (var path in storagePaths)
                store.Delete(path);
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardDelete);

        return app;
    }

    internal static Guid CurrentUserId(ClaimsPrincipal principal) =>
        Guid.Parse(principal.FindFirstValue(ClaimTypes.NameIdentifier) ?? principal.FindFirstValue("sub")!);
}

