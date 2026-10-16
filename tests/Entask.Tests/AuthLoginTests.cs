using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class AuthLoginTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AuthLoginTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    private async Task<string> GetAdminTokenAsync()
    {
        var seed = _factory.SeedCredentials();
        var r = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var json = await r.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("accessToken").GetString()!;
    }

    // 儲存格式是 SHA256 的 hex（`JwtTokenService.Hash`）。與 RefreshTokenReplayTests 同形：
    // 查不到列時 `FirstAsync` 會當場拋，不會靜靜地測一個空集合。
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

    [Fact]
    public async Task Login_WithValidCredentials_ReturnsTokens()
    {
        var seed = _factory.SeedCredentials();
        var response = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrEmpty(json.GetProperty("accessToken").GetString()));
        Assert.False(string.IsNullOrEmpty(json.GetProperty("refreshToken").GetString()));
        Assert.True(json.GetProperty("isAdmin").GetBoolean());
    }

    [Fact]
    public async Task Login_WithWrongPassword_Returns401()
    {
        var seed = _factory.SeedCredentials();
        var response = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = "WrongPass1!" }));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Refresh_ReturnsNewTokens_And_OldRefreshTokenBecomesInvalid()
    {
        var seed = _factory.SeedCredentials();
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var loginJson = await login.Content.ReadFromJsonAsync<JsonElement>();
        var firstRefresh = loginJson.GetProperty("refreshToken").GetString()!;

        var refresh = await _client.PostAsync("/api/auth/refresh",
            JsonContent.Create(new { refreshToken = firstRefresh }));
        Assert.Equal(HttpStatusCode.OK, refresh.StatusCode);

        // 同一個 refresh token 再換一次 → 已撤銷（rotation）。
        // 但「剛被輪替掉」在輪替後 N 秒內是寬限窗容忍的良性競態（多分頁）⇒ 先把撤銷時刻
        // 推到窗外，這一支驗的才是「舊 token 已經失效」這件事本身（測試意圖不變）。
        await MutateTokenAsync(firstRefresh, expiresAt: null, revokedAt: DateTime.UtcNow.AddSeconds(-10));
        var second = await _client.PostAsync("/api/auth/refresh",
            JsonContent.Create(new { refreshToken = firstRefresh }));
        Assert.Equal(HttpStatusCode.Unauthorized, second.StatusCode);
    }

    [Fact]
    public async Task Logout_WithoutAccessToken_RevokesRefreshToken()
    {
        var seed = _factory.SeedCredentials();
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var refreshToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        // 模擬 access token 已過期：只帶 refresh token、不帶 Authorization header
        _client.DefaultRequestHeaders.Authorization = null;
        var logout = await _client.PostAsync("/api/auth/logout",
            JsonContent.Create(new { refreshToken }));
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

        // 撤銷後同一個 refresh token 不可再換新 token
        var refresh = await _client.PostAsync("/api/auth/refresh",
            JsonContent.Create(new { refreshToken }));
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
    }

    [Fact]
    public async Task Me_WithToken_ReturnsUser()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var response = await _client.GetAsync("/api/auth/me");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("admin-test", json.GetProperty("username").GetString());
    }

    [Fact]
    public async Task Login_FailsFiveTimes_ThenLockedOut()
    {
        // 建立專用帳號測試鎖定，避免鎖死共用的 admin-test 影響同 class 其他測試
        var adminToken = await GetAdminTokenAsync();
        var adminClient = _factory.CreateClient();
        adminClient.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var create = await adminClient.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "lockout-test",
            password = "Password1!",
            displayName = "鎖定測試"
        }));
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);

        for (var i = 0; i < 5; i++)
        {
            await _client.PostAsync("/api/auth/login",
                JsonContent.Create(new { username = "lockout-test", password = "WrongPass1!" }));
        }
        var sixth = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "lockout-test", password = "Password1!" }));

        Assert.Equal(HttpStatusCode.Unauthorized, sixth.StatusCode);
    }

    // 迴歸：改名時 issuer 由 taskify 改為 entask，改名當下已經發出去的 access token 會立即失效。
    // issuer/audience 現由 JwtOptions 單一定義、Program.cs 正規化後餵給兩端（見該處註解），
    // 這裡守的是升級窗口的行為，以及「舊 issuer 不得再被接受」這個契約。
    // 影響可控：前端 401 後會走 refresh 換新 token（refresh 只查 DB、不驗 JWT），使用者不需重登。
    [Fact]
    public async Task AccessToken_SignedWithLegacyIssuer_IsRejected()
    {
        var seed = _factory.SeedCredentials();
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var userId = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetString()!;

        // 同一個使用者、同一把密鑰、同一個 audience，只換 issuer——單一變因
        Assert.Equal(HttpStatusCode.OK, await GetProjectsStatusAsync(CreateToken("entask", userId)));
        Assert.Equal(HttpStatusCode.Unauthorized, await GetProjectsStatusAsync(CreateToken("taskify", userId)));
    }

    private string CreateToken(string issuer, string userId)
    {
        var config = _factory.Services.GetRequiredService<IConfiguration>();
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(config["Jwt:Secret"]!));
        var token = new JwtSecurityToken(
            issuer: issuer,
            audience: config["Jwt:Audience"]!,
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, userId),
                new Claim(JwtRegisteredClaimNames.UniqueName, "issuer-test"),
                new Claim("displayName", "issuer-test"),
            ],
            expires: DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    // 不寫入 _client.DefaultRequestHeaders：該 instance 由同 class 的測試共用，避免污染其他測試
    private async Task<HttpStatusCode> GetProjectsStatusAsync(string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/projects");
        request.Headers.Authorization = new("Bearer", token);
        return (await _client.SendAsync(request)).StatusCode;
    }
}
