using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class ChecklistEndpoints
{
    public static IEndpointRouteBuilder MapChecklists(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/cards/{cardId:guid}/checklists", async (Guid cardId, CreateChecklistRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity) =>
        {
            if (string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(new { code = ErrorCodes.ChecklistTitleRequired, message = "檢查清單名稱不可為空" });
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            var last = await db.Checklists.Where(c => c.CardId == cardId).OrderBy(c => c.Position).ThenBy(c => c.Id)
                .Select(c => c.Position).LastOrDefaultAsync();
            var checklist = new Checklist { CardId = cardId, Title = req.Title.Trim(), Position = FractionalPosition.After(last) };
            db.Checklists.Add(checklist);
            await db.SaveChangesAsync();
            await activity.AddAsync(cardId, BoardEndpoints.CurrentUserId(principal), ActivityTypes.ChecklistAdded,
                detail: new { checklistId = checklist.Id });

            return Results.Ok(await GetChecklistAsync(db, checklist.Id));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapPut("/api/cards/{cardId:guid}/checklists/{checklistId:guid}", async (Guid cardId, Guid checklistId,
            UpdateChecklistRequest req, EntaskDbContext db) =>
        {
            if (req.Title is not null && string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(new { code = ErrorCodes.ChecklistTitleRequired, message = "檢查清單名稱不可為空" });
            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            var checklist = await db.Checklists.FirstOrDefaultAsync(c => c.Id == checklistId && c.CardId == cardId);
            if (checklist is null) return ApiResults.NotFound(ErrorCodes.ChecklistNotFound);
            if (req.Title is not null) checklist.Title = req.Title.Trim();
            if (req.Position is not null) checklist.Position = req.Position;
            await db.SaveChangesAsync();
            return Results.Ok(await GetChecklistAsync(db, checklistId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapDelete("/api/cards/{cardId:guid}/checklists/{checklistId:guid}", async (Guid cardId, Guid checklistId,
            ClaimsPrincipal principal, EntaskDbContext db, IActivityService activity) =>
        {
            var checklist = await db.Checklists.FirstOrDefaultAsync(c => c.Id == checklistId && c.CardId == cardId);
            if (checklist is null) return ApiResults.NotFound(ErrorCodes.ChecklistNotFound);
            // activity 先行單獨 commit 會在後續刪除失敗時留下幽靈 activity——包在同一交易
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                await activity.AddAsync(cardId, BoardEndpoints.CurrentUserId(principal), ActivityTypes.ChecklistRemoved,
                    detail: new { checklistId });
                db.Checklists.Remove(checklist);
                await db.SaveChangesAsync();
                await tx.CommitAsync();
                return Results.Ok();
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapPost("/api/cards/{cardId:guid}/checklists/{checklistId:guid}/items", async (Guid cardId, Guid checklistId,
            CreateChecklistItemRequest req, EntaskDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { code = ErrorCodes.ChecklistItemTextRequired, message = "項目文字不可為空" });
            var checklist = await db.Checklists.FirstOrDefaultAsync(c => c.Id == checklistId && c.CardId == cardId);
            if (checklist is null) return ApiResults.NotFound(ErrorCodes.ChecklistNotFound);

            var last = await db.ChecklistItems.Where(i => i.ChecklistId == checklistId).OrderBy(i => i.Position).ThenBy(i => i.Id)
                .Select(i => i.Position).LastOrDefaultAsync();
            var item = new ChecklistItem { ChecklistId = checklistId, Text = req.Text.Trim(), Position = FractionalPosition.After(last) };
            db.ChecklistItems.Add(item);
            await db.SaveChangesAsync();
            return Results.Ok(new ChecklistItemResponse(item.Id, item.Text, item.IsChecked, item.Position));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapPut("/api/cards/{cardId:guid}/checklists/{checklistId:guid}/items/{itemId:guid}",
            async (Guid cardId, Guid checklistId, Guid itemId, UpdateChecklistItemRequest req, ClaimsPrincipal principal,
                EntaskDbContext db, IActivityService activity) =>
        {
            if (req.Text is not null && string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { code = ErrorCodes.ChecklistItemTextRequired, message = "項目文字不可為空" });
            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            var item = await db.ChecklistItems
                .Where(i => i.Id == itemId && i.ChecklistId == checklistId)
                .Select(i => new { Item = i, OwnsCard = i.Checklist.CardId == cardId })
                .FirstOrDefaultAsync();
            if (item is null) return ApiResults.NotFound(ErrorCodes.ChecklistItemNotFound);
            if (!item.OwnsCard) return ApiResults.NotFound(ErrorCodes.ChecklistItemNotFound);
            var itemEntity = item.Item;

            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                if (req.Text is not null) itemEntity.Text = req.Text.Trim();
                if (req.Position is not null) itemEntity.Position = req.Position;
                if (req.IsChecked is not null && req.IsChecked.Value != itemEntity.IsChecked)
                {
                    itemEntity.IsChecked = req.IsChecked.Value;
                    await activity.AddAsync(cardId, BoardEndpoints.CurrentUserId(principal), ActivityTypes.ItemChecked,
                        detail: new { itemId, isChecked = itemEntity.IsChecked });
                }
                await db.SaveChangesAsync();
                await tx.CommitAsync();
                return Results.Ok(new ChecklistItemResponse(itemEntity.Id, itemEntity.Text, itemEntity.IsChecked, itemEntity.Position));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapDelete("/api/cards/{cardId:guid}/checklists/{checklistId:guid}/items/{itemId:guid}",
            async (Guid cardId, Guid checklistId, Guid itemId, EntaskDbContext db) =>
        {
            // 與 item PUT 相同的 OwnsCard 驗證：item 須屬於該 checklist、checklist 須屬於該 card，跨卡一律 404
            var item = await db.ChecklistItems
                .Where(i => i.Id == itemId && i.ChecklistId == checklistId)
                .Select(i => new { Item = i, OwnsCard = i.Checklist.CardId == cardId })
                .FirstOrDefaultAsync();
            if (item is null || !item.OwnsCard) return ApiResults.NotFound(ErrorCodes.ChecklistItemNotFound);
            // 不寫 activity（與 item POST 對稱，activity 只記在 checklist 層級）；單一 Remove+SaveChanges 即原子，不需交易
            db.ChecklistItems.Remove(item.Item);
            await db.SaveChangesAsync();
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        return app;
    }

    internal static async Task<ChecklistResponse> GetChecklistAsync(EntaskDbContext db, Guid checklistId)
    {
        var checklist = await db.Checklists.Where(c => c.Id == checklistId)
            .Select(c => new ChecklistResponse(c.Id, c.Title, c.Position,
                c.Items.OrderBy(i => i.Position).ThenBy(i => i.Id)
                    .Select(i => new ChecklistItemResponse(i.Id, i.Text, i.IsChecked, i.Position)).ToList()))
            .FirstAsync();
        return checklist;
    }
}
