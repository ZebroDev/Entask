using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Entask.Identity;
using Entask.Identity.Models;

namespace Entask.Tests;

// 系統範圍稽核（`GET /api/audit-logs/system`，2026-10-10）。
//
// 測試骨架逐字照 `AuditLogTests.cs`；端點呼叫形狀照既有測試抄，不自己發明 request body：
// 建立帳號＝`POST /api/auth/users`（`AuditLogTests.cs:45`）；停用／復原／刪除／重設密碼＝
// `POST|DELETE /api/admin/users/{id}/…`（`UserDeactivationTests.cs`、`AdminPasswordResetTests.cs`）；
// 非 admin 但擁有團隊 `team.read` 的造法＝`AuditLogTests.AuditLogs_CrossTeam_Returns403`。
public class SystemActivityTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public SystemActivityTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<string> LoginAsync(string username, string password)
    {
        var res = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        // 斷言登入成功是必要的：少了它，登入失敗會以「找不到 accessToken」的形狀出現，
        // 指向錯的方向（照 `AdminPasswordResetTests.LoginTokenAsync`）。
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
    }

    private async Task<JsonElement> SystemLogsAsync(string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/audit-logs/system");
        req.Headers.Authorization = new("Bearer", token);
        var res = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Admin_SeesAllFiveUserLifecycleActions()
    {
        var admin = await LoginAsync("admin-test", "TestPass123!");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", admin);

        // 五個動作各造一列，全部走真實端點。呼叫形狀照既有測試抄，不要重寫：
        // 建立＝`POST /api/auth/users`（`AuditLogTests.cs:45`）；
        // 停用／復原／刪除／重設密碼＝`POST|DELETE /api/admin/users/{id}/…`
        // （既有實測過的呼叫在 `tests/Entask.Tests/UserDeactivationTests.cs` 與
        //  `tests/Entask.Tests/AdminPasswordResetTests.cs`——request body 的欄位名照那裡）。
        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "victim", password = "Password1!", displayName = "被操作者" }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);

        var users = await (await _client.GetAsync("/api/admin/users")).Content.ReadFromJsonAsync<JsonElement>();
        // 欄位名是 `userId`（`AdminUserResponse(UserId, …)` 的第一個位置參數，camelCase 後即此）
        // ——`AdminUserEndpoints` 與 `UserDeactivationTests` 對同一條路由的讀法一致。
        var victimId = users.EnumerateArray()
            .First(u => u.GetProperty("username").GetString() == "victim")
            .GetProperty("userId").GetString()!;

        // 刪除是兩階段的（D5：先停用再刪除）⇒ 中間要再停用一次，五列才齊。
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{victimId}/deactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{victimId}/reactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{victimId}/reset-password",
                JsonContent.Create(new { newPassword = "Temp2Pass!" }))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{victimId}/deactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.DeleteAsync($"/api/admin/users/{victimId}")).StatusCode);

        var logs = await SystemLogsAsync(admin);
        var actions = logs.GetProperty("items").EnumerateArray()
            .Select(l => l.GetProperty("action").GetString()!).ToList();

        Assert.Contains("user.created", actions);
        Assert.Contains("user.deactivated", actions);
        Assert.Contains("user.reactivated", actions);
        Assert.Contains("user.password_reset", actions);
        Assert.Contains("user.deleted", actions);
    }

    [Fact]
    public async Task NonAdmin_WithTeamRead_Returns403()
    {
        var admin = await LoginAsync("admin-test", "TestPass123!");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", admin);

        // 造一個**擁有團隊 `team.read`** 的非 admin（形狀逐字照
        // `AuditLogTests.AuditLogs_CrossTeam_Returns403`：建團隊 → 建使用者 →
        // 取「團隊經理」roleId → `PUT /api/teams/{id}/members`）。
        // 這一支是系統端點那道閘門的守門員：`RequireAuthorization()` 只要求登入，
        // 而 `team.read` 這條團隊權限**不得**對全域資源生效（所以端點刻意不掛
        // `.RequirePermission(...)`）。
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "系統視圖 A 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamAId = teamJson.GetProperty("id").GetString()!;

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "carol", password = "Password1!", displayName = "卡蘿" }));

        var rolesJson = await (await _client.GetAsync($"/api/teams/{teamAId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var managerRoleId = rolesJson.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理")
            .GetProperty("id").GetString()!;
        var assign = await _client.PutAsync($"/api/teams/{teamAId}/members",
            JsonContent.Create(new { username = "carol", roleIds = new[] { managerRoleId } }));
        Assert.Equal(HttpStatusCode.OK, assign.StatusCode);

        var carol = await LoginAsync("carol", "Password1!");

        // 正向控制：carol 必須**真的持有** `team.read`——這一支的判別力全押在它身上。
        // 少了這幾行，指派若靜默失效，carol 會變成「什麼權限都沒有的普通人」，
        // 而突變後的端點仍會用 `permission.denied` 回她 403 ⇒ 錯誤實作下依然全綠。
        var ownReq = new HttpRequestMessage(HttpMethod.Get, $"/api/audit-logs?teamId={teamAId}");
        ownReq.Headers.Authorization = new("Bearer", carol);
        ownReq.Headers.Add("X-Team-Id", teamAId);
        var own = await _client.SendAsync(ownReq);
        Assert.Equal(HttpStatusCode.OK, own.StatusCode);

        var req = new HttpRequestMessage(HttpMethod.Get, "/api/audit-logs/system");
        req.Headers.Authorization = new("Bearer", carol);
        req.Headers.Add("X-Team-Id", teamAId);
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        // 只斷言 403 分不出「閘門正確」與「端點壞掉」——body 是共用契約
        // （`permission.denied`，形狀同 `UserDeactivationTests.AdminEndpoints_RejectNonAdmin`）。
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("permission.denied", body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("message").GetString()));
    }

    [Fact]
    public async Task SystemView_ExcludesTeamScopedRows()
    {
        var admin = await LoginAsync("admin-test", "TestPass123!");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", admin);
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "系統視圖對照部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var logs = await SystemLogsAsync(admin);
        var actions = logs.GetProperty("items").EnumerateArray()
            .Select(l => l.GetProperty("action").GetString()!).ToList();
        Assert.DoesNotContain("team.created", actions);

        // 正向對照：同一列在團隊端點仍在（排除的是範圍，不是那一列本身）
        _client.DefaultRequestHeaders.Add("X-Team-Id", teamId);
        var teamLogs = await (await _client.GetAsync($"/api/audit-logs?teamId={teamId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(teamLogs.GetProperty("items").EnumerateArray(),
            l => l.GetProperty("action").GetString() == "team.created");
    }

    [Fact]
    public async Task DeactivatedAdmin_IsRejected()
    {
        // 被停用的管理員在 access token 過期前仍帶著 `entask:admin` ⇒ `ResolveCurrentUserAsync`
        // 必須先跑。造法：建使用者 → 直接以 `UserManager.AddClaimAsync` 補 admin claim
        // （在 `factory.Services.CreateScope()` 內；`AdminUserEndpoints` 的 admin 閘門讀的是
        // 同一個 `AdminClaim`——`AuthEndpoints` 的建立帳號端點對 `isAdmin` 做的就是這一件事）
        // → 登入（token 帶 claim）→ 由 `admin-test` 停用他 → 以他的 token 打 `/api/audit-logs/system`。
        var adminToken = await LoginAsync("admin-test", "TestPass123!");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        const string username = "sysadmin-off";
        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName = "將被停用的系統管理員" }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var userId = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("userId").GetString()!;

        using (var scope = _factory.Services.CreateScope())
        {
            var userManager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = await userManager.FindByNameAsync(username);
            Assert.NotNull(user);
            var claim = await userManager.AddClaimAsync(user!, new Claim(AdminClaim.Type, AdminClaim.Value));
            Assert.True(claim.Succeeded);
        }

        // 登入在**停用之前**：這顆 access token 帶著 admin claim，且到過期前都不會失效。
        var token = await LoginAsync(username, "Password1!");

        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{userId}/deactivate", null)).StatusCode);

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/audit-logs/system");
        request.Headers.Authorization = new("Bearer", token);
        var response = await _client.SendAsync(request);

        // 狀態碼與 body 形狀照 `AuthErrorBodyTests.AssertUnauthorizedAsync` 對 `sessionInvalid`
        // 的既有斷言（該檔已釘住那個碼與 body 形狀），不自己猜。
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/json; charset=utf-8", response.Content.Headers.ContentType?.ToString());
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("auth.sessionInvalid", body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("message").GetString()));
    }
}
