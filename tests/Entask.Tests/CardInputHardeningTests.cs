using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Entask.Tests;

public class CardInputHardeningTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CardInputHardeningTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<string> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "卡硬化團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "卡硬化專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "卡硬化板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "硬化卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return card.GetProperty("id").GetString()!;
    }

    private static StringContent Json(string raw) => new(raw, Encoding.UTF8, "application/json");

    [Fact]
    public async Task CardPut_TitleAsNumber_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}", Json("""{"title":123}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardPut_DescriptionAsNumber_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}", Json("""{"description":123}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardPut_DueAtInvalid_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}", Json("""{"dueAt":"not-a-date"}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardPut_EstimatedHoursAsString_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}", Json("""{"estimatedHours":"abc"}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardPut_CoverMalformedGuid_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}", Json("""{"coverAttachmentId":"xyz"}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardMembersPut_NullUserIds_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/members", Json("""{"userIds":null}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardLabelsPut_NullLabelIds_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/labels", Json("""{"labelIds":null}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardReviewsPut_NullReviewerUserIds_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/reviews", Json("""{"reviewerUserIds":null}"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CardCustomFieldsPut_NullBody_Returns400()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/custom-fields", Json("null"));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CommentPost_Returns200_WithoutLocation()
    {
        var cardId = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/comments", JsonContent.Create(new { text = "你好" }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Null(resp.Headers.Location);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("你好", body.GetProperty("text").GetString());
    }
}
