using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class ParentExistenceTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ParentExistenceTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // R2：404 檢查需以 admin token 到達端點層（無 token 會在 RequireAuthorization 就 401）
    private async Task AuthAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
    }

    private async Task<string> SetupCardAsync()
    {
        await AuthAsync();
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "父層團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = _client.DefaultRequestHeaders.Authorization;
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "父層專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "父層板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "父層卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return card.GetProperty("id").GetString()!;
    }

    [Fact]
    public async Task BoardsList_NonexistentProject_Returns404()
    {
        await AuthAsync();
        var resp = await _client.GetAsync($"/api/projects/{Guid.NewGuid()}/boards");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task LabelsList_NonexistentBoard_Returns404()
    {
        await AuthAsync();
        var resp = await _client.GetAsync($"/api/boards/{Guid.NewGuid()}/labels");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task ActivityList_NonexistentCard_Returns404()
    {
        await AuthAsync();
        var resp = await _client.GetAsync($"/api/cards/{Guid.NewGuid()}/activity");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task CommentsList_NonexistentCard_Returns404()
    {
        await AuthAsync();
        // GET /comments 已於 P22 `95c4dbd` 移除，留言改由 activity 端點承載
        var resp = await _client.GetAsync($"/api/cards/{Guid.NewGuid()}/activity?filter=comments_only");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    // 新增（不是追加）：既有的 404 支裡沒有一支請求的是「留言」本身——本檔那兩支
    // CommentsList_* 請求的是卡片（撞到的是 card.notFound），ActivityCommentTests 撞到的
    // 都是存在的留言。這支走 comment.notFound 的第一個站點：
    // ActivityEndpoints 的 PUT …/comments/{commentId}。
    [Fact]
    public async Task CommentUpdate_NonexistentComment_Returns404()
    {
        var cardId = await SetupCardAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/comments/{Guid.NewGuid()}",
            JsonContent.Create(new { text = "改一則不存在的留言" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.CommentNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    // 新增（不是追加）：理由同上——既有的 404 支沒有一支請求的是「自訂欄位」。
    // 走 board-scoped 的 DELETE 站點（CustomFieldEndpoints 的 6 個欄位 404 共用同一個碼；
    // 這條路線唯一不必再查一次 projectId）。
    [Fact]
    public async Task BoardCustomFieldDelete_NonexistentField_Returns404()
    {
        var cardId = await SetupCardAsync();
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = card.GetProperty("boardId").GetString()!;

        var resp = await _client.DeleteAsync($"/api/boards/{boardId}/custom-fields/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardFieldNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task CommentsGet_ReturnsOnlyCommentsDescending()
    {
        var cardId = await SetupCardAsync();
        await _client.PostAsync($"/api/cards/{cardId}/comments", JsonContent.Create(new { text = "第一則" }));
        await _client.PostAsync($"/api/cards/{cardId}/comments", JsonContent.Create(new { text = "第二則" }));
        var resp = await _client.GetAsync($"/api/cards/{cardId}/activity?filter=comments_only");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        // 新契約：回應為 { items, nextCursor }，且為新→舊
        var comments = (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(2, comments.Count);
        Assert.All(comments, c => Assert.Equal("comment", c.GetProperty("type").GetString()));
        Assert.True(comments[0].GetProperty("text").GetString() == "第二則");
        Assert.True(comments[1].GetProperty("text").GetString() == "第一則");
    }
}
