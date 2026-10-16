using System.Net.Http.Json;
using System.Text.Json;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class CopyTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CopyTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string TeamId, string ProjectId, string BoardId, string ListId, string CardId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "複製測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "複製測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "原板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "原列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "原卡", description = "描述" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardId}", JsonContent.Create(new { estimatedHours = 5 }));

        // 標籤、成員、檢查清單、自訂欄位值
        var label = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "bug", color = "#ff0000" }))).Content.ReadFromJsonAsync<JsonElement>();
        await _client.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = new[] { Guid.Parse(label.GetProperty("id").GetString()!) } }));
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收" }))).Content.ReadFromJsonAsync<JsonElement>();
        await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklist.GetProperty("id").GetString()}/items",
            JsonContent.Create(new { text = "項目一" }));
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var priorityId = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [priorityId] = "高" }));
        // 留言與工時（不應被複製）
        await _client.PostAsync($"/api/cards/{cardId}/comments", JsonContent.Create(new { text = "原留言" }));
        await _client.PostAsync($"/api/cards/{cardId}/effort", JsonContent.Create(new { hours = 2, timeZoneId = "UTC" }));

        return (teamId, projectId, boardId, listId, cardId);
    }

    [Fact]
    public async Task CopyCard_CopiesFieldsNotActivity_Works()
    {
        var (_, _, _, listId, cardId) = await SetupAsync();

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy", JsonContent.Create(new { })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var copyId = copy.GetProperty("id").GetString()!;
        Assert.Equal("原卡（副本）", copy.GetProperty("title").GetString());
        Assert.Equal("描述", copy.GetProperty("description").GetString());
        Assert.Equal(5m, copy.GetProperty("estimatedHours").GetDecimal());
        Assert.Single(copy.GetProperty("labels").EnumerateArray());
        Assert.Single(copy.GetProperty("checklists").EnumerateArray());
        Assert.Single(copy.GetProperty("customFields").EnumerateArray());

        // 活動/留言/審查/工時不複製：副本活動只有 copy 一條
        var activity = await (await _client.GetAsync($"/api/cards/{copyId}/activity")).Content.ReadFromJsonAsync<JsonElement>();
        var types = activity.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("type").GetString()).ToList();
        Assert.Equal(new[] { "copy" }, types);
        var effort = await (await _client.GetAsync($"/api/cards/{copyId}/effort")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0m, effort.GetProperty("totalHours").GetDecimal());
    }

    [Fact]
    public async Task CopyCard_CrossBoard_NoLabelsNoFieldValues()
    {
        var (_, projectId, _, listId, cardId) = await SetupAsync();
        var board2 = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "異板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var list2 = await (await _client.PostAsync($"/api/boards/{board2.GetProperty("id").GetString()}/lists",
            JsonContent.Create(new { name = "異列表" }))).Content.ReadFromJsonAsync<JsonElement>();

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy",
            JsonContent.Create(new { targetListId = list2.GetProperty("id").GetString() }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(copy.GetProperty("labels").EnumerateArray());
        Assert.Empty(copy.GetProperty("customFields").EnumerateArray());
        // 檢查清單仍複製（不依賴看板範疇）
        Assert.Single(copy.GetProperty("checklists").EnumerateArray());
    }

    [Fact]
    public async Task CopyList_CopiesCardsIntoBoard_Works()
    {
        var (_, projectId, boardId, listId, cardId) = await SetupAsync();
        var board2 = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "清單複製目標" }))).Content.ReadFromJsonAsync<JsonElement>();
        var targetBoardId = board2.GetProperty("id").GetString()!;

        var copy = await (await _client.PostAsync($"/api/lists/{listId}/copy",
            JsonContent.Create(new { targetBoardId }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("原列表", copy.GetProperty("name").GetString());
        // 原列表 1 張卡 → 複製出 1 張
        Assert.Single(copy.GetProperty("cards").EnumerateArray());
        // 跨看板 → 卡片無標籤
        var copiedCard = copy.GetProperty("cards").EnumerateArray()
            .First(c => c.GetProperty("title").GetString() == "原卡（副本）");
        Assert.Empty(copiedCard.GetProperty("labels").EnumerateArray());
    }

    [Fact]
    public async Task CopyBoard_CopiesListsCardsAndLabels_Works()
    {
        var (_, projectId, boardId, _, _) = await SetupAsync();

        var copy = await (await _client.PostAsync($"/api/boards/{boardId}/copy",
            JsonContent.Create(new { targetProjectId = projectId, name = "板副本" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("板副本", copy.GetProperty("name").GetString());
        var copyBoardId = copy.GetProperty("id").GetString()!;

        var detail = await (await _client.GetAsync($"/api/boards/{copyBoardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(detail.GetProperty("lists").EnumerateArray());
        var labels = await (await _client.GetAsync($"/api/boards/{copyBoardId}/labels")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(labels.EnumerateArray());
        // 卡片標籤關聯經 ID 映射保留（舊實作：目標標籤已重建但卡片無標籤）
        var copiedCard = detail.GetProperty("lists").EnumerateArray().First()
            .GetProperty("cards").EnumerateArray()
            .First(c => c.GetProperty("title").GetString() == "原卡（副本）");
        Assert.Single(copiedCard.GetProperty("labels").EnumerateArray());
    }

    [Fact]
    public async Task CopyProject_CopiesBoardsAndMembers_Works()
    {
        var (teamId, projectId, _, _, _) = await SetupAsync();

        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{projectId}/copy");
        req.Headers.Add("X-Team-Id", teamId);
        req.Content = JsonContent.Create(new { name = "專案副本" });
        var copy = await (await _client.SendAsync(req)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("專案副本", copy.GetProperty("name").GetString());
        var copyProjectId = copy.GetProperty("id").GetString()!;

        var boards = await (await _client.GetAsync($"/api/projects/{copyProjectId}/boards")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(boards.EnumerateArray());
        var members = await (await _client.GetAsync($"/api/projects/{copyProjectId}/members")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(members.EnumerateArray());
        var fields = await (await _client.GetAsync($"/api/projects/{copyProjectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, fields.GetArrayLength());
    }

    // ===== SignalR 廣播（2026-09-27）=====
    //
    // 複製出來的卡片對用戶端而言就是「多了一張卡」：不廣播的話，別人得重新整理才看得到。
    // 在此之前這條路線沒有廣播（實查：改動前全檔零個 `IHubContext`）。
    //
    // **兩支成對，判別力在第二支**：只寫「同看板複製會廣播」的話，把**來源**的 boardId
    // 寫進群組也照樣綠（同看板時來源與目標相等）；第二支走跨看板，兩者才分得開。
    // 替身是 singleton（見 `ApiWebApplicationFactory.Hub`），記錄會跨測試累積 ⇒ 開頭清空。
    [Fact]
    public async Task CopyCard_BroadcastsCardCreatedToBoardAndProject()
    {
        var (_, projectId, boardId, listId, cardId) = await SetupAsync();
        _factory.Hub.Clear();

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy", JsonContent.Create(new { })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var copyId = copy.GetProperty("id").GetString()!;

        Assert.Equal(2, _factory.Hub.Broadcasts.Count);
        Assert.All(_factory.Hub.Broadcasts, b => Assert.Equal("CardCreated", b.Method));

        foreach (var b in new[]
                 {
                     _factory.Hub.Broadcasts.Single(b => b.Kind == "group" && b.Target == $"board:{boardId}"),
                     _factory.Hub.Broadcasts.Single(b => b.Kind == "group" && b.Target == $"project:{projectId}"),
                 })
        {
            Assert.Equal(Guid.Parse(copyId), b.Payload.GetProperty("cardId").GetGuid());
            Assert.Equal(Guid.Parse(listId), b.Payload.GetProperty("listId").GetGuid());
            Assert.Equal(Guid.Parse(boardId), b.Payload.GetProperty("boardId").GetGuid());
            Assert.Equal(Guid.Parse(projectId), b.Payload.GetProperty("projectId").GetGuid());
        }
    }

    [Fact]
    public async Task CopyCard_CrossBoard_BroadcastsToTargetGroupsNotSource()
    {
        var (_, projectId, boardId, _, cardId) = await SetupAsync();
        var board2 = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "廣播目標板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var targetBoardId = board2.GetProperty("id").GetString()!;
        var list2 = await (await _client.PostAsync($"/api/boards/{targetBoardId}/lists",
            JsonContent.Create(new { name = "廣播目標列表" }))).Content.ReadFromJsonAsync<JsonElement>();
        var targetListId = list2.GetProperty("id").GetString()!;
        _factory.Hub.Clear();

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy",
            JsonContent.Create(new { targetListId }))).Content.ReadFromJsonAsync<JsonElement>();
        var copyId = copy.GetProperty("id").GetString()!;

        Assert.Equal(2, _factory.Hub.Broadcasts.Count);
        Assert.All(_factory.Hub.Broadcasts, b => Assert.Equal("CardCreated", b.Method));
        // 群組必須是**目標**：寫成來源的話，看得到來源看板的人會收到一張不在那裡的卡，
        // 而目標看板的人什麼都收不到——同看板複製時兩者相等，只有這一支分得開。
        Assert.DoesNotContain(_factory.Hub.Broadcasts,
            b => b.Kind == "group" && b.Target == $"board:{boardId}");

        foreach (var b in new[]
                 {
                     _factory.Hub.Broadcasts.Single(b => b.Kind == "group" && b.Target == $"board:{targetBoardId}"),
                     _factory.Hub.Broadcasts.Single(b => b.Kind == "group" && b.Target == $"project:{projectId}"),
                 })
        {
            Assert.Equal(Guid.Parse(copyId), b.Payload.GetProperty("cardId").GetGuid());
            Assert.Equal(Guid.Parse(targetListId), b.Payload.GetProperty("listId").GetGuid());
            Assert.Equal(Guid.Parse(targetBoardId), b.Payload.GetProperty("boardId").GetGuid());
            Assert.Equal(Guid.Parse(projectId), b.Payload.GetProperty("projectId").GetGuid());
        }
    }
}
