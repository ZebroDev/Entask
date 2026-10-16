using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

// 測試工程師（card.read／card.create／card.review，**無** card.edit）需能留言——
// 回報測試異常讓工程師與主管同步是其主要職責（2026-09-12 使用者裁定）。
// 留言路由自此接受 card.comment 或 card.edit；後者保留給既有自訂角色，避免回溯破壞。
public class CommentPermissionTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CommentPermissionTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Comment_TestEngineerWithoutCardEdit_CanPostAndEditOwn()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "留言權限團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var testerRole = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "測試工程師");
        var testerRoleId = testerRole.GetProperty("id").GetString()!;
        // 前提斷言：此角色確實沒有 card.edit，否則本測試無法證明是 card.comment 生效
        var testerPerms = testerRole.GetProperty("permissionCodes").EnumerateArray()
            .Select(p => p.GetString()).ToList();
        Assert.DoesNotContain("card.edit", testerPerms);
        Assert.Contains("card.comment", testerPerms);

        var createProject = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        createProject.Headers.Authorization = _client.DefaultRequestHeaders.Authorization;
        createProject.Headers.Add("X-Team-Id", teamId);
        createProject.Content = JsonContent.Create(new { name = "留言權限專案" });
        var projectId = (await (await _client.SendAsync(createProject)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "留言權限板" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "待辦" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "登入頁異常" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "tester", password = "Password1!", displayName = "測試員" }));
        Guid testerId;
        using (var scope = _factory.Services.CreateScope())
            testerId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Users.First(u => u.UserName == "tester").Id;

        var add = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = testerId, roleIds = new[] { testerRoleId } }));
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "tester", password = "Password1!" }));
        var testerToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        // 留言（先前為 403：路由要求 card.edit）
        var post = new HttpRequestMessage(HttpMethod.Post, $"/api/cards/{cardId}/comments");
        post.Headers.Authorization = new("Bearer", testerToken);
        post.Content = JsonContent.Create(new { text = "iOS 17 Safari 登入頁閃退，附件有截圖" });
        var resp = await _client.SendAsync(post);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var commentId = (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // 自己的留言可修改（作者本人限定的既有規則不變）
        var put = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/comments/{commentId}");
        put.Headers.Authorization = new("Bearer", testerToken);
        put.Content = JsonContent.Create(new { text = "補充：僅 iOS 17 發生" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(put)).StatusCode);
    }
}
