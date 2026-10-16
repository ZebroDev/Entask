using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class TeamTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public TeamTests(ApiWebApplicationFactory factory)
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
    public async Task Admin_CreatesTeam_And_ListsIt()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var create = await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部", description = "核心開發團隊" }));
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);

        var list = await _client.GetAsync("/api/teams");
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        var items = await list.Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotEmpty(items.EnumerateArray());
        Assert.Contains(items.EnumerateArray(), t => t.GetProperty("name").GetString() == "研發部");
    }

    [Fact]
    public async Task AssignMember_NullRoleIds_Returns400()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "工程師艾琳" }));

        var assign = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "erin", roleIds = (Guid[]?)null }));
        Assert.Equal(HttpStatusCode.BadRequest, assign.StatusCode);
    }

    [Fact]
    public async Task NonAdmin_CannotCreateTeam()
    {
        // 建立一般使用者（無 admin claim）
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "bob", password = "Password1!", displayName = "林工程師" }));

        // 以 bob 登入
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "bob", password = "Password1!" }));
        var json = await login.Content.ReadFromJsonAsync<JsonElement>();
        var bobToken = json.GetProperty("accessToken").GetString()!;

        var bobClient = _factory.CreateClient();
        bobClient.DefaultRequestHeaders.Authorization = new("Bearer", bobToken);
        var create = await bobClient.PostAsync("/api/teams",
            JsonContent.Create(new { name = "X 團隊" }));

        Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);
        // 判別力所在：只斷言 403 的話，改動前（`Results.Forbid()`，空 body）與改動後（帶 body）
        // 都是綠的。body 的 `code` 才是「使用者看得到人話」的那個契約。
        var body = await create.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("permission.denied", body.GetProperty("code").GetString());
        Assert.Equal("你沒有存取這個資源的權限", body.GetProperty("message").GetString());
    }

    [Fact]
    public async Task NonMember_UpdatesTeam_Returns403WithPermissionDeniedBody()
    {
        // dave：非 admin、也不是這個團隊的成員（沒有任何團隊角色 ⇒ 沒有 team.role.manage）
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "守衛團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "戴夫" }));

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "dave", password = "Password1!" }));
        var daveToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        var daveClient = _factory.CreateClient();
        daveClient.DefaultRequestHeaders.Authorization = new("Bearer", daveToken);
        var resp = await daveClient.PutAsync($"/api/teams/{teamId}",
            JsonContent.Create(new { name = "改名" }));

        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("permission.denied", body.GetProperty("code").GetString());
        Assert.Equal("你沒有存取這個資源的權限", body.GetProperty("message").GetString());
    }

    [Fact]
    public async Task TeamManager_AssignsMultipleRoles_ToMember()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        // 建立團隊與一般使用者
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "carol", password = "Password1!", displayName = "陳助理" }));

        // 查團隊內角色範本
        var rolesJson = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var roleIds = rolesJson.EnumerateArray()
            .Where(r => r.GetProperty("name").GetString() is "工程師" or "專案助理")
            .Select(r => r.GetProperty("id").GetString()!)
            .ToList();
        Assert.Equal(2, roleIds.Count);

        // 指派 carol 兩個角色（admin 有 team.member.manage 能力，本測試直接以 admin 驗證多角色指派）
        var assign = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "carol", roleIds }));
        Assert.Equal(HttpStatusCode.OK, assign.StatusCode);

        var detail = await _client.GetAsync($"/api/teams/{teamId}");
        var members = (await detail.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("members").EnumerateArray().ToList();
        Assert.Single(members);
        Assert.Equal(2, members[0].GetProperty("roles").GetArrayLength());
    }

    [Fact]
    public async Task GetUnknownTeam_Returns404WithCode()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var response = await _client.GetAsync($"/api/teams/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(ErrorCodes.TeamNotFound, await ErrorBody.CodeOfAsync(response));
    }

    [Fact]
    public async Task RemoveUnknownMember_Returns404WithCode()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "研發部-成員404" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        // 團隊存在、成員不存在 ⇒ TeamEndpoints.cs:221 的 existing.Count == 0
        var response = await _client.DeleteAsync($"/api/teams/{teamId}/members/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(ErrorCodes.TeamMemberNotFound, await ErrorBody.CodeOfAsync(response));
    }

    [Fact]
    public async Task CreateTeam_NameValidation_SameRulesAsUpdate()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        // 邊界：恰好 100 字元 ⇒ 合法（'長' 是 BMP 字元，Length==100）
        var ok = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = new string('長', 100) }));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

        // Trim 是新行為：前後空白被清掉後才存
        var padded = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "  研發二部  " }));
        Assert.Equal(HttpStatusCode.OK, padded.StatusCode);
        var paddedBody = await padded.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("研發二部", paddedBody.GetProperty("name").GetString());

        // 空白 ⇒ team.nameRequired（建立路線以前沒有這條）
        var blank = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "   " }));
        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
        var blankBody = await blank.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("team.nameRequired", blankBody.GetProperty("code").GetString());

        // 控制字元 ⇒ team.nameInvalid（JSON 允許 \r\n 轉義 ⇒ 使用者可控）
        var ctrl = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "x\r\nY" }));
        Assert.Equal(HttpStatusCode.BadRequest, ctrl.StatusCode);
        var ctrlBody = await ctrl.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("team.nameInvalid", ctrlBody.GetProperty("code").GetString());
        Assert.Equal("團隊名稱含無效字元", ctrlBody.GetProperty("message").GetString());

        // 101 字元 ⇒ team.nameTooLong（訊息與 @params 照 displayNameTooLong 的形狀）
        var tooLong = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = new string('長', 101) }));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        var tooLongBody = await tooLong.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("team.nameTooLong", tooLongBody.GetProperty("code").GetString());
        Assert.Equal("團隊名稱不可超過 100 字元", tooLongBody.GetProperty("message").GetString());
        Assert.Equal(100, tooLongBody.GetProperty("params").GetProperty("max").GetInt32());
    }

    [Fact]
    public async Task UpdateTeam_NameValidation_SameRulesAsCreate()
    {
        var token = await AdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var teamJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "驗證團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamId = teamJson.GetProperty("id").GetString()!;

        // 更新路線的三格與建立相同（不對稱收斂，state/37）
        var blank = await _client.PutAsync($"/api/teams/{teamId}", JsonContent.Create(new { name = " " }));
        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
        Assert.Equal("team.nameRequired",
            (await blank.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        var ctrl = await _client.PutAsync($"/api/teams/{teamId}", JsonContent.Create(new { name = "a\tb" }));
        Assert.Equal(HttpStatusCode.BadRequest, ctrl.StatusCode);
        Assert.Equal("team.nameInvalid",
            (await ctrl.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        var tooLong = await _client.PutAsync($"/api/teams/{teamId}", JsonContent.Create(new { name = new string('長', 101) }));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Equal("team.nameTooLong",
            (await tooLong.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // 合法值仍然通過、且被 Trim
        var valid = await _client.PutAsync($"/api/teams/{teamId}", JsonContent.Create(new { name = "  改名後  " }));
        Assert.Equal(HttpStatusCode.OK, valid.StatusCode);
        Assert.Equal("改名後",
            (await valid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString());
    }
}
