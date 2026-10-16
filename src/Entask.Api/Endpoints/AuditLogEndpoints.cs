using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class AuditLogEndpoints
{
    public static IEndpointRouteBuilder MapAuditLogs(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/audit-logs", async (Guid teamId, string? cursor,
            EntaskDbContext db, UserManager<ApplicationUser> userManager) =>
        {
            if (!TimestampIdCursor.TryRead(cursor, out var key)) return Results.BadRequest();
            return Results.Ok(await QueryAsync(
                db.AuditLogs.Where(l => l.TeamId == teamId), key, userManager));
        })
        .RequireAuthorization()
        .RequirePermission(PermissionCodes.TeamRead);

        // 系統範圍（TeamId == null）：使用者生命週期的五個動作寫在那裡
        // （`AuthEndpoints.cs:248`、`AdminUserEndpoints.cs:124/149/233/281`）。
        //
        // ★ 守衛形狀逐字照 `AdminUserEndpoints.RequireAdminAsync`：**先** `ResolveCurrentUserAsync`
        //   **再**驗 admin claim。被停用的管理員在 access token 過期前仍帶著 `entask:admin`，
        //   順序顛倒等於開了一個「停用後仍可讀系統稽核」的窗口。
        // ★ 這裡**刻意不用** `.RequirePermission(...)`：那會掛上 `TeamPermissionMetadata`
        //   （團隊權限語意），而 `RequirePermissionExtensions` 的權限檢查以 `X-Team-Id` 那個
        //   團隊為範圍、跨團隊守衛又只在 query 帶 `teamId` 時才觸發 ⇒ 任何持有任一團隊
        //   `team.read` 的人都過得了那道守衛。系統範圍是全域資源，閘門是 admin。
        // ★ 403 的 body 與 `AdminUserEndpoints` 那一行逐字相同（`check:message-values` 是
        //   雙向契約；改一個字會紅）。
        app.MapGet("/api/audit-logs/system", async (
            ClaimsPrincipal principal, string? cursor,
            EntaskDbContext db, UserManager<ApplicationUser> userManager) =>
        {
            var (_, error) = await UserEndpoints.ResolveCurrentUserAsync(principal, userManager);
            if (error is not null) return error;

            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
            {
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);
            }

            if (!TimestampIdCursor.TryRead(cursor, out var key)) return Results.BadRequest();
            return Results.Ok(await QueryAsync(
                db.AuditLogs.Where(l => l.TeamId == null), key, userManager));
        })
        .RequireAuthorization();

        return app;
    }

    // 頁面大小寫死：不加 `limit` 參數（設計 §8）。要開放時形狀照
    // `ActivityEndpoints.cs:25` 的 `Math.Min(limit, 100)` 封頂，不要直接吃呼叫端的值。
    private const int PageSize = 100;

    /// <summary>
    /// 兩條讀取路線共用的查詢：cursor 定位、排序（`CreatedAt` 遞減、`Id` 當 tiebreaker
    /// ⇒ 截斷點確定）、頁面大小 + 1 的探測、以及 actor 名稱解析。
    /// </summary>
    private static async Task<AuditLogPage> QueryAsync(
        IQueryable<AuditLog> query, TimestampIdCursor? cursor, UserManager<ApplicationUser> userManager)
    {
        if (cursor is { } key)
        {
            // 留在 IQueryable 裡、**不進記憶體**：`Guid.CompareTo` 在 .NET 的欄位比較序與
            // Postgres `uuid` 的位元序**不同**，只有 WHERE 與 ORDER BY 都由 Postgres 求值，
            // 兩者才同源（設計 §5.1）。寫成 client 端比較會是靜默的錯——兩邊各自有序。
            query = query.Where(l => l.CreatedAt < key.CreatedAt
                || (l.CreatedAt == key.CreatedAt && l.Id.CompareTo(key.Id) < 0));
        }

        var rows = await query
            .OrderByDescending(l => l.CreatedAt)
            .ThenByDescending(l => l.Id)
            .Take(PageSize + 1)
            .Select(l => new
            {
                l.Id, l.UserId, l.Action, l.EntityType, l.EntityId, l.EntityTitle, l.Detail, l.CreatedAt
            })
            .ToListAsync();

        var hasMore = rows.Count > PageSize;
        if (hasMore) rows.RemoveAt(PageSize);
        var nextCursor = hasMore ? new TimestampIdCursor(rows[^1].CreatedAt, rows[^1].Id).ToString() : null;

        var actorIds = rows.Where(r => r.UserId is not null).Select(r => r.UserId!.Value).Distinct().ToList();
        var names = await userManager.Users
            .Where(u => actorIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName })
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName);

        var items = rows
            .Select(r => new AuditLogDto(
                r.Id, r.UserId, r.Action, r.EntityType, r.EntityId, r.EntityTitle, r.Detail, r.CreatedAt,
                r.UserId is Guid id && names.TryGetValue(id, out var name) ? name : null))
            .ToList();

        return new AuditLogPage(items, nextCursor);
    }
}
