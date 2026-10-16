using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Identity;

namespace Entask.Tests;

// 管理員重設使用者密碼（docs/state/35 的〈已裁定〉段，2026-10-08）。
// 與 UserDeactivationTests 同一個 fixture 形狀。
public class AdminPasswordResetTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AdminPasswordResetTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    /// <summary>建一個使用者，回傳它的 id。呼叫端自行處理 Authorization header。</summary>
    private async Task<string> CreateUserAsync(string username, string password = "Password1!")
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password,
            displayName = $"重設測試 {username}",
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;
        return (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetString()!;
    }

    private async Task<HttpStatusCode> LoginStatusAsync(string username, string password)
    {
        var resp = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password }));
        return resp.StatusCode;
    }

    /// <summary>非 admin 的 access token（`TestAuth` 只有 `GetAdminTokenAsync` 一支，
    /// 2026-10-08 實查）。</summary>
    private async Task<string> LoginTokenAsync(string username, string password)
    {
        var resp = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
    }

    /// <summary>seed admin 的 id 與 token。`AuthResponse` 帶 `userId`（`AuthDtos.cs:6`）。</summary>
    private async Task<(string Id, string Token)> AdminIdAndTokenAsync()
    {
        var seed = _factory.SeedCredentials();
        var resp = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var json = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return (json.GetProperty("userId").GetString()!, json.GetProperty("accessToken").GetString()!);
    }

    [Fact]
    public async Task Reset_WithNonCompliantPassword_KeepsOldPasswordWorking()
    {
        var id = await CreateUserAsync("reset-weak");

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword = "short" }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("identity.passwordTooShort", body.GetProperty("code").GetString());

        // 這一條才是這一支測試存在的理由：失敗之後**舊密碼仍然有效**。
        // ★ 判別力在**紅燈**：把 handler 裡「先跑 PasswordValidators」那個迴圈拿掉、
        //   只留 `RemovePasswordAsync` ＋ `AddPasswordAsync`，這一支就紅在這裡
        //   （`Expected: OK / Actual: Unauthorized`，2026-10-08 實測）——使用者被留在
        //   「沒有密碼」的狀態。綠燈分不出「先驗後清」與「根本沒被測到」。
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync("reset-weak", "Password1!"));
    }

    [Fact]
    public async Task Reset_ChangesPassword()
    {
        var id = await CreateUserAsync("reset-ok");

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword = "Temp2Pass!" }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync("reset-ok", "Temp2Pass!"));
        Assert.Equal(HttpStatusCode.Unauthorized, await LoginStatusAsync("reset-ok", "Password1!"));
    }

    // 解鎖（2026-10-10，D1 的裁定：重設密碼順帶解鎖、零新介面）。lockout 是 per-account 的
    // ——任何已知帳號 5 次錯密碼就被鎖 15 分鐘，而在此之前**全庫沒有任何解鎖路徑**
    // （唯一的 `ResetAccessFailedCountAsync` 在登入成功那條，見 `AuthEndpoints.cs`）。
    // 形狀取自 `AuthLoginTests.Login_FailsFiveTimes_ThenLockedOut`，但用**自己的**專用帳號
    // （`lockout-test` 屬另一個 class，且會被那一支鎖著 15 分鐘）。
    [Fact]
    public async Task ResetPassword_AlsoUnlocksLockedOutUser()
    {
        const string username = "unlock-test";
        const string oldPassword = "Password1!";
        const string newPassword = "Password2!";

        var id = await CreateUserAsync(username, oldPassword);

        // 鎖住它：5 次錯密碼 ⇒ 第 6 次即使密碼正確也是 401
        for (var i = 0; i < 5; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, await LoginStatusAsync(username, "WrongPass1!"));
        Assert.Equal(HttpStatusCode.Unauthorized, await LoginStatusAsync(username, oldPassword));

        // admin 重設密碼
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var reset = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword }));
        _client.DefaultRequestHeaders.Authorization = null;
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);

        // ★ 判別力所在：解鎖沒做的話，連新密碼都會被 lockout 擋下（Unauthorized）。
        //   綠燈分不出「解鎖真的做了」與「lockout 根本沒生效」——所以上面那條
        //   「舊密碼在重設前是 401」是這條斷言的**前提**，不是熱身。
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync(username, newPassword));
    }

    [Fact]
    public async Task Reset_RevokesExistingSessions()
    {
        var id = await CreateUserAsync("reset-session");

        // 使用者先自己登入，拿一顆 refresh token
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "reset-session", password = "Password1!" }));
        var refreshToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/reset-password",
                JsonContent.Create(new { newPassword = "Temp2Pass!" }))).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // 舊 refresh token 必須已死（撤銷是這一支的全部理由）
        var again = await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken }));
        Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);
        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("auth.sessionInvalid", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Reset_StampsPasswordChangedReason()
    {
        var id = await CreateUserAsync("reset-reason");
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "reset-reason", password = "Password1!" }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/reset-password",
                JsonContent.Create(new { newPassword = "Temp2Pass!" }))).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // 形狀照 UserDeactivationTests.Deactivate_StampsItsOwnRevocationReason：
        // 開一個 scope 讀 RefreshTokens 那一列。**刻意重用 `password_changed` 而不是
        // 新增一個原因**——理由全文在 `RevokedReasons.PasswordChanged` 的註解（新原因
        // 漏了 `RefreshAsync` 的臂會靜默落進 fail-safe）；這支測試釘的就是那個決定。
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var reasons = await db.RefreshTokens
            .Where(t => t.UserId == Guid.Parse(id) && t.RevokedReason != null)
            .Select(t => t.RevokedReason)
            .Distinct()
            .ToListAsync();
        Assert.Equal([RevokedReasons.PasswordChanged], reasons);
    }

    [Fact]
    public async Task Reset_Self_IsRejected()
    {
        var (adminId, adminToken) = await AdminIdAndTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var resp = await _client.PostAsync($"/api/admin/users/{adminId}/reset-password",
            JsonContent.Create(new { newPassword = "Temp2Pass!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("request.invalid", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Reset_ForDeletedUser_IsRejected()
    {
        var id = await CreateUserAsync("reset-gone");
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        // 刪除是兩階段的（D5）：先停用、再刪除
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/deactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.DeleteAsync($"/api/admin/users/{id}")).StatusCode);

        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword = "Temp2Pass!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("request.invalid", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Reset_ForDeactivatedUser_Succeeds()
    {
        var id = await CreateUserAsync("reset-off");
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/deactivate", null)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/reset-password",
                JsonContent.Create(new { newPassword = "Temp2Pass!" }))).StatusCode);
        // 停用中仍然登不進去（這一支不是在測登入，是在測「重置沒有被停用擋掉」）
        Assert.Equal(HttpStatusCode.Unauthorized, await LoginStatusAsync("reset-off", "Temp2Pass!"));
    }

    // ★ 攻擊者與目標**必須是兩個人**。初版兩者是同一個 id，於是拿掉 admin 閘門時
    //   接住 request 的是「不可重設自己的密碼」（400 `request.invalid`）——閘門整段被
    //   刪掉也會紅，但紅的理由是**自傷守衛**，而真正該守的那條路
    //   （非管理員改**別人**的密碼 ⇒ 204 且密碼真的被換掉）**一路綠燈**
    //   （2026-10-08 R1 的突變挖出來的）。
    [Fact]
    public async Task Reset_RejectsNonAdmin()
    {
        var victimId = await CreateUserAsync("reset-victim");
        await CreateUserAsync("reset-attacker");
        var token = await LoginTokenAsync("reset-attacker", "Password1!");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var resp = await _client.PostAsync($"/api/admin/users/{victimId}/reset-password",
            JsonContent.Create(new { newPassword = "Temp2Pass!" }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("permission.denied", body.GetProperty("code").GetString());

        // 把「閘門在守什麼」做成可觀測的：victim 的密碼**沒有被換掉**。
        // 少了這一條，一個「先改密碼再回 403」的實作會全綠——而那已經是提權。
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync("reset-victim", "Password1!"));
    }

    [Fact]
    public async Task Reset_WritesAuditRow()
    {
        var id = await CreateUserAsync("reset-audited");
        // 用 `AdminIdAndTokenAsync`（不是 `GetAdminTokenAsync`）——這一支要斷言**發起人**，
        // 而那需要 admin 自己的 id。
        var (adminId, adminToken) = await AdminIdAndTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/reset-password",
                JsonContent.Create(new { newPassword = "Temp2Pass!" }))).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.AuditLogs
            .Where(l => l.Action == AuditActions.UserPasswordReset && l.EntityId == Guid.Parse(id))
            .SingleAsync();
        Assert.Equal(Guid.Parse(id), row.EntityId);
        // ★ **actor 必須是呼叫者，不是目標。** 少了這一條，把 `caller.Id` 誤寫成 `user.Id`
        //   全綠——上面那條 `EntityId` 與 `Where` 同義、恆真，看不出來——而這一列會變成
        //   「**受害者自己重設了自己的密碼**」。這一欄不是裝飾：「重用 `PasswordChanged`、
        //   不另開一個撤銷原因」的補償控制**就是它**（誰做的記在這裡，不在撤銷原因裡）。
        Assert.Equal(Guid.Parse(adminId), row.UserId);
        // 這一筆的 TeamId 是 null（與 user.created／user.deleted 同型）⇒ 活動牆上不可達，
        // 但前端標籤表仍必須有它（check:labels 比的是集合相等）。
        Assert.Null(row.TeamId);
    }

    [Fact]
    public async Task Reset_WithPasswordEqualToOld_Succeeds()
    {
        var id = await CreateUserAsync("reset-same");
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword = "Password1!" }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    // ★ **契約釘（pin test），不是 TDD 出來的**——如實寫在前面：它**沒有現成的突變證據**
    //   （紅燈來自**框架或 handler 的改動**，不是來自今天任何一顆已跑過的突變）。
    //   它釘的是**今天的契約**：這個形狀今天是 400、不是 500。
    //
    //   但它**不是「不可突變」**——不要把它當成沒人守著的死條目：把 handler 的
    //   `PasswordValidators` 迴圈拿掉，`null` 的 body 會走進 `RemovePasswordAsync`，
    //   那位使用者被留在**沒有密碼**的狀態 ⇒ 這一支也會紅（推論，未逐格實測：
    //   機制與第一支的那顆突變相同——`AddPasswordAsync` 的驗證在那之後才擋下來，
    //   所以紅的是最後一條「舊密碼仍有效」）。handler 順手加一句
    //   `if (req.NewPassword is null) return …` 同樣會讓它紅。
    //
    //   為什麼要留：`ResetPasswordRequest.NewPassword` 是不可為 null 的位置參數，
    //   但 JSON 給 `null`（或整個缺欄位）在執行期照樣綁得進去——那是真實的客戶端形狀
    //   （前端任何一次 `JSON.stringify` 掉欄位都會產生它）。今天回 400 純粹是
    //   `PasswordValidator.ValidateAsync` 把 null 收斂成「太短」的結果（2026-10-08 實測），
    //   **離一個 500 只差一次框架改動**：哪天那個收斂不見了，或 handler 先碰到
    //   `req.NewPassword` 的成員，這條路就會以 500 的形狀出現——而 500 在畫面上與
    //   「伺服器壞了」不可分。這一支是那個契約唯一的守門員。
    [Theory]
    [InlineData("null")]     // body 顯式給 `null`
    [InlineData("missing")]  // body 整個缺 `newPassword`
    public async Task Reset_WithNullOrMissingPassword_ReturnsBadRequestNotServerError(string shape)
    {
        // 使用者名稱由**這一格的形狀**推導（不是長度——`null` 與 `""` 的長度會撞名，
        // 而同一支 Theory 的每一格共用同一份 DB）。
        var username = $"reset-null-{shape}";
        var id = await CreateUserAsync(username);
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            shape == "null" ? JsonContent.Create(new { newPassword = (string?)null }) : JsonContent.Create(new { }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("identity.passwordTooShort", body.GetProperty("code").GetString());
        // 舊密碼仍然有效——與第一支同一個「先驗後清」的不變量（驗證跑在移除之前，
        // 所以連這一條路徑都碰不到密碼欄位）。
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync(username, "Password1!"));
    }

    // ★ 計畫的〈Review Focus〉#2 要求「空白／**極長** ⇒ 400 不是 500」，但**「極長 ⇒ 400」
    //   那一半的預期值是錯的**（不是實作錯）：`PasswordOptions` 只有 `RequiredLength` 下限、
    //   **沒有上限**（`Program.cs:42` 只調 `RequiredLength = 8`），所以 10000 字元的臨時密碼
    //   是**合政策**的。這一支**釘住實測到的行為**（不是推導，也不是計畫寫的值）：
    //   2026-10-08 實測 ⇒ **204，且新密碼真的可以登入**。
    //   ★ 它同時是「極長輸入不會 500」那一半的守門員——那才是這一格原本要守的東西。
    [Fact]
    public async Task Reset_WithVeryLongPassword_IsAcceptedAndDoesNotFail()
    {
        var username = "reset-very-long";
        var id = await CreateUserAsync(username);
        var longPassword = new string('a', 9996) + "Aa1!";   // 10000 字元，合政策（含各類字元）
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword = longPassword }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync(username, longPassword));
    }

    [Theory]
    [InlineData("")]
    [InlineData("        ")]
    // 第三格原本是 brief 的 `"Aa1!Aa1!…"`（16 次重複、64 字元）——**實測它不是壞輸入**：
    // 它有大小寫、數字、符號，`RequiredLength` 8 也過，`RequiredUniqueChars` 預設是 1
    // ⇒ 端點回 **204**，這一支紅在 `Expected: BadRequest／Actual: NoContent`（2026-10-08 實測）。
    // 換成「夠長但單一字母」：長的輸入仍要被處理（這是這一格真正想釘的），而它真的不合政策。
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public async Task Reset_WithBadInput_ReturnsBadRequestNotServerError(string bad)
    {
        var id = await CreateUserAsync($"reset-bad-{bad.Length}");
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var resp = await _client.PostAsync($"/api/admin/users/{id}/reset-password",
            JsonContent.Create(new { newPassword = bad }));
        _client.DefaultRequestHeaders.Authorization = null;

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        // 而且舊密碼仍然有效（與第一支同一個不變量）
        Assert.Equal(HttpStatusCode.OK, await LoginStatusAsync($"reset-bad-{bad.Length}", "Password1!"));
    }
}
