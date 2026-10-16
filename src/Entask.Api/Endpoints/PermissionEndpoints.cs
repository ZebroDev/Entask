using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Core.Abstractions;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class PermissionEndpoints
{
    public static IEndpointRouteBuilder MapPermissions(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/permissions", async (EntaskDbContext db) =>
            Results.Ok(await db.Permissions
                .OrderBy(p => p.Category).ThenBy(p => p.Code)
                .Select(p => new { p.Code, p.Category, p.Description })
                .ToListAsync()))
        .RequireAuthorization();

        // 我的有效權限（多角色聯集；admin claim 回傳全部）
        app.MapGet("/api/permissions/mine", async (Guid teamId, ClaimsPrincipal principal, IPermissionChecker checker) =>
        {
            // R18: MapInboundClaims=false，ClaimTypes.NameIdentifier 不會被填入，fallback 至原始 "sub"
            var userId = Guid.Parse(
                principal.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? principal.FindFirstValue("sub")!);
            var codes = await checker.GetEffectivePermissionsAsync(userId, teamId);
            return Results.Ok(codes.Order());
        }).RequireAuthorization();

        return app;
    }
}
