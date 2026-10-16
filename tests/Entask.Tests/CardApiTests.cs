using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class CardApiTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CardApiTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ListId, string BoardId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "卡測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "卡測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "卡板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        return (list.GetProperty("id").GetString()!, boardId);
    }

    [Fact]
    public async Task CardCrud_CreateGetUpdateDelete_Works()
    {
        var (listId, _) = await SetupAsync();

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "第一張卡", description = "內容" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;
        Assert.Equal("第一張卡", card.GetProperty("title").GetString());

        var fetched = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("內容", fetched.GetProperty("description").GetString());

        var updated = await (await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { title = "改名卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("改名卡", updated.GetProperty("title").GetString());

        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/cards/{cardId}")).StatusCode);
        var afterDelete = await _client.GetAsync($"/api/cards/{cardId}");
        Assert.Equal(HttpStatusCode.NotFound, afterDelete.StatusCode);
        Assert.Equal(ErrorCodes.CardNotFound, await ErrorBody.CodeOfAsync(afterDelete));
    }

    [Fact]
    public async Task CardCreate_EmptyTitle_Returns400()
    {
        var (listId, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/lists/{listId}/cards", JsonContent.Create(new { title = "  " }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardMove_CrossListWithinBoard_Works()
    {
        var (listId, boardId) = await SetupAsync();
        var l2 = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "進行中" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var targetListId = l2.GetProperty("id").GetString()!;

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "移動卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;

        var moved = await (await _client.PutAsync($"/api/cards/{cardId}/position",
            JsonContent.Create(new { listId = targetListId, position = "h" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(targetListId, moved.GetProperty("listId").GetString());

        // 活動串記 move（以 DbContext 斷言，activity 端點為 Task 8）
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var types = db.ActivityItems.Where(a => a.CardId == Guid.Parse(cardId))
                .Select(a => a.Type).ToList();
            Assert.Contains("move", types);
        }
    }

    [Fact]
    public async Task CardMove_CrossBoard_Returns400()
    {
        var (listId, boardId) = await SetupAsync();
        // 第二個看板（同專案）
        var projectId = "";
        {
            var detail = await (await _client.GetAsync($"/api/boards/{boardId}")).Content.ReadFromJsonAsync<JsonElement>();
            projectId = detail.GetProperty("projectId").GetString()!;
        }
        var otherBoard = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "別板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherBoardId = otherBoard.GetProperty("id").GetString()!;
        var otherList = await (await _client.PostAsync($"/api/boards/{otherBoardId}/lists", JsonContent.Create(new { name = "別列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "跨板卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PutAsync($"/api/cards/{card.GetProperty("id").GetString()}/position",
            JsonContent.Create(new { listId = otherList.GetProperty("id").GetString(), position = "h" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }
}
