using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

// #24：GET /api/teams/my-permissions 單查詢回傳使用者各團隊有效權限碼
// （取代前端每團隊 1+N 的 /api/permissions/mine 呼叫）
public class TeamPermissionsBulkTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public TeamPermissionsBulkTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    private async Task LoginAsync(string username, string password)
    {
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    [Fact]
    public async Task MyPermissions_Unauthenticated_Returns401()
    {
        _client.DefaultRequestHeaders.Authorization = null;
        var resp = await _client.GetAsync("/api/teams/my-permissions");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task MyPermissions_Member_ReturnsOwnTeamWithCodes()
    {
        // admin 建立團隊 A 與使用者 carol，並指派 carol 為 A 團隊的團隊經理（含 team.read）
        await LoginAsync("admin-test", "TestPass123!");
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "A 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "carol", password = "Password1!", displayName = "卡蘿" }));

        var rolesJson = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var managerRoleId = rolesJson.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理")
            .GetProperty("id").GetString()!;
        var assign = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "carol", roleIds = new[] { managerRoleId } }));
        Assert.Equal(HttpStatusCode.OK, assign.StatusCode);

        // carol 登入後查詢：回 [{teamId, codes}]，含團隊經理既有權限碼
        await LoginAsync("carol", "Password1!");
        var resp = await _client.GetAsync("/api/teams/my-permissions");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var entries = (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().ToList();
        Assert.Single(entries);
        Assert.Equal(teamId, entries[0].GetProperty("teamId").GetString());
        var codes = entries[0].GetProperty("codes").EnumerateArray()
            .Select(c => c.GetString()).ToList();
        Assert.Contains("team.read", codes);
        Assert.Contains("board.read", codes);
    }

    [Fact]
    public async Task MyPermissions_NonMember_ReturnsEmptyArray()
    {
        // dave 非任何團隊成員 → 200 空陣列（非 403/404）
        await LoginAsync("admin-test", "TestPass123!");
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "戴夫" }));

        await LoginAsync("dave", "Password1!");
        var resp = await _client.GetAsync("/api/teams/my-permissions");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var entries = (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().ToList();
        Assert.Empty(entries);
    }

    [Fact]
    public async Task MyPermissions_Admin_ReturnsAllTeamsWithFullCodes()
    {
        await LoginAsync("admin-test", "TestPass123!");
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "B 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var resp = await _client.GetAsync("/api/teams/my-permissions");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var entries = (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().ToList();
        var entry = entries.First(e => e.GetProperty("teamId").GetString() == teamId);
        var codes = entry.GetProperty("codes").EnumerateArray()
            .Select(c => c.GetString()).ToList();
        // admin 於 PermissionChecker 回傳全部權限碼
        Assert.Contains("team.read", codes);
        Assert.Contains("board.read", codes);
    }
}
