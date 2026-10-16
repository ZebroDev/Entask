using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ChecklistApiTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ChecklistApiTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<string> SetupCardAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "清單測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "清單測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "清單板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var card = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "清單卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return card.GetProperty("id").GetString()!;
    }

    [Fact]
    public async Task Checklist_FullLifecycle_Works()
    {
        var cardId = await SetupCardAsync();

        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;

        var item1 = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "第一項" }))).Content.ReadFromJsonAsync<JsonElement>();
        var item2 = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "第二項" }))).Content.ReadFromJsonAsync<JsonElement>();

        var checkedItem = await (await _client.PutAsync(
            $"/api/cards/{cardId}/checklists/{checklistId}/items/{item1.GetProperty("id").GetString()}",
            JsonContent.Create(new { isChecked = true }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(checkedItem.GetProperty("isChecked").GetBoolean());

        // 卡片 GET 含檢查清單
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var cl = card.GetProperty("checklists").EnumerateArray().First();
        var items = cl.GetProperty("items");
        Assert.Equal(2, items.GetArrayLength());
        Assert.Equal(item1.GetProperty("id").GetString(), items[0].GetProperty("id").GetString());
        Assert.Equal(item2.GetProperty("id").GetString(), items[1].GetProperty("id").GetString());

        // 歸屬驗證：另一張卡的 cardId → 404
        var otherCard = await (await _client.PostAsync($"/api/lists/{card.GetProperty("listId").GetString()}/cards",
            JsonContent.Create(new { title = "別卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cross = await _client.PutAsync($"/api/cards/{otherCard.GetProperty("id").GetString()}/checklists/{checklistId}",
            JsonContent.Create(new { title = "hack" }));
        Assert.Equal(HttpStatusCode.NotFound, cross.StatusCode);

        // 刪除清單
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/cards/{cardId}/checklists/{checklistId}")).StatusCode);

        // 勾選活動已記
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var types = db.ActivityItems.Where(a => a.CardId == Guid.Parse(cardId)).Select(a => a.Type).ToList();
            Assert.Contains("item_checked", types);
            Assert.Contains("checklist_added", types);
            Assert.Contains("checklist_removed", types);
        }
    }

    [Fact]
    public async Task Checklist_EmptyTitle_Returns400()
    {
        var cardId = await SetupCardAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/checklists", JsonContent.Create(new { title = "" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ChecklistItemPut_UpdatesTextAndChecked_Works()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var item = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "買牛奶" }))).Content.ReadFromJsonAsync<JsonElement>();
        var itemId = item.GetProperty("id").GetString()!;
        var updated = await (await _client.PutAsync($"/api/cards/{cardId}/checklists/{checklistId}/items/{itemId}",
            JsonContent.Create(new { text = "買豆漿", isChecked = true }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("買豆漿", updated.GetProperty("text").GetString());
        Assert.True(updated.GetProperty("isChecked").GetBoolean());
    }

    [Fact]
    public async Task ChecklistItemPost_EmptyText_Returns400()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklist.GetProperty("id").GetString()}/items",
            JsonContent.Create(new { text = "  " }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ChecklistItemPut_CrossCard_Returns404()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var listId = card.GetProperty("listId").GetString()!;
        // 同列表建立第二張卡
        var cardB = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "別卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var item = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "項目" }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PutAsync($"/api/cards/{cardB.GetProperty("id").GetString()}/checklists/{checklistId}/items/{item.GetProperty("id").GetString()}",
            JsonContent.Create(new { text = "偷改" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task ChecklistPut_InvalidPosition_Returns400()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var resp = await _client.PutAsync($"/api/cards/{cardId}/checklists/{checklistId}",
            JsonContent.Create(new { position = "not-valid!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardPositionInvalid,
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ChecklistPut_InvalidPosition_NonexistentChecklist_Returns400()
    {
        var cardId = await SetupCardAsync();
        // 與 item/list/card PUT 一致：position 驗證先於存在性查詢
        var resp = await _client.PutAsync($"/api/cards/{cardId}/checklists/{Guid.NewGuid()}",
            JsonContent.Create(new { position = "not-valid!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task ChecklistItemPut_InvalidPosition_Returns400()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var item = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "項目" }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/checklists/{checklistId}/items/{item.GetProperty("id").GetString()}",
            JsonContent.Create(new { position = "!!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardPositionInvalid,
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ChecklistPut_ValidPosition_Returns200()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var resp = await _client.PutAsync($"/api/cards/{cardId}/checklists/{checklistId}",
            JsonContent.Create(new { position = "Z" }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Z", body.GetProperty("position").GetString());
    }

    [Fact]
    public async Task ChecklistItemDelete_RemovesItem_Works()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var item = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "買牛奶" }))).Content.ReadFromJsonAsync<JsonElement>();
        var itemId = item.GetProperty("id").GetString()!;

        var resp = await _client.DeleteAsync($"/api/cards/{cardId}/checklists/{checklistId}/items/{itemId}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var items = card.GetProperty("checklists")[0].GetProperty("items");
        Assert.Equal(0, items.GetArrayLength());
    }

    [Fact]
    public async Task ChecklistItemDelete_NonexistentItem_Returns404()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;

        var resp = await _client.DeleteAsync($"/api/cards/{cardId}/checklists/{checklistId}/items/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.ChecklistItemNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task ChecklistItemDelete_CrossCard_Returns404()
    {
        var cardId = await SetupCardAsync();
        var checklist = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "驗收清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistId = checklist.GetProperty("id").GetString()!;
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var listId = card.GetProperty("listId").GetString()!;
        var cardB = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "別卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var item = await (await _client.PostAsync($"/api/cards/{cardId}/checklists/{checklistId}/items",
            JsonContent.Create(new { text = "項目" }))).Content.ReadFromJsonAsync<JsonElement>();
        var itemId = item.GetProperty("id").GetString()!;

        var resp = await _client.DeleteAsync(
            $"/api/cards/{cardB.GetProperty("id").GetString()}/checklists/{checklistId}/items/{itemId}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);

        // 原始 item 未被誤刪
        var cardAfter = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, cardAfter.GetProperty("checklists")[0].GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task ChecklistItemDelete_ItemFromOtherChecklistOfSameCard_Returns404()
    {
        var cardId = await SetupCardAsync();
        var checklistA = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "清單甲" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checklistB = await (await _client.PostAsync($"/api/cards/{cardId}/checklists",
            JsonContent.Create(new { title = "清單乙" }))).Content.ReadFromJsonAsync<JsonElement>();
        var itemB = await (await _client.PostAsync(
            $"/api/cards/{cardId}/checklists/{checklistB.GetProperty("id").GetString()}/items",
            JsonContent.Create(new { text = "乙的項目" }))).Content.ReadFromJsonAsync<JsonElement>();
        var itemBId = itemB.GetProperty("id").GetString()!;

        // 同卡但不同清單 → 仍須 404，且不得誤刪
        var resp = await _client.DeleteAsync(
            $"/api/cards/{cardId}/checklists/{checklistA.GetProperty("id").GetString()}/items/{itemBId}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var checklists = card.GetProperty("checklists");
        var listB = checklists.EnumerateArray().First(c => c.GetProperty("id").GetString() == checklistB.GetProperty("id").GetString());
        Assert.Equal(1, listB.GetProperty("items").GetArrayLength());
    }

    // 查不到的是 checklist 本身時回 checklist.notFound，不是 checklistItem.notFound
    //（反向對照＝上面兩支 item 的 404，它們查不到的確實是 item，必須維持 checklistItem.notFound）
    [Fact]
    public async Task ChecklistPut_NonexistentChecklist_ReturnsChecklistNotFound()
    {
        var cardId = await SetupCardAsync();
        var resp = await _client.PutAsync($"/api/cards/{cardId}/checklists/{Guid.NewGuid()}",
            JsonContent.Create(new { title = "改名" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.ChecklistNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task ChecklistDelete_NonexistentChecklist_ReturnsChecklistNotFound()
    {
        var cardId = await SetupCardAsync();
        var resp = await _client.DeleteAsync($"/api/cards/{cardId}/checklists/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.ChecklistNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task ChecklistItemPost_NonexistentChecklist_ReturnsChecklistNotFound()
    {
        var cardId = await SetupCardAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/checklists/{Guid.NewGuid()}/items",
            JsonContent.Create(new { text = "項目" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.ChecklistNotFound, await ErrorBody.CodeOfAsync(resp));
    }
}
