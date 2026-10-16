using Microsoft.EntityFrameworkCore;
using Entask.Infrastructure.Data;
using Entask.Core;
using Entask.Core.Entities;
using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;

namespace Entask.Api.Endpoints;

public static class NotificationEndpoints
{
    public static IEndpointRouteBuilder MapNotifications(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/notifications").RequireAuthorization();

        group.MapGet("", GetNotifications);
        group.MapPut("{id:guid}/read", MarkAsRead);
        group.MapPut("read-all", MarkAllAsRead);
        
        group.MapGet("preferences", GetPreferences);
        group.MapPut("preferences", UpdatePreferences);

        return app;
    }

    private static async Task<IResult> GetNotifications(EntaskDbContext db, ClaimsPrincipal principal)
    {
        var userId = BoardEndpoints.CurrentUserId(principal);

        // payload 是 DB 裡的 jsonb 文字，轉成物件必須在記憶體內做（EF 翻不出 JsonDocument.Parse）。
        // 端點上限 50 筆，成本可忽略。
        var rows = await db.Notifications
            .Where(n => n.UserId == userId)
            .OrderByDescending(n => n.CreatedAt)
            .Take(50)
            .ToListAsync();

        // 整列具體化之後直接餵給共用的產生器——REST 與 SignalR 送同一組欄位。
        // 不要在這裡手寫第二份匿名物件：兩份手寫物件正是 P-C 之前
        // `time = "剛剛"` 只寫死在一邊、REST 送另一種格式的成因。
        return Results.Ok(rows.Select(NotificationPayloads.Push));
    }

    private static async Task<IResult> MarkAsRead(Guid id, EntaskDbContext db, ClaimsPrincipal principal)
    {
        var userId = BoardEndpoints.CurrentUserId(principal);
        var notification = await db.Notifications.FirstOrDefaultAsync(n => n.Id == id && n.UserId == userId);
        if (notification == null) return ApiResults.NotFound(ErrorCodes.NotificationNotFound);

        notification.IsRead = true;
        await db.SaveChangesAsync();
        return Results.NoContent();
    }

    private static async Task<IResult> MarkAllAsRead(EntaskDbContext db, ClaimsPrincipal principal)
    {
        var userId = BoardEndpoints.CurrentUserId(principal);
        var unread = await db.Notifications.Where(n => n.UserId == userId && !n.IsRead).ToListAsync();
        foreach (var n in unread)
        {
            n.IsRead = true;
        }
        await db.SaveChangesAsync();
        return Results.NoContent();
    }

    private static async Task<IResult> GetPreferences(EntaskDbContext db, ClaimsPrincipal principal)
    {
        var userId = BoardEndpoints.CurrentUserId(principal);
        var prefs = await db.NotificationPreferences.Where(p => p.UserId == userId).ToListAsync();
        return Results.Ok(prefs);
    }

    private static async Task<IResult> UpdatePreferences(
        [FromBody] List<PreferenceUpdateDto> updates, 
        EntaskDbContext db, 
        ClaimsPrincipal principal)
    {
        // 集合上限（2026-10-10 公開前硬化；第 14 個站點，2026-10-11 最終複審 F1 補上）：
        // 在任何 DB 工作之前——見 `RequestLimits` 的摘要。
        if (updates is { Count: > RequestLimits.MaxPreferenceUpdates })
            return Results.BadRequest(new
            {
                code = ErrorCodes.RequestCollectionTooLarge,
                message = $"清單的項目數超過上限 {RequestLimits.MaxPreferenceUpdates}",
                @params = new { max = RequestLimits.MaxPreferenceUpdates }
            });

        var userId = BoardEndpoints.CurrentUserId(principal);
        var existing = await db.NotificationPreferences.Where(p => p.UserId == userId).ToListAsync();
        
        foreach (var update in updates)
        {
            var pref = existing.FirstOrDefault(p => p.Type == update.Type);
            if (pref == null)
            {
                pref = new NotificationPreference { UserId = userId, Type = update.Type };
                db.NotificationPreferences.Add(pref);
            }
            pref.InAppEnabled = update.InAppEnabled;
            // pref.EmailEnabled = update.EmailEnabled;
        }
        
        await db.SaveChangesAsync();
        return Results.Ok();
    }
}

public class PreferenceUpdateDto
{
    public string Type { get; set; } = "";
    public bool InAppEnabled { get; set; }
}
