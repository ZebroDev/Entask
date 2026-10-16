using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class PositionValidationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public PositionValidationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ProjectId, string BoardId, string ListId, string CardId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "位置團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "位置專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "位置板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "位置卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (projectId, boardId, listId, card.GetProperty("id").GetString()!);
    }

    [Fact]
    public async Task CardMove_InvalidAlphabet_Returns400()
    {
        var (_, _, listId, cardId) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/position",
            JsonContent.Create(new { listId, position = "z!!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardMove_OverlongPosition_Returns400()
    {
        var (_, _, listId, cardId) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/position",
            JsonContent.Create(new { listId, position = new string('h', 101) }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ListPut_InvalidAlphabet_Returns400()
    {
        var (_, _, listId, _) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/lists/{listId}", JsonContent.Create(new { position = "??" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardMove_ValidPositions_ReturnOk()
    {
        var (_, _, listId, cardId) = await SetupAsync();
        foreach (var position in new[] { "h", "aU", "0", "Z" })
        {
            var resp = await _client.PutAsync($"/api/cards/{cardId}/position",
                JsonContent.Create(new { listId, position }));
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        }
    }

    [Fact]
    public async Task BoardPut_InvalidPosition_Returns400()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/boards/{boardId}", JsonContent.Create(new { position = "??" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardPositionInvalid,
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task LabelPut_InvalidPosition_Returns400()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var label = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "位置標籤", color = "#ff8800" }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PutAsync($"/api/boards/{boardId}/labels/{label.GetProperty("id").GetString()}",
            JsonContent.Create(new { position = "?" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardPositionInvalid,
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task CustomFieldProjectPut_InvalidPosition_Returns400()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var priorityId = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級")
            .GetProperty("id").GetString()!;
        var resp = await _client.PutAsync($"/api/projects/{projectId}/custom-fields/{priorityId}",
            JsonContent.Create(new { position = "!!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardPositionInvalid,
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task CustomFieldBoardPut_InvalidPosition_Returns400()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var field = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "估時", type = "number" }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PutAsync($"/api/boards/{boardId}/custom-fields/{field.GetProperty("id").GetString()}",
            JsonContent.Create(new { position = "!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardPositionInvalid,
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }
}
