using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Dtos;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

[Collection("ApiTests")]
public class CardCompletionTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CardCompletionTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string TeamId, string ProjectId, string BoardId, string ListId, string CardId)> SetupAsync(string token)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", tId);
        create.Content = JsonContent.Create(new { name = "P" });
        var project = await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>();
        var pId = project.GetProperty("id").GetString()!;

        var board = await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var bId = board.GetProperty("id").GetString()!;

        var list = await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var lId = list.GetProperty("id").GetString()!;

        await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "C" }));
        var boardsResp = await (await _client.GetAsync($"/api/boards/{bId}")).Content.ReadFromJsonAsync<JsonElement>();
        var cId = boardsResp.GetProperty("lists")[0].GetProperty("cards")[0].GetProperty("id").GetString()!;

        return (tId, pId, bId, lId, cId);
    }

    [Fact]
    public async Task CanMarkCardAsCompletedAndUncompleted()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, _, _, _, cardId) = await SetupAsync(token);

        // Mark completed
        var res1 = await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
        Assert.Equal(HttpStatusCode.OK, res1.StatusCode);
        var c1 = await res1.Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotNull(c1.GetProperty("completedAt").GetString());

        // Check activity（CardResponse 自 P22 `f49e3c0` 起已無 activity 成員，改由 /activity 端點取得）
        var activities = (await (await _client.GetAsync($"/api/cards/{cardId}/activity"))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().ToList();
        Assert.Contains(activities, a => a.GetProperty("type").GetString() == "complete");

        // Mark uncompleted
        var res2 = await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = false }));
        Assert.Equal(HttpStatusCode.OK, res2.StatusCode);
        var c2 = await res2.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, c2.GetProperty("completedAt").ValueKind);

        activities = (await (await _client.GetAsync($"/api/cards/{cardId}/activity"))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().ToList();
        Assert.Contains(activities, a => a.GetProperty("type").GetString() == "uncomplete");
    }
}



