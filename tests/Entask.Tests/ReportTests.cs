using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ReportTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ReportTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task LoginAsync(string username, string password)
    {
        var login = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    // 數學 fixture：
    // c1（est 10，指派 erin）：erin 3h + dave 2h = 5h；審查 erin approved 4 + dave pending；優先級 高
    // c2（est 5，指派 erin+dave）：dave 4h；審查 dave rejected（無評分——退回不可帶評分）
    // c3（封存，est 8）：admin 5h —— 全排除
    // 期望：memberHours erin 3 / dave 6；memberRemaining erin 15/9/6、dave 5/4/1；
    // reviewStats pending 1 approved 1 rejected 1 avg 4（平均只計有評分的那一列）；cards 2 列
    private async Task<(string ProjectId, string Card1, Guid ErinId, Guid DaveId)> SetupAsync()
    {
        await LoginAsync("admin-test", "TestPass123!");
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = $"報表團隊{Guid.NewGuid():N}" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "報表專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "報表板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list1 = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var list2 = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "進行中" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var c1 = await (await _client.PostAsync($"/api/lists/{list1.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "卡一" }))).Content.ReadFromJsonAsync<JsonElement>();
        var c2 = await (await _client.PostAsync($"/api/lists/{list2.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "卡二" }))).Content.ReadFromJsonAsync<JsonElement>();
        var c3 = await (await _client.PostAsync($"/api/lists/{list1.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "封存卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var card1Id = c1.GetProperty("id").GetString()!;
        var card2Id = c2.GetProperty("id").GetString()!;
        var card3Id = c3.GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{card1Id}", JsonContent.Create(new { estimatedHours = 10 }));
        await _client.PutAsync($"/api/cards/{card2Id}", JsonContent.Create(new { estimatedHours = 5 }));
        await _client.PutAsync($"/api/cards/{card3Id}", JsonContent.Create(new { estimatedHours = 8, isArchived = true }));

        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "艾琳" }));
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "戴夫" }));
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "tina", password = "Password1!", displayName = "蒂娜" }));
        Guid erinId, daveId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            erinId = db.Users.First(u => u.UserName == "erin").Id;
            daveId = db.Users.First(u => u.UserName == "dave").Id;
        }
        // 工時需 CardEffortUpdate、審查需 CardReview → 工程師；tina 測試工程師（無 report.view）。
        // **erin 例外，用工程組長**：她那一列審查是**帶分數**的 approved，而 card.rate
        // （Task 9，設計 §13.5 D8）只給主管角色——留工程師的話那一筆會 400，
        // 下面的 averageScore 靜默變成 null。dave 維持工程師：他送的是 rejected、不帶分數。
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineer = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var tester = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "測試工程師").GetProperty("id").GetString()!;
        var lead = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "工程組長").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "erin", roleIds = new[] { lead } }));
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "dave", roleIds = new[] { engineer } }));
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "tina", roleIds = new[] { tester } }));

        // 卡片指派者與審查者必須是專案成員（2026-09-19 不變量）：erin／dave 都會出現在下面
        // /members 與 /reviews 的 payload 裡，少了這兩格那些 PUT 會 400。
        // （下面幾個 PUT 是裸呼叫，靜默失敗的後果是報表數字全錯、測試卻照綠。）
        foreach (var (uid, roleId) in new[] { (erinId, lead), (daveId, engineer) })
            Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
                JsonContent.Create(new { userId = uid, roleIds = new[] { roleId } }))).StatusCode);

        await _client.PutAsync($"/api/cards/{card1Id}/members", JsonContent.Create(new { userIds = new[] { erinId } }));
        await _client.PutAsync($"/api/cards/{card2Id}/members", JsonContent.Create(new { userIds = new[] { erinId, daveId } }));

        await LoginAsync("erin", "Password1!");
        await _client.PostAsync($"/api/cards/{card1Id}/effort", JsonContent.Create(new { hours = 3, timeZoneId = "UTC" }));
        await LoginAsync("dave", "Password1!");
        await _client.PostAsync($"/api/cards/{card1Id}/effort", JsonContent.Create(new { hours = 2, timeZoneId = "UTC" }));
        await _client.PostAsync($"/api/cards/{card2Id}/effort", JsonContent.Create(new { hours = 4, timeZoneId = "UTC" }));
        await LoginAsync("admin-test", "TestPass123!");
        await _client.PostAsync($"/api/cards/{card3Id}/effort", JsonContent.Create(new { hours = 5, timeZoneId = "UTC" }));

        await _client.PutAsync($"/api/cards/{card1Id}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { erinId, daveId } }));
        await _client.PutAsync($"/api/cards/{card2Id}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { daveId } }));
        var c1Reviews = await (await _client.GetAsync($"/api/cards/{card1Id}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var erinReviewId = c1Reviews.EnumerateArray()
            .First(r => r.GetProperty("reviewerUserId").GetString() == erinId.ToString()).GetProperty("id").GetString()!;
        await LoginAsync("erin", "Password1!");
        // 這一行的狀態碼必須斷言：它原本是裸呼叫，靜默 400 的後果是下面 averageScore
        // 從 4.0 變成 null——那不是「測試紅了」，是「測試對一個壞掉的系統說綠」
        // （Task 9 的 card.rate 閘門正好落在這條路徑上，2026-09-17）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{card1Id}/reviews/{erinReviewId}",
            JsonContent.Create(new { status = "approved", score = 4 }))).StatusCode);
        await LoginAsync("dave", "Password1!");
        var c2Reviews = await (await _client.GetAsync($"/api/cards/{card2Id}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var daveReviewId = c2Reviews.EnumerateArray().First().GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{card2Id}/reviews/{daveReviewId}",
            JsonContent.Create(new { status = "rejected", comment = "測試失敗，請修正" }));

        await LoginAsync("admin-test", "TestPass123!");
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var priorityId = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{card1Id}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [priorityId] = "高" }));
        return (projectId, card1Id, erinId, daveId);
    }

    /// <summary>
    /// 最小可用的專案（團隊 → 專案 → 看板 → 列表），供**只需要一個乾淨專案**的測試使用
    /// ——`SetupAsync` 另外造了使用者／角色／成員／審查／工時，那些對年份與窗框的斷言
    /// 是純噪音。
    ///
    /// 手法同 `TeamReportTests.SetupBareTeamAsync`（該檔是本 repo 這類 fixture 的先例）。
    /// 兩檔各自持有自己的版本是刻意的：前置條件不同，共用會逼其中一邊長出用不到的欄位。
    /// </summary>
    private async Task<(string TeamId, string ProjectId, string ListId)> SetupBareProjectAsync()
    {
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = $"年份團隊{Guid.NewGuid():N}" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "年份專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards", JsonContent.Create(new { name = "年份板" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "年份列表" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        return (teamId, projectId, listId);
    }

    private async Task<string> CreateCardAsync(string listId, string title) =>
        (await (await _client.PostAsync($"/api/lists/{listId}/cards", JsonContent.Create(new { title })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

    private async Task CompleteAsync(string cardId) =>
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/completion",
            JsonContent.Create(new { isCompleted = true }))).StatusCode);

    private async Task<JsonElement> GetReportAsync(string projectId, string query)
    {
        var res = await _client.GetAsync($"/api/projects/{projectId}/report{query}");
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>
    /// 把建卡日直接寫成 `utc`。**API 造不出過去的年份**（一律蓋 `DateTime.UtcNow`），
    /// 所以繞過端點直接進 `DbContext` 是唯一的路——手法同 `TeamReportTests` 的那兩支。
    /// </summary>
    private async Task ForceCardCreatedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.CreatedAt = utc;
        await db.SaveChangesAsync();
    }

    /// <summary>同 `ForceCardCreatedAtAsync`，改的是交付日。</summary>
    private async Task ForceCardCompletedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.CompletedAt = utc;
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Report_AggregatesFixtureNumbers()
    {
        var (projectId, _, erinId, daveId) = await SetupAsync();
        var report = await (await _client.GetAsync($"/api/projects/{projectId}/report"))
            .Content.ReadFromJsonAsync<JsonElement>();

        var hours = report.GetProperty("memberHours").EnumerateArray().ToList();
        Assert.Equal(2, hours.Count);   // admin 僅封存卡工時 → 不出現
        var erinRow = hours.Single(h => h.GetProperty("userId").GetString() == erinId.ToString());
        Assert.Equal(3m, erinRow.GetProperty("hours").GetDecimal());
        Assert.Equal(1, erinRow.GetProperty("cardCount").GetInt32());
        Assert.Equal("艾琳", erinRow.GetProperty("displayName").GetString());
        var daveRow = hours.Single(h => h.GetProperty("userId").GetString() == daveId.ToString());
        Assert.Equal(6m, daveRow.GetProperty("hours").GetDecimal());

        var remaining = report.GetProperty("memberRemaining").EnumerateArray().ToList();
        var erinRem = remaining.Single(r => r.GetProperty("userId").GetString() == erinId.ToString());
        Assert.Equal(15m, erinRem.GetProperty("estimatedHours").GetDecimal());
        Assert.Equal(9m, erinRem.GetProperty("loggedHours").GetDecimal());
        Assert.Equal(6m, erinRem.GetProperty("remainingHours").GetDecimal());
        var daveRem = remaining.Single(r => r.GetProperty("userId").GetString() == daveId.ToString());
        Assert.Equal(5m, daveRem.GetProperty("estimatedHours").GetDecimal());
        Assert.Equal(4m, daveRem.GetProperty("loggedHours").GetDecimal());
        Assert.Equal(1m, daveRem.GetProperty("remainingHours").GetDecimal());

        var stats = report.GetProperty("reviewStats");
        Assert.Equal(1, stats.GetProperty("pendingCount").GetInt32());
        Assert.Equal(1, stats.GetProperty("approvedCount").GetInt32());
        Assert.Equal(1, stats.GetProperty("rejectedCount").GetInt32());
        Assert.Equal(4.0, stats.GetProperty("averageScore").GetDouble());

        var cards = report.GetProperty("cards").EnumerateArray().ToList();
        Assert.Equal(2, cards.Count);   // 封存卡排除
        var card1 = cards.Single(c => c.GetProperty("title").GetString() == "卡一");
        Assert.Equal("報表板", card1.GetProperty("boardName").GetString());
        Assert.Equal("待辦", card1.GetProperty("listName").GetString());
        Assert.Equal(5m, card1.GetProperty("loggedHours").GetDecimal());
        Assert.Equal(5m, card1.GetProperty("remainingHours").GetDecimal());
        Assert.Equal("pending", card1.GetProperty("reviewStatus").GetString());
        Assert.Equal("高", card1.GetProperty("priority").GetString());
        Assert.Equal(erinId.ToString(), card1.GetProperty("assigneeUserIds")[0].GetString());
        var card2 = cards.Single(c => c.GetProperty("title").GetString() == "卡二");
        Assert.Equal("rejected", card2.GetProperty("reviewStatus").GetString());
        Assert.Equal(1m, card2.GetProperty("remainingHours").GetDecimal());
        Assert.Equal(JsonValueKind.Null, card2.GetProperty("priority").ValueKind);
    }

    [Fact]
    public async Task Report_TimeWindow_FiltersEffortOnly()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var from = Uri.EscapeDataString(DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-ddTHH:mm:ssZ"));
        var report = await (await _client.GetAsync($"/api/projects/{projectId}/report?from={from}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(report.GetProperty("memberHours").EnumerateArray());
        var cards = report.GetProperty("cards").EnumerateArray().ToList();
        Assert.Equal(2, cards.Count);   // 卡片列為現況
        Assert.All(cards, c => Assert.Equal(0m, c.GetProperty("loggedHours").GetDecimal()));
        Assert.Equal(1, report.GetProperty("reviewStats").GetProperty("approvedCount").GetInt32());   // 審查不受窗
    }

    [Fact]
    public async Task Report_ToBound_FiltersEffortOnly()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var to = Uri.EscapeDataString(DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-ddTHH:mm:ssZ"));
        var report = await (await _client.GetAsync($"/api/projects/{projectId}/report?to={to}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(report.GetProperty("memberHours").EnumerateArray());
        var cards = report.GetProperty("cards").EnumerateArray().ToList();
        Assert.Equal(2, cards.Count);   // 卡片列為現況
        Assert.All(cards, c => Assert.Equal(0m, c.GetProperty("loggedHours").GetDecimal()));
        Assert.Equal(1, report.GetProperty("reviewStats").GetProperty("approvedCount").GetInt32());   // 審查不受窗
    }

    /// <summary>
    /// naive 窗框字串（**無時區標記**，裁定範例的形狀）不得 500——**本批的紅燈**。
    ///
    /// 修正前，專案報表的三對工時窗吃原始 `from`／`to`（不經 `ReportWindow`），而 naive 字串
    /// 繫結出 `Kind=Unspecified`；`EffortLog.LoggedAt` 是 `timestamp with time zone`
    /// （`20260814214206_AddBoardCore.cs:349`）⇒ Npgsql 擋下、整個請求 500。
    /// 團隊報表的三對已於 `6d0db37` 修好，**這一邊不在那一批的範圍**。
    ///
    /// **兩列各釘一半**：涵蓋那一列證明窗框有套用、資料進得來；窗外那一列證明它**真的在過濾**。
    /// 少了後者，一個把窗框整個忽略的實作照樣綠。
    /// </summary>
    [Theory]
    [InlineData(-1, 1, false)]
    [InlineData(1, 2, true)]
    public async Task Report_AcceptsNaiveWindowStrings(int fromOffsetDays, int toOffsetDays, bool expectEmpty)
    {
        var (projectId, _, erinId, _) = await SetupAsync();
        // 刻意**不帶 `Z`**——帶了就測不到這一條（既有兩支窗框測試都帶 `Z`）。
        var from = Uri.EscapeDataString(DateTime.UtcNow.AddDays(fromOffsetDays).ToString("yyyy-MM-ddTHH:mm:ss"));
        var to = Uri.EscapeDataString(DateTime.UtcNow.AddDays(toOffsetDays).ToString("yyyy-MM-ddTHH:mm:ss"));

        var resp = await _client.GetAsync($"/api/projects/{projectId}/report?from={from}&to={to}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var report = await resp.Content.ReadFromJsonAsync<JsonElement>();

        var cards = report.GetProperty("cards").EnumerateArray().ToList();
        Assert.Equal(2, cards.Count);   // 卡片列為現況，不受窗
        var hours = report.GetProperty("memberHours").EnumerateArray().ToList();
        if (expectEmpty)
        {
            Assert.Empty(hours);
            Assert.All(cards, c => Assert.Equal(0m, c.GetProperty("loggedHours").GetDecimal()));
        }
        else
        {
            Assert.Equal(3m, hours.Single(h => h.GetProperty("userId").GetString() == erinId.ToString())
                .GetProperty("hours").GetDecimal());
            Assert.Equal(5m, cards.Single(c => c.GetProperty("title").GetString() == "卡一")
                .GetProperty("loggedHours").GetDecimal());
            Assert.Equal(4m, cards.Single(c => c.GetProperty("title").GetString() == "卡二")
                .GetProperty("loggedHours").GetDecimal());
        }
    }

    /// <summary>
    /// naive 窗框字串在**匯出路徑**上同樣不得 500。這一條釘的是 `GetCardRowsAsync`——它是三對
    /// 工時窗裡**唯一同時在兩條路由上**的一對（`ReportEndpoints.cs:25`／`:55`）⇒ 兩條路徑
    /// 各自紅過、各自綠，JSON 那一條綠了不代表這一條會綠。
    /// </summary>
    [Fact]
    public async Task ReportExport_AcceptsNaiveWindowStrings()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var from = Uri.EscapeDataString(DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-ddTHH:mm:ss"));
        var to = Uri.EscapeDataString(DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-ddTHH:mm:ss"));

        var resp = await _client.GetAsync($"/api/projects/{projectId}/report/export?from={from}&to={to}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Contains("卡一", await resp.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 匯出路徑的顛倒窗框回 400——**本批的紅燈**（今天回 200 ＋ 只有 BOM 的 CSV）。
    ///
    /// 這是 `docs/STATE.md` 那條「專案報表匯出路徑沒有 `from >= to` 的 400（與 JSON 路由
    /// 不對稱）」的結案測試，**刻意的 wire 行為變更**（空 CSV → 400）。兩條路由同在
    /// `ReportEndpoints.cs`，所以守門員放在這裡、緊鄰 JSON 路由那一支（下一支）。
    ///
    /// **它比下一支多斷言一個 `code`**：那一支只看狀態碼，而 `code` 才是機器契約
    /// （`ErrorCodes.cs` 的檔頭：`code` 是契約、`message` 是除錯與後備）。少了這一行，
    /// 一個回 400 卻帶著別種 code 的實作照樣綠。
    /// </summary>
    [Fact]
    public async Task ReportExport_FromNotBeforeTo_Returns400()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var from = Uri.EscapeDataString(DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-ddTHH:mm:ssZ"));
        var to = Uri.EscapeDataString(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"));

        var resp = await _client.GetAsync($"/api/projects/{projectId}/report/export?from={from}&to={to}");

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task Report_FromNotBeforeTo_Returns400()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var from = Uri.EscapeDataString(DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-ddTHH:mm:ssZ"));
        var to = Uri.EscapeDataString(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"));
        var resp = await _client.GetAsync($"/api/projects/{projectId}/report?from={from}&to={to}");
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    /// <summary>
    /// 專案兩條路由的區間上限（外部報告 C 類第 4 條）：**恰 366 天放行、367 天 400**
    /// （判準是 `>` 不是 `>=`，同 `WorkLogEndpoints` 的既有形狀）。修前：516 天照樣回 200。
    /// </summary>
    [Theory]
    [InlineData("report")]
    [InlineData("report/export")]
    public async Task ProjectReport_RangeOver366Days_Returns400(string route)
    {
        var (projectId, _, _, _) = await SetupAsync();
        var resp = await _client.GetAsync(
            $"/api/projects/{projectId}/{route}?from=2030-01-01T00:00:00Z&to=2031-06-01T00:00:00Z");

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.QueryRangeTooLong, await ErrorBody.CodeOfAsync(resp));
    }

    /// <summary>
    /// 區間上限的**下界**（與上一支成對）：恰 366 天必須放行——只驗 over 的話，
    /// 判準被寫成 `>=` 的實作照樣綠（邊界 off-by-one 要兩側各一格才分得開）。
    /// 2030 非閏年：2030-01-01 → 2031-01-02 恰 366 天。
    /// </summary>
    [Theory]
    [InlineData("report")]
    [InlineData("report/export")]
    public async Task ProjectReport_RangeAt366Days_Returns200(string route)
    {
        var (projectId, _, _, _) = await SetupAsync();
        var resp = await _client.GetAsync(
            $"/api/projects/{projectId}/{route}?from=2030-01-01T00:00:00Z&to=2031-01-02T00:00:00Z");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    /// <summary>
    /// **匯出 CSV 的 `RemainingHours` 與畫面同源**（全期存量），而同一列的 `LoggedHours` 吃窗框。
    ///
    /// 兩條路由**各自呼叫一次** `GetCardRowsAsync`（`ReportEndpoints.cs` 的 JSON 路由與 export 路由）
    /// ⇒ JSON 那條綠了不代表這條會綠，所以匯出要有自己的守門員（同
    /// `ReportExport_AcceptsNaiveWindowStrings` 的理由）。上一支是 JSON 那一半。
    ///
    /// 這一條的語意變更是**刻意的**（使用者 2026-09-22 裁定「匯出同步收斂」）：**表頭不變**，
    /// 但 `RemainingHours` 的值從「預估 − 窗框內已記」變成「預估 − 全期已記」——匯出檔是餵給
    /// 下游工具的，所以這個變更會傳到 Excel／Pandas 那一側。
    ///
    /// 欄序（實查 `ReportEndpoints.cs` 的 `sb.AppendLine`）：0 CardId／1 Title／2 BoardName／
    /// 3 ListName／4 EstimatedHours／**5 LoggedHours**／**6 RemainingHours**／7 Priority。
    /// 只讀 5 與 6 ⇒ 尾端的 `\r` 與空白的 Priority 不影響。斷言用**字串精確比對**（沿用
    /// `ExportCultureTests.AssertCsvShape` 的慣例）——預設文化下 `5m` 寫出來就是 `5`。
    /// </summary>
    [Fact]
    public async Task ReportExport_CardRemainingIsAllTime()
    {
        var (projectId, _, _, _) = await SetupAsync();
        // 種子（實查 `SetupAsync`）：卡一 預估 10、erin 3 ＋ dave 2 ＝ 已記 5。

        static string[] RowOf(string csv) => csv.Split('\n').Select(l => l.TrimEnd('\r'))
            .Single(l => l.Contains("\"卡一\"")).Split(',');

        var all = RowOf(await _client.GetStringAsync($"/api/projects/{projectId}/report/export"));
        var windowed = RowOf(await _client.GetStringAsync(
            $"/api/projects/{projectId}/report/export?from=2030-01-01T00:00:00Z&to=2031-01-01T00:00:00Z"));

        // 對照組：窗框生效——「已報」欄清空。
        Assert.Equal("5", all[5]);
        Assert.Equal("0", windowed[5]);
        // 主斷言：剩餘欄是存量，不隨窗框改變。
        Assert.Equal("5", all[6]);
        Assert.Equal("5", windowed[6]);
    }

    /// <summary>
    /// `availableYears` ＝這份**專案**資料涵蓋的年份（建卡年 ∪ 交付年）、由大到小，
    /// 且**不含今年**——今年的缺席是契約（後端不得讀時鐘判年份，設計 D3）。
    ///
    /// 與團隊那一支（`TeamReportTests.AvailableYears_ComeFromDataOnly`）的差別在**對照專案**。
    /// 那一支靠「fixture 全部放在非今年」讓「不含今年」有判別力；本支另外在同一座 DB 造一個
    /// **含今年卡片**的專案，於是「今年」是真的存在於資料裡的年份——**少了這一半，一個
    /// 「掃全庫、不看 `projectId`」的實作與正確實作會給出同一份清單**（團隊那一支對這個形狀
    /// 是全盲的：它只有一個專案）。兩支共用同一個查詢，驗的是不同的接線。
    ///
    /// fixture 三種壞實作各有紅燈（精確相等 ＋ 缺席兩條一起）：
    /// 讀時鐘併入今年 ⇒ 清單多一個 2026；少了交付年那一半 ⇒ `[2023, 2019]`；
    /// 排序反了 ⇒ `[2019, 2021, 2023]`。
    /// </summary>
    [Fact]
    public async Task Report_HasAvailableYears_FromDataOnly()
    {
        await LoginAsync("admin-test", "TestPass123!");
        var (_, projectId, listId) = await SetupBareProjectAsync();
        var (_, _, otherListId) = await SetupBareProjectAsync();

        // 建於 2019、交付於 2021：兩個年份各撐住一半的查詢。
        var delivered = await CreateCardAsync(listId, "Y-delivered");
        await ForceCardCreatedAtAsync(delivered, new DateTime(2019, 3, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(delivered);   // 先交付（端點會蓋上今天的時間戳）再改寫成交付年
        await ForceCardCompletedAtAsync(delivered, new DateTime(2021, 5, 1, 0, 0, 0, DateTimeKind.Utc));

        // 建於 2023、從未交付：只有建卡年那一半。
        var open = await CreateCardAsync(listId, "Y-open");
        await ForceCardCreatedAtAsync(open, new DateTime(2023, 7, 1, 0, 0, 0, DateTimeKind.Utc));

        // 對照專案：卡片建於**今年**，真的寫進 DB（理由見上面的 summary）。
        await CreateCardAsync(otherListId, "Y-other");

        var body = await GetReportAsync(projectId, "");
        var years = body.GetProperty("availableYears").EnumerateArray().Select(y => y.GetInt32()).ToList();

        Assert.Equal(new[] { 2023, 2021, 2019 }, years);
        // 今年在資料庫裡（對照專案那張卡）卻不在這份清單裡。
        Assert.DoesNotContain(DateTime.Now.Year, years);
    }

    /// <summary>
    /// `availableYears` **與窗框無關**——換一個窗框，這份清單不變（換的是別的東西）。
    ///
    /// 這條性質是刻意保留的（`GetAvailableYearsAsync` 是全檔唯一不吃 `ReportWindow` 的查詢），
    /// 但「刻意」不等於「有人看著」：把它接到已加窗的查詢上，清單會在大部分情況下**照樣**
    /// 正確（資料橫跨多年時，窗內外的年份常常重疊），只有像本 fixture 這種「資料全在窗外」
    /// 的情境才會露出來。
    ///
    /// **對照組是必需的**：同一支測試要證明窗框**在同一個請求裡真的生效**（吃窗框的
    /// `memberHours` 在該窗下清空）。少了它，一個完全不看 `from`／`to` 的實作也照綠
    /// ——測不到東西的綠燈與正確的綠燈長得一樣。
    /// </summary>
    [Fact]
    public async Task Report_AvailableYears_IndependentOfWindow()
    {
        await LoginAsync("admin-test", "TestPass123!");
        var (_, projectId, listId) = await SetupBareProjectAsync();

        var delivered = await CreateCardAsync(listId, "Y-delivered");
        await ForceCardCreatedAtAsync(delivered, new DateTime(2019, 3, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(delivered);
        await ForceCardCompletedAtAsync(delivered, new DateTime(2021, 5, 1, 0, 0, 0, DateTimeKind.Utc));

        var open = await CreateCardAsync(listId, "Y-open");
        await ForceCardCreatedAtAsync(open, new DateTime(2023, 7, 1, 0, 0, 0, DateTimeKind.Utc));
        // 工時記在「現在」⇒ 2023 曆年的窗裡一筆都沒有，窗框因此在這個請求裡看得見效果。
        await _client.PostAsync($"/api/cards/{open}/effort", JsonContent.Create(new { hours = 4, timeZoneId = "UTC" }));

        var all = await GetReportAsync(projectId, "");
        var windowed = await GetReportAsync(projectId, "?from=2023-01-01T00:00:00Z&to=2024-01-01T00:00:00Z");

        // 對照：窗框真的生效了。
        Assert.NotEmpty(all.GetProperty("memberHours").EnumerateArray());
        Assert.Empty(windowed.GetProperty("memberHours").EnumerateArray());

        // 主斷言：年份清單逐位元不變。
        Assert.Equal(all.GetProperty("availableYears").GetRawText(),
            windowed.GetProperty("availableYears").GetRawText());
    }

    /// <summary>
    /// 剩餘工時**不吃窗框**（裁定 5，2026-09-22 使用者定案）。
    ///
    /// 「投入工時」是區間**流量**指標，嚴格吃窗框；「剩餘工時」是專案的**存量**指標
    /// （現在還欠多少），必須維持全期——跨年情境下讓它吃窗框會出現「越做工時剩餘越多」
    /// 甚至負數。實作上就是把 `ReportWindow.All` 傳給 `GetMemberRemainingRowsAsync`，
    /// 而那個查詢的**預估側本來就不吃窗框、只有已記側吃**——那個不對稱正是這條裁定
    /// 要消滅的東西（只餵一個窗框進去，兩側就會各說各話）。
    ///
    /// **對照組是必需的**：`memberHours` 在同一個窗下清空，證明窗框在其他地方真的生效。
    /// 兩半合起來才同時排除「窗框沒接上」與「窗框接到剩餘工時上」這兩個相反的缺陷。
    ///
    /// 突變：把 `ReportWindow.All` 換回 `window` ⇒ 這個窗裡 erin 的已記由 9 掉到 0、
    /// 剩餘由 6 跳到 15 ⇒ 逐位元比對紅。
    /// </summary>
    [Fact]
    public async Task Remaining_IgnoresWindow()
    {
        var (projectId, _, _, _) = await SetupAsync();

        var all = await GetReportAsync(projectId, "");
        // 對照的前半：全期下真的有工時，否則「窗內清空」也是空的、兩邊分不開。
        Assert.NotEmpty(all.GetProperty("memberHours").EnumerateArray());
        Assert.NotEmpty(all.GetProperty("memberRemaining").EnumerateArray());

        // 2030 曆年：所有工時都記在「現在」⇒ 這個窗裡一筆都沒有。
        var windowed = await GetReportAsync(projectId, "?from=2030-01-01T00:00:00Z&to=2031-01-01T00:00:00Z");

        // 對照的後半：窗框生效了——吃窗框的那一半清空。
        Assert.Empty(windowed.GetProperty("memberHours").EnumerateArray());
        // 主斷言：不吃窗框的那一半逐位元不變（含排序）。
        Assert.Equal(all.GetProperty("memberRemaining").GetRawText(),
            windowed.GetProperty("memberRemaining").GetRawText());
    }

    /// <summary>
    /// **卡片明細的「剩餘」是存量（全期），同一列的「已報」是流量（吃窗框）**——兩者刻意不同源。
    ///
    /// 2026-09-22 使用者裁定：整頁的規則收斂成一句話「**沒標的跟著期間選擇器、標了「（全期）」的固定**」。
    /// 這一支與上一支（`Remaining_IgnoresWindow`）是同一條裁定的兩層：上一支釘**成員**層級的剩餘、
    /// 這一支釘**卡片**層級。改動前 `RemainingHours = EstimatedHours −（窗框內的 LoggedHours）`
    /// （窗框過濾在 `ProjectReportQueries.GetCardRowsAsync` 的 `logs` 那兩行）⇒ 選了 2030 之後
    /// 同一張卡的剩餘會**從 5 變成 10**，讀起來像「越做剩餘越多」。
    ///
    /// **對照組是必需的**：同一列的 `loggedHours` 在該窗下必須**清空**——少了它，一個
    /// 「把窗框整個忽略」的實作（連已報都不吃窗框）照樣讓主斷言成立。兩半合起來才同時排除了
    /// 「窗框沒接上」與「窗框接到了剩餘上」這兩個**相反**的缺陷——而後者正是本批要消滅的形狀。
    ///
    /// 主斷言**釘值也釘不變性**，兩者都要：只釘不變性的話，「兩邊都算全期但算式錯了」
    /// （例如整條減項漏掉）照樣綠。
    ///
    /// 突變①：`RemainingHours` 讀窗框內的那個和 ⇒ 主斷言紅（5 → 10）。
    /// 突變②：`LoggedHours` 讀全期的那個和（＝把裁定 1 反過來做）⇒ 對照組紅（兩跑都是 5）。
    /// </summary>
    [Fact]
    public async Task CardDetail_RemainingIsAllTime_WhileLoggedFollowsWindow()
    {
        var (projectId, _, _, _) = await SetupAsync();
        // 種子（實查 `SetupAsync`）：卡一 預估 10、erin 3 ＋ dave 2 ＝ 已記 5。

        var all = await GetReportAsync(projectId, "");
        // 2030 曆年：所有工時都記在「現在」⇒ 這個窗裡一筆都沒有（同上一支的理由）。
        var windowed = await GetReportAsync(projectId, "?from=2030-01-01T00:00:00Z&to=2031-01-01T00:00:00Z");

        static JsonElement CardOf(JsonElement body) => body.GetProperty("cards").EnumerateArray()
            .Single(c => c.GetProperty("title").GetString() == "卡一");

        var allCard = CardOf(all);
        var windowedCard = CardOf(windowed);

        // 對照組：窗框生效——「已報」是流量，窗內清空。
        Assert.Equal(5m, allCard.GetProperty("loggedHours").GetDecimal());
        Assert.Equal(0m, windowedCard.GetProperty("loggedHours").GetDecimal());

        // 主斷言：剩餘是存量——值是「預估 − 全期已記」，且逐位元不隨窗框改變。
        Assert.Equal(5m, allCard.GetProperty("remainingHours").GetDecimal());
        Assert.Equal(allCard.GetProperty("remainingHours").GetRawText(),
            windowedCard.GetProperty("remainingHours").GetRawText());
    }

    [Fact]
    public async Task Report_WithoutReportView_Returns403()
    {
        var (projectId, _, _, _) = await SetupAsync();
        await LoginAsync("tina", "Password1!");   // 測試工程師無 report.view
        var resp = await _client.GetAsync($"/api/projects/{projectId}/report");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Report_Anonymous_Returns401()
    {
        var (projectId, _, _, _) = await SetupAsync();
        _client.DefaultRequestHeaders.Authorization = null;
        var resp = await _client.GetAsync($"/api/projects/{projectId}/report");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
