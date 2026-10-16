using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

public class AuditLogTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public AuditLogTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task TeamCreation_WritesAuditLog()
    {
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-test", password = "TestPass123!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "稽核部門" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        _client.DefaultRequestHeaders.Add("X-Team-Id", teamId);
        var logs = await _client.GetAsync($"/api/audit-logs?teamId={teamId}");
        Assert.Equal(HttpStatusCode.OK, logs.StatusCode);
        var items = (await logs.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("items").EnumerateArray().ToList();
        Assert.Contains(items, l => l.GetProperty("action").GetString() == "team.created");
    }

    [Fact]
    public async Task AuditLogs_WithoutTeamReadPermission_Returns403()
    {
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-test", password = "TestPass123!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "frank", password = "Password1!", displayName = "無權限員工" }));

        var frankLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "frank", password = "Password1!" }));
        var frankToken = (await frankLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        // frank 不屬於任何團隊 → team.read 檢查失敗
        var frankRequest = new HttpRequestMessage(HttpMethod.Get,
            $"/api/audit-logs?teamId={Guid.NewGuid()}");
        frankRequest.Headers.Authorization = new("Bearer", frankToken);
        frankRequest.Headers.Add("X-Team-Id", Guid.NewGuid().ToString());
        var response = await _client.SendAsync(frankRequest);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task AuditLogs_CrossTeam_Returns403()
    {
        // admin 建立團隊 A、B 與使用者 carol，並指派 carol 為 A 團隊的團隊經理（含 team.read）
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-test", password = "TestPass123!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamAJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "A 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamAId = teamAJson.GetProperty("id").GetString()!;
        var teamBJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "B 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamBId = teamBJson.GetProperty("id").GetString()!;

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

        // carol 登入
        var carolLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "carol", password = "Password1!" }));
        var carolToken = (await carolLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        // X-Team-Id: A 但 query teamId=B → 403（跨團隊讀取必須被擋）
        var crossRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/audit-logs?teamId={teamBId}");
        crossRequest.Headers.Authorization = new("Bearer", carolToken);
        crossRequest.Headers.Add("X-Team-Id", teamAId);
        var cross = await _client.SendAsync(crossRequest);
        Assert.Equal(HttpStatusCode.Forbidden, cross.StatusCode);

        // 正向控制：同 headers 但 ?teamId=A → 200（讀自己團隊不應被誤擋）
        var ownRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/audit-logs?teamId={teamAId}");
        ownRequest.Headers.Authorization = new("Bearer", carolToken);
        ownRequest.Headers.Add("X-Team-Id", teamAId);
        var own = await _client.SendAsync(ownRequest);
        Assert.Equal(HttpStatusCode.OK, own.StatusCode);
    }

    [Fact]
    public async Task AuditLogs_TeamScope_IncludesActingUserDisplayName()
    {
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-test", password = "TestPass123!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "名稱解析部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;
        _client.DefaultRequestHeaders.Add("X-Team-Id", teamId);

        var me = await (await _client.GetAsync("/api/auth/me")).Content.ReadFromJsonAsync<JsonElement>();
        var expectedName = me.GetProperty("displayName").GetString();

        var logs = await (await _client.GetAsync($"/api/audit-logs?teamId={teamId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var row = logs.GetProperty("items").EnumerateArray()
            .First(l => l.GetProperty("action").GetString() == "team.created");

        Assert.Equal(expectedName, row.GetProperty("userDisplayName").GetString());
    }
}
