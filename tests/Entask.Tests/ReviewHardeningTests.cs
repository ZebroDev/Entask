using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ReviewHardeningTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ReviewHardeningTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // team → project → board → list → card；回傳 (cardAId, cardBId, adminId)
    private async Task<(string CardA, string CardB, string AdminId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "審查硬化團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "審查硬化專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "審查板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var cardA = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "審查卡A" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardB = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "審查卡B" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (cardA.GetProperty("id").GetString()!, cardB.GetProperty("id").GetString()!, "admin");
    }

    private async Task<string> CreateReviewAsync(string cardId, string reviewerUserId)
    {
        var resp = await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { reviewerUserId } }));
        var list = (await resp.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().ToList();
        return list.Single().GetProperty("id").GetString()!;
    }

    /// <summary>
    /// 把使用者加進卡片所屬的專案：審查者必須是該卡片所屬專案的成員（2026-09-19 不變量）。
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
    public async Task ReviewSubmit_OtherCardReview_Returns404()
    {
        var (cardA, cardB, _) = await SetupAsync();
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var adminId = db.Users.First(u => u.UserName == "admin-test").Id.ToString();
        var reviewId = await CreateReviewAsync(cardA, adminId);
        var resp = await _client.PutAsync($"/api/cards/{cardB}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = 5, comment = "ok" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.ReviewNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task ReviewSubmit_InvalidStatus_Returns400()
    {
        var (cardA, _, _) = await SetupAsync();
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var adminId = db.Users.First(u => u.UserName == "admin-test").Id.ToString();
        var reviewId = await CreateReviewAsync(cardA, adminId);
        var resp = await _client.PutAsync($"/api/cards/{cardA}/reviews/{reviewId}",
            JsonContent.Create(new { status = "bogus", score = (int?)null, comment = (string?)null }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ReviewersPut_NonexistentUser_Returns400()
    {
        var (cardA, _, _) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardA}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { Guid.NewGuid() } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task EffortPost_NegativeHours_Returns400()
    {
        var (cardA, _, _) = await SetupAsync();
        // 帶一個有效的時區：這一支要紅在「時數為負」，時區必須先過關。
        var resp = await _client.PostAsync($"/api/cards/{cardA}/effort",
            JsonContent.Create(new { hours = -1m, note = (string?)null, timeZoneId = "UTC" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ReviewersPut_FullReplace_RemovesUnlisted()
    {
        var (cardA, _, _) = await SetupAsync();
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var adminId = db.Users.First(u => u.UserName == "admin-test").Id;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "reviewer2", password = "Password1!", displayName = "審查者二" }));
        var reviewer2Id = db.Users.First(u => u.UserName == "reviewer2").Id;
        // reviewer2 必須先是專案成員，否則下面的指派會 400（2026-09-19 不變量）。
        await AddProjectMemberAsync(cardA, reviewer2Id);

        await _client.PutAsync($"/api/cards/{cardA}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { adminId, reviewer2Id } }));
        var replaced = await _client.PutAsync($"/api/cards/{cardA}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { adminId } }));
        var list = (await replaced.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().ToList();
        Assert.Single(list);
        Assert.Equal(adminId.ToString(), list[0].GetProperty("reviewerUserId").GetString());
    }

    [Fact]
    public async Task ReviewsGet_ReturnsAssigned()
    {
        var (cardA, _, _) = await SetupAsync();
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var adminId = db.Users.First(u => u.UserName == "admin-test").Id.ToString();
        await CreateReviewAsync(cardA, adminId);
        var resp = await _client.GetAsync($"/api/cards/{cardA}/reviews");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var list = (await resp.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().ToList();
        Assert.Single(list);
        Assert.Equal("pending", list[0].GetProperty("status").GetString());
    }
}
