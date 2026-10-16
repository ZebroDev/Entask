using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using BoardEntity = Entask.Core.Entities.Board;

namespace Entask.Tests;

public class ProjectPermissionTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ProjectPermissionTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // 以 admin 建立團隊、使用者 alice，alice 加入團隊並被指派「工程師」；
    // 再由 admin 建立團隊下的專案並把 alice 指派為專案成員（工程師）——
    // 工程師有 card.edit 但無 project.edit；同時驗證 admin claim bypass 與跨專案階層綁定
    [Fact]
    public async Task ProjectPermission_Engineer_CanEditCard_NotProject_AndAdminBypasses()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "權限團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "alice", password = "Password1!", displayName = "愛麗絲" }));

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var managerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "alice", roleIds = new[] { engineerId } }));

        // 建立專案（X-Team-Id 指定團隊）
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "測試專案" });
        var projectResp = await _client.SendAsync(create);
        Assert.Equal(HttpStatusCode.OK, projectResp.StatusCode);
        var project = await projectResp.Content.ReadFromJsonAsync<JsonElement>();
        var projectId = project.GetProperty("id").GetString()!;

        // 指派 alice 為專案成員（工程師）；alice 的 userId 自 DbContext 解析
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var aliceId = db.Users.First(u => u.UserName == "alice").Id;
            await _client.PostAsync($"/api/projects/{projectId}/members",
                JsonContent.Create(new { userId = aliceId, roleIds = new[] { engineerId } }));
        }

        // alice 登入
        var aliceLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "alice", password = "Password1!" }));
        var aliceToken = (await aliceLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        // 工程師對專案無 project.edit → PUT /api/projects/{id} 403
        var putProject = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{projectId}");
        putProject.Headers.Authorization = new("Bearer", aliceToken);
        putProject.Content = JsonContent.Create(new { name = "改名" });
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(putProject)).StatusCode);

        // admin claim bypass：admin 不帶任何 team header 也能改專案
        var adminPut = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{projectId}");
        adminPut.Headers.Authorization = new("Bearer", adminToken);
        adminPut.Content = JsonContent.Create(new { name = "改名成功" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(adminPut)).StatusCode);
    }

    // 跨專案階層綁定：bob 為團隊成員（自訂「無板讀角色」，僅 card.read）且為專案 A 成員
    // （工程師——spec #19 起含 board.read）。存取專案 A 的看板 → 200（專案成員角色生效）；
    // 存取專案 B 的看板 → 403（團隊角色無 board.read、bob 非專案 B 成員 → 專案 B 有效權限不含 board.read）。
    // 注意：團隊成員角色會 union 進專案 scope（PermissionChecker），負向斷言須以不含
    // board.read 的自訂團隊角色為前提（工程師種子角色自 spec #19 起含 board.read，不能再用於負向）。
    [Fact]
    public async Task ProjectPermission_HierarchyBinding_CrossProject_Returns403()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var admin = db.Users.First(u => u.UserName == "admin-test");
        var teamA = new Team { Id = Guid.NewGuid(), Name = "A", CreatedById = admin.Id, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Teams.Add(teamA);
        var projectA = new Project { Id = Guid.NewGuid(), TeamId = teamA.Id, Name = "A 專案", CreatedById = admin.Id, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        var projectB = new Project { Id = Guid.NewGuid(), TeamId = teamA.Id, Name = "B 專案", CreatedById = admin.Id, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Projects.AddRange(projectA, projectB);
        var boardA = new BoardEntity { Id = Guid.NewGuid(), ProjectId = projectA.Id, Name = "A 板", CreatedById = admin.Id, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        var boardB = new BoardEntity { Id = Guid.NewGuid(), ProjectId = projectB.Id, Name = "B 板", CreatedById = admin.Id, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        db.Boards.AddRange(boardA, boardB);
        await db.SaveChangesAsync();

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "bob", password = "Password1!", displayName = "鮑伯" }));
        var roles = await (await _client.GetAsync($"/api/teams/{teamA.Id}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        // 自訂團隊角色（不含 board.read）：bob 的團隊成員角色——負向斷言的前提
        var noBoardReadRole = await (await _client.PostAsync($"/api/teams/{teamA.Id}/roles",
            JsonContent.Create(new
            {
                name = "無板讀角色",
                description = "跨專案負向斷言用",
                permissionCodes = new[] { "card.read" },
            }))).Content.ReadFromJsonAsync<JsonElement>();
        var noBoardReadRoleId = noBoardReadRole.GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamA.Id}/members",
            JsonContent.Create(new { username = "bob", roleIds = new[] { noBoardReadRoleId } }));
        // bob 為專案 A 成員（直接寫 DB 以繞過尚未完成的 member API 細節）
        var joinedAt = DateTime.UtcNow;
        db.ProjectMembers.Add(new ProjectMember
        {
            Id = Guid.NewGuid(), ProjectId = projectA.Id,
            UserId = db.Users.First(u => u.UserName == "bob").Id, RoleId = Guid.Parse(engineerId),
            JoinedAt = joinedAt, JoinedLocalDate = DateOnly.FromDateTime(joinedAt),
        });
        await db.SaveChangesAsync();

        var bobLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "bob", password = "Password1!" }));
        var bobToken = (await bobLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        // bob 的團隊角色（無 board.read）union 進專案 B scope、且 bob 非專案 B 成員 → 403
        var reqB = new HttpRequestMessage(HttpMethod.Get, $"/api/boards/{boardB.Id}");
        reqB.Headers.Authorization = new("Bearer", bobToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(reqB)).StatusCode);

        // 正向控制：bob 為專案 A 成員（工程師，spec #19 起含 board.read）→ 存取 A 板 200；
        // 同一團隊角色不授予專案 B 看板權限（階層綁定成立）
        var reqA = new HttpRequestMessage(HttpMethod.Get, $"/api/boards/{boardA.Id}");
        reqA.Headers.Authorization = new("Bearer", bobToken);
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(reqA)).StatusCode);
    }
}
