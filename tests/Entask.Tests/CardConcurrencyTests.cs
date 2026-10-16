using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

/// <summary>
/// P3 Fix round 2 Bug 2：並發 full-replace PUT（labels/members）的衝突處理。
/// 兩並行 PUT 刪除重疊 join 列時，後到交易的 0-row DELETE 觸發 DbUpdateConcurrencyException
/// （修復前 → 500）；修復後 bounded retry（2 次）收斂，最終狀態為兩 payload 之一（last-write-wins）。
/// </summary>
public class CardConcurrencyTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CardConcurrencyTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string CardId, string BoardId, List<Guid> LabelIds)> SetupLabelsAsync(string prefix)
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = $"{prefix}團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = $"{prefix}專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = $"{prefix}看板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;

        var labelIds = new List<Guid>();
        foreach (var (name, color) in new[] { ("紅", "#B60205"), ("綠", "#0E8A16"), ("藍", "#1D76DB") })
        {
            var label = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
                JsonContent.Create(new { name, color }))).Content.ReadFromJsonAsync<JsonElement>();
            labelIds.Add(Guid.Parse(label.GetProperty("id").GetString()!));
        }

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = $"{prefix}卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;
        var assigned = await _client.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = labelIds.ToArray() }));
        Assert.Equal(HttpStatusCode.OK, assigned.StatusCode);
        return (cardId, boardId, labelIds);
    }

    /// <summary>
    /// 把使用者加進卡片所屬的專案：卡片的指派者與審查者必須是專案成員（2026-09-19 不變量）。
    /// 專案與團隊一律由**卡片**反推——`WithDbReset()` 是 per-class（`IClassFixture` 共用 host），
    /// 同一個類別每一支測試都建了同名的團隊／專案，用名稱查會抓到別支測試的。
    /// </summary>
    private async Task AddProjectMemberAsync(string cardId, Guid userId)
    {
        Guid projectId, teamId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var cardGuid = Guid.Parse(cardId);
            projectId = db.Cards.Where(c => c.Id == cardGuid).Select(c => c.List.Board.ProjectId).First();
            teamId = db.Projects.Where(p => p.Id == projectId).Select(p => p.TeamId).First();
        }
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { roleId } }))).StatusCode);
    }

    [Fact]
    public async Task TiedPositions_FallBackToDeterministicIdOrdering()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "同分排序團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "同分排序專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "同分排序看板" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "列表" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var cardIds = new List<string>();
        for (var i = 0; i < 4; i++)
        {
            var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
                JsonContent.Create(new { title = $"卡{i}" }))).Content.ReadFromJsonAsync<JsonElement>();
            cardIds.Add(card.GetProperty("id").GetString()!);
        }

        // position 由用戶端計算後原樣送出，並行拖曳可能算出相同字串；新增路徑的
        // After(last) 同為 read-compute-write，並行新增亦會撞值。無唯一索引故兩者
        // 都不拋例外，這裡直接指定同一 position 重現同分狀態。
        foreach (var id in cardIds)
        {
            var moved = await _client.PutAsync($"/api/cards/{id}/position",
                JsonContent.Create(new { listId, position = "hU" }));
            Assert.Equal(HttpStatusCode.OK, moved.StatusCode);
        }

        // 契約：同分時以 Id 遞增為決定性次序鍵。PostgreSQL 的 uuid 比較是 16 位元組
        // memcmp，正規十六進位字串（"d" 格式）的序數比較與其同序。
        //
        // 註：本測試鎖定的是「順序契約」，不是重現競態本身。實測移除 ThenBy(Id) 後
        // 本測試仍會通過——8 張同分卡片（隨機 Guid，巧合機率 1/40320）在現行
        // PostgreSQL／EF 組合下仍回傳 Id 遞增序，故無法構造出會紅的版本。保留此測試
        // 是為了在未來查詢改動或排序行為變化時能攔下契約破壞。
        var expected = cardIds.OrderBy(id => id, StringComparer.Ordinal).ToArray();

        var board = await (await _client.GetAsync($"/api/boards/{boardId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var actual = board.GetProperty("lists").EnumerateArray()
            .SelectMany(l => l.GetProperty("cards").EnumerateArray())
            .Select(c => c.GetProperty("id").GetString()!)
            .ToArray();

        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task ConcurrentLabelPuts_No500_FinalStateIsOneOfPayloads()
    {
        var (cardId, _, labelIds) = await SetupLabelsAsync("標籤並發");
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);

        // A：清空；B：只留 lb2。兩者皆刪除重疊列（lb1/lb3）→ 衝突窗口
        var clientA = _factory.CreateClient();
        var clientB = _factory.CreateClient();
        clientA.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        clientB.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var putA = Task.Run(() => clientA.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = Array.Empty<Guid>() })));
        var putB = Task.Run(() => clientB.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = new[] { labelIds[1] } })));
        var (respA, respB) = (await putA, await putB);

        // 修復前衝突 → 500；修復後 bounded retry 於 2-way 爭用必收斂 → 皆 200
        Assert.Equal(HttpStatusCode.OK, respA.StatusCode);
        Assert.Equal(HttpStatusCode.OK, respB.StatusCode);

        var final = await (await _client.GetAsync($"/api/cards/{cardId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var ids = final.GetProperty("labels").EnumerateArray()
            .Select(l => l.GetProperty("id").GetString()).ToList();
        Assert.True(
            ids.Count == 0 || (ids.Count == 1 && ids[0] == labelIds[1].ToString()),
            $"最終標籤狀態非兩 payload 之一: [{string.Join(",", ids)}]");
    }

    [Fact]
    public async Task ConcurrentMemberPuts_No500_FinalStateIsOneOfPayloads()
    {
        var (cardId, _, _) = await SetupLabelsAsync("成員並發");
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "carol", password = "Password1!", displayName = "卡蘿" }));
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "大衛" }));
        Guid carolId, daveId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            carolId = db.Users.First(u => u.UserName == "carol").Id;
            daveId = db.Users.First(u => u.UserName == "dave").Id;
        }
        // 指派者必須是專案成員（2026-09-19 不變量），否則下面兩個 PUT 會 400 而不是在比並發。
        await AddProjectMemberAsync(cardId, carolId);
        await AddProjectMemberAsync(cardId, daveId);
        var assigned = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { carolId, daveId } }));
        Assert.Equal(HttpStatusCode.OK, assigned.StatusCode);

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        // A：清空；B：只留 carol。兩者皆刪除 dave → 衝突窗口
        var clientA = _factory.CreateClient();
        var clientB = _factory.CreateClient();
        clientA.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        clientB.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var putA = Task.Run(() => clientA.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = Array.Empty<Guid>() })));
        var putB = Task.Run(() => clientB.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { carolId } })));
        var (respA, respB) = (await putA, await putB);

        Assert.Equal(HttpStatusCode.OK, respA.StatusCode);
        Assert.Equal(HttpStatusCode.OK, respB.StatusCode);

        var final = await (await _client.GetAsync($"/api/cards/{cardId}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var ids = final.GetProperty("members").EnumerateArray().Select(m => m.GetString()).ToList();
        Assert.True(
            ids.Count == 0 || (ids.Count == 1 && ids[0] == carolId.ToString()),
            $"最終成員狀態非兩 payload 之一: [{string.Join(",", ids)}]");
    }
}
