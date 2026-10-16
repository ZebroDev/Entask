using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class PermissionCheckTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public PermissionCheckTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    private async Task<string> TokenAsync(string username, string password)
    {
        var r = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password }));
        var json = await r.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("accessToken").GetString()!;
    }

    [Fact]
    public async Task Mine_ReturnsUnionOfMultipleRoles()
    {
        var admin = await TokenAsync("admin-test", "TestPass123!");
        _client.DefaultRequestHeaders.Authorization = new("Bearer", admin);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "工程師艾琳" }));

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var engineer = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var assistant = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "專案助理").GetProperty("id").GetString()!;

        // erin 同時是工程師 + 專案助理
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "erin", roleIds = new[] { engineer, assistant } }));

        var erin = await TokenAsync("erin", "Password1!");
        var erinClient = _factory.CreateClient();
        erinClient.DefaultRequestHeaders.Authorization = new("Bearer", erin);

        var mine = await erinClient.GetAsync($"/api/permissions/mine?teamId={teamId}");
        Assert.Equal(HttpStatusCode.OK, mine.StatusCode);
        var codes = (await mine.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()
            .Select(c => c.GetString()!).ToList();

        Assert.Contains("card.edit", codes);          // 工程師
        Assert.Contains("card.effort.update", codes); // 工程師
        Assert.Contains("project.read", codes);       // 專案助理
        Assert.DoesNotContain("team.role.manage", codes);
    }

    [Fact]
    public async Task AdminBypasses_RBAC_Checks()
    {
        var admin = await TokenAsync("admin-test", "TestPass123!");
        var adminClient = _factory.CreateClient();
        adminClient.DefaultRequestHeaders.Authorization = new("Bearer", admin);

        // admin 不屬於任何團隊，但 mine 應回傳全部權限（claim 優先）
        var mine = await adminClient.GetAsync($"/api/permissions/mine?teamId={Guid.NewGuid()}");
        var codes = (await mine.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().Count();
        // 以正典清單為準，避免每次新增權限碼都要改這裡
        Assert.Equal(PermissionCodes.All.Length, codes);
    }
}
