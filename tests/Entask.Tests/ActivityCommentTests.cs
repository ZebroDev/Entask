using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Board.Positioning;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ActivityCommentTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ActivityCommentTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string CardId, string ListId, string BoardId)> SetupCardWithBoardAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "活動測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "活動測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "活動板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "活動卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (card.GetProperty("id").GetString()!, listId, boardId);
    }

    private async Task<string> SetupCardAsync() => (await SetupCardWithBoardAsync()).CardId;

    [Fact]
    public async Task Comments_PostListEditOwnOnly_Works()
    {
        var cardId = await SetupCardAsync();

        // 建立卡片時已記 create 活動
        var activity = await (await _client.GetAsync($"/api/cards/{cardId}/activity")).Content.ReadFromJsonAsync<JsonElement>();
        var types = activity.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("type").GetString()).ToList();
        Assert.Contains("create", types);

        // 留言
        var comment = await (await _client.PostAsync($"/api/cards/{cardId}/comments",
            JsonContent.Create(new { text = "第一則留言" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("comment", comment.GetProperty("type").GetString());
        var commentId = comment.GetProperty("id").GetString()!;

        // 列出含留言（倒序，留言應在前）
        var after = await (await _client.GetAsync($"/api/cards/{cardId}/activity")).Content.ReadFromJsonAsync<JsonElement>();
        var arr = after.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal("comment", arr[0].GetProperty("type").GetString());

        // 修改自己的留言
        var edited = await (await _client.PutAsync($"/api/cards/{cardId}/comments/{commentId}",
            JsonContent.Create(new { text = "改過的留言" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("改過的留言", edited.GetProperty("text").GetString());

        // 刪除
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/cards/{cardId}/comments/{commentId}")).StatusCode);
    }

    [Fact]
    public async Task Comment_OthersComment_EditReturns403()
    {
        var cardId = await SetupCardAsync();
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "henry", password = "Password1!", displayName = "亨利" }));

        // henry 留言（需先賦予 card.read——指派為專案成員，簡化：以 admin 建立兩則情境改測型態）
        // 直接以 DbContext 製造 henry 的留言
        Guid henryId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            henryId = db.Users.First(u => u.UserName == "henry").Id;
            var item = new Core.Entities.ActivityItem { CardId = Guid.Parse(cardId), UserId = henryId, Type = "comment", Text = "亨利留言", CreatedAt = DateTime.UtcNow };
            db.ActivityItems.Add(item);
            await db.SaveChangesAsync();
        }

        // admin（非留言者）修改 → 403，body 帶 code（PUT 站點）
        var resp = await _client.PutAsync($"/api/cards/{cardId}/comments/{FindCommentId(cardId)}",
            JsonContent.Create(new { text = "hack" }));
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        Assert.Equal("comment.notOwner",
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // 刪除同一則（非留言者）→ 403，body 帶同一個 code（DELETE 站點）
        var commentId = FindCommentId(cardId);
        var del = await _client.DeleteAsync($"/api/cards/{cardId}/comments/{commentId}");
        Assert.Equal(HttpStatusCode.Forbidden, del.StatusCode);
        Assert.Equal("comment.notOwner",
            (await del.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    private string FindCommentId(string cardId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return db.ActivityItems.Where(a => a.CardId == Guid.Parse(cardId) && a.Type == "comment")
            .OrderByDescending(a => a.CreatedAt).First().Id.ToString();
    }

    [Fact]
    public async Task Comment_EmptyText_Returns400()
    {
        var cardId = await SetupCardAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/comments", JsonContent.Create(new { text = "  " }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // Ruling T5（Task 5 裁決）：move 活動 detail 內容斷言
    [Fact]
    public async Task Activity_MoveDetail_ContainsFromAndToListIds()
    {
        var (cardId, listId, boardId) = await SetupCardWithBoardAsync();
        var target = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "進行中" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var targetListId = target.GetProperty("id").GetString()!;

        // 目標列表尚無卡片：After(null) 與卡片建立時的位置演算法一致
        await _client.PutAsync($"/api/cards/{cardId}/position",
            JsonContent.Create(new { listId = targetListId, position = FractionalPosition.After(null) }));

        var activity = await GetActivityAsync(cardId);
        var move = OfType(activity, "move").Single();
        var detail = ParseDetail(move);
        Assert.Equal(listId, detail.GetProperty("fromListId").GetString());
        Assert.Equal(targetListId, detail.GetProperty("toListId").GetString());
    }

    // Ruling T6（Task 6 裁決）：due_change 活動內容＋僅變更才寫
    [Fact]
    public async Task Activity_DueChange_OnlyOnChange()
    {
        var (cardId, _, _) = await SetupCardWithBoardAsync();

        await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { dueAt = "2026-09-01T00:00:00Z" }));
        Assert.Single(OfType(await GetActivityAsync(cardId), "due_change"));

        // 相同值再送：不寫新活動
        await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { dueAt = "2026-09-01T00:00:00Z" }));
        Assert.Single(OfType(await GetActivityAsync(cardId), "due_change"));
    }

    // Ruling T6（Task 6 裁決）：member_added/member_removed 活動內容＋僅變更才寫
    [Fact]
    public async Task Activity_MemberChanges_ContentAndOnlyOnChange()
    {
        var (cardId, _, _) = await SetupCardWithBoardAsync();
        Guid adminId;
        using (var scope = _factory.Services.CreateScope())
            adminId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "admin-test").Id;

        await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = new[] { adminId } }));

        var added = OfType(await GetActivityAsync(cardId), "member_added").ToList();
        Assert.Single(added);
        Assert.Equal(adminId.ToString(), ParseDetail(added[0]).GetProperty("userId").GetString());

        // 相同指派再送：不寫新活動
        await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = new[] { adminId } }));
        Assert.Single(OfType(await GetActivityAsync(cardId), "member_added"));

        // 移除：記 member_removed
        await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = Array.Empty<Guid>() }));
        var removed = OfType(await GetActivityAsync(cardId), "member_removed").ToList();
        Assert.Single(removed);
        Assert.Equal(adminId.ToString(), ParseDetail(removed[0]).GetProperty("userId").GetString());

        // 再送空陣列：不寫新活動
        await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = Array.Empty<Guid>() }));
        Assert.Single(OfType(await GetActivityAsync(cardId), "member_removed"));
    }

    // Ruling T6（Task 6 裁決）：label_added/label_removed 活動內容＋僅變更才寫
    [Fact]
    public async Task Activity_LabelChanges_ContentAndOnlyOnChange()
    {
        var (cardId, _, boardId) = await SetupCardWithBoardAsync();
        var label = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "活動標籤", color = "#ff8800" }))).Content.ReadFromJsonAsync<JsonElement>();
        var labelId = label.GetProperty("id").GetString()!;

        await _client.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = new[] { Guid.Parse(labelId) } }));

        var added = OfType(await GetActivityAsync(cardId), "label_added").ToList();
        Assert.Single(added);
        Assert.Equal(labelId, ParseDetail(added[0]).GetProperty("labelId").GetString());

        // 相同標籤再送：不寫新活動
        await _client.PutAsync($"/api/cards/{cardId}/labels",
            JsonContent.Create(new { labelIds = new[] { Guid.Parse(labelId) } }));
        Assert.Single(OfType(await GetActivityAsync(cardId), "label_added"));

        // 移除：記 label_removed
        await _client.PutAsync($"/api/cards/{cardId}/labels", JsonContent.Create(new { labelIds = Array.Empty<Guid>() }));
        var removed = OfType(await GetActivityAsync(cardId), "label_removed").ToList();
        Assert.Single(removed);
        Assert.Equal(labelId, ParseDetail(removed[0]).GetProperty("labelId").GetString());

        // 再送空陣列：不寫新活動
        await _client.PutAsync($"/api/cards/{cardId}/labels", JsonContent.Create(new { labelIds = Array.Empty<Guid>() }));
        Assert.Single(OfType(await GetActivityAsync(cardId), "label_removed"));
    }

    private async Task<JsonElement> GetActivityAsync(string cardId) =>
        await (await _client.GetAsync($"/api/cards/{cardId}/activity")).Content.ReadFromJsonAsync<JsonElement>();

    private static IEnumerable<JsonElement> OfType(JsonElement activity, string type) =>
        activity.GetProperty("items").EnumerateArray().Where(a => a.GetProperty("type").GetString() == type);

    private static JsonElement ParseDetail(JsonElement item)
    {
        using var doc = JsonDocument.Parse(item.GetProperty("detail").GetString()!);
        return doc.RootElement.Clone();
    }
}
