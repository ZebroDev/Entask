using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ProjectHardeningTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ProjectHardeningTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ProjectId, string TeamId, string EngineerRoleId, string ManagerRoleId, string AliceId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "硬化團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "hard-alice", password = "Password1!", displayName = "硬化艾莉絲" }));
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var managerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "hard-alice", roleIds = new[] { engineerId } }));
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "硬化專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var aliceId = db.Users.First(u => u.UserName == "hard-alice").Id.ToString();
        return (projectId, teamId, engineerId, managerId, aliceId);
    }

    [Fact]
    public async Task ProjectCreate_NonexistentTeam_Returns400()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", Guid.NewGuid().ToString());
        create.Content = JsonContent.Create(new { name = "幽靈專案" });
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.SendAsync(create)).StatusCode);
    }

    [Fact]
    public async Task ProjectMembersPut_NullRoleIds_Returns400()
    {
        var (projectId, _, engineerId, _, aliceId) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/projects/{projectId}/members/{aliceId}",
            new StringContent("""{"roleIds":null}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ProjectMembersPost_NullRoleIds_Returns400()
    {
        var (projectId, _, engineerId, _, aliceId) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/projects/{projectId}/members",
            new StringContent($$"""{"userId":"{{aliceId}}","roleIds":null}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ProjectMembersPut_NonexistentUser_Returns400()
    {
        var (projectId, _, engineerId, _, _) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/projects/{projectId}/members/{Guid.NewGuid()}",
            JsonContent.Create(new { roleIds = new[] { engineerId } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ProjectsList_NonAdminVisibility_ThreeBranches()
    {
        var (projectId, teamId, engineerId, _, aliceId) = await SetupAsync();
        // bob：團隊成員（工程師）但非專案成員 → 有效權限非空 → 可見
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "hard-bob", password = "Password1!", displayName = "硬化鮑伯" }));
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "hard-bob", roleIds = new[] { engineerId } }));
        // carol：非團隊成員且非專案成員 → 不可見
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "hard-carol", password = "Password1!", displayName = "硬化卡蘿" }));

        // alice 為專案成員 → 可見
        await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = Guid.Parse(aliceId), roleIds = new[] { engineerId } }));

        var aliceToken = await LoginAsync("hard-alice");
        var bobToken = await LoginAsync("hard-bob");
        var carolToken = await LoginAsync("hard-carol");

        var aliceProjects = await ListProjectsAsync(aliceToken);
        Assert.Contains(aliceProjects, p => p.GetProperty("id").GetString() == projectId);
        var bobProjects = await ListProjectsAsync(bobToken);
        Assert.Contains(bobProjects, p => p.GetProperty("id").GetString() == projectId);
        var carolProjects = await ListProjectsAsync(carolToken);
        Assert.DoesNotContain(carolProjects, p => p.GetProperty("id").GetString() == projectId);
    }

    private async Task<string> LoginAsync(string username)
    {
        var r = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        return (await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
    }

    private async Task<List<JsonElement>> ListProjectsAsync(string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/projects");
        req.Headers.Authorization = new("Bearer", token);
        var resp = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<List<JsonElement>>())!;
    }
}
