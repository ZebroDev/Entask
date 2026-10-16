using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Identity;

namespace Entask.Api.Endpoints;

public static class AdminUserEndpoints
{
    public static IEndpointRouteBuilder MapAdminUserEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/admin/users").RequireAuthorization();

        // 管理員閘門。形狀照 `AuthEndpoints.cs` 建立帳號端點那條非 admin 分支的既有寫法
        // （**描述性引用**——2026-10-07 實查時它已不在舊註解寫的行號上）。
        //
        // ★ 每條路由**同時**要 `ResolveCurrentUserAsync`（設計 §4.4）。理由：被停用的
        //   管理員在 access token 過期前**仍帶著 `entask:admin` claim**，少了後者，
        //   他可以在被停用之後用舊 token 把自己復原、或對別人做一樣的事。
        async Task<IResult?> RequireAdminAsync(ClaimsPrincipal principal, UserManager<ApplicationUser> userManager)
        {
            var (_, error) = await UserEndpoints.ResolveCurrentUserAsync(principal, userManager);
            if (error is not null) return error;

            // 403 共用 `permission.denied`，不為「資源不存在」另開一個 code
            // （docs/invariants/04-error-codes-and-messages.md）。這一行逐字照
            // `AuthEndpoints.cs` 建立帳號端點的非 admin 分支寫——`message` 是內嵌字面值，
            // 改一個字就會被 `check:message-values` 抓（它是雙向契約）。
            if (principal.FindFirstValue(AdminClaim.Type) == AdminClaim.Value) return null;
            return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                statusCode: StatusCodes.Status403Forbidden);
        }

        group.MapGet("", async (EntaskDbContext db, UserManager<ApplicationUser> userManager,
            ClaimsPrincipal principal) =>
        {
            if (await RequireAdminAsync(principal, userManager) is { } gate) return gate;

            var rows = await db.Users
                .OrderBy(u => u.DisplayName).ThenBy(u => u.UserName)
                .Select(u => new
                {
                    u.Id, u.UserName, u.DisplayName, u.AvatarUrl, u.DeactivatedAt, u.DeletedAt,
                })
                .ToListAsync();

            var adminIds = (await db.UserClaims
                    .Where(c => c.ClaimType == AdminClaim.Type && c.ClaimValue == AdminClaim.Value)
                    .Select(c => c.UserId).ToListAsync())
                .ToHashSet();

            return Results.Ok(rows.Select(u => new AdminUserResponse(
                u.Id, u.UserName ?? "", u.DisplayName, u.AvatarUrl,
                adminIds.Contains(u.Id), u.DeactivatedAt, u.DeletedAt)).ToList());
        });

        group.MapGet("/{userId:guid}/offboarding", async (Guid userId, EntaskDbContext db,
            UserManager<ApplicationUser> userManager, ClaimsPrincipal principal) =>
        {
            if (await RequireAdminAsync(principal, userManager) is { } gate) return gate;

            var openCards = await db.Cards
                .CountAsync(c => !c.IsArchived && c.CompletedAt == null
                                 && c.Members.Any(m => m.UserId == userId));

            // `pending` 是不可提交的狀態（docs/invariants/08-reviews.md）。
            // `CardReview` 掛著 `RemovedAt == null` 的全域 query filter ⇒ 這裡只算現任。
            var pendingReviews = await db.CardReviews
                .CountAsync(r => r.ReviewerUserId == userId && r.Status == ReviewStatuses.Pending);

            var projectMemberships = await db.ProjectMembers.CountAsync(m => m.UserId == userId);
            var teamMemberships = await db.TeamMembers.CountAsync(m => m.UserId == userId);

            return Results.Ok(new OffboardingResponse(openCards, pendingReviews,
                projectMemberships, teamMemberships));
        });

        group.MapPost("/{userId:guid}/deactivate", async (Guid userId, EntaskDbContext db,
            UserManager<ApplicationUser> userManager, JwtTokenService tokens,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            var (caller, error) = await UserEndpoints.ResolveCurrentUserAsync(principal, userManager);
            if (error is not null) return error;
            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var user = await userManager.FindByIdAsync(userId.ToString());
            if (user is null) return TargetMissing();
            if (user.DeletedAt is not null) return TargetMissing();   // 已刪除者不可再操作
            if (user.DeactivatedAt is not null) return Results.NoContent();   // 冪等

            if (user.Id == caller!.Id)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "不可停用自己的帳號" });

            // 「最後一個 admin」的判準是**當下進得去的人數**，不是歷史上有幾個。
            // 寫成「admin 總數」會讓「已停用一個、再停用另一個」在第二次誤判為安全。
            //
            // ★ 已接受的殘餘（T5 review 的 F1，2026-10-07 裁定）：兩個 admin **併發**互打
            //   deactivate 時，兩邊都讀到 count ＝ 2（對方的 commit 還沒發生）⇒ 兩道守衛
            //   都過 ⇒ 0 個可用 admin，in-band 不可復原（登入被擋、復原需要 admin），
            //   只能直接改 DB。刻意不修：正確的修法要交易＋鎖序（`SELECT … FOR UPDATE`
            //   或條件式 UPDATE），而併發**做不出確定的紅燈**（本 repo 的判別標準）
            //   ——沒有紅燈的守衛只是一種形狀。
            if (await IsAdminAsync(db, user.Id) && await CountUsableAdminsAsync(db) <= 1)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "不可停用最後一個可用的管理員" });

            user.DeactivatedAt = DateTime.UtcNow;
            var result = await userManager.UpdateAsync(user);
            if (!result.Succeeded) return UpdateFailed(result);

            // 一定要撤銷：不撤銷的話**復原時舊 session 會一起復活**
            // （某人三個月前那台筆電的 refresh token 會重新有效）。**只有在更新成功時**
            // ——否則撤銷與稽核都做了、狀態卻沒變（I-2）。
            await tokens.RevokeAllActiveAsync(user.Id, RevokedReasons.Deactivated);

            await audit.AddAsync(caller.Id, null, AuditActions.UserDeactivated, "user", user.Id,
                user.UserName, new { username = user.UserName });

            return Results.NoContent();
        });

        group.MapPost("/{userId:guid}/reactivate", async (Guid userId, EntaskDbContext db,
            UserManager<ApplicationUser> userManager, IAuditService audit, ClaimsPrincipal principal) =>
        {
            var (caller, error) = await UserEndpoints.ResolveCurrentUserAsync(principal, userManager);
            if (error is not null) return error;
            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var user = await userManager.FindByIdAsync(userId.ToString());
            if (user is null) return TargetMissing();
            if (user.DeletedAt is not null) return TargetMissing();
            if (user.DeactivatedAt is null) return Results.NoContent();   // 冪等

            user.DeactivatedAt = null;
            var result = await userManager.UpdateAsync(user);
            if (!result.Succeeded) return UpdateFailed(result);

            // **不復原任何 token**——撤銷是永久的。復原只復原帳號，不復原工作階段。
            await audit.AddAsync(caller!.Id, null, AuditActions.UserReactivated, "user", user.Id,
                user.UserName, new { username = user.UserName });

            return Results.NoContent();
        });

        group.MapPost("/{userId:guid}/reset-password", async (Guid userId, ResetPasswordRequest req,
            EntaskDbContext db, UserManager<ApplicationUser> userManager, JwtTokenService tokens,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            var (caller, error) = await UserEndpoints.ResolveCurrentUserAsync(principal, userManager);
            if (error is not null) return error;
            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var user = await userManager.FindByIdAsync(userId.ToString());
            if (user is null) return TargetMissing();
            if (user.DeletedAt is not null) return TargetMissing();   // 已刪除者不可再操作
            // 停用者**可以**重置：停用可復原，重置後復原即可用（與 reactivate 只擋 DeletedAt 同形）。
            // 不必多一道「先復原」的摩擦——那是刪除那條兩階段設計的理由，不是這條的。

            if (user.Id == caller!.Id)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "不可重設自己的密碼" });

            // **先驗後清。** `AddPasswordAsync` 對已經有密碼的使用者是**拒絕**、不是覆寫
            // ——2026-10-08 實測：它回 `UserAlreadyHasPassword`（「User already has a password.」）
            // 且一個位元組都沒寫。所以「只呼叫它一支」的方案在真實使用者身上**永遠回 400、
            // 密碼從來沒有被換過**（那個推論在實作階段被紅燈推翻）。
            // 一定要先移除舊的，但移除與新增之間那位使用者處於**沒有密碼**的狀態，而那不是
            // 一個可以用密碼登入的狀態 ⇒ 政策驗證必須跑在移除**之前**。
            // 守門員是 `AdminPasswordResetTests.Reset_WithNonCompliantPassword_KeepsOldPasswordWorking`
            // （拿掉這個迴圈，它會紅在「舊密碼仍有效」那一行）。
            foreach (var validator in userManager.PasswordValidators)
            {
                var validation = await validator.ValidateAsync(userManager, user, req.NewPassword);
                if (!validation.Succeeded) return UpdateFailed(validation);
            }

            // ★ **交易是必要的，不是保險。** `RemovePasswordAsync` 與 `AddPasswordAsync`
            //   各是一次 `SaveChangesAsync`（兩次來回），所以中間那個「這個人沒有密碼」的
            //   狀態**會 commit 出去**。沒有交易時，任何在兩次之間寫入同一列的第三方
            //   ——另一位管理員按旁邊那顆「停用／復原」、或本人用**仍然有效**的 access token
            //   改 profile／頭像（`UserEndpoints.cs` 那兩條也是 `userManager.UpdateAsync`）
            //   ——會讓 `AddPasswordAsync` 撞 `ConcurrencyStamp`（`EntaskDbContext` 繼承
            //   `IdentityDbContext` ⇒ 它是 concurrency token）⇒ 回 400，而目標已被留在
            //   **沒有密碼**的狀態：鎖死、稽核沒寫、refresh 也沒撤銷。行程在兩次寫入之間
            //   死掉（容器滾動／OOM）是同一件事，而那一半任何註解都救不回來。
            //   **交易保證的正是「失敗時舊密碼還在」**——它不會阻止併發失敗本身。
            //   撤銷與稽核**也刻意留在交易內**：一筆成功的重設一定配一筆稽核與一次撤銷，
            //   而失敗時三者一起回滾（否則會出現「密碼換了、沒有紀錄、舊 session 還活著」）。
            //   收尾照〈程式碼不變量〉：一律經 `TransactionGuard.RollbackIfActiveAsync(db)`。
            //
            //   **罩得住的前提（實查 ＋ 實測）**：`UserManager` 的 store 用的是**同一個**
            //   scoped `EntaskDbContext`——`Program.cs` 的 `AddDbContext<EntaskDbContext>`
            //   預設 Scoped，同一條 Identity 鏈上的 `.AddEntityFrameworkStores<EntaskDbContext>()`
            //   把 store 綁到它（`JwtTokenService`／`AuditService` 的建構子收的也是它）。
            //   （2026-10-11：原本寫的是 `:37`／`:47`，行號已因子行插入而漂移 ⇒ 改以符號定位。）
            //   2026-10-08 實測（探針已移除）：同一 scope 內對該交易 `RemovePasswordAsync`
            //   再 `RollbackAsync` ⇒ 另一個 scope 讀到的 `PasswordHash` **還在**。
            //   少了這個前提，交易會是空的而**看起來完全正常**。
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                var removed = await userManager.RemovePasswordAsync(user);
                if (!removed.Succeeded)
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    return UpdateFailed(removed);
                }

                // 新增時 Identity 會再跑一次同一組驗證器——上面那個迴圈不是它的替代品，
                // 只是把（可預期的）失敗提前到狀態改變**之前**。
                var result = await userManager.AddPasswordAsync(user, req.NewPassword);
                if (!result.Succeeded)
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    return UpdateFailed(result);
                }

                // 解鎖（2026-10-10）：lockout 是 per-account 的，5 次錯密碼就能把任何已知帳號
                // 鎖 15 分鐘，而在此之前**全庫沒有任何解鎖路徑**（`ResetAccessFailedCountAsync`
                // 只出現在登入成功那條）。**兩支都叫是刻意的**：一支清失敗計數、一支清
                // `LockoutEnd`——Identity 的哪一支「順便」做了另一件事不是這裡要依賴的契約。
                // **必須在同一個交易內**：只換了密碼卻沒解鎖，正是要消滅的那個狀態（被鎖的人
                // 拿著新密碼照樣進不來）。失敗照同一個出口（I-2）——回滾、不撤銷、不稽核，
                // 不留「密碼換了、人卻進不去、也沒有紀錄」的組合。
                var unlocked = await userManager.SetLockoutEndDateAsync(user, null);
                if (!unlocked.Succeeded)
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    return UpdateFailed(unlocked);
                }

                var failuresCleared = await userManager.ResetAccessFailedCountAsync(user);
                if (!failuresCleared.Succeeded)
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    return UpdateFailed(failuresCleared);
                }

                // 與使用者改自己密碼同一條理由（UserEndpoints.cs 的 /password）：不撤銷的話
                // 被重設密碼的人也攔不住（舊 session 仍有效）。**只有在更新成功時**——否則
                // 撤銷與稽核都做了、密碼卻沒變（I-2，2026-10-08 的複審）。
                await tokens.RevokeAllActiveAsync(user.Id, RevokedReasons.PasswordChanged);

                await audit.AddAsync(caller.Id, null, AuditActions.UserPasswordReset, "user", user.Id,
                    user.UserName, new { username = user.UserName });

                await tx.CommitAsync();
                return Results.NoContent();
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        });

        group.MapDelete("/{userId:guid}", async (Guid userId, EntaskDbContext db,
            UserManager<ApplicationUser> userManager, IAuditService audit, ClaimsPrincipal principal) =>
        {
            var (caller, error) = await UserEndpoints.ResolveCurrentUserAsync(principal, userManager);
            if (error is not null) return error;
            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var user = await userManager.FindByIdAsync(userId.ToString());
            if (user is null) return TargetMissing();
            if (user.DeletedAt is not null) return TargetMissing();

            // 兩階段是這個設計的骨架（D5）。它同時讓「最後一個 admin」的守衛不可能被繞過——
            // 進不了停用狀態就到不了這裡。
            if (user.DeactivatedAt is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "請先停用這個帳號再刪除" });

            // 清帳號資料，**DisplayName 留著**（D2：歷史要還讀得懂）。
            // `UserName` 用佔位符而不是空字串：Identity 對 `NormalizedUserName` 有唯一性約束，
            // 空字串第二個就撞。UI 上顯示成「陳美惠／@deleted-3f9a1c2b」，in-band 地說明
            // 這個帳號已經沒了——不必為此在五個投影站點各加一個條件。
            var placeholder = $"deleted-{user.Id:N}"[..24];
            user.UserName = placeholder;
            user.NormalizedUserName = placeholder.ToUpperInvariant();
            user.Email = null;
            user.NormalizedEmail = null;
            user.PasswordHash = null;
            user.SecurityStamp = Guid.NewGuid().ToString();
            user.ConcurrencyStamp = Guid.NewGuid().ToString();
            user.AvatarUrl = null;
            user.DeletedAt = DateTime.UtcNow;
            var result = await userManager.UpdateAsync(user);
            if (!result.Succeeded) return UpdateFailed(result);

            await audit.AddAsync(caller!.Id, null, AuditActions.UserDeleted, "user", user.Id,
                user.DisplayName, new { username = placeholder });

            return Results.NoContent();
        });

        return app;
    }

    /// <summary>
    /// 「目標使用者不存在」不是 404——這個 repo **沒有** `ErrorCodes.NotFound`，也沒有
    /// `user.notFound`（2026-10-07 實查）。既有的形狀是 400 ＋ `RequestInvalid` ＋
    /// 「使用者不存在」（`TeamEndpoints.cs:185`），照它寫。
    ///
    /// **不是 `MapAdminUserEndpoints` 裡的區域函式**（計畫原本的形狀）：Task 4 的兩條路由
    /// 都是唯讀、一次都用不到它，而區域函式沒被用到會產生 `CS8321`（實測：`dotnet build`
    /// 1 個警告）——Step 10 的預期是 0 警告。收成類別成員沒有行為差異，Task 5 的三個動作
    /// 端點在**同一個類別裡**以簡單名稱呼叫它，逐字不變。
    /// </summary>
    private static IResult TargetMissing() =>
        Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "使用者不存在" });

    /// <summary>
    /// `UserManager.UpdateAsync` 的失敗出口（I-2）：**形狀逐字照**建帳號端點
    /// （`AuthEndpoints.cs` 的 `CreateAsync` 失敗分支），不新增錯誤碼或字面值
    /// ——`message` 是 Identity 的原文，`code` 經 `IdentityErrorCodes.Map`（認不得的落
    /// `identity.unknown`，不猜）。
    ///
    /// 三個動作端點（停用／復原／刪除）共用它：失敗時**不撤銷、不稽核**。少了這道檢查，
    /// 回傳值被丟掉，端點照樣往下走——該做的處置與「狀態是否真的改變」脫鉤。
    /// 刪除路徑修前的形狀更糟：回的是 **500**（2026-10-08 修前測試實測 `Expected: BadRequest`／
    /// `Actual: InternalServerError`）。**500 的機制是推論（未實查、未捕捉堆疊）**：使用者的修改
    /// 還掛在同一個 scoped `EntaskDbContext` 的變更追蹤裡，後續稽核的 `SaveChangesAsync` 會把
    /// 它一起送去寫 ⇒ 例外從稽核那一行炸出來。已實測的是失敗的**來源**——`UpdateAsync` 是
    /// **回傳失敗**、不是拋例外（同日探針）。
    /// </summary>
    private static IResult UpdateFailed(IdentityResult result)
    {
        var e = result.Errors.First();
        return Results.BadRequest(new { code = IdentityErrorCodes.Map(e.Code), message = e.Description });
    }

    /// <summary>資料庫裡的 admin 身分。判準是 `UserClaims` 的列，不是 token 裡的 claim
    /// ——停用端點的「最後一個 admin」守衛要數的是**現在**還算數的那些人。</summary>
    private static Task<bool> IsAdminAsync(EntaskDbContext db, Guid userId) =>
        db.UserClaims.AnyAsync(c => c.UserId == userId
            && c.ClaimType == AdminClaim.Type && c.ClaimValue == AdminClaim.Value);

    /// <summary>
    /// 「當下進得去」的 admin 人數。判準不可是 admin 總數——見呼叫端的註解。
    ///
    /// `Distinct()` 是語意的一部分：數的是**人**，不是 claim 的**列**。同一使用者可能有兩列
    /// `(entask:admin,true)`（`AdminClaimSeed` 的〈併發註記〉說這種重複列可能存在，
    /// 而它當時的理由是「所有讀取路徑都是 Any／FindFirstValue」——這個 count 不是）。
    /// **HTTP 上不可觀測**（重複列目前沒有產生路徑，同 R15 的理由），所以沒有測試釘著它。
    /// </summary>
    private static Task<int> CountUsableAdminsAsync(EntaskDbContext db) =>
        db.UserClaims
            .Where(c => c.ClaimType == AdminClaim.Type && c.ClaimValue == AdminClaim.Value)
            .Join(db.Users, c => c.UserId, u => u.Id, (_, u) => u)
            .Where(u => u.DeactivatedAt == null && u.DeletedAt == null)
            .Select(u => u.Id)
            .Distinct()
            .CountAsync();
}

public record ResetPasswordRequest(string NewPassword);
