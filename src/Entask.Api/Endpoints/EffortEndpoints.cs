using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Api.Hubs;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class EffortEndpoints
{
    public static IEndpointRouteBuilder MapEffort(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/cards/{cardId:guid}/effort", async (Guid cardId, EntaskDbContext db) =>
        {
            return Results.Ok(await GetEffortAsync(db, cardId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        app.MapPost("/api/cards/{cardId:guid}/effort", async (Guid cardId, CreateEffortRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            if (req.Hours <= 0)
                return Results.BadRequest(new { code = ErrorCodes.EffortHoursNotPositive, message = "工時須大於 0" });
            // 時區必填、認不得不 fallback（`TimeZones.TryResolve`）：猜一個時區等於讓錯誤的
            // 日界線靜默生效。驗證順序與其他端點一致——先內容、後存在性。
            if (!TimeZones.TryResolve(req.TimeZoneId, out var tz))
                return Results.BadRequest(new { code = ErrorCodes.TimeZoneInvalid, message = "時區識別碼無效" });
            var nowUtc = DateTime.UtcNow;
            var authorToday = TimeZones.LocalToday(nowUtc, tz);
            var workDay = req.LocalDate ?? authorToday;
            // 未來日的判準是**作者的本地日**，不是 UTC 日——用 UTC 日比會在日界線附近
            // 把合理的補登擋掉、或讓 UTC+14 的「今天」變成未來。
            if (workDay > authorToday)
                return Results.BadRequest(new { code = ErrorCodes.EffortLocalDateInFuture, message = "不可登記未來的工時" });

            var card = await db.Cards.Include(c => c.List.Board).FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            var userId = BoardEndpoints.CurrentUserId(principal);
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                // 三個時間欄位一次凍結：`LoggedAt` 是 UTC 瞬時（不變）、`LocalDate` 是工作日、
                // `LoggedAtLocal` 是填報當下的牆鐘（補登時仍是**填報**當下，不是補登的那一天）。
                var log = new EffortLog
                {
                    CardId = cardId, UserId = userId, Hours = req.Hours, Note = req.Note,
                    LoggedAt = nowUtc, LocalDate = workDay, LoggedAtLocal = TimeZones.LocalWallClock(nowUtc, tz),
                };
                db.EffortLogs.Add(log);
                await db.SaveChangesAsync();
                await activity.AddAsync(cardId, userId, ActivityTypes.EffortLogged, detail: new { hours = log.Hours });
                await tx.CommitAsync();

                // 廣播須在 commit 之後（未提交就廣播，其他連線可能讀到未提交狀態）
                await hub.Clients.Group($"board:{card.List.BoardId}").SendAsync("CardUpdated",
                    new { cardId, boardId = card.List.BoardId, projectId = card.List.Board.ProjectId, action = "effort", hours = log.Hours });
                await hub.Clients.Group($"project:{card.List.Board.ProjectId}").SendAsync("CardUpdated",
                    new { cardId, boardId = card.List.BoardId, projectId = card.List.Board.ProjectId, action = "effort", hours = log.Hours });
                // P21 F1 補充：若使用者位於未加入專案群組的全域頁面（如工作台/報表），須確保其自身也能收到快取失效訊號
                await hub.Clients.User(userId.ToString()).SendAsync("CardUpdated",
                    new { cardId, boardId = card.List.BoardId, projectId = card.List.Board.ProjectId, action = "effort", hours = log.Hours });

                var user = await db.Users.FirstAsync(u => u.Id == userId);
                return Results.Ok(new EffortLogResponse(log.Id, userId, user.UserName ?? "", user.DisplayName ?? "",
                    log.Hours, log.Note, log.LocalDate));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEffortUpdate);

        return app;
    }

    // 兩步查詢組出 Username/DisplayName（ActivityEndpoints.GetActivitiesAsync 既有模式）
    // 顯示的是凍結的工作日（`LocalDate`）；排序**刻意仍用 `LoggedAt`**——清單順序是
    // 「先填的在前」，補登不會把它插到過去的位置（2026-10-08，T2 裁定 3）。
    internal record EffortRow(Guid Id, Guid UserId, decimal Hours, string? Note, DateOnly LocalDate);

    internal static async Task<List<EffortRow>> GetEffortRowsAsync(EntaskDbContext db, Guid cardId) =>
        await db.EffortLogs.Where(e => e.CardId == cardId).OrderByDescending(e => e.LoggedAt)
            .Select(e => new EffortRow(e.Id, e.UserId, e.Hours, e.Note, e.LocalDate))
            .ToListAsync();

    internal static EffortListResponse ComposeEffort(List<EffortRow> rows, Dictionary<Guid, ApplicationUser> users)
    {
        var logs = rows.Select(r =>
        {
            users.TryGetValue(r.UserId, out var u);
            return new EffortLogResponse(r.Id, r.UserId,
                u?.UserName ?? "", u?.DisplayName ?? "", r.Hours, r.Note, r.LocalDate);
        }).ToList();
        return new EffortListResponse(logs, logs.Sum(l => l.Hours));
    }

    internal static async Task<EffortListResponse> GetEffortAsync(EntaskDbContext db, Guid cardId)
    {
        var rows = await GetEffortRowsAsync(db, cardId);
        var users = await ActivityEndpoints.GetUsersAsync(db, rows.Select(r => r.UserId));
        return ComposeEffort(rows, users);
    }
}
