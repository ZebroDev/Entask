using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Api.Hubs;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class ActivityEndpoints
{
    public static IEndpointRouteBuilder MapActivity(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/cards/{cardId:guid}/activity", async (Guid cardId, [Microsoft.AspNetCore.Mvc.FromQuery] string? cursor, [Microsoft.AspNetCore.Mvc.FromQuery] int? limit, [Microsoft.AspNetCore.Mvc.FromQuery] string? filter, EntaskDbContext db) =>
        {
            if (!TimestampIdCursor.TryRead(cursor, out var key)) return Results.BadRequest();

            var cardExists = await db.Cards.AnyAsync(c => c.Id == cardId);
            if (!cardExists) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            
            int take = limit.HasValue && limit.Value > 0 ? Math.Min(limit.Value, 100) : 20;
            
            var query = db.ActivityItems.Where(a => a.CardId == cardId);
            if (filter == "comments_only")
                query = query.Where(a => a.Type == ActivityTypes.Comment);
            else if (filter == "activity_only")
                query = query.Where(a => a.Type != ActivityTypes.Comment);

            if (key is { } k)
            {
                // 留在 IQueryable 裡、**不進記憶體**：`Guid.CompareTo` 在 .NET 的欄位比較序與
                // Postgres `uuid` 的位元序**不同**，只有 WHERE 與 ORDER BY 都由 Postgres 求值，
                // 兩者才同源（設計 §4.2，形狀逐字照 `AuditLogEndpoints.QueryAsync`）。
                query = query.Where(a => a.CreatedAt < k.CreatedAt
                    || (a.CreatedAt == k.CreatedAt && a.Id.CompareTo(k.Id) < 0));
            }
            
            var rows = await query.OrderByDescending(a => a.CreatedAt)
                .ThenByDescending(a => a.Id)
                .Take(take + 1)
                .Select(a => new ActivityRow(a.Id, a.CardId, a.UserId, a.Type, a.Text, a.Detail, a.CreatedAt))
                .ToListAsync();

            var hasMore = rows.Count > take;
            if (hasMore) rows.RemoveAt(take);

            var users = await GetUsersAsync(db, rows.Select(r => r.UserId));
            var items = ComposeActivities(rows, users);
            
            var nextCursor = hasMore ? new TimestampIdCursor(rows[^1].CreatedAt, rows[^1].Id).ToString() : null;
            
            return Results.Ok(new { Items = items, NextCursor = nextCursor });
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        app.MapPost("/api/cards/{cardId:guid}/comments", async (Guid cardId, CreateCommentRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IHubContext<CollaborationHub> hub) =>
        {
            if (string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { code = ErrorCodes.CommentBodyRequired, message = "留言不可為空" });
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            var userId = BoardEndpoints.CurrentUserId(principal);
            var comment = new ActivityItem { CardId = cardId, UserId = userId, Type = ActivityTypes.Comment, Text = req.Text.Trim() };
            db.ActivityItems.Add(comment);
            await db.SaveChangesAsync();

            var user = await db.Users.FirstAsync(u => u.Id == userId);
            var response = new ActivityResponse(comment.Id, comment.CardId, userId,
                user.UserName ?? "", user.DisplayName ?? "", comment.Type, comment.Text, comment.Detail, comment.CreatedAt);

            var recipients = await db.CardMembers.Where(m => m.CardId == cardId && m.UserId != userId)
                .Select(m => m.UserId).ToListAsync();
            if (card.CreatedById != userId && !recipients.Contains(card.CreatedById))
            {
                recipients.Add(card.CreatedById);
            }
            var boardInfo = await db.Cards.Where(c => c.Id == cardId)
                .Select(c => new { c.List.BoardId, c.List.Board.ProjectId }).FirstOrDefaultAsync();
            if (boardInfo != null)
            {
                await hub.Clients.Group($"board:{boardInfo.BoardId}").SendAsync("CardUpdated", new { cardId, boardId = boardInfo.BoardId, projectId = boardInfo.ProjectId, action = "comment" });
                await hub.Clients.Group($"project:{boardInfo.ProjectId}").SendAsync("CardUpdated", new { cardId, boardId = boardInfo.BoardId, projectId = boardInfo.ProjectId, action = "comment" });

                if (recipients.Any())
                {
                    var rIds = recipients.ToList();
                    var prefs = await db.NotificationPreferences
                        .Where(p => rIds.Contains(p.UserId) && p.Type == NotificationTypes.Comment)
                        .ToListAsync();

                    foreach (var rId in rIds)
                    {
                        var pref = prefs.FirstOrDefault(p => p.UserId == rId);
                        if (pref == null || pref.InAppEnabled)
                        {
                            var notif = NotificationPayloads.Create(
                                rId,
                                NotificationTypes.Comment,
                                NotificationKinds.CommentCreated,
                                new { actor = user.DisplayName ?? user.UserName, card = card.Title },
                                $"/projects/{boardInfo.ProjectId}/boards/{boardInfo.BoardId}?cardId={cardId}");
                            db.Notifications.Add(notif);
                            await db.SaveChangesAsync();

                            await hub.Clients.User(rId.ToString())
                                .SendAsync("NotificationReceived", NotificationPayloads.Push(notif));
                        }
                    }
                }
            }

            // 無單筆留言 GET 路由，201 的 Location 會指向不存在的位址；回 200 與 PUT 一致
            return Results.Ok(response);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardComment, PermissionCodes.CardEdit);

        app.MapPut("/api/cards/{cardId:guid}/comments/{commentId:guid}", async (Guid cardId, Guid commentId,
            CreateCommentRequest req, ClaimsPrincipal principal, EntaskDbContext db) =>
        {
            if (string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { code = ErrorCodes.CommentBodyRequired, message = "留言不可為空" });
            var comment = await db.ActivityItems.FirstOrDefaultAsync(a => a.Id == commentId && a.CardId == cardId && a.Type == ActivityTypes.Comment);
            if (comment is null) return ApiResults.NotFound(ErrorCodes.CommentNotFound);
            if (comment.UserId != BoardEndpoints.CurrentUserId(principal))
                return Results.Json(new { code = ErrorCodes.CommentNotOwner, message = "只有留言作者本人可以編輯或刪除留言" },
                    statusCode: StatusCodes.Status403Forbidden);

            comment.Text = req.Text.Trim();
            await db.SaveChangesAsync();
            var user = await db.Users.FirstAsync(u => u.Id == comment.UserId);
            return Results.Ok(new ActivityResponse(comment.Id, comment.CardId, comment.UserId,
                user.UserName ?? "", user.DisplayName ?? "", comment.Type, comment.Text, comment.Detail, comment.CreatedAt));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardComment, PermissionCodes.CardEdit);

        app.MapDelete("/api/cards/{cardId:guid}/comments/{commentId:guid}", async (Guid cardId, Guid commentId,
            ClaimsPrincipal principal, EntaskDbContext db) =>
        {
            var comment = await db.ActivityItems.FirstOrDefaultAsync(a => a.Id == commentId && a.CardId == cardId && a.Type == ActivityTypes.Comment);
            if (comment is null) return ApiResults.NotFound(ErrorCodes.CommentNotFound);
            if (comment.UserId != BoardEndpoints.CurrentUserId(principal))
                return Results.Json(new { code = ErrorCodes.CommentNotOwner, message = "只有留言作者本人可以編輯或刪除留言" },
                    statusCode: StatusCodes.Status403Forbidden);

            db.ActivityItems.Remove(comment);
            await db.SaveChangesAsync();
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardComment, PermissionCodes.CardEdit);

        return app;
    }

    // Core 無法引用 Identity（ApplicationUser），故以兩步查詢組出 Username/DisplayName
    // （Task 3 ProjectMembers 的既有模式），而非導覽屬性投影。
    internal record ActivityRow(Guid Id, Guid CardId, Guid UserId, string Type, string? Text, string? Detail, DateTime CreatedAt);

    internal static async Task<List<ActivityRow>> GetActivityRowsAsync(EntaskDbContext db, Guid cardId) =>
        await db.ActivityItems.Where(a => a.CardId == cardId).OrderByDescending(a => a.CreatedAt)
            .Select(a => new ActivityRow(a.Id, a.CardId, a.UserId, a.Type, a.Text, a.Detail, a.CreatedAt))
            .ToListAsync();

    internal static List<ActivityResponse> ComposeActivities(List<ActivityRow> rows, Dictionary<Guid, ApplicationUser> users) =>
        rows.Select(r =>
        {
            users.TryGetValue(r.UserId, out var u);
            return new ActivityResponse(r.Id, r.CardId, r.UserId,
                u?.UserName ?? "", u?.DisplayName ?? "", r.Type, r.Text, r.Detail, r.CreatedAt);
        }).ToList();

    internal static async Task<Dictionary<Guid, ApplicationUser>> GetUsersAsync(EntaskDbContext db, IEnumerable<Guid> userIds)
    {
        var ids = userIds.Distinct().ToList();
        return await db.Users.Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id);
    }

    internal static async Task<List<ActivityResponse>> GetActivitiesAsync(EntaskDbContext db, Guid cardId)
    {
        var rows = await GetActivityRowsAsync(db, cardId);
        var users = await GetUsersAsync(db, rows.Select(r => r.UserId));
        return ComposeActivities(rows, users);
    }

}
