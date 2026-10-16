using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

/// <summary>報表讀取路徑：`/api/teams/{id}/worklog`（Team 範疇）、`/api/projects/{id}/worklog`（Project 範疇，
/// 日曆取專案所屬團隊）與 `/api/me/worklog`（Me 範疇）。
/// 例外列直接寫 DB——寫入端點這時還不存在（Task 4），而這一類測的是讀取。
/// admin 有 admin claim ⇒ `RequirePermission` 直接放行、不需要 X-Team-Id（見該擴充方法的 R8）。
/// 日期：2026-10-05 是週一、2026-10-10 是週六（既有 WorkCalendarTests 已釘住同一個月份）。
/// 2026-10-08 批次後，工作日誌讀取端收的是**本地日**區間（`to` 排他），`tzOffsetMinutes` 已移除
/// ⇒ 這裡的 `from`／`to` 就是原本換算後的那兩天，語意不變。</summary>
public class WorkCalendarReportTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public WorkCalendarReportTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        _factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task TeamScope_NoExceptions_MatchesMonToFri()
    {
        var teamId = await CreateTeamAsync("無例外隊");
        var body = await GetReportAsync($"/api/teams/{teamId}/worklog?from=2026-10-05&to=2026-10-12");

        Assert.Equal(new[] { "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09" },
            Workdays(body));
        Assert.Equal(5, body.GetProperty("summary").GetProperty("workdayCount").GetInt32());
    }

    [Fact]
    public async Task TeamScope_Holiday_IsRemovedFromWorkdays()
    {
        var teamId = await CreateTeamAsync("放假隊");
        await SeedAsync(teamId, new DateOnly(2026, 10, 5), WorkCalendarKind.Holiday);

        var body = await GetReportAsync($"/api/teams/{teamId}/worklog?from=2026-10-05&to=2026-10-06");

        Assert.Empty(Workdays(body));
    }

    [Fact]
    public async Task TeamScope_WorkdayMakeup_OnSaturday_IsAdded()
    {
        var teamId = await CreateTeamAsync("補班隊");
        await SeedAsync(teamId, new DateOnly(2026, 10, 10), WorkCalendarKind.Workday);

        var body = await GetReportAsync($"/api/teams/{teamId}/worklog?from=2026-10-10&to=2026-10-11");

        Assert.Equal(new[] { "2026-10-10" }, Workdays(body));
    }

    [Fact]
    public async Task ProjectScope_HolidayOfOwningTeam_IsRemovedFromWorkdays()
    {
        var teamId = await CreateTeamAsync("專案隊");
        var projectId = await CreateProjectAsync(teamId, "專案");
        await SeedAsync(teamId, new DateOnly(2026, 10, 5), WorkCalendarKind.Holiday);

        var body = await GetReportAsync(
            $"/api/projects/{projectId}/worklog?from=2026-10-05&to=2026-10-12");

        // 專案範疇的日曆＝**專案所屬團隊**的日曆（R1；`GetScopeTeamIdsAsync` 的 Project 分支）。
        // 最自然的退化是照抄 Team 分支寫成 `[scopeId]`——那樣會拿**專案 id** 去查例外表（查不到），
        // 這一天就會留在 workdays、summary 也不會降。該退化不會讓任何既有測試變紅。
        Assert.Equal(new[] { "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09" }, Workdays(body));
        Assert.Equal(4, body.GetProperty("summary").GetProperty("workdayCount").GetInt32());
    }

    [Fact]
    public async Task MeScope_TwoTeams_HolidayWins()
    {
        await CreateUserAsync("dana", "Dana");
        var teamA = await CreateTeamAsync("A 隊");
        var teamB = await CreateTeamAsync("B 隊");
        await AddMemberAsync(teamA, "dana");
        await AddMemberAsync(teamB, "dana");
        await SeedAsync(teamA, new DateOnly(2026, 10, 5), WorkCalendarKind.Holiday);
        await SeedAsync(teamB, new DateOnly(2026, 10, 5), WorkCalendarKind.Workday);

        await LoginAsync("dana", "Password1!");
        var body = await GetReportAsync("/api/me/worklog?from=2026-10-05&to=2026-10-06");

        // R3（取聯集）＋ R4（假優先於補班）：A 隊標放假、B 隊標補班 ⇒ 這天不是工作日
        Assert.Empty(Workdays(body));
    }

    [Fact]
    public async Task MeScope_NoTeam_FallsBackToMonToFri()
    {
        await CreateUserAsync("erin", "Erin");
        await LoginAsync("erin", "Password1!");

        var body = await GetReportAsync("/api/me/worklog?from=2026-10-05&to=2026-10-06");

        Assert.Equal(new[] { "2026-10-05" }, Workdays(body));
    }

    // --- helpers ---

    private static List<string?> Workdays(JsonElement body) =>
        body.GetProperty("workdays").EnumerateArray().Select(x => x.GetString()).ToList();

    private async Task LoginAsync(string username, string password)
    {
        var res = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        res.EnsureSuccessStatusCode();
        var token = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    // 每個寫入型 helper 都先用自己的 admin 身分登入 —— helper 之間因此沒有
    // 「現在這支 _client 帶的是誰的 token」這種隱性順序（第一個測試就踩過：沒先登入 ⇒ 401）
    private async Task LoginAsAdminAsync() => await LoginAsync("admin-test", "TestPass123!");

    private async Task<Guid> CreateTeamAsync(string name)
    {
        await LoginAsAdminAsync();
        var res = await _client.PostAsync("/api/teams", JsonContent.Create(new { name }));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>建立隸屬指定團隊的專案（團隊由 request 層的 `X-Team-Id` 指名，與前端同機制）。</summary>
    private async Task<Guid> CreateProjectAsync(Guid teamId, string name)
    {
        await LoginAsAdminAsync();
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        request.Headers.Add("X-Team-Id", teamId.ToString());
        request.Content = JsonContent.Create(new { name });
        var res = await _client.SendAsync(request);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private async Task CreateUserAsync(string username, string displayName)
    {
        await LoginAsAdminAsync();
        var res = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName }));
        res.EnsureSuccessStatusCode();
    }

    private async Task AddMemberAsync(Guid teamId, string username)
    {
        await LoginAsAdminAsync();
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var engineerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("code").GetString() == "engineer").GetProperty("id").GetString()!;
        var res = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username, roleIds = new[] { engineerRoleId } }));
        res.EnsureSuccessStatusCode();
    }

    private async Task<JsonElement> GetReportAsync(string url)
    {
        var res = await _client.GetAsync(url);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task SeedAsync(Guid teamId, DateOnly date, WorkCalendarKind kind)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.WorkCalendarExceptions.Add(new WorkCalendarException
        {
            Id = Guid.NewGuid(), TeamId = teamId, Date = date, Kind = kind,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }
}
