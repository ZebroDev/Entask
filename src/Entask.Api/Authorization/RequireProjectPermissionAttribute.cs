using System.Security.Claims;
using Entask.Api.Endpoints;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Identity;

namespace Entask.Api.Authorization;

// 這個類別是**死的**——全庫沒有任何程式碼在讀它（Minimal API 不消費具名方法上的屬性）。
// 把它寫在具名 handler 方法上會是「編譯得過、執行期毫無作用」的守衛：那個端點等於完全
// 沒有守衛，而四道閘門與所有測試都不會響。真正生效的是同檔的 `RequireProjectPermissionExtensions`。
//
// `[Obsolete(error: true)]` 是刻意的處置（2026-09-23 使用者裁定）：**不刪除**，因為刪除版的
// 錯誤訊息只給 `CS0246: 找不到類型`，而這一版的訊息直接指向正解。守門員是
// `DeadAttributeGuardTests`——否則下一個做死碼清理的人會把這兩行連類別一起清掉，而**不會
// 有任何測試變紅**，陷阱就回來了。
[Obsolete(
    "這個 attribute 沒有任何程式碼在讀它：掛上去編譯得過、執行期毫無作用（守衛靜默消失）。"
    + "請改用同檔的擴充方法 `.RequireProjectPermission(...)`。",
    error: true)]
[AttributeUsage(AttributeTargets.Method)]
public class RequireProjectPermissionAttribute : Attribute
{
    public string Code { get; }
    public RequireProjectPermissionAttribute(string code) => Code = code;
}

public static class RequireProjectPermissionExtensions
{
    public static RouteHandlerBuilder RequireProjectPermission(this RouteHandlerBuilder builder, params string[] codes)
    {
        // 讓這個守衛在端點圖上看得見（`EndpointAuthorizationGuardTests` 是唯一消費者）。
        // 少了這一行，「這個端點有沒有被守著」在端點圖上與完全沒掛守衛的端點長得一模一樣。
        builder.WithMetadata(new ProjectPermissionMetadata(codes));

        builder.Add(endpointBuilder =>
        {
            var original = endpointBuilder.RequestDelegate!;
            endpointBuilder.RequestDelegate = async context =>
            {
                // admin claim 直接放行（R8 語義）
                if (context.User.FindFirstValue(AdminClaim.Type) == AdminClaim.Value)
                {
                    await original(context);
                    return;
                }

                // R18: MapInboundClaims=false → fallback 至 "sub"
                var userIdClaim = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? context.User.FindFirstValue("sub");
                if (!Guid.TryParse(userIdClaim, out var userId))
                {
                    // 篩選器手上只有 HttpContext、沒有 IResult 可回，所以走產生點的另一個入口
                    // ——**不是**自己在這裡設狀態碼：兩條路徑的 bytes 必須相同（閘門 R14 釘住
                    // 全庫的 StatusCodes.Status401Unauthorized 恰好一處，就是產生點那一行）。
                    await ApiResults.WriteUnauthorizedAsync(context, ErrorCodes.AuthSessionInvalid);
                    return;
                }

                var resolver = context.RequestServices.GetRequiredService<IProjectScopeResolver>();
                var projectId = await resolver.ResolveProjectIdAsync(context);
                if (projectId is null)
                {
                    // 這裡與下面的「權限不足」刻意回**完全相同**的 body（同狀態碼、同 code、同 message）：
                    // 兩者若可分（例如「資源不存在」自己一個 code 或改回 404），就等於憑空造出一個
                    // 存在性 oracle——攻擊者用「哪一種回應」就能列舉資源存不存在。兩者的補救方式也相同。
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await context.Response.WriteAsJsonAsync(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" });
                    return;
                }

                // 任一權限成立即可（例：留言同時接受 card.comment 與 card.edit，後者保留給既有自訂角色）
                var checker = context.RequestServices.GetRequiredService<IPermissionChecker>();
                var granted = false;
                foreach (var code in codes)
                {
                    if (await checker.HasProjectPermissionAsync(userId, projectId.Value, code))
                    {
                        granted = true;
                        break;
                    }
                }
                if (!granted)
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
