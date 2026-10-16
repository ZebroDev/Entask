using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class CardRelationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CardRelationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ListId, string BoardId, string ProjectId, string TeamId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "關聯測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "關聯測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "關聯板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        return (list.GetProperty("id").GetString()!, boardId, projectId, teamId);
    }

    [Fact]
    public async Task CardMembers_AssignReplace_Works()
    {
        var (listId, _, projectId, teamId) = await SetupAsync();
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "grace", password = "Password1!", displayName = "葛瑞絲" }));
        Guid graceId;
        using (var scope = _factory.Services.CreateScope())
            graceId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "grace").Id;

        // grace 必須先是專案成員：卡片的指派者與審查者都必須是該卡片所屬專案的成員
        // （2026-09-19 不變量），否則下面的指派會拿到 400。
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = graceId, roleIds = new[] { engineerRoleId } }))).StatusCode);

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "指派卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;

        // 卡片建立寫入 card.created 稽核（專案與標題正確）
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var log = db.AuditLogs.Single(l => l.Action == "card.created" && l.EntityId == Guid.Parse(cardId));
            Assert.Equal(Guid.Parse(projectId), log.ProjectId);
            Assert.Equal("指派卡", log.EntityTitle);
        }

        var assigned = await (await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { graceId } }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(assigned.GetProperty("members").EnumerateArray());

        var cleared = await (await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = Array.Empty<Guid>() }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(cleared.GetProperty("members").EnumerateArray());
    }

    [Fact]
    public async Task CardLabels_CrossBoardLabel_Returns400()
    {
        var (listId, boardId, projectId, _) = await SetupAsync();
        var otherBoard = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "異板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherBoardId = otherBoard.GetProperty("id").GetString()!;
        var otherLabel = await (await _client.PostAsync($"/api/boards/{otherBoardId}/labels",
            JsonContent.Create(new { name = "別板標籤", color = "#00ff00" }))).Content.ReadFromJsonAsync<JsonElement>();

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "標籤卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;

        var resp = await _client.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = new[] { Guid.Parse(otherLabel.GetProperty("id").GetString()!) } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);

        // 本板標籤可指派
        var ownLabel = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "本板", color = "#0000ff" }))).Content.ReadFromJsonAsync<JsonElement>();
        var ok = await (await _client.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = new[] { Guid.Parse(ownLabel.GetProperty("id").GetString()!) } })))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(ok.GetProperty("labels").EnumerateArray());
    }

    [Fact]
    public async Task CardPut_DueAtAndEstimatedHours_NullClearsAbsentKeeps()
    {
        var (listId, _, _, _) = await SetupAsync();
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "日期卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;

        // 設定 dueAt 與 estimatedHours
        var set = await (await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { dueAt = "2026-09-01T00:00:00Z", estimatedHours = 8.5 }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("2026-09-01T00:00:00Z", set.GetProperty("dueAt").GetString());
        Assert.Equal(8.5m, set.GetProperty("estimatedHours").GetDecimal());

        // 只改 title：dueAt/estimatedHours 缺席 → 不變
        var partial = await (await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { title = "改名不影響日期" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("2026-09-01T00:00:00Z", partial.GetProperty("dueAt").GetString());

        // null 清除
        var cleared = await (await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { dueAt = (DateTime?)null, estimatedHours = (decimal?)null }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("dueAt").ValueKind);
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("estimatedHours").ValueKind);
    }

    [Fact]
    public async Task CardScope_EngineerMember_EditsCard_NonMemberGets403()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        // 自建團隊/專案/看板/列表（需 teamId 查角色）
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "範圍測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "範圍測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "範圍板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "範圍列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "範圍卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;

        // 工程師使用者（card.read/card.edit，無 board.*）加入專案
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "henry", password = "Password1!", displayName = "亨利" }));
        Guid henryId;
        using (var scope = _factory.Services.CreateScope())
            henryId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "henry").Id;
        var add = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = henryId, roleIds = new[] { engineerRoleId } }));
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);

        // 無專案存取的使用者
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "ivan", password = "Password1!", displayName = "伊凡" }));

        // henry（僅 card.* 權限）經 cardId 階層授權改卡片標題 → 200
        var henryLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "henry", password = "Password1!" }));
        var henryToken = (await henryLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        var henryPut = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}");
        henryPut.Headers.Authorization = new("Bearer", henryToken);
        henryPut.Content = JsonContent.Create(new { title = "工程師改名" });
        var putResp = await _client.SendAsync(henryPut);
        Assert.Equal(HttpStatusCode.OK, putResp.StatusCode);
        var putBody = await putResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("工程師改名", putBody.GetProperty("title").GetString());

        // ivan（無任何專案角色）GET 卡片 → 403
        var ivanLogin = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "ivan", password = "Password1!" }));
        var ivanToken = (await ivanLogin.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
        var ivanGet = new HttpRequestMessage(HttpMethod.Get, $"/api/cards/{cardId}");
        ivanGet.Headers.Authorization = new("Bearer", ivanToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(ivanGet)).StatusCode);
    }
}
