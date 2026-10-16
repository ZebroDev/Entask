using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using BoardEntity = Entask.Core.Entities.Board;

namespace Entask.Tests;

// 兩支授權篩選器的 5 處 403（RequirePermission ×3、RequireProjectPermission ×2）都必須帶
// `{ code, message }` body，且**五處共用同一個 code**：`permission.denied`。
//
// 為什麼五處不分開給 code（那是安全性質，不是圖方便）：
//   ① RequireProjectPermission 的「資源解析不出來」與「資源存在但沒權限」**必須無法區分**
//      ——可分的話，攻擊者用「哪一種回應」就能列舉資源存不存在（存在性 oracle）。
//   ② RequirePermission 的兩個跨團隊守衛與「缺權限」對使用者的補救方式相同，
//      區分只會增加 code 數量。
//
// **判別力**：只斷言 `StatusCode == Forbidden` 是沒有用的——改動前（無 body）與改動後
// （有 body）都是 403，那種斷言在兩種實作下都是綠的。本檔一律把 body 讀出來斷言 `code`，
// 並在第二支測試比對兩條路徑的 body 是否**逐字相同**（那是 ① 的理由本身，
// 也是唯一擋得住「把 `projectId is null` 換成 404 或換成另一個 code」的東西）。
//
// 使用者一律用**非 admin**：兩支篩選器都有 admin claim bypass，用 admin 測等於沒測。
public class PermissionDeniedBodyTests : IClassFixture<ApiWebApplicationFactory>
{
    private const string DeniedCode = "permission.denied";
    private const string DeniedMessage = "你沒有存取這個資源的權限";

    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public PermissionDeniedBodyTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // RequirePermission 的三處：缺權限、route 的 teamId 與 X-Team-Id 不一致、
    // query 的 teamId 與 X-Team-Id 不一致。
    [Fact]
    public async Task TeamFilter_AllThreeSites_ReturnPermissionDeniedBody()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var teamAId = await CreateTeamAsync("A 團隊");
        var teamBId = await CreateTeamAsync("B 團隊");

        // carol：A 團隊經理（種子角色含 team.read）——兩處跨團隊守衛的前置
        await CreateUserAsync("denied-carol");
        await AssignTeamRoleAsync(teamAId, "denied-carol", await TeamRoleIdAsync(teamAId, "團隊經理"));
        var carolToken = await LoginAsync("denied-carol");

        // dave：A 團隊工程師。工程師種子角色**不含 team.read**（RoleSeed 的 Templates），
        // 所以他缺的是那一個權限碼，不是團隊成員身分。
        await CreateUserAsync("denied-dave");
        await AssignTeamRoleAsync(teamAId, "denied-dave", await TeamRoleIdAsync(teamAId, "工程師"));
        var daveToken = await LoginAsync("denied-dave");

        // ① 缺 team.read → HasPermissionAsync 為 false
        await AssertDeniedAsync(
            await SendAsync(HttpMethod.Get, $"/api/teams/{teamAId}", daveToken, teamAId.ToString()));

        // ① 的正向對照：同一條 URL、同一個 header，換成有 team.read 的 carol → 200。
        // 少了它，上面的 403 可能來自任何原因，而不見得是「缺少那個權限碼」。
        Assert.Equal(HttpStatusCode.OK,
            (await SendAsync(HttpMethod.Get, $"/api/teams/{teamAId}", carolToken, teamAId.ToString())).StatusCode);

        // ② route 的 teamId（B）≠ header（A）；carol 對 A 有 team.read，所以權限檢查會先過
        await AssertDeniedAsync(
            await SendAsync(HttpMethod.Get, $"/api/teams/{teamBId}", carolToken, teamAId.ToString()));

        // ③ query 的 teamId（B）≠ header（A）；audit-logs 的 teamId 在 query、route 沒有這一層
        await AssertDeniedAsync(
            await SendAsync(HttpMethod.Get, $"/api/audit-logs?teamId={teamBId}", carolToken, teamAId.ToString()));

        // ②③ 的正向對照：同樣的 headers 指向自己的團隊 → 200（守衛只擋跨團隊）
        Assert.Equal(HttpStatusCode.OK,
            (await SendAsync(HttpMethod.Get, $"/api/audit-logs?teamId={teamAId}", carolToken, teamAId.ToString())).StatusCode);
    }

    // RequireProjectPermission 的兩處：resolver 解析不出專案、以及解析出來但沒有該權限。
    // 兩者的 body 必須逐字相同——本測試的後半段就是那條安全性質的迴歸鎖。
    [Fact]
    public async Task ProjectFilter_BothSites_ReturnIdenticalPermissionDeniedBody()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var teamId = Guid.Empty;
        var projectAId = Guid.Empty;
        var boardAId = Guid.Empty;
        var boardBId = Guid.Empty;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var admin = db.Users.First(u => u.UserName == "admin-test");
            var team = new Team
            {
                Id = Guid.NewGuid(), Name = "鎖團隊", CreatedById = admin.Id,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            };
            db.Teams.Add(team);
            var projectA = new Project
            {
                Id = Guid.NewGuid(), TeamId = team.Id, Name = "A 專案", CreatedById = admin.Id,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            };
            var projectB = new Project
            {
                Id = Guid.NewGuid(), TeamId = team.Id, Name = "B 專案", CreatedById = admin.Id,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            };
            db.Projects.AddRange(projectA, projectB);
            var boardA = new BoardEntity
            {
                Id = Guid.NewGuid(), ProjectId = projectA.Id, Name = "A 板", CreatedById = admin.Id,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            };
            var boardB = new BoardEntity
            {
                Id = Guid.NewGuid(), ProjectId = projectB.Id, Name = "B 板", CreatedById = admin.Id,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            };
            db.Boards.AddRange(boardA, boardB);
            await db.SaveChangesAsync();

            teamId = team.Id;
            projectAId = projectA.Id;
            boardAId = boardA.Id;
            boardBId = boardB.Id;
        }

        // bob 的**團隊**角色是不含 board.read 的自訂角色（負向斷言的前提：團隊角色會 union
        // 進專案 scope），**專案**角色才是工程師（含 board.read，用來當正向對照）。
        await CreateUserAsync("lock-bob");
        var noBoardReadRoleId = await CreateTeamRoleAsync(teamId, "無板讀角色", ["card.read"]);
        await AssignTeamRoleAsync(teamId, "lock-bob", noBoardReadRoleId);

        var engineerRoleId = await TeamRoleIdAsync(teamId, "工程師");
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var joinedAt = DateTime.UtcNow;
            db.ProjectMembers.Add(new ProjectMember
            {
                Id = Guid.NewGuid(),
                ProjectId = projectAId,
                UserId = db.Users.First(u => u.UserName == "lock-bob").Id,
                RoleId = Guid.Parse(engineerRoleId),
                JoinedAt = joinedAt,
                JoinedLocalDate = DateOnly.FromDateTime(joinedAt),
            });
            await db.SaveChangesAsync();
        }

        var bobToken = await LoginAsync("lock-bob");

        // 正向對照：A 板解析得出來、且 bob 對它確有 board.read → 200。
        // 少了它，下面 B 板的 403 可能只是「連 A 板都讀不到」的另一種表現。
        Assert.Equal(HttpStatusCode.OK,
            (await SendAsync(HttpMethod.Get, $"/api/boards/{boardAId}", bobToken, null)).StatusCode);

        // ① B 板存在、resolver 解析得出專案 B，但 bob（非專案 B 成員、團隊角色不含 board.read）
        //    沒有 board.read → `!granted` 那處
        var existingButForbidden = await SendAsync(HttpMethod.Get, $"/api/boards/{boardBId}", bobToken, null);

        // ② 這個 boardId 不存在 → ProjectScopeResolver.Resolve 回 null → `projectId is null` 那處
        var missing = await SendAsync(HttpMethod.Get, $"/api/boards/{Guid.NewGuid()}", bobToken, null);

        var existingBody = await AssertDeniedAsync(existingButForbidden);
        var missingBody = await AssertDeniedAsync(missing);

        // 安全性質的迴歸鎖：兩條路徑的 body 必須**逐字相同**（狀態碼由上面兩次斷言釘住，
        // 這裡釘的是 body 本身）。有人把「資源不存在」改成 404、或給它自己的 code，
        // 就會在這裡變紅——那正是這兩處共用一個 code 的理由。
        Assert.Equal(existingBody, missingBody);
    }

    // 判別力所在：只斷言 403 的話，改動前（無 body）與改動後（有 body）都是綠的。
    // 回傳原始 body 字串，供安全性質的迴歸鎖逐字比對。
    private static async Task<string> AssertDeniedAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        // WriteAsJsonAsync 自己會設 Content-Type（本階段實查，故原始碼沒有多寫那一行）。
        // 沒有 body 的回應在這裡就會先失敗（ContentType 為 null）。
        Assert.Equal("application/json; charset=utf-8", response.Content.Headers.ContentType?.ToString());

        var raw = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        Assert.Equal(DeniedCode, doc.RootElement.GetProperty("code").GetString());
        Assert.Equal(DeniedMessage, doc.RootElement.GetProperty("message").GetString());
        return raw;
    }

    private Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, string token, string? teamHeader)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new("Bearer", token);
        if (teamHeader is not null) request.Headers.Add("X-Team-Id", teamHeader);
        return _client.SendAsync(request);
    }

    // 以下呼叫端都以 admin 身分（_client 的預設 Authorization header）執行
    private async Task<Guid> CreateTeamAsync(string name)
    {
        var resp = await _client.PostAsync("/api/teams", JsonContent.Create(new { name }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private async Task CreateUserAsync(string username)
    {
        var resp = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName = username }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    private async Task<string> LoginAsync(string username)
    {
        var resp = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
    }

    private async Task<string> TeamRoleIdAsync(Guid teamId, string name)
    {
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content
            .ReadFromJsonAsync<JsonElement>();
        return roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == name)
            .GetProperty("id").GetString()!;
    }

    private async Task<string> CreateTeamRoleAsync(Guid teamId, string name, string[] permissionCodes)
    {
        var resp = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new { name, description = "測試用角色", permissionCodes }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
    }

    private async Task AssignTeamRoleAsync(Guid teamId, string username, string roleId)
    {
        var resp = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username, roleIds = new[] { roleId } }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }
}
