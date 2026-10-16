using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

// 401 家族（本階段）。**改動前 401 一律是空 body**，所以這一檔的每一支在改動前都紅。
//
// 三個碼的分工：
//   auth.unauthenticated  —— 認證挑戰（沒有憑證／憑證簽章或效期有問題）。由 `OnChallenge` 產生。
//   auth.sessionInvalid   —— token 有效但主體不可用（使用者被刪、`sub` 解析不出來、
//                            refresh token 不可用）。**refresh 與其他站點共用一個碼是刻意的**：
//                            `JwtTokenService.RefreshAsync` 回 `null` 的成因有三類
//                            （查無此列／已撤銷／已過期），端點**分不出來**，一個碼是它唯一
//                            誠實的解析度。已撤銷那一類自 2026-09-23 起再依撤銷原因分流
//                            ——只有**窗內且未過期**的 `Replaced` 走寬限窗回 200（良性競態），
//                            其餘（`Logout`、`ReplayDetected`、`Deactivated`、
//                            `PasswordChanged`、原因為 null 的既有列）仍回 `null`。
//   auth.invalidCredentials —— 登入失敗。**四條路徑共用一個碼是安全性質**：
//                            分開就等於憑「哪一個 code」列舉帳號存不存在（同 403 的
//                            `permission.denied` 那條）。登入頁的 `catch` 刻意不看 body 也是同一個理由。
//
// **判別力**：只斷言 `StatusCode == Unauthorized` 是沒有用的——改動前（空 body）與改動後
// （有 body）都是 401，那種斷言在兩種實作下都是綠的。本檔一律把 body 讀出來斷言 `code`，
// 並在每一個「多站點」家族裡比對各站點的 body 是否**逐字相同**。
//
// **刻意不斷言 `message` 的字面值**：那是產品文案（改字是產品決定），由閘門 B
// （`check:error-messages`，`ErrorMessages.cs` ↔ zh-TW 語系值）與閘門 C 擁有。這一檔釘的是
// **形狀**：狀態碼、Content-Type、`code`、以及各站點之間的一致性。
public class AuthErrorBodyTests : IClassFixture<ApiWebApplicationFactory>
{
    private const string UnauthenticatedCode = "auth.unauthenticated";
    private const string SessionInvalidCode = "auth.sessionInvalid";
    private const string InvalidCredentialsCode = "auth.invalidCredentials";

    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AuthErrorBodyTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // ① 反列舉：登入的四條失敗路徑（帳號不存在／密碼錯誤／已鎖定／已停用）必須回
    // **逐位元相同**的 body。少了這條鎖，把其中一條換成自己的 code（或換成不同的 message）
    // 不會有任何測試變紅，而那就是一個帳號列舉的 oracle。
    //
    // 第四條是 2026-10-07 加的（使用者停用設計的 D9）：原本考慮讓停用者看到「此帳號已停用」，
    // 那會推翻登入頁「刻意不看 body」的決定。使用者否決了那個方向——所以這一支從三條守到四條，
    // 而 `LoginPage.tsx` 的裸 `catch {}` 保持不動。
    [Fact]
    public async Task InvalidCredentials_FourLoginPaths_ReturnIdenticalBodies()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var create = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "body-lockout",
            password = "Password1!",
            displayName = "鎖定測試",
        }));
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // ① 帳號不存在 —— FindByNameAsync 回 null
        var unknown = await AssertUnauthorizedAsync(
            await LoginAsync("body-nobody", "Password1!"), InvalidCredentialsCode);

        // ② 密碼錯誤（第 1 次失敗，此時尚未鎖定）—— CheckPasswordAsync 那條分支
        var wrongPassword = await AssertUnauthorizedAsync(
            await LoginAsync("body-lockout", "WrongPass1!"), InvalidCredentialsCode);

        // ③ 已鎖定：再失敗 4 次湊滿 5 次（第 5 次本身就觸發鎖定），第 6 次帶**正確**密碼
        //    ⇒ 一定來自 IsLockedOutAsync 那條分支，不是密碼比對失敗。
        for (var i = 0; i < 4; i++) await LoginAsync("body-lockout", "WrongPass1!");
        var lockedOut = await AssertUnauthorizedAsync(
            await LoginAsync("body-lockout", "Password1!"), InvalidCredentialsCode);

        // ④ 已停用：帳號存在、密碼正確，但被停用 ⇒ 仍必須是逐位元相同的 body。
        //    用**新的**帳號：`body-lockout` 在路徑③已經被鎖定，會先撞上 IsLockedOutAsync，
        //    那樣這一條就證明不了「停用判準本身」。
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "body-deactivated",
            password = "Password1!",
            displayName = "停用測試",
        }))).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;
        await DeactivateAsync("body-deactivated");
        var deactivated = await AssertUnauthorizedAsync(
            await LoginAsync("body-deactivated", "Password1!"), InvalidCredentialsCode);

        Assert.Equal(unknown, wrongPassword);
        Assert.Equal(wrongPassword, lockedOut);
        Assert.Equal(lockedOut, deactivated);
    }

    // ② 會話失效：五個站點、三個檔案、兩種產生機制（端點回 `IResult` vs 篩選器直接寫 response），
    // 全部必須是**同一個** body。
    [Fact]
    public async Task SessionInvalid_AllFiveSites_ReturnIdenticalBodies()
    {
        // 兩把自簽的 token：簽章／issuer／audience／效期都合法（會通過 JwtBearer 驗證），
        // 差別只在 `sub`——一把指向不存在的使用者，一把不是 GUID。
        var ghostToken = CreateToken(Guid.NewGuid().ToString());
        var malformedSubToken = CreateToken("not-a-guid");

        // ① AuthEndpoints `/me` 的 `user is null`
        var ghostMe = await AssertUnauthorizedAsync(
            await SendAsync(HttpMethod.Get, "/api/auth/me", ghostToken), SessionInvalidCode);

        // ② UserEndpoints 八處的代表（`PUT /api/me/profile` 的 `user is null`）
        var ghostProfile = await AssertUnauthorizedAsync(
            await SendAsync(HttpMethod.Put, "/api/me/profile", ghostToken,
                JsonContent.Create(new { displayName = "不會被寫入" })), SessionInvalidCode);

        // ③ AuthEndpoints `/me` 的 `!Guid.TryParse(sub)`
        var badSubMe = await AssertUnauthorizedAsync(
            await SendAsync(HttpMethod.Get, "/api/auth/me", malformedSubToken), SessionInvalidCode);

        // ④ `RequireProjectPermission` 的篩選器——它沒有 `IResult` 可回，直接寫 response
        var filter = await AssertUnauthorizedAsync(
            await SendAsync(HttpMethod.Get, $"/api/boards/{Guid.NewGuid()}", malformedSubToken), SessionInvalidCode);

        // ⑤ `/refresh`：換過一次（rotation）的 refresh token 再換一次 ⇒ RefreshAsync 回 null。
        //    但「剛被輪替掉」在輪替後 N 秒內是寬限窗容忍的良性競態（多分頁）⇒ 先把撤銷時刻
        //    推到窗外，這一站驗的才是「舊 token 已經失效」這件事本身（同 AuthLoginTests 的處置）。
        var seed = _factory.SeedCredentials();
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var refreshToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;
        Assert.Equal(HttpStatusCode.OK,
            (await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken }))).StatusCode);
        await MutateTokenAsync(refreshToken, expiresAt: null, revokedAt: DateTime.UtcNow.AddSeconds(-10));
        var revokedRefresh = await AssertUnauthorizedAsync(
            await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken })),
            SessionInvalidCode);

        Assert.Equal(ghostMe, ghostProfile);
        Assert.Equal(ghostProfile, badSubMe);
        Assert.Equal(badSubMe, filter);
        Assert.Equal(filter, revokedRefresh);
    }

    // ③ 認證挑戰：沒有憑證、憑證壞掉，都必須帶同一個 body，**而且仍然是一個合規的 401**。
    // 後半段是這支測試的真正價值：`OnChallenge` 裡呼叫 `HandleResponse()` 會讓框架
    // **同時跳過狀態碼與 `WWW-Authenticate` 標頭**，兩者都得自己補——少補一個就是
    // 一個沒有任何測試會發現的協定退化（改動前那兩個值是框架給的，看起來「本來就有」）。
    [Fact]
    public async Task Challenge_MissingOrBrokenToken_ReturnsUnauthenticatedBody()
    {
        _client.DefaultRequestHeaders.Authorization = null;
        var missing = await _client.GetAsync("/api/projects");
        var missingBody = await AssertUnauthorizedAsync(missing, UnauthenticatedCode);

        // 沒帶憑證時不得附 error 碼（RFC 6750 §3），這也是框架原本的行為。
        Assert.Equal("Bearer", missing.Headers.WwwAuthenticate.ToString());

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/projects");
        request.Headers.Authorization = new("Bearer", "not.a.jwt");
        var broken = await _client.SendAsync(request);
        var brokenBody = await AssertUnauthorizedAsync(broken, UnauthenticatedCode);

        // 憑證有問題時才附 error="invalid_token"（同框架的規則：看 AuthenticateFailure）。
        Assert.Contains("invalid_token", broken.Headers.WwwAuthenticate.ToString());

        // 「沒有憑證」與「憑證壞掉」對使用者是同一件事——body 不得洩漏是哪一種。
        Assert.Equal(missingBody, brokenBody);
    }

    // ④ 挑戰標頭**只送 `error` 碼**：框架在 `IncludeErrorDetails` 為真時會把
    // `ErrorDescription` 填好（憑證過期 ⇒ 連**過期時刻**都寫進去），`OnChallenge` 原本
    // 逐字轉發那兩個值 ⇒ **未經驗證的呼叫端**拿得到失敗分類（「簽章金鑰找不到」與
    // 「簽章不對」在攻擊者眼裡是兩種訊號）。裁定（使用者 2026-09-22）：只留 RFC 6750 §3
    // 要求的最小面。**這一支是那條裁定的唯一守門員**——沒有它，把那兩行加回去
    // 不會有任何測試變紅（既有的挑戰測試只斷言 `invalid_token` 在標頭裡）。
    [Fact]
    public async Task Challenge_EveryReachableFailureReason_SendsOnlyErrorCode()
    {
        var cases = new (string Name, string Token)[]
        {
            ("expired", Mint(expires: DateTime.UtcNow.AddMinutes(-5))),
            ("wrong-signature", Mint(expires: DateTime.UtcNow.AddMinutes(5), secret: "wrong-secret-0123456789abcdef0123456789ab")),
            ("wrong-audience", Mint(expires: DateTime.UtcNow.AddMinutes(5), audience: "someone-else")),
        };

        foreach (var (name, token) in cases)
        {
            var response = await SendAsync(HttpMethod.Get, "/api/projects", token);

            // 前提：真的走到挑戰（body 是 `auth.unauthenticated`），否則「沒有描述」可能只是
            // 因為這一格根本沒被執行到——三個成因分別寫進 token 本身（效期／金鑰／audience）。
            await AssertUnauthorizedAsync(response, UnauthenticatedCode);

            var header = response.Headers.WwwAuthenticate.ToString();
            Assert.Contains("invalid_token", header);

            // 本體：框架的兩個細節欄位一個都不轉發。`error_uri` 今天恆為空（量過），
            // 但它與 `error_description` 是同一條轉發路徑，所以一起釘住。
            Assert.DoesNotContain("error_description", header);
            Assert.DoesNotContain("error_uri", header);
        }
    }

    // 儲存格式是 SHA256 的 hex（`JwtTokenService.Hash`）。與 `RefreshTokenReplayTests`／
    // `AuthLoginTests` 的同名 helper 同形：查不到列時 `FirstAsync` 會當場拋，
    // 不會靜靜地測一個空集合。
    private static string HashOf(string refreshToken) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(refreshToken)));

    /// <summary>直接改 DB 的欄位，用來把「已撤銷」的時刻推到寬限窗之外。</summary>
    private async Task MutateTokenAsync(string refreshToken, DateTime? expiresAt, DateTime? revokedAt)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.RefreshTokens.FirstAsync(t => t.TokenHash == HashOf(refreshToken));
        if (expiresAt is not null) row.ExpiresAt = expiresAt.Value;
        if (revokedAt is not null) row.RevokedAt = revokedAt.Value;
        await db.SaveChangesAsync();
    }

    /// <summary>把使用者的 <c>DeactivatedAt</c> 設起來。端點在 Task 5 才有。</summary>
    private async Task DeactivateAsync(string username)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var user = await db.Users.FirstAsync(u => u.UserName == username);
        user.DeactivatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
    }

    // 判別力所在：只斷言 401 的話，改動前（無 body）與改動後（有 body）都是綠的。
    // 回傳原始 body 字串，供各站點之間逐字比對。
    private static async Task<string> AssertUnauthorizedAsync(HttpResponseMessage response, string expectedCode)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/json; charset=utf-8", response.Content.Headers.ContentType?.ToString());

        var raw = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        Assert.Equal(expectedCode, doc.RootElement.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(doc.RootElement.GetProperty("message").GetString()));
        return raw;
    }

    private async Task<HttpResponseMessage> LoginAsync(string username, string password)
        => await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));

    // 不寫入 `_client.DefaultRequestHeaders`：同 class 的其他測試也要用這個 client。
    private Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, string token, HttpContent? content = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = content };
        request.Headers.Authorization = new("Bearer", token);
        return _client.SendAsync(request);
    }

    /// <summary>
    /// 自簽一把**會通過驗證**的 access token（與 AuthLoginTests 的同名 helper 同源）。
    /// 這一檔用它造出「簽章沒問題、但主體不可用」的狀態——那是 `AuthEndpoints`／`UserEndpoints`／
    /// `RequireProjectPermission` 的 401 唯一的到達方式。
    /// </summary>
    private string CreateToken(string sub) => Mint("body-test", sub);

    /// <summary>
    /// 三個可選參數是「把失敗成因寫進 token 本身」的旋鈕（測試 ④ 用）：
    /// 過期時刻、audience、簽章金鑰。預設值＝一個會通過驗證的 token。
    /// </summary>
    private string Mint(string uniqueName = "body-test", string? sub = null, DateTime? expires = null,
        string? audience = null, string? secret = null)
    {
        var config = _factory.Services.GetRequiredService<IConfiguration>();
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret ?? config["Jwt:Secret"]!));
        var token = new JwtSecurityToken(
            issuer: config["Jwt:Issuer"]!,
            audience: audience ?? config["Jwt:Audience"]!,
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, sub ?? "body-test"),
                new Claim(JwtRegisteredClaimNames.UniqueName, uniqueName),
                new Claim("displayName", uniqueName),
            ],
            expires: expires ?? DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
