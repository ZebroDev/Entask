using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

// 團隊讀取端點（GET /api/teams/{id}、GET /api/teams/{id}/roles）需 team.read 權限，
// 且 X-Team-Id header 綁定的團隊必須與 route 的 teamId 一致
public class TeamReadPermissionTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public TeamReadPermissionTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task TeamReadEndpoints_CrossTeam_Returns403()
    {
        // admin 建立團隊 A、B 與使用者 carol，並指派 carol 為 A 團隊的團隊經理（含 team.read）
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-test", password = "TestPass123!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var teamAJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "A 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamAId = teamAJson.GetProperty("id").GetString()!;
        var teamBJson = await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = "B 團隊" }))).Content.ReadFromJsonAsync<JsonElement>();
        var teamBId = teamBJson.GetProperty("id").GetString()!;

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "carol", password = "Password1!", displayName = "卡蘿" }));

        var rolesJson = await (await _client.GetAsync($"/api/teams/{teamAId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var managerRoleId = rolesJson.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理")
            .GetProperty("id").GetString()!;
        var assign = await _client.PutAsync($"/api/teams/{teamAId}/members",
            JsonContent.Create(new { username = "carol", roleIds = new[] { managerRoleId } }));
        Assert.Equal(HttpStatusCode.OK, assign.StatusCode);

        // carol 登入
        var carolLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "carol", password = "Password1!" }));
        var carolToken = (await carolLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        // X-Team-Id: A 但 route teamId=B → 403（跨團隊讀取必須被擋）
        var detailRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/teams/{teamBId}");
        detailRequest.Headers.Authorization = new("Bearer", carolToken);
        detailRequest.Headers.Add("X-Team-Id", teamAId);
        var detailCross = await _client.SendAsync(detailRequest);
        Assert.Equal(HttpStatusCode.Forbidden, detailCross.StatusCode);

        var rolesRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/teams/{teamBId}/roles");
        rolesRequest.Headers.Authorization = new("Bearer", carolToken);
        rolesRequest.Headers.Add("X-Team-Id", teamAId);
        var rolesCross = await _client.SendAsync(rolesRequest);
        Assert.Equal(HttpStatusCode.Forbidden, rolesCross.StatusCode);

        // 正向控制：同 headers 但 route teamId=A → 200（讀自己團隊不應被誤擋）
        var ownDetailRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/teams/{teamAId}");
        ownDetailRequest.Headers.Authorization = new("Bearer", carolToken);
        ownDetailRequest.Headers.Add("X-Team-Id", teamAId);
        var ownDetail = await _client.SendAsync(ownDetailRequest);
        Assert.Equal(HttpStatusCode.OK, ownDetail.StatusCode);

        var ownRolesRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/teams/{teamAId}/roles");
        ownRolesRequest.Headers.Authorization = new("Bearer", carolToken);
        ownRolesRequest.Headers.Add("X-Team-Id", teamAId);
        var ownRoles = await _client.SendAsync(ownRolesRequest);
        Assert.Equal(HttpStatusCode.OK, ownRoles.StatusCode);
    }
}
