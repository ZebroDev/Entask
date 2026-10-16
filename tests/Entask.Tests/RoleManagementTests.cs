using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class RoleManagementTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public RoleManagementTests(ApiWebApplicationFactory factory)
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
    public async Task TeamRole_CRUD_WithDeleteProtection()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        // 建立自訂角色「助理PM」
        var create = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new
            {
                name = "助理PM",
                description = "工程師兼助理專案經理",
                permissionCodes = new[] { "card.read", "card.edit", "project.read", "card.effort.update" }
            }));
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        var roleJson = await create.Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roleJson.GetProperty("id").GetString()!;
        Assert.Equal(4, roleJson.GetProperty("permissionCodes").GetArrayLength());

        // 指派後刪除 → 400
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "工程師大衛" }));
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "dave", roleIds = new[] { roleId } }));

        var deleteAssigned = await _client.DeleteAsync($"/api/teams/{teamId}/roles/{roleId}");
        Assert.Equal(HttpStatusCode.BadRequest, deleteAssigned.StatusCode);

        // 移除指派後刪除 → 204
        // （dave 的 userId 由團隊詳情取得）
        var detail = await (await _client.GetAsync($"/api/teams/{teamId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var userId = detail.GetProperty("members")[0].GetProperty("userId").GetString()!;
        await _client.DeleteAsync($"/api/teams/{teamId}/members/{userId}");

        var delete = await _client.DeleteAsync($"/api/teams/{teamId}/roles/{roleId}");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
    }

    // I1（2026-09-19 修復）：角色刪除是第四道門。`ProjectMembers.RoleId` 的外鍵是
    // ON DELETE CASCADE（migration 20260814214206_AddBoardCore.cs:101-105；目前模型快照亦同）
    // ⇒ 只在**專案層**被指派的自訂角色被刪掉時，那些 `ProjectMember` 列會被靜默級聯刪除，
    // 把仍在卡片上的人踢出專案名冊——正是「卡片鎖死」的成因（卡片 PUT 只收專案成員，
    // 而下拉列的是專案名冊）。守衛因此涵蓋團隊**或**專案兩層的指派；
    // 錯誤碼沿用既有的 `team.roleAssigned`（契約擴大，不是新錯誤碼）。
    [Fact]
    public async Task TeamRole_AssignedOnlyAtProjectLevel_CannotBeDeleted()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        // dave 在團隊層用系統範本角色（工程師）；下面那個自訂角色只出現在專案層
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "工程師大衛" }));
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var engineerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "dave", roleIds = new[] { engineerRoleId } }));

        var createRole = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new
            {
                name = "專案層專屬",
                description = "只在專案層被指派",
                permissionCodes = new[] { "card.read" }
            }));
        Assert.Equal(HttpStatusCode.OK, createRole.StatusCode);
        var roleId = (await createRole.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // 同一個團隊的專案（X-Team-Id 指名），dave 只以該自訂角色加入專案，不在任何卡片上
        var createProject = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        createProject.Headers.Add("X-Team-Id", teamId);
        createProject.Content = JsonContent.Create(new { name = "專案層角色專案" });
        var projectId = (await (await _client.SendAsync(createProject)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var detail = await (await _client.GetAsync($"/api/teams/{teamId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var daveId = detail.GetProperty("members").EnumerateArray()
            .First(m => m.GetProperty("username").GetString() == "dave").GetProperty("userId").GetString()!;
        var addMember = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = daveId, roleIds = new[] { roleId } }));
        Assert.Equal(HttpStatusCode.OK, addMember.StatusCode);

        var delete = await _client.DeleteAsync($"/api/teams/{teamId}/roles/{roleId}");
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        Assert.Equal(ErrorCodes.TeamRoleAssigned,
            (await delete.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task TeamRole_CreateDuplicateName_Returns400()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var first = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new
            {
                name = "助理PM",
                description = "重複名稱測試",
                permissionCodes = new[] { "card.read" }
            }));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var duplicate = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new
            {
                name = "助理PM",
                description = "名稱重複",
                permissionCodes = new[] { "card.read" }
            }));
        Assert.Equal(HttpStatusCode.BadRequest, duplicate.StatusCode);
    }

    [Fact]
    public async Task TeamRole_CreateNullPermissionCodes_Returns400()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var post = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new { name = "缺權限角色", description = "", permissionCodes = (string[]?)null }));
        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
    }

    [Fact]
    public async Task TeamRole_CreateWhitespaceName_Returns400()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var post = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new { name = "   ", description = "", permissionCodes = new[] { "card.read" } }));
        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
    }

    [Fact]
    public async Task CannotDeleteSystemTemplateRole()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var templateId = roles.EnumerateArray()
            .First(r => r.GetProperty("isSystem").GetBoolean() && r.GetProperty("name").GetString() == "工程師")
            .GetProperty("id").GetString()!;

        var response = await _client.DeleteAsync($"/api/teams/{teamId}/roles/{templateId}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task DeleteUnknownRole_Returns404WithCode()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        // 路由是 /{roleId:guid}（TeamRoleEndpoints.cs:87），所以用一個合法的、不存在的 Guid
        var response = await _client.DeleteAsync($"/api/teams/{teamId}/roles/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(ErrorCodes.TeamRoleNotFound, await ErrorBody.CodeOfAsync(response));
    }
}
