using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

/// <summary>端點寫入路徑。helpers 與 WorkCalendarReportTests 同型（每個寫入型 helper 先登入 admin，
/// 因此沒有「現在帶的是誰的 token」這種隱性順序）。</summary>
public class WorkCalendarEndpointTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public WorkCalendarEndpointTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    private async Task LoginAsAdminAsync() => await LoginAsync("admin-test", "TestPass123!");

    private async Task LoginAsync(string username, string password)
    {
        var res = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        res.EnsureSuccessStatusCode();
        var token = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    private async Task<Guid> CreateTeamAsync(string name)
    {
        await LoginAsAdminAsync();
        var res = await _client.PostAsync("/api/teams", JsonContent.Create(new { name }));
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

    private async Task<JsonElement> GetJsonAsync(string url)
    {
        var res = await _client.GetAsync(url);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>可帶 `X-Team-Id` 的請求（非 admin 的測試要用）；`body` 為 null 時不帶 Content。
    /// header 是 `RequirePermission` 的契約：缺了是 400、與 route 的 teamId 不一致是 403。</summary>
    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, object? body, Guid? teamId = null)
    {
        var request = new HttpRequestMessage(method, url);
        if (body is not null) request.Content = JsonContent.Create(body);
        if (teamId is Guid id) request.Headers.Add("X-Team-Id", id.ToString());
        return await _client.SendAsync(request);
    }

    [Fact]
    public async Task Put_Holiday_ThenReportDropsThatDay()
    {
        var teamId = await CreateTeamAsync("寫入隊");
        var put = await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/work-calendar/2026-10-05",
            new { kind = "Holiday", name = "國慶日" });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var body = await GetJsonAsync($"/api/teams/{teamId}/worklog?from=2026-10-05&to=2026-10-06");
        Assert.Empty(body.GetProperty("workdays").EnumerateArray());
    }

    [Fact]
    public async Task PutTwice_KeepsOneRow_AndIsIdempotent()
    {
        var teamId = await CreateTeamAsync("冪等隊");
        await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/work-calendar/2026-10-10", new { kind = "Workday", name = "補班" });
        var second = await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/work-calendar/2026-10-10",
            new { kind = "Holiday", name = "改成放假" });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        var list = await GetJsonAsync($"/api/teams/{teamId}/work-calendar?from=2026-10-01&to=2026-10-31");
        Assert.Equal(1, list.GetArrayLength());                                    // 一列，不是兩列
        Assert.Equal("Holiday", list[0].GetProperty("kind").GetString());          // 後寫的贏
    }

    [Fact]
    public async Task Delete_RemovesTheDay()
    {
        var teamId = await CreateTeamAsync("刪除隊");
        await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/work-calendar/2026-10-05", new { kind = "Holiday", name = "國慶日" });

        var removed = await SendAsync(HttpMethod.Delete, $"/api/teams/{teamId}/work-calendar/2026-10-05", null);
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);

        // 覆蓋 204 之外也要覆蓋「真的刪掉了」：清單不再含該日
        var list = await GetJsonAsync($"/api/teams/{teamId}/work-calendar?from=2026-10-01&to=2026-10-31");
        Assert.DoesNotContain(list.EnumerateArray(), e => e.GetProperty("date").GetString() == "2026-10-05");
    }

    [Fact]
    public async Task Delete_Missing_Is404WithCode()
    {
        var teamId = await CreateTeamAsync("不存在隊");
        var res = await SendAsync(HttpMethod.Delete, $"/api/teams/{teamId}/work-calendar/2026-10-09", null);

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("workCalendar.notFound", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task InvalidKindAndBadDate_Are400()
    {
        var teamId = await CreateTeamAsync("驗證隊");
        Assert.Equal(HttpStatusCode.BadRequest,
            (await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/work-calendar/2026-10-05", new { kind = "1" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/work-calendar/2026-13-99", new { kind = "Holiday" })).StatusCode);
    }

    [Fact]
    public async Task ReaderWithoutManagePermission_CanReadButCannotWrite()
    {
        // 自訂角色只給 team.read：讀得到、寫不動 —— 證明兩道權限是分開的
        await CreateUserAsync("fiona", "Fiona");
        var teamId = await CreateTeamAsync("權限隊");
        // 下面的建立角色與指派都由 admin 執行（CreateTeamAsync 剛登入過），admin claim 讓 RequirePermission 放行
        var created = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new { name = "只讀者", permissionCodes = new[] { "team.read" } }));
        created.EnsureSuccessStatusCode();
        var roleId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var assign = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "fiona", roleIds = new[] { roleId } }));
        assign.EnsureSuccessStatusCode();

        await LoginAsync("fiona", "Password1!");
        // X-Team-Id 是 header 契約：帶了就通過 route/header 一致性檢查，擋下來的是權限本身
        var get = await SendAsync(HttpMethod.Get,
            $"/api/teams/{teamId}/work-calendar?from=2026-10-01&to=2026-10-31", null, teamId);
        var put = await SendAsync(HttpMethod.Put,
            $"/api/teams/{teamId}/work-calendar/2026-10-05", new { kind = "Holiday" }, teamId);
        var delete = await SendAsync(HttpMethod.Delete,
            $"/api/teams/{teamId}/work-calendar/2026-10-05", null, teamId);
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, put.StatusCode);
        // DELETE 是另一條 `.RequirePermission(TeamWorkCalendarManage)`：少了這一支，
        // 把 DELETE 的權限碼改弱成 team.read 不會有任何紅燈
        Assert.Equal(HttpStatusCode.Forbidden, delete.StatusCode);
    }
}
