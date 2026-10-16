using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Api.Options;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Identity;

namespace Entask.Api.Endpoints;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuth(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth");

        group.MapPost("/login", async (
            LoginRequest req,
            UserManager<ApplicationUser> userManager,
            JwtTokenService tokens,
            HttpContext ctx) =>
        {
            // 下面四條失敗路徑**必須共用同一個碼**（＝同一份 body）：分開就等於憑
            // 「哪一個 code」列舉帳號存不存在。登入頁的 catch 刻意不看 body 也是同一個理由。
            // 守門員是 AuthErrorBodyTests 那支「四條路徑逐位元相同」。
            var user = await userManager.FindByNameAsync(req.Username);
            if (user is null)
                return ApiResults.Unauthorized(ErrorCodes.AuthInvalidCredentials);

            // 鎖定檢查：失敗 5 次後 15 分鐘內即使密碼正確也拒絕
            if (await userManager.IsLockedOutAsync(user))
                return ApiResults.Unauthorized(ErrorCodes.AuthInvalidCredentials);

            // 停用與刪除者共用既有的通用碼（D9）——**不新增錯誤碼**。
            // 掛在密碼檢查之前是**成本**考量、不是機密性考量：兩種順序回的都是同一個 body
            // （上面那條四路徑逐位元相同的測試看著它），所以提早 return 只是省下一次
            // 為「永遠登不進來的帳號」做的 PBKDF2 雜湊。
            // 時序上沒有新破口：不存在的帳號本來就在 FindByNameAsync 之後直接 return。
            if (user.DeletedAt is not null || user.DeactivatedAt is not null)
                return ApiResults.Unauthorized(ErrorCodes.AuthInvalidCredentials);

            if (!await userManager.CheckPasswordAsync(user, req.Password))
            {
                // CheckPasswordAsync 不記錄失敗次數，須手動累計；達 5 次即鎖定
                await userManager.AccessFailedAsync(user);
                return ApiResults.Unauthorized(ErrorCodes.AuthInvalidCredentials);
            }

            await userManager.ResetAccessFailedCountAsync(user);

            var isAdmin = (await userManager.GetClaimsAsync(user))
                .Any(c => c.Type == AdminClaim.Type && c.Value == AdminClaim.Value);

            var (access, refresh) = await tokens.IssueTokensAsync(user, ctx.Connection.RemoteIpAddress?.ToString(), isAdmin);
            return Results.Ok(new AuthResponse(access, refresh, user.Id, user.UserName!, user.DisplayName, isAdmin, user.AvatarUrl));
        }).AllowAnonymous();

        group.MapPost("/refresh", async (RefreshRequest req, JwtTokenService tokens, HttpContext ctx) =>
        {
            // `sessionInvalid` 而不是自己一個碼：`JwtTokenService.RefreshAsync` 對「查不到／
            // 已撤銷／已過期」一律回 null，這一層分不出來——一個碼是它唯一誠實的解析度。
            var result = await tokens.RefreshAsync(req.RefreshToken, ctx.Connection.RemoteIpAddress?.ToString());
            return result is null ? ApiResults.Unauthorized(ErrorCodes.AuthSessionInvalid) : Results.Ok(
                new AuthResponse(result.Value.AccessToken, result.Value.RefreshToken, Guid.Empty, "", "", false, null));
        }).AllowAnonymous();

        // 不要求 Authorization：access token 可能已過期，撤銷僅憑 refresh token 本身
        // （token 值即為秘密，符合 OAuth 撤銷端點慣例）
        group.MapPost("/logout", async (RefreshRequest req, JwtTokenService tokens) =>
        {
            await tokens.RevokeAsync(req.RefreshToken);
            return Results.NoContent();
        }).AllowAnonymous();

        group.MapGet("/me", async (ClaimsPrincipal principal, UserManager<ApplicationUser> userManager) =>
        {
            var idClaim = principal.FindFirstValue(JwtRegisteredClaimNames.Sub);
            // 這一道**不可拿掉**：`AuthErrorBodyTests` 的站點③ 釘著「非 GUID 的 `sub` ⇒ 401」，
            // 而它也是這一條不共用 `ResolveCurrentUserAsync` 的唯一理由——helper 把原始 claim
            // 直接餵 `FindByIdAsync`，非 GUID 會拋。
            if (!Guid.TryParse(idClaim, out var userId))
                return ApiResults.Unauthorized(ErrorCodes.AuthSessionInvalid);

            var user = await userManager.FindByIdAsync(idClaim);
            // 停用與刪除的判準（設計 §4.3：窗在「本來就要讀 DB」的站點關掉）。
            // ★ 這是 `UserEndpoints.ResolveCurrentUserAsync` 之外的**第二份副本**——
            //   **兩處要一起改**，只改一處不會有任何紅燈（2026-10-07 Task 5）。
            if (user is null || user.DeletedAt is not null || user.DeactivatedAt is not null)
                return ApiResults.Unauthorized(ErrorCodes.AuthSessionInvalid);

            var isAdmin = principal.HasClaim(c => c.Type == AdminClaim.Type && c.Value == AdminClaim.Value);
            return Results.Ok(new MeResponse(userId, user.UserName ?? "", user.DisplayName, isAdmin, user.AvatarUrl));
        }).RequireAuthorization();

        // 列出**可見範圍內**的使用者（供指派成員下拉選單使用）
        //
        // 2026-09-23 收斂（第二階段）：篩選器把「任何已認證者」縮到「admin 或 X-Team-Id
        // 所指團隊的 team.member.manage」，但回應仍是全庫 ⇒ 任一個團隊的經理仍可列舉所有人。
        // 現在的範圍是「**該團隊成員 ∪ 未歸屬任何團隊者**」——後者是必要的：這個端點唯一的
        // 消費端是「指派成員」下拉，而它要挑的正是**還沒加入團隊**的人（`PUT
        // /api/teams/{teamId}/members`）。admin 不受限（平台擁有者，且他能建帳號）。
        // 非 admin 且無該團隊的 `team.member.manage` ⇒ **403** `permission.denied`（`RequirePermission`
        // 的既有語意，與 `PUT/DELETE /api/teams/{teamId}/members` 同一道閘門）。
        // 缺 header 時非 admin 到不了這裡（篩選器已回 400）；admin 無 header ⇒ 視為平台層操作。
        group.MapGet("/users", async (EntaskDbContext db, HttpContext ctx) =>
        {
            var teamHeader = ctx.Request.Headers["X-Team-Id"].FirstOrDefault();
            var scoped = Guid.TryParse(teamHeader, out var teamId)
                && ctx.User.FindFirstValue(AdminClaim.Type) != AdminClaim.Value;

            var query = db.Users.AsQueryable();
            // 可指派池**排除**停用與刪除者（設計 D7 的反面）。
            // 第二個條件是**防禦性冗餘**，不是承重的：不變量是
            // `DeletedAt is not null ⇒ DeactivatedAt is not null`（刪除的前置條件是已停用），
            // 所以只寫 `DeactivatedAt` 已經涵蓋已刪除者——兩個都寫，是為了不讓池子把
            // 語意寄望在那條不變量上（`ApplicationUser` 的欄位註解是它的出處）。
            query = query.Where(u => u.DeactivatedAt == null && u.DeletedAt == null);
            if (scoped)
            {
                var memberIds = db.TeamMembers.Where(m => m.TeamId == teamId).Select(m => m.UserId);
                var assignedIds = db.TeamMembers.Select(m => m.UserId);
                query = query.Where(u => memberIds.Contains(u.Id) || !assignedIds.Contains(u.Id));
            }

            var users = await query
                .OrderBy(u => u.DisplayName)
                .Select(u => new UserSummaryResponse(u.Id, u.UserName ?? "", u.DisplayName, u.AvatarUrl))
                .ToListAsync();
            return Results.Ok(users);
        }).RequireAuthorization().RequirePermission(PermissionCodes.TeamMemberManage);

        // **全目錄**的使用者搜尋（供跨團隊指派使用）
        //
        // 上一輪把 `/users` 收斂成「該團隊成員 ∪ 未歸屬任何團隊者」之後，跨團隊指派在下拉端
        // 就沒有路徑了（指派本身一直是允許的，缺的是「輸入名稱找人」這一條）。本端點把那個
        // **能力**補回來——範圍是**全目錄**，與 `/users` 的「可指派池」是兩個集合。
        // 因此**必須是另一條路由**：同一個 URL 帶不帶 `q` 回傳兩個不同宇宙的集合時，那個差異
        // 正好是本功能的安全性質，它必須在路由上看得見。（`/users` 與 `/users/search` 逐段比對，
        // 無 shadowing。）
        //
        // 閘門與 `/users` **逐字相同**：本端點的可見範圍嚴格大於 `/users` ⇒ 閘門不得比它弱，
        // 否則上一輪的收斂會被這條路整個繞過。「搜尋該不該更嚴」不採——另立一個權限碼會讓
        // 既有的團隊經理**預設拿不到**（範本角色要改），功能對目標使用者等於不可見；而且
        // admin 一律直接放行的關係，「新增權限碼卻忘了授予」在 admin 測試下不會被發現。
        //
        // ★ 列舉防護。要防的是「用搜尋**批次**倒出全庫名冊」，不是單筆的存在性 oracle
        // ——後者今天已經存在（`PUT /api/teams/{id}/members` 對不存在的帳號回「使用者不存在」），
        // 所以防護一律打在**列舉**上：
        //   ① trim 後 < 3 個字元 ⇒ 400，**不執行任何查詢**（擋「空查詢倒全庫」與單字元掃描）
        //   ② 硬寫 `Take(20)`，**刻意不開放 `limit` 參數**——一個呼叫端可調的上限，就是唯一
        //      能讓那個上限失效的旋鈕（`SearchEndpoints` 有那個旋鈕，這裡刻意不抄：
        //      少一個旋鈕，就少一個要守的地方）
        //   ③ 不回總數、不分頁——兩者本身就是列舉 API
        // 代價（刻意接受，不是缺陷）：`q=小明`（2 字元）搜不到，要 3 個字元才搜尋。
        // 字元數不是好的可列舉性代理指標（2 個漢字比 3 個拉丁字母更 specific），但那是
        // 取捨的結果，不要為了「讓中文更好用」而把門檻調成 2——那會讓英文 2 個字母就能探測。
        //
        // ★★ LIKE 的萬用字元**必須逃逸**。不逃逸時送 `q=%%%`（**3 個字元，會通過**上面的
        // 最短長度檢查）⇒ pattern 變成 `%%%%%%%` ⇒ **比對到全部使用者** ⇒ 一次請求倒出前 20 名，
        // 而上面三條防護看起來完全沒被繞過。
        // **逃逸的實作已於 2026-09-24 集中到 `LikePattern`**（單一建造點）——包含「`\` 要先逃逸」
        // 的順序理由與「escape 字元為什麼要明確傳給 `ILike`」，都在那個檔的類別摘要裡。
        // 站點這邊**不要再自己寫 `$"%{…}%"`**；`SearchEndpoints` 就是漏掉逃逸的那一站。
        // 守門員仍是 `UserSearchTests` 的 B-5b（**順序**）與 B-5（有沒有逃逸）——兩者守的是
        // 不同的性質，而 B-5 對順序**全盲**：順序顛倒時它的兩格照樣全綠（`Assert.Empty`
        // 因為錯的理由通過）。少了 B-5b，這一段會在下一次「順手簡化」時靜默消失。
        group.MapGet("/users/search", async (HttpContext ctx, EntaskDbContext db) =>
        {
            var trimmed = (ctx.Request.Query["q"].FirstOrDefault())?.Trim() ?? "";
            // 長度與**內容**是同一個閘門的兩半：前者擋「太短」（一次查詢就倒全庫），後者擋
            // 「合法長度但不該進查詢的值」。`q=%00%00%00` 三個 NUL **會通過**長度檢查
            // （`Trim()` 不剝 NUL、`Length == 3`），而 PostgreSQL 的 `text` 不能含 `0x00`
            // ⇒ 實測是 **500**（不是契約寫的 400）⇒ 呼叫端可以拿它隨意製造 500。
            // 兩半共用同一個出口、同一個碼是刻意的：這不是新的失敗種類，而是同一條閘門漏了
            // 一半。**訊息仍是長度那一句**——它對這一支不精確（值不短，只是不合法），
            // 換句措辭等於替 `request.invalid` 多生一個字面值，而那會動到
            // `check:message-values` 的粗粒度碼宣告；不精確的訊息勝過一個為此膨脹的契約。
            if (trimmed.Length < 3 || trimmed.Any(char.IsControl))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "搜尋關鍵字至少需 3 個字元" });

            var pattern = LikePattern.Contains(trimmed);

            var users = await db.Users
                .Where(u => u.DeactivatedAt == null && u.DeletedAt == null)
                .Where(u => EF.Functions.ILike(u.UserName!, pattern, LikePattern.EscapeCharacter) ||
                            EF.Functions.ILike(u.DisplayName, pattern, LikePattern.EscapeCharacter))
                // 決定性排序是必需的、不是美觀問題：有了 `Take(20)` 就一定有「是哪 20 筆」的
                // 問題，而不排序時同一句查詢的兩次請求可以回不同集合——那不是搜尋，是抽獎。
                .OrderBy(u => u.DisplayName).ThenBy(u => u.UserName)
                .Take(20)
                .Select(u => new UserSummaryResponse(u.Id, u.UserName ?? "", u.DisplayName, u.AvatarUrl))
                .ToListAsync();
            return Results.Ok(users);
        }).RequireAuthorization().RequirePermission(PermissionCodes.TeamMemberManage)
        // 限流與 `SearchEndpoints` 的同一個政策（列舉面共用一顆桶的定義，見 `RateLimitPolicy`）。
        // 上面的三條防護界住的是**單次請求**（最短長度／硬寫的 Take(20)／不分頁），
        // 界不住「一場 campaign」——那個要靠這裡。
        .RequireRateLimiting(RateLimitPolicy.Name);

        // 管理員建帳號（Phase 1 不開放自行註冊）
        group.MapPost("/users", async (
            CreateUserRequest req,
            UserManager<ApplicationUser> userManager,
            IAuditService audit,
            ClaimsPrincipal principal) =>
        {
            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            if (string.IsNullOrWhiteSpace(req.Username))
                return Results.BadRequest(new { code = ErrorCodes.AuthUsernameRequired, message = "帳號不可為空" });
            // minimal API JSON binding 不強制 NRT：displayName 缺席時 Length 會 NRE → 500
            if (string.IsNullOrWhiteSpace(req.DisplayName))
                return Results.BadRequest(new { code = ErrorCodes.UserDisplayNameRequired, message = "顯示名稱不可為空" });
            if (req.DisplayName.Length > 100)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.UserDisplayNameTooLong,
                    message = "顯示名稱不可超過 100 字元",
                    @params = new { max = 100 }
                });

            var user = new ApplicationUser { UserName = req.Username, DisplayName = req.DisplayName };
            var result = await userManager.CreateAsync(user, req.Password);
            if (!result.Succeeded)
            {
                var e = result.Errors.First();
                return Results.BadRequest(new { code = IdentityErrorCodes.Map(e.Code), message = e.Description });
            }

            if (req.IsAdmin)
            {
                var claimResult = await userManager.AddClaimAsync(user, new Claim(AdminClaim.Type, AdminClaim.Value));
                if (!claimResult.Succeeded)
                    return ApiResults.InternalError(ErrorCodes.AuthAdminGrantFailed);
            }

            await audit.AddAsync(
                Guid.Parse(principal.FindFirstValue(ClaimTypes.NameIdentifier)
                    ?? principal.FindFirstValue("sub")!),
                null, AuditActions.UserCreated, "user", user.Id, user.UserName, new { username = req.Username });
            return Results.Ok(new MeResponse(user.Id, user.UserName!, user.DisplayName, req.IsAdmin, user.AvatarUrl));
        })
        .RequireAuthorization();

        return group;
    }
}
