using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Api.Dtos;

namespace Entask.Tests;

public class SearchTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public SearchTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // `extraCardTitle`（2026-09-24 新增）：多建一張標題含**字面**萬用字元的卡片，供逃逸那一支
    // 當**正向對照**用。少了它，「逃逸」可以退化成「把 `%` 濾掉」而測試照樣綠。
    // 預設 null ⇒ 既有五支的呼叫端一字未改。刻意放在最後建：`cards[0]` 的取用不受影響。
    private async Task<(string TeamId, string ProjectId, string CardId)> SetupAsync(
        string token, string? extraCardTitle = null)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "Search Team" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        
        var createProj = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        createProj.Headers.Add("X-Team-Id", teamId);
        createProj.Content = JsonContent.Create(new { name = "Search Project" });
        var project = await (await _client.SendAsync(createProj)).Content.ReadFromJsonAsync<JsonElement>();
        var projectId = project.GetProperty("id").GetString()!;

        var b1 = await (await _client.PostAsync($"/api/projects/{projectId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var b1Id = b1.GetProperty("id").GetString()!;
        var l1 = await (await _client.PostAsync($"/api/boards/{b1Id}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var l1Id = l1.GetProperty("id").GetString()!;

        await _client.PostAsync($"/api/lists/{l1Id}/cards", JsonContent.Create(new { title = "搜尋測試卡片", description = "這是詳細描述" }));
        var listsB1 = await (await _client.GetAsync($"/api/boards/{b1Id}")).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = listsB1.GetProperty("lists")[0].GetProperty("cards")[0].GetProperty("id").GetString()!;

        await _client.PostAsync($"/api/cards/{cardId}/comments", JsonContent.Create(new { text = "這是一條測試留言" }));

        await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes", JsonContent.Create(new { title = "搜尋測試節點" }));

        if (extraCardTitle is not null)
            await _client.PostAsync($"/api/lists/{l1Id}/cards", JsonContent.Create(new { title = extraCardTitle }));

        return (teamId, projectId, cardId);
    }

    [Fact]
    public async Task FindsCards_ByTitleIlike()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token);
        
        var res = await _client.GetFromJsonAsync<SearchResponse>($"/api/projects/{projectId}/search?q=搜尋測試");
        Assert.NotNull(res);
        Assert.Single(res.Cards);
        Assert.Contains("搜尋測試卡片", res.Cards[0].Title);
    }

    [Fact]
    public async Task FindsComments_ByContentIlike()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token);
        
        var res = await _client.GetFromJsonAsync<SearchResponse>($"/api/projects/{projectId}/search?q=測試留言");
        Assert.NotNull(res);
        Assert.Single(res.Comments);
        Assert.Contains("測試留言", res.Comments[0].Content);
    }

    [Fact]
    public async Task FindsNodes_ByTitleIlike()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token);
        
        var res = await _client.GetFromJsonAsync<SearchResponse>($"/api/projects/{projectId}/search?q=搜尋測試節點");
        Assert.NotNull(res);
        Assert.Single(res.Nodes);
        Assert.Contains("搜尋測試節點", res.Nodes[0].Title);
    }

    [Fact]
    public async Task Returns400_WhenQueryTooShort()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token);
        
        var res = await _client.GetAsync($"/api/projects/{projectId}/search?q=a");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task RespectsTypes_WhenOnlyCardsRequested()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token);
        
        var res = await _client.GetFromJsonAsync<SearchResponse>($"/api/projects/{projectId}/search?q=搜尋測試&types=cards");
        Assert.NotNull(res);
        Assert.NotEmpty(res.Cards);
        Assert.Empty(res.Comments);
        Assert.Empty(res.Nodes);
    }

    // ── 以下兩支：列舉面防禦（2026-09-24）──────────────────────────────────────

    // LIKE 萬用字元逃逸。這一支是**本站的**守門員——與 `UserSearchTests` 的 B-5／B-5b 同型
    // 但**不同站**：兩站自 2026-09-24 起共用 `LikePattern`，可是**守門員必須各自在**，
    // 因為漏掉逃逸的那一站，它自己的既有測試仍然是綠的（本站就是那個實例：修之前五支全綠）。
    //
    // 三格分工（**前兩格是反向、第三格是正向**，缺一不可）：
    //   ① `q=%%`——不逃逸時 pattern 是 `%%%%`，比對到**整個專案** ⇒ 卡片、留言、節點三種結果
    //      **都會**非空。逃逸後 pattern 是「含有字面 `%%`」，而沒有任何標題含連續兩個 `%`
    //      ⇒ 三種結果全空。★ 這一格**不能**期望「命中標題含 `%` 的那張卡」：`%%` 逃逸後要求的是
    //      **兩個連續**的百分號，那張卡只有一個（2026-09-24 實測：`q=百分比` 命中 1 張、
    //      `q=卡片` 命中 2 張，而同一次 `q=%%` 是 0 張——所以 0 張是逃逸**正確**的表現）。
    //   ② `q=__`——**第二個**萬用字元；只補了 `%` 的實作會在這一格紅。
    //   ③ `q=比%卡`——**正向對照**，也同時是「逃逸」與「把 `%` 濾掉」的分野：逃逸後 pattern 是
    //      「含有字面 `比%卡`」⇒ 命中那張；濾掉 `%` 之後是「含有 `比卡`」，而「百分比%卡片」
    //      不含 `比卡` ⇒ 0 筆。少了這一格，「逃逸」可以退化成「把 `%` 濾掉」而①②照樣綠。
    //      （SetupAsync 的 `extraCardTitle` 就是為它而加的。）
    [Fact]
    public async Task EscapesLikeWildcards_WhenQueryIsAllWildcards()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token, extraCardTitle: "百分比%卡片");

        // ③ 正向對照：逃逸之後**仍然**命中含字面 `%` 的那一張。
        var literal = await _client.GetFromJsonAsync<SearchResponse>(
            $"/api/projects/{projectId}/search?q={Uri.EscapeDataString("比%卡")}");
        Assert.NotNull(literal);
        Assert.Single(literal.Cards);
        Assert.Equal("百分比%卡片", literal.Cards[0].Title);

        // ① 全 `%`：逃逸後是「含有字面 `%%`」⇒ 三種結果全空。
        var percents = await _client.GetFromJsonAsync<SearchResponse>(
            $"/api/projects/{projectId}/search?q={Uri.EscapeDataString("%%")}");
        Assert.NotNull(percents);
        Assert.Empty(percents.Cards);
        Assert.Empty(percents.Comments);
        Assert.Empty(percents.Nodes);

        // ② 全 `_`：同型。
        var underscores = await _client.GetFromJsonAsync<SearchResponse>(
            $"/api/projects/{projectId}/search?q=__");
        Assert.NotNull(underscores);
        Assert.Empty(underscores.Cards);
        Assert.Empty(underscores.Comments);
        Assert.Empty(underscores.Nodes);
    }

    // 閘門的另一半：**內容**。`q` 的值不短、只是不合法——兩個 NUL 的 `Length` 是 2
    // （過得了長度檢查），而 PostgreSQL 的 `text` 不能含 `0x00`。
    // 兄弟站（`UserSearchTests` 的 ①b）那時是**實測** 500；本站當時只是**推論**
    // ——這一支就是把那個推論變成實測：契約是 **400**，呼叫端不該能拿輸入隨意製造 500。
    [Fact]
    public async Task Returns400_WhenQueryHasControlCharacters()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId, _) = await SetupAsync(token);

        var res = await _client.GetAsync(
            $"/api/projects/{projectId}/search?q={Uri.EscapeDataString("\0\0")}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("request.invalid", body.GetProperty("code").GetString());
    }
}
