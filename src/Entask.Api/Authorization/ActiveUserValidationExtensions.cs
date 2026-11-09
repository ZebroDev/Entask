using System.Security.Claims;
using Entask.Api.Endpoints;
using Entask.Core;
using Entask.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Entask.Api.Authorization;

/// <summary>
/// 已驗證請求的帳號狀態守衛（F-02，外部審查 2026-11-09）。
///
/// 停用／刪除只撤銷 refresh token；access token 在到期前（預設 30 分鐘）仍通過 JWT 驗證。
/// 專案權限守衛（`RequireProjectPermission`）與 <c>PermissionChecker</c> 都不看帳號狀態，
/// 且管理員 claim 會直接放行 ⇒ 停用者（尤其是管理員）仍可操作專案資料。
/// 端點層的 `ResolveCurrentUserAsync` 只罩住 admin 與 /api/me 那幾條，無法覆蓋全部。
///
/// 這裡在共用管線統一補上，讓「帳號不可用」與 token 是否過期脫鉤：
/// 每個已驗證請求以主鍵查一次使用者狀態（停用／刪除），不再依賴各端點記得檢查。
/// 代價是每個已驗證請求多一次 PK lookup；換來的是停用即時生效，而不是等 access token 過期。
///
/// 匿名端點（login／refresh／logout／health／頭像）一律跳過：它們本來就要能在憑證失效時
/// 執行，且登入請求可能夾帶前一個 session 的 Authorization header——不能因此擋掉重新登入。
/// </summary>
public static class ActiveUserValidationExtensions
{
    public static IApplicationBuilder UseActiveUserValidation(this IApplicationBuilder app) =>
        app.Use(async (context, next) =>
        {
            if (context.GetEndpoint()?.Metadata.GetMetadata<IAllowAnonymous>() is not null)
            {
                await next(context);
                return;
            }

            if (context.User.Identity?.IsAuthenticated == true)
            {
                // 與 RequireProjectPermission 一致：MapInboundClaims=false ⇒ fallback 至 "sub"。
                var userIdClaim = context.User.FindFirstValue(ClaimTypes.NameIdentifier)
                    ?? context.User.FindFirstValue("sub");
                // L-1：已驗證但 sub 無法解析成 GUID（或缺席）一律拒絕。這種 token 只有持有
                // 簽章金鑰才簽得出來，但放行是 fail-open：不同端點會各自以 500 或較寬鬆的
                // 路徑處理，違反「帳號狀態守衛罩住所有已驗證請求」的不變量。
                if (!Guid.TryParse(userIdClaim, out var userId))
                {
                    await ApiResults.WriteUnauthorizedAsync(context, ErrorCodes.AuthSessionInvalid);
                    return;
                }

                var db = context.RequestServices.GetRequiredService<EntaskDbContext>();
                var active = await db.Users.AsNoTracking().AnyAsync(
                    u => u.Id == userId && u.DeactivatedAt == null && u.DeletedAt == null,
                    context.RequestAborted);
                if (!active)
                {
                    await ApiResults.WriteUnauthorizedAsync(context, ErrorCodes.AuthSessionInvalid);
                    return;
                }
            }

            await next(context);
        });
}
