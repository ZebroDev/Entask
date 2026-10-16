using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

// Task 6 review 補測：PUT 更新、系統範本 PUT 404、無效權限碼 400
public class RoleEndpointCoverageTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public RoleEndpointCoverageTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    private async Task<string> AdminTokenAsync()
    {
        var r = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-test", password = "TestPass123!" }));
        var json = await r.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("accessToken").GetString()!;
    }

    [Fact]
    public async Task PutRole_UpdatesNameAndPermissions_Returns200()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var create = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new
            {
                name = "助理PM",
                description = "工程師兼助理專案經理",
                permissionCodes = new[] { "card.read" }
            }));
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        var roleId = (await create.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var put = await _client.PutAsync($"/api/teams/{teamId}/roles/{roleId}",
            JsonContent.Create(new
            {
                name = "助理PM2",
                description = "更新後的角色",
                permissionCodes = new[] { "card.read", "card.edit" }
            }));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var json = await put.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("助理PM2", json.GetProperty("name").GetString());
        Assert.Equal(2, json.GetProperty("permissionCodes").GetArrayLength());
    }

    [Fact]
    public async Task PutSystemTemplateRole_Returns404()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var templateId = roles.EnumerateArray()
            .First(r => r.GetProperty("isSystem").GetBoolean())
            .GetProperty("id").GetString()!;

        var put = await _client.PutAsync($"/api/teams/{teamId}/roles/{templateId}",
            JsonContent.Create(new
            {
                name = "試圖改名",
                description = "不應成功",
                permissionCodes = new[] { "card.read" }
            }));
        Assert.Equal(HttpStatusCode.NotFound, put.StatusCode);
        Assert.Equal(ErrorCodes.TeamRoleSystemNotEditable, await ErrorBody.CodeOfAsync(put));
    }

    [Fact]
    public async Task PostRole_WithInvalidPermissionCode_Returns400()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var post = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new
            {
                name = "壞角色",
                description = "包含無效權限碼",
                permissionCodes = new[] { "not.a.permission" }
            }));
        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
    }
}
