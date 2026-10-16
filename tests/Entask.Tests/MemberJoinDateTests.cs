using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

// 成員／專案的到職日凍結（Q1／R6，2026-10-08 裁定）：五個成員列寫入站點都以**動作發起人**
// 的時區凍結 `JoinedLocalDate`，不是被加入者的、也不是 UTC；不帶 `timeZoneId` 走 UTC 預設（D8）。
//
// 「本地日」一律由**測試端自己**用 `TimeZoneInfo` 算（不呼叫 `TimeZones`——這四支測的是端點，
// helper 自己的判別力在 `TimeZonesTests`）。Kiritimati 是 UTC+14、Midway 是 UTC-11，相差 25 小時
// ⇒ 同一個瞬時下兩者的本地日**必然不同**，這是「不是直接取 UTC 日」的判別核心。
public class MemberJoinDateTests : IClassFixture<ApiWebApplicationFactory>
{
    private const string EastTz = "Pacific/Kiritimati";
    private const string WestTz = "Pacific/Midway";

    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public MemberJoinDateTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static DateOnly LocalTodayOf(string ianaId, DateTime utcNow) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(utcNow, TimeZoneInfo.FindSystemTimeZoneById(ianaId)));

    private async Task LoginAdminAsync()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    private async Task<string> CreateTeamAsync()
    {
        var team = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = $"到職團隊{Guid.NewGuid():N}" }))).Content.ReadFromJsonAsync<JsonElement>();
        return team.GetProperty("id").GetString()!;
    }

    private async Task<string> CreateProjectAsync(string teamId)
    {
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = $"到職專案{Guid.NewGuid():N}" });
        return (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
    }

    private async Task<Guid> CreateUserAsync(string username)
    {
        // 建不起來就當場紅在狀態碼——不擋的話下一個 `First()` 會拋
        // `InvalidOperationException`，把真正的原因（例如使用者名稱撞號）蓋掉。
        var resp = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName = username }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        using var scope = _factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == username).Id;
    }

    private async Task<string> RoleIdAsync(string teamId, string roleName)
    {
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        return roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == roleName)
            .GetProperty("id").GetString()!;
    }

    /// <summary>
    /// 兩列的預期值各自在請求前後算一次、取聯集——吸收「本地午夜正好跨過這次請求」的窗口
    /// （同 `ReviewEffortTests` 的寫法）。兩個請求各有自己的 `timeZoneId`：凍結用的是**該次
    /// 動作發起人**帶的時區，而判別核心是兩列**必然不同日**。
    /// </summary>
    [Fact]
    public async Task TeamMembers_FreezeJoinDayInTheInitiatorsTimeZone_PerRequest()
    {
        await LoginAdminAsync();
        var teamId = await CreateTeamAsync();
        var roleId = await RoleIdAsync(teamId, "工程師");
        var eastUserId = await CreateUserAsync("mika");
        var westUserId = await CreateUserAsync("noel");

        var eastBefore = LocalTodayOf(EastTz, DateTime.UtcNow);
        var eastResp = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "mika", roleIds = new[] { roleId }, timeZoneId = EastTz }));
        var eastAfter = LocalTodayOf(EastTz, DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, eastResp.StatusCode);

        var westBefore = LocalTodayOf(WestTz, DateTime.UtcNow);
        var westResp = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "noel", roleIds = new[] { roleId }, timeZoneId = WestTz }));
        var westAfter = LocalTodayOf(WestTz, DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, westResp.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var east = db.TeamMembers.Single(m => m.TeamId == Guid.Parse(teamId) && m.UserId == eastUserId);
        var west = db.TeamMembers.Single(m => m.TeamId == Guid.Parse(teamId) && m.UserId == westUserId);
        Assert.Contains(east.JoinedLocalDate, new[] { eastBefore, eastAfter });
        Assert.Contains(west.JoinedLocalDate, new[] { westBefore, westAfter });
        // +14 與 -11 的本地日不可能相同：以 UTC 日凍結的實作會讓兩者相等
        Assert.NotEqual(east.JoinedLocalDate, west.JoinedLocalDate);
    }

    /// <summary>
    /// D8：欄位缺席（不是 null、也不是空字串）⇒ UTC 預設，200 且寫入的是 UTC 日。
    /// **四個以成員列收尾的站點都在這裡走一遍**（團隊指派／建立專案的建立者／加專案成員／
    /// 更新成員角色），**每一列的值都被讀到**：漏掉任何一處的賦值，那一列不會報錯——欄位是
    /// NOT NULL 但沒有 DB 預設，EF 會送 CLR 預設值 `0001-01-01`，看起來就像一個正常的日期。
    /// 第五個站點（複製）在下一支。
    /// </summary>
    [Fact]
    public async Task Members_WithoutTimeZoneId_FreezeTheUtcDay()
    {
        await LoginAdminAsync();
        var teamId = await CreateTeamAsync();
        var roleId = await RoleIdAsync(teamId, "工程師");
        var leadRoleId = await RoleIdAsync(teamId, "工程組長");
        var userId = await CreateUserAsync("olive");

        var before = DateOnly.FromDateTime(DateTime.UtcNow);
        // 站點 1：團隊成員指派
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "olive", roleIds = new[] { roleId } }))).StatusCode);
        // 站點 2：建立專案時建立者自動加入（發起人 ＝ admin-test，不帶 timeZoneId）
        var projectId = await CreateProjectAsync(teamId);
        // 站點 3：加專案成員
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { roleId } }))).StatusCode);
        // **這一列的值要在下一列把它刪掉之前讀**：站點 4 的差集會刪掉「工程師」那一列，
        // 只在尾端讀的話，站點 3 的覆蓋是假的（拿掉 `ProjectEndpoints.cs:210` 的賦值整支仍綠）。
        DateOnly site3JoinedLocalDate;
        using (var scope = _factory.Services.CreateScope())
            site3JoinedLocalDate = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .ProjectMembers.Single(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == userId).JoinedLocalDate;
        // 站點 4：更新成員角色——差集新增的那一列（工程師換成工程組長，舊列移除）
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/projects/{projectId}/members/{userId}",
            JsonContent.Create(new { roleIds = new[] { leadRoleId } }))).StatusCode);
        var after = DateOnly.FromDateTime(DateTime.UtcNow);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var utcDays = new[] { before, after };
            Assert.Contains(site3JoinedLocalDate, utcDays);
            Assert.Contains(db.TeamMembers.Single(m => m.TeamId == Guid.Parse(teamId) && m.UserId == userId).JoinedLocalDate, utcDays);
            Assert.Contains(db.ProjectMembers.Single(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == userId).JoinedLocalDate, utcDays);
            var adminId = db.Users.First(u => u.UserName == "admin-test").Id;
            var creatorRows = db.ProjectMembers.Where(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == adminId).ToList();
            Assert.NotEmpty(creatorRows);
            Assert.All(creatorRows, m => Assert.Contains(m.JoinedLocalDate, utcDays));
        }
    }

    /// <summary>
    /// 裁定 4：`JoinedLocalDate` 是**凍結值**、不是可變欄位——角色編輯**保留**的那一列不得被重寫。
    /// 判別靠一個**過去的**值：種 2026-08-01 進既有列，再 PUT 一組含它 RoleId 的 desired
    /// （該列被保留）＋一個新角色（新列）；重寫的實作會把 2026-08-01 蓋成今天，而拿「今天」
    /// 當預期值會讓這一支恆綠——所以這裡兩種值都斷言。
    /// 直接寫 DB 是測試端的既有縫（前例：`ProjectPermissionTests` 直接改 `ProjectMembers`）。
    /// </summary>
    [Fact]
    public async Task UpdateMemberRoles_KeepsTheFrozenJoinDayOfRetainedRows()
    {
        await LoginAdminAsync();
        var teamId = await CreateTeamAsync();
        var projectId = await CreateProjectAsync(teamId);
        var engineerRoleId = await RoleIdAsync(teamId, "工程師");
        var leadRoleId = await RoleIdAsync(teamId, "工程組長");
        var userId = await CreateUserAsync("quinn");

        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { engineerRoleId } }))).StatusCode);
        var frozen = new DateOnly(2026, 8, 1);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var row = db.ProjectMembers.Single(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == userId);
            row.JoinedLocalDate = frozen;
            await db.SaveChangesAsync();
        }

        var before = DateOnly.FromDateTime(DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/projects/{projectId}/members/{userId}",
            JsonContent.Create(new { roleIds = new[] { engineerRoleId, leadRoleId } }))).StatusCode);
        var after = DateOnly.FromDateTime(DateTime.UtcNow);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var rows = db.ProjectMembers.Where(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == userId).ToList();
            Assert.Equal(2, rows.Count);
            Assert.Equal(frozen, rows.Single(m => m.RoleId == Guid.Parse(engineerRoleId)).JoinedLocalDate);
            var added = rows.Single(m => m.RoleId == Guid.Parse(leadRoleId));
            Assert.Contains(added.JoinedLocalDate, new[] { before, after });
            Assert.NotEqual(frozen, added.JoinedLocalDate);
        }
    }

    /// <summary>
    /// 認不得的 ID **不 fallback**（`TimeZones` 的契約）：**五個站點的五條 400 出口都打一次**。
    /// 五處的三行區塊逐字相同，所以覆蓋其中兩處等於「另外三處被拿掉也全綠」——這一支把五條
    /// 出口都變成可觀測的。「沒寫入」不是附帶的性質——靜默 fallback 成 UTC 的實作照樣回得了
    /// 400 以外的東西，而這一支要釘的是「整筆動作沒有發生」。
    /// </summary>
    [Fact]
    public async Task Members_UnknownTimeZoneId_Return400_AndWriteNothing()
    {
        await LoginAdminAsync();
        var teamId = await CreateTeamAsync();
        var projectId = await CreateProjectAsync(teamId);
        var roleId = await RoleIdAsync(teamId, "工程師");
        var userId = await CreateUserAsync("pete");

        int projectsBefore;
        using (var scopeBefore = _factory.Services.CreateScope())
            projectsBefore = scopeBefore.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Projects.Count(p => p.TeamId == Guid.Parse(teamId));

        var teamResp = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "pete", roleIds = new[] { roleId }, timeZoneId = "Not/AZone" }));
        Assert.Equal(HttpStatusCode.BadRequest, teamResp.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(teamResp));

        var projectResp = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { roleId }, timeZoneId = "Not/AZone" }));
        Assert.Equal(HttpStatusCode.BadRequest, projectResp.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(projectResp));

        // 站點 2：建立專案（建立者的成員列）
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "不該被建立的專案", timeZoneId = "Not/AZone" });
        var createResp = await _client.SendAsync(create);
        Assert.Equal(HttpStatusCode.BadRequest, createResp.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(createResp));

        // 站點 4：更新成員角色（pete 還不是成員 ⇒ 這條路徑會新增他的第一列）
        var roleResp = await _client.PutAsync($"/api/projects/{projectId}/members/{userId}",
            JsonContent.Create(new { roleIds = new[] { roleId }, timeZoneId = "Not/AZone" }));
        Assert.Equal(HttpStatusCode.BadRequest, roleResp.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(roleResp));

        // 站點 5：專案複製
        var copyReq = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{projectId}/copy");
        copyReq.Headers.Add("X-Team-Id", teamId);
        copyReq.Content = JsonContent.Create(new { name = "不該被複製的專案", timeZoneId = "Not/AZone" });
        var copyResp = await _client.SendAsync(copyReq);
        Assert.Equal(HttpStatusCode.BadRequest, copyResp.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(copyResp));

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        Assert.Empty(db.TeamMembers.Where(m => m.TeamId == Guid.Parse(teamId) && m.UserId == userId));
        Assert.Empty(db.ProjectMembers.Where(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == userId));
        // 站點 2／5 的半成品：專案數與名稱都不能多出來
        Assert.Equal(projectsBefore, db.Projects.Count(p => p.TeamId == Guid.Parse(teamId)));
        Assert.Empty(db.Projects.Where(p => p.Name == "不該被建立的專案" || p.Name == "不該被複製的專案"));
    }

    /// <summary>
    /// 專案複製：新專案的成員列也由**發起人**的時區凍結。列數與來源相同是這一支的前提——
    /// 少了它，空集合會讓下面的斷言 vacuous 通過。
    /// </summary>
    [Fact]
    public async Task CopiedProjectMembers_FreezeJoinDayInTheInitiatorsTimeZone()
    {
        await LoginAdminAsync();
        var teamId = await CreateTeamAsync();
        var projectId = await CreateProjectAsync(teamId);

        int sourceMembers;
        using (var scope = _factory.Services.CreateScope())
            sourceMembers = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .ProjectMembers.Count(m => m.ProjectId == Guid.Parse(projectId));
        Assert.True(sourceMembers > 0, "複製來源必須有成員列，否則下面的斷言是空的");

        var before = LocalTodayOf(EastTz, DateTime.UtcNow);
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{projectId}/copy");
        req.Headers.Add("X-Team-Id", teamId);
        req.Content = JsonContent.Create(new { name = "到職專案副本", timeZoneId = EastTz });
        var resp = await _client.SendAsync(req);
        var after = LocalTodayOf(EastTz, DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var copyProjectId = (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var rows = db.ProjectMembers.Where(m => m.ProjectId == Guid.Parse(copyProjectId)).ToList();
            Assert.Equal(sourceMembers, rows.Count);
            Assert.All(rows, r => Assert.Contains(r.JoinedLocalDate, new[] { before, after }));
        }
    }
}
