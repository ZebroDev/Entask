using System.Security.Claims;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Identity;

namespace Entask.Api.Authorization;

// 這個類別是**死的**——全庫沒有任何程式碼在讀它（Minimal API 不消費具名方法上的屬性）。
// 把它寫在具名 handler 方法上會是「編譯得過、執行期毫無作用」的守衛：那個端點等於完全
// 沒有守衛，而四道閘門與所有測試都不會響。真正生效的是同檔的 `RequirePermissionExtensions`。
//
// `[Obsolete(error: true)]` 是刻意的處置（2026-09-23 使用者裁定）：**不刪除**，因為刪除版的
// 錯誤訊息只給 `CS0246: 找不到類型`，而這一版的訊息直接指向正解。守門員是
// `DeadAttributeGuardTests`——否則下一個做死碼清理的人會把這兩行連類別一起清掉，而**不會
// 有任何測試變紅**，陷阱就回來了。
[Obsolete(
    "這個 attribute 沒有任何程式碼在讀它：掛上去編譯得過、執行期毫無作用（守衛靜默消失）。"
    + "請改用同檔的擴充方法 `.RequirePermission(...)`。",
    error: true)]
[AttributeUsage(AttributeTargets.Method)]
public class RequirePermissionAttribute : Attribute
{
    public string Code { get; }
    public RequirePermissionAttribute(string code) => Code = code;
}

public static class RequirePermissionExtensions
{
    public static RouteHandlerBuilder RequirePermission(this RouteHandlerBuilder builder, string code)
    {
        // 與 `RequireProjectPermission` 同一個理由：讓守衛在端點圖上看得見。
        builder.WithMetadata(new TeamPermissionMetadata(code));

        builder.Add(endpointBuilder =>
        {
            var original = endpointBuilder.RequestDelegate!;
            endpointBuilder.RequestDelegate = async context =>
            {
                // R8: admin claim 優先於 header 需求，直接放行（Task 5/6 既有測試以 admin 呼叫且不帶 header）
                if (context.User.FindFirstValue(AdminClaim.Type) == AdminClaim.Value)
                {
                    await original(context);
                    return;
                }

                // R18: MapInboundClaims=false，ClaimTypes.NameIdentifier 不會被填入，fallback 至原始 "sub"
                var userId = Guid.Parse(
                    context.User.FindFirstValue(ClaimTypes.NameIdentifier)
                    ?? context.User.FindFirstValue("sub")!);

                var teamHeader = context.Request.Headers["X-Team-Id"].FirstOrDefault();
                if (string.IsNullOrEmpty(teamHeader) || !Guid.TryParse(teamHeader, out var teamId))
                {
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    await context.Response.WriteAsync("缺少 X-Team-Id header");
                    return;
                }

                var checker = context.RequestServices.GetRequiredService<IPermissionChecker>();
                if (!await checker.HasPermissionAsync(userId, teamId, code))
                {
                    // 本檔三處 403（缺權限、route／query 的跨團隊守衛）一律回同一個 code：
                    // 它們對使用者的補救方式相同，區分只會增加 code 數量。
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await context.Response.WriteAsJsonAsync(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" });
                    return;
                }

                // 授權範圍綁定：權限檢查針對 X-Team-Id header 的團隊，資源本身的 teamId
                // （成員/角色端點在 route、audit-logs 在 query）必須與 header 一致，
                // 防止 A 團隊成員以 A 的 header 存取 B 團隊的資源
                if (context.Request.RouteValues.TryGetValue("teamId", out var routeTeamIdValue) &&
                    Guid.TryParse(routeTeamIdValue?.ToString(), out var routeTeamId) &&
                    routeTeamId != teamId)
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await context.Response.WriteAsJsonAsync(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" });
                    return;
                }
                if (context.Request.Query.TryGetValue("teamId", out var queryTeamIdValue) &&
                    Guid.TryParse(queryTeamIdValue.ToString(), out var queryTeamId) &&
                    queryTeamId != teamId)
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await context.Response.WriteAsJsonAsync(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" });
                    return;
                }
                await original(context);
            };
        });
        return builder;
    }
}
