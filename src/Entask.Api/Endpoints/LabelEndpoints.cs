using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static partial class LabelEndpoints
{
    public static IEndpointRouteBuilder MapLabels(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/boards/{boardId:guid}/labels", async (Guid boardId, EntaskDbContext db) =>
        {
            var boardExists = await db.Boards.AnyAsync(b => b.Id == boardId);
            if (!boardExists) return ApiResults.NotFound(ErrorCodes.BoardNotFound);
            var labels = await db.Labels.Where(l => l.BoardId == boardId).OrderBy(l => l.Position).ThenBy(l => l.Id)
                .Select(l => new LabelResponse(l.Id, l.Name, l.Color, l.Position)).ToListAsync();
            return Results.Ok(labels);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardRead);

        app.MapPost("/api/boards/{boardId:guid}/labels", async (Guid boardId, CreateLabelRequest req, EntaskDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.LabelNameRequired, message = "標籤名稱不可為空" });
            if (!ColorRegex().IsMatch(req.Color))
                return Results.BadRequest(new { code = ErrorCodes.LabelColorInvalid, message = "顏色格式須為 #rrggbb" });
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);

            var last = await db.Labels.Where(l => l.BoardId == boardId).OrderBy(l => l.Position).ThenBy(l => l.Id)
                .Select(l => l.Position).LastOrDefaultAsync();
            var label = new Label { BoardId = boardId, Name = req.Name.Trim(), Color = req.Color, Position = FractionalPosition.After(last) };
            db.Labels.Add(label);
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateException ex) when (IsDuplicateLabelName(ex))
            {
                return Results.BadRequest(new { code = ErrorCodes.LabelNameDuplicate, message = "此看板已有同名標籤" });
            }
            return Results.Ok(new LabelResponse(label.Id, label.Name, label.Color, label.Position));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapPut("/api/boards/{boardId:guid}/labels/{labelId:guid}", async (Guid boardId, Guid labelId,
            UpdateLabelRequest req, EntaskDbContext db) =>
        {
            if (req.Name is not null && string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.LabelNameRequired, message = "標籤名稱不可為空" });
            if (req.Color is not null && !ColorRegex().IsMatch(req.Color))
                return Results.BadRequest(new { code = ErrorCodes.LabelColorInvalid, message = "顏色格式須為 #rrggbb" });
            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            var label = await db.Labels.FirstOrDefaultAsync(l => l.Id == labelId && l.BoardId == boardId);
            if (label is null) return ApiResults.NotFound(ErrorCodes.LabelNotFound);
            if (req.Name is not null) label.Name = req.Name.Trim();
            if (req.Color is not null) label.Color = req.Color;
            if (req.Position is not null) label.Position = req.Position;
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateException ex) when (IsDuplicateLabelName(ex))
            {
                return Results.BadRequest(new { code = ErrorCodes.LabelNameDuplicate, message = "此看板已有同名標籤" });
            }
            return Results.Ok(new LabelResponse(label.Id, label.Name, label.Color, label.Position));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapDelete("/api/boards/{boardId:guid}/labels/{labelId:guid}", async (Guid boardId, Guid labelId, EntaskDbContext db) =>
        {
            var label = await db.Labels.FirstOrDefaultAsync(l => l.Id == labelId && l.BoardId == boardId);
            if (label is null) return ApiResults.NotFound(ErrorCodes.LabelNotFound);
            // ExecuteDeleteAsync 不參與 SaveChanges 交易——包在同一交易內避免
            // CardLabel 已刪、Label 刪除失敗的不一致狀態
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                await db.CardLabels.Where(cl => cl.LabelId == labelId).ExecuteDeleteAsync();
                db.Labels.Remove(label);
                await db.SaveChangesAsync();
                await tx.CommitAsync();
                return Results.Ok();
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        return app;
    }

    // Labels 上唯一的非 PK 唯一索引是 ("BoardId","Name")（2026-10-09 新增）
    // ⇒ Labels 的 23505 只可能來自它。與 CardEndpoints.cs:292 的攔截子句同型。
    private static bool IsDuplicateLabelName(DbUpdateException ex)
        => ex.InnerException is Npgsql.PostgresException { SqlState: "23505" };

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorRegex();
}
