using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Entask.Identity.Models;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Infrastructure.Identity;

namespace Entask.Api.Endpoints;

public static class UserEndpoints
{
    // 頭像大小上限。回應的 @params max 由此除以 1024*1024 得出，兩者必須同源
    // ——否則改了上限、訊息卻還是舊數字（或反過來），而且沒有任何東西會變紅。
    private const long MaxAvatarFileSize = 5 * 1024 * 1024;

    private static bool IsValidAvatarFileName(string fileName)
    {
        return Regex.IsMatch(fileName, "^[0-9a-fA-F]{32}\\.(png|jpg|jpeg|gif|webp)$");
    }

    /// <summary>
    /// 解析目前使用者。回傳的 <c>Error</c> 不是 null 時，呼叫端必須直接把它回出去。
    ///
    /// **`/api/me/*` 這一組路由的唯一入口。** 在這之前它是四條路由各兩份、共 8 個
    /// 逐字相同的副本（`:49/:52`、`:78/:81`、`:102/:105`、`:160/:163`），而它的註解寫著
    /// 「兩種到達方式（`sub` 不是 GUID／使用者已被刪除）共用一個碼」。
    ///
    /// ★ **`/api/auth/me` 不在這裡——它有自己的一份行內副本**（`AuthEndpoints.cs`，
    /// 2026-10-07 實查）。那一條要先 `Guid.TryParse` 擋非 GUID 的 `sub`
    /// （`AuthErrorBodyTests` 站點③ 釘著那一格），所以不能改走這支 helper
    /// ⇒ **判準在兩處，改一處要一起改另一處**；只改一邊不會有任何紅燈。
    ///
    /// 為什麼一定要收成一處：2026-10-07 的停用／刪除設計讓「使用者已被刪除」**不再表現為
    /// `user is null`**（列還在，只是多了 `DeletedAt`）⇒ 8 個副本會**同時靜默失明**，
    /// 而它們看起來完全正常。判準是 `grep -c AuthSessionInvalid` 於本檔 ＝ 1。
    ///
    /// **不要把它拆回行內。**
    ///
    /// `internal` 而非 `private`：Task 4 的 `AdminUserEndpoints` 要共用它——被停用的管理員
    /// 在 token 過期前仍帶著 `entask:admin` claim，那個群組少了這一步就擋不住他。
    /// </summary>
    internal static async Task<(ApplicationUser? User, IResult? Error)> ResolveCurrentUserAsync(
        ClaimsPrincipal principal, UserManager<ApplicationUser> userManager)
    {
        var userId = principal.FindFirstValue(JwtRegisteredClaimNames.Sub);
        var user = userId is null ? null : await userManager.FindByIdAsync(userId);

        // 停用與刪除共用 `sessionInvalid`：AuthErrorBodyTests 的檔頭已經定義它是
        // 「token 有效但主體不可用」——兩者都精確落在這句話裡，不必新造語意。
        // `user is null` 那一支仍是原本的兩種到達方式（`sub` 不是 GUID／使用者已被刪除）。
        //
        // ★ 這一條同時罩住四條 `/api/me/*` 路由與 admin 群組。它之所以有效，
        //   前提是 Task 2 把那 8 個副本收成了一處——副本是靠不住的。
        if (user is null || user.DeletedAt is not null || user.DeactivatedAt is not null)
            return (null, ApiResults.Unauthorized(ErrorCodes.AuthSessionInvalid));

        return (user, null);
    }

    // 頭像的落地目錄（2026-09-28）。形狀與 `AttachmentStore` 的建構子同型——**設定優先、
    // 缺席才回退**——但兩者的鍵與預設目錄不同：附件走 `Storage:AttachmentsPath`，頭像走
    // `Storage:AvatarsPath`。在這之前頭像是硬編碼的，於是「用設定把附件搬到 volume 外的
    // 絕對路徑」時頭像會留在 image 裡（重新佈署即消失），而**不會有任何東西變紅**。
    //
    // `IsNullOrWhiteSpace` 而非 `IsNullOrEmpty` 是刻意的：設定檔裡的空白字串是**填錯**，
    // 不是一個路徑——`Path.Combine("", "x")` 會變成相對路徑而落在行程的工作目錄。
    // 公開是為了可測（`BoardEndpoints.CurrentUserId` 是同一種形狀的先例）。
    public static string ResolveAvatarsRoot(IConfiguration config, IWebHostEnvironment env)
    {
        var configured = config["Storage:AvatarsPath"];
        return string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "storage", "avatars")
            : configured;
    }

    public static IEndpointRouteBuilder MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/me").RequireAuthorization();

        group.MapPut("/profile", async (
            UpdateProfileRequest req,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager) =>
        {
            var (user, sessionError) = await ResolveCurrentUserAsync(principal, userManager);
            if (sessionError is not null) return sessionError;

            if (string.IsNullOrWhiteSpace(req.DisplayName))
                return Results.BadRequest(new { code = ErrorCodes.UserDisplayNameRequired, message = "顯示名稱不可為空" });
            if (req.DisplayName.Length > 100)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.UserDisplayNameTooLong,
                    message = "顯示名稱不可超過 100 字元",
                    @params = new { max = 100 }
                });

            user!.DisplayName = req.DisplayName;
            var result = await userManager.UpdateAsync(user);
            return result.Succeeded
                ? Results.Ok()
                : ApiResults.InternalError(ErrorCodes.UserUpdateFailed);
        });

        group.MapPut("/password", async (
            UpdatePasswordRequest req,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            JwtTokenService tokens) =>
        {
            var (user, sessionError) = await ResolveCurrentUserAsync(principal, userManager);
            if (sessionError is not null) return sessionError;

            var result = await userManager.ChangePasswordAsync(user!, req.CurrentPassword, req.NewPassword);
            if (!result.Succeeded)
            {
                var e = result.Errors.First();
                return Results.BadRequest(new { code = IdentityErrorCodes.Map(e.Code), message = e.Description });
            }

            // 改密碼 ⇒ 撤銷**全部**有效 session（外部報告 C 類第 2 條）：token 裡沒有「這顆是
            // 哪個 session」的資訊 ⇒ 現行 session 也一起（access token 最多再活 30 分鐘，
            // 之後需以新密碼重新登入）。**必須成對**——只改密碼不撤銷，被改密碼的人也攔不住。
            await tokens.RevokeAllActiveAsync(user!.Id, RevokedReasons.PasswordChanged);

            return Results.Ok();
        });

        group.MapPut("/avatar", async (
            IFormFile file,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            IWebHostEnvironment env,
            IConfiguration config) =>
        {
            var (user, sessionError) = await ResolveCurrentUserAsync(principal, userManager);
            if (sessionError is not null) return sessionError;

            if (file.Length == 0) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "檔案為空" });

            // 限制圖片格式與大小
            var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
            if (ext is not ".jpg" and not ".jpeg" and not ".png" and not ".gif" and not ".webp")
                return Results.BadRequest(new { code = ErrorCodes.UserAvatarUnsupportedFormat, message = "不支援的檔案格式" });
            if (file.Length > MaxAvatarFileSize)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.UserAvatarTooLarge,
                    message = "檔案大小不可超過 5MB",
                    @params = new { max = MaxAvatarFileSize / (1024 * 1024) }
                });

            var avatarsPath = ResolveAvatarsRoot(config, env);
            Directory.CreateDirectory(avatarsPath);

            var newFileName = $"{Guid.NewGuid():N}{ext}";
            if (!IsValidAvatarFileName(newFileName))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "大頭貼檔名不合法" });

            var fullPath = Path.Combine(avatarsPath, newFileName);

            await using var stream = File.Create(fullPath);
            await file.CopyToAsync(stream);

            // 如果原本有大頭貼，就刪除
            if (!string.IsNullOrEmpty(user!.AvatarUrl))
            {
                var oldFileName = Path.GetFileName(user.AvatarUrl);
                if (!IsValidAvatarFileName(oldFileName))
                    return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "大頭貼檔名不合法" });

                var oldFullPath = Path.Combine(avatarsPath, oldFileName);
                if (File.Exists(oldFullPath)) File.Delete(oldFullPath);
            }

            user.AvatarUrl = $"/api/avatars/{newFileName}";
            var result = await userManager.UpdateAsync(user);

            return result.Succeeded
                ? Results.Ok(new { AvatarUrl = user.AvatarUrl })
                : ApiResults.InternalError(ErrorCodes.UserUpdateFailed);
        }).DisableAntiforgery(); // 為了接受 multipart/form-data，且使用 JWT 驗證

        group.MapDelete("/avatar", async (
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            IWebHostEnvironment env,
            IConfiguration config) =>
        {
            var (user, sessionError) = await ResolveCurrentUserAsync(principal, userManager);
            if (sessionError is not null) return sessionError;

            if (!string.IsNullOrEmpty(user!.AvatarUrl))
            {
                var oldFileName = Path.GetFileName(user.AvatarUrl);
                if (!IsValidAvatarFileName(oldFileName))
                    return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "大頭貼檔名不合法" });

                var avatarsPath = ResolveAvatarsRoot(config, env);
                var oldFullPath = Path.Combine(avatarsPath, oldFileName);
                if (File.Exists(oldFullPath)) File.Delete(oldFullPath);
            }

            user.AvatarUrl = null;
            var result = await userManager.UpdateAsync(user);

            return result.Succeeded
                ? Results.Ok()
                : ApiResults.InternalError(ErrorCodes.UserDeleteFailed);
        });

        app.MapGet("/api/avatars/{fileName}", (string fileName, IWebHostEnvironment env, IConfiguration config) =>
        {
            var safeName = Path.GetFileName(fileName);
            if (!IsValidAvatarFileName(safeName))
                return ApiResults.NotFound(ErrorCodes.UserAvatarNotFound);

            var avatarsPath = ResolveAvatarsRoot(config, env);
            var fullPath = Path.Combine(avatarsPath, safeName);
            if (!File.Exists(fullPath)) return ApiResults.NotFound(ErrorCodes.UserAvatarNotFound);

            var ext = Path.GetExtension(safeName).ToLowerInvariant();
            var contentType = ext switch
            {
                ".png" => "image/png",
                ".gif" => "image/gif",
                ".webp" => "image/webp",
                _ => "image/jpeg"
            };

            return Results.File(fullPath, contentType);
        }).AllowAnonymous();

        return app;
    }
}

public record UpdateProfileRequest(string DisplayName);
public record UpdatePasswordRequest(string CurrentPassword, string NewPassword);
