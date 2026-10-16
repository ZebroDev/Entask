using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Data.Seed;

namespace Entask.Tests;

/// <summary>
/// 系統識別碼（Role.Code / CustomFieldDefinition.SystemKey）。
///
/// 背景：三處曾以「顯示名稱」當資料列查詢鍵——
///   RoleSeed 的冪等鍵、ProjectEndpoints 查「團隊經理」範本角色、
///   ProjectReportQueries 查「優先級」自訂欄位。
/// 名稱是會變的：自訂欄位名稱使用者可自由更改（CustomFieldDialog → CustomFieldEndpoints PUT）；
/// 系統角色名稱在 i18n 之後會隨語系而異。識別碼不會變。
///
/// 隔離註記：系統角色（TeamId == null）是跨測試共用的全域資料，而同一測試類別只在
/// 第一個 client 建立時重置一次 DB（見 ApiWebApplicationFactory）。本檔凡動到系統角色者
/// 一律包在 <see cref="WithSystemRolesRestoredAsync"/> 內，還原名稱並刪除被 SeedAsync
/// 復活的列，避免污染同類別的其他測試。
/// </summary>
public class SystemIdentifierTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public SystemIdentifierTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task LoginAsync(string username, string password)
    {
        var login = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    private async Task<string> CreateTeamAsync()
    {
        var team = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = $"識別碼團隊{Guid.NewGuid():N}" }))).Content.ReadFromJsonAsync<JsonElement>();
        return team.GetProperty("id").GetString()!;
    }

    private async Task<(string TeamId, string ProjectId)> CreateTeamAndProjectAsync()
    {
        var teamId = await CreateTeamAsync();
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "識別碼專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        return (teamId, projectId);
    }

    // 系統角色是全域資料：快照 → 執行 → 還原。
    // 先刪除多出來的列再還原名稱——反過來會撞 (TeamId, Name) 唯一索引。
    private async Task WithSystemRolesRestoredAsync(Func<Task> body)
    {
        List<(Guid Id, string Name, string? Code)> snapshot;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            snapshot = (await db.Roles.Where(r => r.TeamId == null).ToListAsync())
                .Select(r => (r.Id, r.Name, r.Code)).ToList();
        }

        try
        {
            await body();
        }
        finally
        {
            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                var known = snapshot.Select(s => s.Id).ToHashSet();
                db.Roles.RemoveRange(await db.Roles.Where(r => r.TeamId == null && !known.Contains(r.Id)).ToListAsync());
                await db.SaveChangesAsync();
            }
            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                foreach (var (id, name, code) in snapshot)
                {
                    var role = await db.Roles.FirstOrDefaultAsync(r => r.Id == id);
                    if (role is null) continue;
                    role.Name = name;
                    role.Code = code;
                }
                await db.SaveChangesAsync();
            }
        }
    }

    // ── 自訂欄位：使用者可改名，報表不得因此失效 ──────────────────────────────

    [Fact]
    public async Task Report_PriorityFieldRenamed_StillResolvesPriorityColumn()
    {
        await LoginAsync("admin-test", "TestPass123!");
        var (_, projectId) = await CreateTeamAndProjectAsync();

        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var priorityId = fields.EnumerateArray()
            .First(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;

        var rename = await _client.PutAsync($"/api/projects/{projectId}/custom-fields/{priorityId}",
            JsonContent.Create(new { name = "重要性" }));
        Assert.Equal(HttpStatusCode.OK, rename.StatusCode);

        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "識別碼板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var list = await (await _client.PostAsync($"/api/boards/{board.GetProperty("id").GetString()}/lists",
            JsonContent.Create(new { name = "待辦" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = (await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "識別碼卡" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [priorityId] = "高" }));

        var report = await (await _client.GetAsync($"/api/projects/{projectId}/report"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var row = report.GetProperty("cards").EnumerateArray()
            .Single(c => c.GetProperty("title").GetString() == "識別碼卡");

        // 改動前：以 Name == "優先級" 查找 → 改名後找不到 → priority 靜默變 null
        Assert.Equal("高", row.GetProperty("priority").GetString());
    }

    // ── 系統角色：seed 名稱改變（i18n）不得造成重複或失效 ────────────────────

    [Fact]
    public async Task Seed_SystemTemplateRoles_CarryStableCodes()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var byCode = await db.Roles.Where(r => r.TeamId == null && r.Code != null)
            .ToDictionaryAsync(r => r.Code!, r => r.Name);

        // 同時鎖住 migration 回填時所比對的六個歷史名稱
        Assert.Equal("團隊經理", byCode[SystemRoleCodes.TeamManager]);
        Assert.Equal("專案經理", byCode[SystemRoleCodes.ProjectManager]);
        Assert.Equal("專案助理", byCode[SystemRoleCodes.ProjectAssistant]);
        Assert.Equal("工程組長", byCode[SystemRoleCodes.EngineeringLead]);
        Assert.Equal("工程師", byCode[SystemRoleCodes.Engineer]);
        Assert.Equal("測試工程師", byCode[SystemRoleCodes.QaEngineer]);
    }

    [Fact]
    public async Task RoleSeed_SystemRoleRenamed_AdoptsByCodeWithoutResurrectingOldName()
    {
        await WithSystemRolesRestoredAsync(async () =>
        {
            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                var role = await db.Roles.SingleAsync(r => r.TeamId == null && r.Name == "專案助理");
                role.Name = "Project Assistant";   // 模擬 i18n 後 seed 名稱隨語系改變
                await db.SaveChangesAsync();
            }

            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                await RoleSeed.SeedAsync(db);
            }

            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                var roles = await db.Roles.Where(r => r.TeamId == null).ToListAsync();

                // 改動前：以 Name 查 → 找不到已改名的角色 → 建一個同名新角色（7 個）
                Assert.Equal(6, roles.Count);
                Assert.DoesNotContain(roles, r => r.Name == "專案助理");
                // 名稱是使用者的資料，seed 不得改寫既有列
                Assert.Equal("Project Assistant",
                    roles.Single(r => r.Code == SystemRoleCodes.ProjectAssistant).Name);
            }
        });
    }

    [Fact]
    public async Task CreateProject_SystemRoleRenamed_CreatorStillBecomesMember()
    {
        await LoginAsync("admin-test", "TestPass123!");
        await WithSystemRolesRestoredAsync(async () =>
        {
            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                var role = await db.Roles.SingleAsync(r => r.TeamId == null && r.Name == "團隊經理");
                role.Name = "Team Manager";
                await db.SaveChangesAsync();
            }

            // admin 在該團隊無任何角色 → 走「指派團隊經理範本角色」這條分支
            var (_, projectId) = await CreateTeamAndProjectAsync();

            using (var scope = _factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
                var adminId = await db.Users.Where(u => u.UserName == "admin-test").Select(u => u.Id).SingleAsync();
                // 改動前：以 Name 查「團隊經理」→ Guid.Empty → 靜默略過 → 建立者不是成員
                Assert.True(await db.ProjectMembers.AnyAsync(
                    m => m.ProjectId == Guid.Parse(projectId) && m.UserId == adminId),
                    "系統角色改名後，建立者仍必須被加入專案成員");
            }
        });
    }
}
