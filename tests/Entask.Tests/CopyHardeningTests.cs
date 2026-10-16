using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class CopyHardeningTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CopyHardeningTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ProjectId, string BoardId, string ListId, string CardId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "複製團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "複製專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "複製板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        // 標籤
        var label = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "紅標", color = "#B60205" }))).Content.ReadFromJsonAsync<JsonElement>();
        var labelId = label.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "被複製卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{cardId}/labels", JsonContent.Create(new { labelIds = new[] { labelId } }));
        return (projectId, boardId, listId, cardId);
    }

    [Fact]
    public async Task CardCopy_NonexistentTargetList_Returns404()
    {
        var (_, _, _, cardId) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/copy",
            JsonContent.Create(new { targetListId = Guid.NewGuid() }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task ProjectCopy_MissingTeamHeader_Returns400()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{projectId}/copy");
        req.Headers.Authorization = new("Bearer", _client.DefaultRequestHeaders.Authorization?.Parameter);
        req.Content = JsonContent.Create(new { });
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task CardCopy_NoPermission_Returns403()
    {
        var (_, _, _, cardId) = await SetupAsync();
        // carol：任何團隊/專案皆無 → wrapper fail-closed 403
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "copy-carol", password = "Password1!", displayName = "複製卡蘿" }));
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "copy-carol", password = "Password1!" }));
        var carolToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/cards/{cardId}/copy");
        req.Headers.Authorization = new("Bearer", carolToken);
        req.Content = JsonContent.Create(new { });
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(req)).StatusCode);
    }

    // 這一條與上面 `CardCopy_NoPermission_Returns403` 的分工：
    // carol 對**來源卡片所屬專案**連 `card.read` 都沒有 ⇒ 擋在 `RequireProjectPermission`
    // 篩選器（那是 Task 2 的範圍）。erin 有 `card.read`（過得了篩選器）但沒有 `card.create`
    // ⇒ 擋在**本任務改的手寫站點**（CopyEndpoints.cs 的 `CardCreate` 檢查）。
    [Fact]
    public async Task CardCopy_TeamMemberWithoutCardCreate_Returns403WithCode()
    {
        var (projectId, _, _, cardId) = await SetupAsync();
        var teamId = FindTeamId(projectId);
        // 「工程師」：card.read ✓、card.create ✗（RoleSeed 的系統範本）
        var erinToken = await CreateEngineerTokenAsync(teamId, "copy-erin", "複製艾琳");

        // 正向控制（Task 3 審查的 Minor 2）：erin 真的拿到了來源專案的 `card.read`
        // ——也就是成員指派真的生效、她過得了來源端那個 `RequireProjectPermission` 篩選器。
        // 少了它，下面那個 403 哪天改成來自篩選器時，這支測試會**靜默退化**成一支篩選器測試：
        // 兩層發出的 body 逐位元相同（都是 `permission.denied`），斷言照樣綠，
        // 而 `CopyEndpoints` 手寫站點的覆蓋就無聲消失了。
        var readReq = new HttpRequestMessage(HttpMethod.Get, $"/api/cards/{cardId}");
        readReq.Headers.Authorization = new("Bearer", erinToken);
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(readReq)).StatusCode);

        // body 的 targetListId 留空 ⇒ 目標就是卡片自己所在的列表（同一個專案）
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/cards/{cardId}/copy");
        req.Headers.Authorization = new("Bearer", erinToken);
        req.Content = JsonContent.Create(new { });
        var resp = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        Assert.Equal("permission.denied",
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    // 站點 5／6／7（清單／看板／專案複製）。與站點 4 同型：每條路線都有兩層看門
    // ——`RequireProjectPermission` 篩選器守**來源端**、`CopyEndpoints` 的手寫站點守**目標端**
    // ——而兩層發出的 body 逐位元相同（都是 `permission.denied`）⇒ 少了正向控制，
    // 「這個 403 來自哪一層」就分不出來：手寫站點哪天被拿掉、或它的權限碼改成探針剛好有的
    // 那一個，測試會**靜默退化**成一支篩選器測試。這三處的 body 在此之前**沒有任何測試讀過**
    // （只有「四處形狀逐字相同」＋ 抽樣；見 AGENTS.md 的未結項目）。
    [Fact]
    public async Task ListCopy_TeamMemberWithoutBoardEdit_Returns403WithCode()
    {
        var (projectId, boardId, listId, _) = await SetupAsync();
        var token = await CreateEngineerTokenAsync(FindTeamId(projectId), "copy-frank", "複製弗蘭克");

        // 正向控制：目標不存在 ⇒ **404 由 handler 發出**，所以這個請求已經走過篩選器了
        // ⇒ 下面那個 403 只可能是手寫站點發的。
        //
        // 這一支刻意用「同一條路線上的 404」而不是站點 4 那種「另一個端點的 200」：後者只證明了
        // 探針有 `board.read`；篩選器哪天被收緊成 `board.edit`，那個 GET 照樣 200、下面照樣 403
        // 綠燈，而手寫站點的覆蓋已經無聲消失。on-route 探針**同時**涵蓋「探針掉了權限」與
        // 「篩選器被收緊」兩種退化——`CardCopy_NonexistentTargetList_Returns404` 是站點 4 的
        // 同型探針（但它是獨立一支，所以站點 4 自己那支仍留著 200 控制）。
        Assert.Equal(HttpStatusCode.NotFound,
            (await SendWithTokenAsync(token, $"/api/lists/{listId}/copy",
                body: new { targetBoardId = Guid.NewGuid() })).StatusCode);

        // body 的 targetBoardId 留空 ⇒ 目標就是清單自己所在的看板（同一個專案）。
        // 工程師有 `board.read` 而沒有 `board.edit` ⇒ 擋在 CopyEndpoints 的手寫站點。
        await AssertPermissionDeniedAsync(await SendWithTokenAsync(token, $"/api/lists/{listId}/copy"));
    }

    [Fact]
    public async Task BoardCopy_TeamMemberWithoutBoardCreate_Returns403WithCode()
    {
        var (projectId, boardId, _, _) = await SetupAsync();
        var token = await CreateEngineerTokenAsync(FindTeamId(projectId), "copy-gina", "複製吉娜");

        // 正向控制：同站點 5，on-route 的 404（目標專案不存在）。
        Assert.Equal(HttpStatusCode.NotFound,
            (await SendWithTokenAsync(token, $"/api/boards/{boardId}/copy",
                body: new { targetProjectId = Guid.NewGuid() })).StatusCode);

        // body 的 targetProjectId 留空 ⇒ 目標就是看板自己所在的專案（同一個專案）。
        // 工程師有 `board.read` 而沒有 `board.create`。
        await AssertPermissionDeniedAsync(await SendWithTokenAsync(token, $"/api/boards/{boardId}/copy"));
    }

    [Fact]
    public async Task ProjectCopy_TeamMemberWithoutProjectCreate_Returns403WithCode()
    {
        var (projectId, _, _, _) = await SetupAsync();
        var teamId = FindTeamId(projectId);
        var token = await CreateEngineerTokenAsync(teamId, "copy-henry", "複製亨利");

        // 正向控制：這一站沒有「目標不存在」的分支（目標是 header 指的團隊，只驗它存不存在），
        // 走得比篩選器更遠的 on-route 探針是**缺 header 的 400**——400 由 handler 發出
        // ⇒ 篩選器放行了這個探針。與 `ProjectCopy_MissingTeamHeader_Returns400` 是同一個請求，
        // 差別在那一支釘的是 400 自己的契約，這裡是**本站 403 的控制**。
        Assert.Equal(HttpStatusCode.BadRequest,
            (await SendWithTokenAsync(token, $"/api/projects/{projectId}/copy")).StatusCode);

        // 這一站與 5／6 不同：手寫站點查的是**目標團隊**（`X-Team-Id`）的 `project.create`，
        // 不是來源專案——而工程師在該團隊有 `project.read`、沒有 `project.create`。
        await AssertPermissionDeniedAsync(
            await SendWithTokenAsync(token, $"/api/projects/{projectId}/copy", teamId));
    }

    // 建立一位「工程師」團隊成員並回傳她的 token。先登入再指派角色（與站點 4 同順序）
    // ——權限是查 DB 的，不是看 token 裡的 claim。
    private async Task<string> CreateEngineerTokenAsync(string teamId, string username, string displayName)
    {
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        // 用 `code` 不用 `name`：顯示名稱只是「第一次寫入」的預設值、之後是使用者的資料，
        // 查找一律用 Code（RoleSeed 檔頭的原話）——用名稱當鍵會讓這支測試在有人改角色名時紅。
        var engineerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("code").GetString() == SystemRoleCodes.Engineer).GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName }));
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username, roleIds = new[] { engineerRoleId } }));
        return token;
    }

    private async Task<HttpResponseMessage> SendWithTokenAsync(string token, string url,
        string? teamHeader = null, object? body = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new("Bearer", token);
        if (teamHeader is not null) req.Headers.Add("X-Team-Id", teamHeader);
        req.Content = JsonContent.Create(body ?? new { });
        return await _client.SendAsync(req);
    }

    // 斷言釘的是 **wire 上的字面值**（不是 `ErrorCodes.PermissionDenied` 常數）：
    // 常數值被改掉時，用常數寫的斷言會跟著改、靜默通過（403 階段的 M3 實測）。
    private static async Task AssertPermissionDeniedAsync(HttpResponseMessage resp)
    {
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        Assert.Equal("permission.denied",
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    private string FindTeamId(string projectId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return db.Projects.Where(p => p.Id == Guid.Parse(projectId)).Select(p => p.TeamId).First().ToString();
    }

    [Fact]
    public async Task CardCopy_DefaultName_AppendsCopySuffix()
    {
        var (_, _, _, cardId) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/copy", JsonContent.Create(new { }));
        var copy = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("被複製卡（副本）", copy.GetProperty("title").GetString());
    }

    [Fact]
    public async Task ListCopy_SameBoard_KeepsCardLabels()
    {
        var (_, boardId, listId, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/lists/{listId}/copy", JsonContent.Create(new { }));
        var newList = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var copiedCard = newList.GetProperty("cards").EnumerateArray().Single();
        Assert.Single(copiedCard.GetProperty("labels").EnumerateArray());
    }

    [Fact]
    public async Task BoardCopy_WritesBoardCreatedAudit()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/boards/{boardId}/copy", JsonContent.Create(new { }));
        var newBoard = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var newBoardId = newBoard.GetProperty("id").GetString()!;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var audit = db.AuditLogs.Single(a =>
                a.Action == "board.created" && a.EntityId == Guid.Parse(newBoardId));
            Assert.NotNull(audit.ProjectId);
        }
    }

    [Fact]
    public async Task CardCopy_WritesCardCreatedAudit()
    {
        var (projectId, _, _, cardId) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/copy", JsonContent.Create(new { }));
        var copy = await resp.Content.ReadFromJsonAsync<JsonElement>();
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var audit = db.AuditLogs.Single(a =>
                a.Action == "card.created" && a.EntityId == Guid.Parse(copy.GetProperty("id").GetString()!));
            Assert.Equal(Guid.Parse(projectId), audit.ProjectId);
        }
    }

    [Fact]
    public async Task BoardCopy_CopiedListsAndCards_InPositionOrder()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/boards/{boardId}/copy", JsonContent.Create(new { }));
        var newBoardId = (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var detail = await (await _client.GetAsync($"/api/boards/{newBoardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var lists = detail.GetProperty("lists").EnumerateArray().ToList();
        Assert.Single(lists);
        var cards = lists[0].GetProperty("cards").EnumerateArray().ToList();
        Assert.Single(cards);
        Assert.Equal("被複製卡（副本）", cards[0].GetProperty("title").GetString());
    }

    // 複製後綴是**寫入時**依操作者語系決定的（`?locale=`）：存進 DB 之後它就是一段使用者資料，
    // 後端、搜尋、匯出、其他語系的使用者讀到的都是同一串，沒有任何一層會再去翻譯它。
    // 這一支的判別力在「locale 真的走到了寫入路徑」——只在預設語系下斷言的話，
    // 把 locale 整個拿掉也照樣綠。
    [Fact]
    public async Task CardCopy_EnglishLocale_UsesEnglishSuffix()
    {
        var (_, _, _, cardId) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/copy?locale=en", JsonContent.Create(new { }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var copy = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("被複製卡 (copy)", copy.GetProperty("title").GetString());
    }

    // 看板複製是深層複製：locale 要穿過 board → list → card 三層才會到卡片標題，
    // 只驗看板名稱的話漏掉後面兩層的傳遞。
    [Fact]
    public async Task BoardCopy_EnglishLocale_UsesEnglishSuffix_ThroughAllLayers()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/boards/{boardId}/copy?locale=en", JsonContent.Create(new { }));
        var copy = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("複製板 (copy)", copy.GetProperty("name").GetString());
        var newBoardId = copy.GetProperty("id").GetString()!;

        var detail = await (await _client.GetAsync($"/api/boards/{newBoardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var cardTitle = detail.GetProperty("lists").EnumerateArray().Single()
            .GetProperty("cards").EnumerateArray().Single().GetProperty("title").GetString();
        Assert.Equal("被複製卡 (copy)", cardTitle);
    }

    // 認不得的語系回預設語系、**不是 400**——與 `ExportLabels.Resolve` 同語意
    // （`?locale=` 來自瀏覽器，讓整份複製失敗比給一個看得懂的預設語系更糟）。
    [Fact]
    public async Task CardCopy_UnknownLocale_FallsBackToDefaultSuffix()
    {
        var (_, _, _, cardId) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/copy?locale=xx-YY", JsonContent.Create(new { }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var copy = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("被複製卡（副本）", copy.GetProperty("title").GetString());
    }

    // 走訪**每一個**內嵌語系檔，斷言樣板留住了原標題。
    // 這擋的是 parity 的檢查 10 擋不到的洞：它比的是「各語系的佔位名**集合**是否相等」，
    // 三個語系一起把 {{name}} 拿掉它照樣綠——而那正是「複製出來的標題把原標題吃掉」的
    // 靜默失敗（寫進 DB 的就是錯的字，沒有紅燈、畫面也不會壞，只有使用者看得出來）。
    // 讀內嵌資源而不是 `ExportLabels.For`：後者是 internal，本專案沒有 InternalsVisibleTo。
    [Fact]
    public void EveryExportLocale_KeepsSourceNameInCopyTemplate()
    {
        var asm = typeof(Entask.Api.Endpoints.CopyEndpoints).Assembly;
        var locales = asm.GetManifestResourceNames()
            .Select(n => (Resource: n, Match: System.Text.RegularExpressions.Regex.Match(n, @"\.export\.([^.]+)\.json$")))
            .Where(x => x.Match.Success)
            .Select(x => (x.Resource, Locale: x.Match.Groups[1].Value))
            .OrderBy(x => x.Locale, StringComparer.Ordinal)
            .ToList();
        Assert.NotEmpty(locales);

        foreach (var (resource, locale) in locales)
        {
            using var stream = asm.GetManifestResourceStream(resource)!;
            var values = JsonSerializer.Deserialize<Dictionary<string, string>>(stream)!;
            Assert.True(values.TryGetValue(ExportKeys.CopyName, out var template),
                $"{locale} 的資源檔沒有 {ExportKeys.CopyName}（parity 的檢查 11 應該先擋下這個）");

            // 前提斷言：沒有這一條時，樣板被改成不含 {{name}} 的值（例如 "X (copy)"）會讓
            // 下面兩條**都過**——寫進 DB 的就是錯的字，沒有紅燈、畫面也不會壞。
            Assert.Contains("{{name}}", template!, StringComparison.Ordinal);

            var rendered = template!.Replace("{{name}}", "X", StringComparison.Ordinal);
            Assert.Contains("X", rendered);
            Assert.NotEqual("X", rendered);
        }
    }
}
