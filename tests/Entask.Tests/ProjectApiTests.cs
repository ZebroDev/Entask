using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ProjectApiTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ProjectApiTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string TeamId, string EngineerRoleId, string ManagerRoleId)> SetupTeamAsync(string adminToken)
    {
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var managerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理").GetProperty("id").GetString()!;
        return (teamId, engineerId, managerId);
    }

    private async Task<string> CreateProjectAsync(string teamId, string adminToken, string name = "測試專案")
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        req.Headers.Authorization = new("Bearer", adminToken);
        req.Headers.Add("X-Team-Id", teamId);
        req.Content = JsonContent.Create(new { name });
        var resp = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
    }

    [Fact]
    public async Task Admin_CreatesProject_SeedsCustomFields_AndListsIt()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var (teamId, _, _) = await SetupTeamAsync(adminToken);

        var projectId = await CreateProjectAsync(teamId, adminToken);

        // 建立者（admin）自動成為專案成員，且 seed 兩個自訂欄位
        var members = await _client.GetAsync($"/api/projects/{projectId}/members");
        var membersJson = await members.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(membersJson.EnumerateArray());

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var fields = db.CustomFieldDefinitions.Where(f => f.ScopeId == Guid.Parse(projectId)).ToList();
            Assert.Equal(2, fields.Count);
            Assert.Contains(fields, f => f.Name == "優先級" && f.Type == "select");
            Assert.Contains(fields, f => f.Name == "提出需求者" && f.Type == "member");
        }

        // GET /api/projects 列出（admin 可見全部）
        var list = await _client.GetAsync("/api/projects");
        var listJson = await list.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(listJson.EnumerateArray(), p => p.GetProperty("id").GetString() == projectId);
    }

    [Fact]
    public async Task MemberManagement_AssignUpdateRemove_Works()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var (teamId, engineerId, managerId) = await SetupTeamAsync(adminToken);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "大衛" }));
        var projectId = await CreateProjectAsync(teamId, adminToken);

        Guid daveId;
        using (var scope = _factory.Services.CreateScope())
            daveId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "dave").Id;

        // 指派（工程師）→ 更新（團隊經理）→ 移除
        var add = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = daveId, roleIds = new[] { engineerId } }));
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);

        var update = await _client.PutAsync($"/api/projects/{projectId}/members/{daveId}",
            JsonContent.Create(new { roleIds = new[] { managerId } }));
        Assert.Equal(HttpStatusCode.OK, update.StatusCode);

        var members = await (await _client.GetAsync($"/api/projects/{projectId}/members"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var daveRow = members.EnumerateArray().First(m => m.GetProperty("username").GetString() == "dave");
        Assert.Contains(managerId, daveRow.GetProperty("roleIds").EnumerateArray().Select(r => r.GetString()));

        // Ruling 1 正向授權：非 admin 專案成員以 project.edit（團隊經理）更新專案名稱 → 200
        var daveLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "dave", password = "Password1!" }));
        var daveToken = (await daveLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        var davePut = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{projectId}");
        davePut.Headers.Authorization = new("Bearer", daveToken);
        davePut.Content = JsonContent.Create(new { name = "大衛更名" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(davePut)).StatusCode);

        var remove = await _client.DeleteAsync($"/api/projects/{projectId}/members/{daveId}");
        Assert.Equal(HttpStatusCode.OK, remove.StatusCode);
        var after = await (await _client.GetAsync($"/api/projects/{projectId}/members"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.DoesNotContain(after.EnumerateArray(), m => m.GetProperty("username").GetString() == "dave");
    }

    [Fact]
    public async Task MemberAssign_InvalidRole_Returns400()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var (teamId, _, _) = await SetupTeamAsync(adminToken);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "艾琳" }));
        var projectId = await CreateProjectAsync(teamId, adminToken);

        Guid erinId;
        using (var scope = _factory.Services.CreateScope())
            erinId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "erin").Id;

        // 不存在的角色 → 400
        var bad = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = erinId, roleIds = new[] { Guid.NewGuid() } }));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
    }

    [Fact]
    public async Task PermissionsMine_ReturnsUnionOfProjectRoles()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var (teamId, engineerId, _) = await SetupTeamAsync(adminToken);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "frank", password = "Password1!", displayName = "法蘭克" }));
        var projectId = await CreateProjectAsync(teamId, adminToken);

        Guid frankId;
        using (var scope = _factory.Services.CreateScope())
            frankId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "frank").Id;
        await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = frankId, roleIds = new[] { engineerId } }));

        var frankLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "frank", password = "Password1!" }));
        var frankToken = (await frankLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        var mineReq = new HttpRequestMessage(HttpMethod.Get, $"/api/projects/{projectId}/permissions/mine");
        mineReq.Headers.Authorization = new("Bearer", frankToken);
        var mine = await _client.SendAsync(mineReq);
        Assert.Equal(HttpStatusCode.OK, mine.StatusCode);
        var codes = (await mine.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().Select(c => c.GetString()).ToList();
        Assert.Contains("card.edit", codes);
        Assert.DoesNotContain("project.edit", codes);
    }

    // 名稱在 2026-10-08 補上 `AndCodes`：這一支現在同時釘 `roles[].code`
    // （`SystemRoleCodes` 的識別碼）——少了它，後端把 `ProjectMemberRoleDto.Code` 拿掉或
    // 送成 null 時，`GET /projects/{id}/members` 的形狀沒有任何測試看著（前端的角色名
    // 會靜默退回資料庫裡的中文名）。名稱是一句斷言，所以跟著斷言改。
    [Fact]
    public async Task MemberWithMultipleRoles_ProjectMemberCountIsDistinct_AndReturnsRoleNamesAndCodes()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var (teamId, engineerId, managerId) = await SetupTeamAsync(adminToken);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "grace", password = "Password1!", displayName = "葛瑞絲" }));
        var projectId = await CreateProjectAsync(teamId, adminToken);

        Guid graceId;
        using (var scope = _factory.Services.CreateScope())
            graceId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "grace").Id;

        // 指派 grace 同時擁有工程師與團隊經理雙角色
        var add = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = graceId, roleIds = new[] { engineerId, managerId } }));
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);

        // 檢查 GET /api/projects，專案成員數應為 2（admin + grace），而不是 3（1 + 2 角色）
        var list = await (await _client.GetAsync("/api/projects")).Content.ReadFromJsonAsync<JsonElement>();
        var proj = list.EnumerateArray().First(p => p.GetProperty("id").GetString() == projectId);
        Assert.Equal(2, proj.GetProperty("memberCount").GetInt32());

        // 檢查 GET /api/projects/{projectId} 單筆查詢
        var detail = await (await _client.GetAsync($"/api/projects/{projectId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, detail.GetProperty("memberCount").GetInt32());

        // 檢查 GET /api/projects/{projectId}/members 回傳的 roles 包含名稱、ID 與 code
        var members = await (await _client.GetAsync($"/api/projects/{projectId}/members")).Content.ReadFromJsonAsync<JsonElement>();
        var graceRow = members.EnumerateArray().First(m => m.GetProperty("username").GetString() == "grace");
        var roles = graceRow.GetProperty("roles").EnumerateArray().ToList();
        Assert.Equal(2, roles.Count);
        Assert.Contains(roles, r => r.GetProperty("name").GetString() == "工程師" && r.GetProperty("id").GetString() == engineerId);
        Assert.Contains(roles, r => r.GetProperty("name").GetString() == "團隊經理" && r.GetProperty("id").GetString() == managerId);
        // `code` 是顯示端查語系檔的鍵（`web/src/lib/role-labels.ts`）：值直接取自
        // `SystemRoleCodes` 的常數，不寫字面值——這條斷言問的是「DTO 送的是不是識別碼本身」，
        // 不是「那六個字串叫什麼」（後者由 SystemRoleCodes.cs 自己擁有）。
        Assert.Contains(roles, r => r.GetProperty("code").GetString() == SystemRoleCodes.Engineer);
        Assert.Contains(roles, r => r.GetProperty("code").GetString() == SystemRoleCodes.TeamManager);
    }
}
