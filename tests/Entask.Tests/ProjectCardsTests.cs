using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ProjectCardsTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ProjectCardsTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string TeamId, string ProjectId)> SetupProjectAsync(string token)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "Card Test Team" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "Card Test Project" });
        var project = await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>();
        return (teamId, project.GetProperty("id").GetString()!);
    }

    private async Task<(string projectId, string b1Id, string b2Id)> SetupFullAsync(string token)
    {
        var (_, projectId) = await SetupProjectAsync(token);
        
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        
        // board 1
        var b1 = await (await _client.PostAsync($"/api/projects/{projectId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var b1Id = b1.GetProperty("id").GetString()!;
        var l1 = await (await _client.PostAsync($"/api/boards/{b1Id}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var l1Id = l1.GetProperty("id").GetString()!;
        var l2 = await (await _client.PostAsync($"/api/boards/{b1Id}/lists", JsonContent.Create(new { name = "L2" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var l2Id = l2.GetProperty("id").GetString()!;

        // Card A
        await _client.PostAsync($"/api/lists/{l1Id}/cards", JsonContent.Create(new { title = "Card A" }));
        var listsB1 = await (await _client.GetAsync($"/api/boards/{b1Id}")).Content.ReadFromJsonAsync<JsonElement>();
        var cardAId = listsB1.GetProperty("lists")[0].GetProperty("cards")[0].GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardAId}", JsonContent.Create(new { dueAt = DateTime.UtcNow.AddDays(5) }));

        // Card B
        await _client.PostAsync($"/api/lists/{l2Id}/cards", JsonContent.Create(new { title = "Card B" }));
        listsB1 = await (await _client.GetAsync($"/api/boards/{b1Id}")).Content.ReadFromJsonAsync<JsonElement>();
        var cardBId = listsB1.GetProperty("lists")[1].GetProperty("cards")[0].GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardBId}", JsonContent.Create(new { dueAt = DateTime.UtcNow.AddDays(-1) }));

        // board 2
        var b2 = await (await _client.PostAsync($"/api/projects/{projectId}/boards", JsonContent.Create(new { name = "B2" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var b2Id = b2.GetProperty("id").GetString()!;
        var l3 = await (await _client.PostAsync($"/api/boards/{b2Id}/lists", JsonContent.Create(new { name = "L3" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var l3Id = l3.GetProperty("id").GetString()!;
        
        await _client.PostAsync($"/api/lists/{l3Id}/cards", JsonContent.Create(new { title = "Card C" }));
        var listsB2 = await (await _client.GetAsync($"/api/boards/{b2Id}")).Content.ReadFromJsonAsync<JsonElement>();
        var cardCId = listsB2.GetProperty("lists")[0].GetProperty("cards")[0].GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardCId}", JsonContent.Create(new { isArchived = true }));

        return (projectId, b1Id, b2Id);
    }

    [Fact]
    public async Task ReturnsCards_ForAllBoardsInProject()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);
        
        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>($"/api/projects/{projectId}/cards");
        Assert.NotNull(res);
        Assert.Equal(2, res.Total);
        Assert.Equal(2, res.Items.Count);
    }

    [Fact]
    public async Task FiltersByDueFromTo()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);
        
        var from = DateTime.UtcNow.AddDays(-2).ToString("yyyy-MM-dd");
        var to = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd");
        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>(
            $"/api/projects/{projectId}/cards?dueFrom={from}&dueTo={to}");
        Assert.NotNull(res);
        Assert.Equal(1, res.Total);
        Assert.Contains(res.Items, c => c.Title == "Card B");
    }

    [Fact]
    public async Task FiltersByBoardId()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, b1Id, _) = await SetupFullAsync(token);
        
        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>($"/api/projects/{projectId}/cards?boardId={b1Id}");
        Assert.NotNull(res);
        Assert.Equal(2, res.Total);
    }

    [Fact]
    public async Task ExcludesArchivedByDefault()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);
        
        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>($"/api/projects/{projectId}/cards");
        Assert.NotNull(res);
        Assert.DoesNotContain(res.Items, c => c.IsArchived);
    }

    [Fact]
    public async Task IncludesArchived_WhenFlagSet()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);
        
        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>($"/api/projects/{projectId}/cards?includeArchived=true");
        Assert.NotNull(res);
        Assert.Equal(3, res.Total);
        Assert.Contains(res.Items, c => c.IsArchived);
    }

    [Fact]
    public async Task Returns400_WhenPageSizeExceeds500()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _) = await SetupProjectAsync(token);
        
        var res = await _client.GetAsync($"/api/projects/{projectId}/cards?pageSize=501");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    /// <summary>
    /// `ProjectCardEndpoints` 的 rollup 接線（設計 §4.4）。
    ///
    /// 沒有這一條的話，把 `RollupForCardsAsync` 那兩行整段刪掉、**後端全量照樣全綠**
    /// ——多視圖三個 tab 的前端測試全部吃 mock 資料，偵測不到酬載少了這一欄
    /// （`ReviewLifecycleTests.ReviewState_Rollup_OnBoard` 的註解記錄過同一個坑）。
    /// </summary>
    [Fact]
    public async Task ReviewState_Rollup_OnProjectCards()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, b1Id, _) = await SetupFullAsync(token);

        // 取 Card A 的 id（SetupFullAsync 把它放在 B1 的第一個清單）
        var board = await (await _client.GetAsync($"/api/boards/{b1Id}")).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = board.GetProperty("lists")[0].GetProperty("cards")[0].GetProperty("id").GetString()!;

        // seed admin 當審查者，然後提交「退回」
        Guid adminId;
        using (var scope = _factory.Services.CreateScope())
            adminId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Users.First(u => u.UserName == _factory.SeedCredentials().Username).Id;

        await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { adminId } }));
        var reviews = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = reviews.EnumerateArray().First().GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "不行" }));

        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>($"/api/projects/{projectId}/cards?boardId={b1Id}");

        Assert.NotNull(res);
        // 有審查者的那張：rollup 是 rejected
        Assert.Equal(ReviewStatuses.Rejected, res.Items.Single(c => c.Id.ToString() == cardId).ReviewState);
        // 沒有審查者的那張：null（設計 §4.2 第一列）
        Assert.Null(res.Items.Single(c => c.Id.ToString() != cardId).ReviewState);
    }

    /// <summary>
    /// 「無到期日」篩選（`hasDue=false`）。
    ///
    /// 這一條要殺的是**具體的歷史缺陷**：前端原本抓未篩選的前 100 筆再用
    /// `.filter(c => !c.dueAt)` 過濾，而後端排序是 **null 排最後**（`OrderBy(c => c.DueAt == null)`）
    /// ⇒ 專案裡有 100 張以上已排到期日的卡片時，前 100 筆裡一張無到期日的都沒有，
    /// 日曆側欄標題寫著「無到期日」而內容空無一物——**四道閘門與所有測試都不會紅**。
    ///
    /// `SetupFullAsync` 的三張卡剛好是那個形狀的縮小版：Card A／B 有到期日、
    /// Card C 沒有（但已封存 ⇒ 要 `includeArchived=true` 才進得了範圍）。
    /// 少了 `Where` 那一行的話這裡回 3 而不是 1；述詞寫反的話回 2。
    /// </summary>
    [Fact]
    public async Task FiltersByHasDue_False()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);

        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>(
            $"/api/projects/{projectId}/cards?hasDue=false&includeArchived=true");

        Assert.NotNull(res);
        Assert.Equal(1, res.Total);
        Assert.Equal("Card C", res.Items.Single().Title);
    }

    /// <summary>
    /// 同一條述詞的另一半。**`includeArchived=true` 是判別力的來源**——不給它的話，
    /// 未篩選的查詢本來就剛好回 2（那兩張都有到期日），這一支會在實作之前就綠燈，
    /// 於是它證明的不是「篩選正確」而是「什麼都沒證明」。
    /// </summary>
    [Fact]
    public async Task FiltersByHasDue_True()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);

        var res = await _client.GetFromJsonAsync<ProjectCardsResponse>(
            $"/api/projects/{projectId}/cards?hasDue=true&includeArchived=true");

        Assert.NotNull(res);
        Assert.Equal(2, res.Total);
        Assert.All(res.Items, c => Assert.NotNull(c.DueAt));
    }

    /// <summary>
    /// 互斥的兩個輸入一起給時回 400，**不是**空集合：無到期日的卡片永遠不可能落在
    /// 日期區間內，兩者併用必然是空的——而空集合讓呼叫端分不出「真的沒有」與
    /// 「參數互相抵消」，那正是這一整批在消滅的那種靜默。
    ///
    /// 用 `request.invalid`（該方法既有的粗粒度碼，與 pageSize／page 的三道守衛同一個）
    /// ⇒ 不新增錯誤碼、不動語系檔。兩個 `dueFrom`／`dueTo` 各測一次：
    /// 守衛是一個 `||`，只測一邊的話把它改成 `&amp;&amp;` 不會紅。
    /// </summary>
    [Fact]
    public async Task Rejects400_WhenHasDueFalseIsCombinedWithDueRange()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (projectId, _, _) = await SetupFullAsync(token);

        foreach (var range in new[] { "dueFrom=2020-01-01", "dueTo=2030-01-01" })
        {
            var res = await _client.GetAsync($"/api/projects/{projectId}/cards?hasDue=false&{range}");

            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            var body = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(ErrorCodes.RequestInvalid, body.GetProperty("code").GetString());
        }
    }
}
