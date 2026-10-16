using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class ListEndpoints
{
    public static IEndpointRouteBuilder MapLists(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/boards/{boardId:guid}/lists", async (Guid boardId, CreateListRequest req, EntaskDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.ListTitleRequired, message = "列表名稱不可為空" });
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);

            var last = await db.Lists.Where(l => l.BoardId == boardId).OrderBy(l => l.Position).ThenBy(l => l.Id)
                .Select(l => l.Position).LastOrDefaultAsync();
            var list = new BoardList { BoardId = boardId, Name = req.Name.Trim(), Position = FractionalPosition.After(last) };
            db.Lists.Add(list);
            await db.SaveChangesAsync();
            return Results.Ok(new ListResponse(list.Id, list.Name, list.Position, list.IsArchived, []));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapPut("/api/lists/{listId:guid}", async (Guid listId, UpdateListRequest req, EntaskDbContext db) =>
        {
            if (req.Name is not null && string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.ListTitleRequired, message = "列表名稱不可為空" });
            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            var list = await db.Lists.FirstOrDefaultAsync(l => l.Id == listId);
            if (list is null) return ApiResults.NotFound(ErrorCodes.ListNotFound);
            if (req.Name is not null) list.Name = req.Name.Trim();
            if (req.Position is not null) list.Position = req.Position;
            if (req.IsArchived is not null) list.IsArchived = req.IsArchived.Value;
            list.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            return Results.Ok(new ListResponse(list.Id, list.Name, list.Position, list.IsArchived, []));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapDelete("/api/lists/{listId:guid}", async (Guid listId, EntaskDbContext db, IAttachmentStore store) =>
        {
            var list = await db.Lists.FirstOrDefaultAsync(l => l.Id == listId);
            if (list is null) return ApiResults.NotFound(ErrorCodes.ListNotFound);
            var storagePaths = await db.Attachments
                .Where(a => a.Card.ListId == listId)
                .Select(a => a.StoragePath)
                .ToListAsync();
            db.Lists.Remove(list);
            await db.SaveChangesAsync();
            foreach (var path in storagePaths)
                store.Delete(path);
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        return app;
    }
}
