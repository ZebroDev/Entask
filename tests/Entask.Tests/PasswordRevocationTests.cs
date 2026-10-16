using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

/// <summary>
/// 改密碼 ⇒ 撤銷該使用者**全部**有效 refresh token（外部報告 C 類第 2 條，2026-10-08）。
/// 沒有這一格：改完密碼之後舊裝置的 refresh 仍然有效——「改密碼」擋不住已遭竊的 session。
/// ★ 這個行為今天**零測試**（`PUT /api/me/password` 在此之前沒有任何測試檔）。
/// </summary>
[Collection("ApiTests")]
public class PasswordRevocationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public PasswordRevocationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task ChangePassword_RevokesAllRefreshTokens_WithoutReplayCascade()
    {
        const string username = "pw-change";
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "改密碼測試",
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var userId = Guid.Parse((await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("userId").GetString()!);
        _client.DefaultRequestHeaders.Authorization = null;

        // R1：改密碼前的 session——改密碼時會被蓋上 `password_changed`。
        var first = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var firstJson = await first.Content.ReadFromJsonAsync<JsonElement>();
        var r1 = firstJson.GetProperty("refreshToken").GetString()!;

        // 改密碼：走端點（撤銷的語意就在端點裡）。
        var access = firstJson.GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", access);
        var changed = await _client.PutAsync("/api/me/password", JsonContent.Create(new
        {
            currentPassword = "Password1!",
            newPassword = "Password2!",
        }));
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        // R2：改密碼後重新登入拿到的**現行** session。
        _client.DefaultRequestHeaders.Authorization = null;
        var second = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password2!" }));
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var r2 = (await second.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        // 同一個類別共用一條 factory ⇒ 先清乾淨才問得準「這一支有沒有留下痕跡」。
        _factory.LogCapture.Clear();

        // ① ★ 紅燈格：舊 refresh 已被撤銷 ⇒ 401（修前它還換得到 ⇒ 200）。
        Assert.Equal(HttpStatusCode.Unauthorized, (await _client.PostAsync(
            "/api/auth/refresh", JsonContent.Create(new { refreshToken = r1 }))).StatusCode);

        // ② 不連坐：改密碼後重新登入的新 session 必須還換得到（走了重放 fail-safe 就 401）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync(
            "/api/auth/refresh", JsonContent.Create(new { refreshToken = r2 }))).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        // ③ 蓋章本身是資料層契約：舊列的 `RevokedReason` 逐字是 `password_changed`
        //    （蓋成 null／別的原因都不會有 HTTP 紅燈——同 `RevokedReasons.cs` 的檔頭警告）。
        Assert.True(await db.RefreshTokens.AnyAsync(t =>
            t.UserId == userId && t.RevokedReason == RevokedReasons.PasswordChanged));

        // ④ 沒有連坐撤銷的痕跡、也沒有假的重放警告（釘結構化欄位 `{UserId}`，不釘訊息文字）。
        Assert.False(await db.RefreshTokens
            .AnyAsync(t => t.UserId == userId && t.RevokedReason == RevokedReasons.ReplayDetected));
        Assert.DoesNotContain(_factory.LogCapture.Entries, e =>
            e.Category == typeof(JwtTokenService).FullName
            && e.State.Any(kv => kv.Key == "UserId" && kv.Value is Guid id && id == userId));
    }

    // fix round 1（review Minor 2）：**失敗的改密碼不撤銷任何東西**。
    // 今天這條性質只由「撤銷呼叫在 `if (!result.Succeeded)` 的早期返回**之後**」這個位置
    // 維持——把它上移到檢查之前，除了這一支以外的每一支都會全綠，而那種形狀是**自傷 DoS**：
    // 現行密碼打錯一個字，使用者的每一個 session 當場全死。
    // ★ 判別力靠突變（撤銷呼叫上移 ⇒ 紅在斷言 ①），不是靠它今天會紅——綠燈分不出
    // 「這條性質成立」與「根本沒被看著」。
    [Fact]
    public async Task FailedPasswordChange_RevokesNothing()
    {
        const string username = "pw-fail";
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "改密碼失敗測試",
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // 兩條 session：r1 事後會換一次（HTTP 觀測點），r2 全程不碰（資料層的「沒有被蓋章」
        // 觀測點——r1 那一列在成功的 refresh 之後是正常的 `replaced`，讀它分不出「沒撤銷」
        // 與「輪替掉了」）。
        var first = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var firstJson = await first.Content.ReadFromJsonAsync<JsonElement>();
        var r1 = firstJson.GetProperty("refreshToken").GetString()!;
        var second = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var r2 = (await second.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        // 現行密碼**打錯** ⇒ 400。這一格是前提：少了它，下面的綠可能只是「根本沒改成功」
        // 的另一個說法，而不是「失敗不撤銷」。
        _client.DefaultRequestHeaders.Authorization =
            new("Bearer", firstJson.GetProperty("accessToken").GetString()!);
        var failed = await _client.PutAsync("/api/me/password", JsonContent.Create(new
        {
            currentPassword = "WrongPass1!",
            newPassword = "Password2!",
        }));
        Assert.Equal(HttpStatusCode.BadRequest, failed.StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // ① ★ 紅燈格（突變時）：失敗的改密碼不撤銷任何東西 ⇒ 既有 session 還換得到。
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync(
            "/api/auth/refresh", JsonContent.Create(new { refreshToken = r1 }))).StatusCode);

        // ② 資料層：沒被碰過的那一列逐欄沒有撤銷的痕跡（撤銷呼叫上移時它會是
        //    `password_changed` ＋ 一個 `RevokedAt`）。
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(r2)));
        var row = await db.RefreshTokens.FirstAsync(t => t.TokenHash == hash);
        Assert.Null(row.RevokedAt);
        Assert.Null(row.RevokedReason);
    }
}
