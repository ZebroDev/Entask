using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Entask.Api.Dtos;
using Entask.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

[Collection("ApiTests")]
public class TeamReportTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public TeamReportTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<string> SetupTeamAndDataAsync(string token)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "Report Team" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!; var me = await _client.GetFromJsonAsync<JsonElement>("/api/auth/me"); var userId = me.GetProperty("userId").GetString()!; await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { userIds = new[] { userId } }));

        // Project 1
        var p1Req = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        p1Req.Headers.Add("X-Team-Id", teamId);
        p1Req.Content = JsonContent.Create(new { name = "P1" });
        var p1Id = (await (await _client.SendAsync(p1Req)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        
        var b1Id = (await (await _client.PostAsync($"/api/projects/{p1Id}/boards", JsonContent.Create(new { name = "B1" }))).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var l1Id = (await (await _client.PostAsync($"/api/boards/{b1Id}/lists", JsonContent.Create(new { name = "L1" }))).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        
        await _client.PostAsync($"/api/lists/{l1Id}/cards", JsonContent.Create(new { title = "C1" }));
        var boards = await (await _client.GetAsync($"/api/boards/{b1Id}")).Content.ReadFromJsonAsync<JsonElement>();
        var c1Id = boards.GetProperty("lists")[0].GetProperty("cards")[0].GetProperty("id").GetString()!;

        await _client.PutAsync($"/api/cards/{c1Id}/completion", JsonContent.Create(new { isCompleted = true }));

        // Project 2
        var p2Req = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        p2Req.Headers.Add("X-Team-Id", teamId);
        p2Req.Content = JsonContent.Create(new { name = "P2" });
        var p2Id = (await (await _client.SendAsync(p2Req)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        return teamId;
    }

    [Fact]
    public async Task CanGetTeamReport()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var teamId = await SetupTeamAndDataAsync(token);

        var res = await _client.GetAsync($"/api/teams/{teamId}/report");
        if (res.StatusCode != HttpStatusCode.OK) { var body = await res.Content.ReadAsStringAsync(); throw new Exception($"Failed GET {$"/api/teams/{teamId}/report"} with {res.StatusCode}: {body}"); } Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        
        var members = json.GetProperty("members").EnumerateArray().ToList();
        Assert.NotEmpty(members);
        
        var admin = members.First(m => m.GetProperty("username").GetString() == "admin-test");
        Assert.True(admin.GetProperty("completedCards").GetInt32() >= 1);
    }

    [Fact]
    public async Task CanGetUserPerformance()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var teamId = await SetupTeamAndDataAsync(token);

        // Get admin user ID
        var meRes = await _client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        var userId = meRes.GetProperty("userId").GetString()!;

        var res = await _client.GetAsync($"/api/users/{userId}/performance?year={DateTime.UtcNow.Year}");
        if (res.StatusCode != HttpStatusCode.OK) { var body = await res.Content.ReadAsStringAsync(); throw new Exception($"Failed GET {$"/api/teams/{teamId}/report"} with {res.StatusCode}: {body}"); } Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("completedCards").GetInt32() >= 1);
    }

    /// <summary>
    /// `/api/users/{userId}/performance` 的 403（TeamReportEndpoints.cs 的 `!isSharedManager`）：
    /// 端點只掛 `.RequireAuthorization()`，沒有權限篩選器 ⇒ 這裡走到的是**手寫**的那個站點。
    /// 呼叫者是**非 admin 且無任何團隊**的新使用者（admin 由 `!isAdmin` 條件本身放行，
    /// 用 admin 打永遠到不了這一條）。
    /// </summary>
    [Fact]
    public async Task Performance_OtherUserWithoutSharedTeam_Returns403WithCode()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var adminId = await AdminUserIdAsync();

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "perf-dave", password = "Password1!", displayName = "績效戴夫" }));
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "perf-dave", password = "Password1!" }));
        var daveToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/users/{adminId}/performance");
        req.Headers.Authorization = new("Bearer", daveToken);
        var resp = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        Assert.Equal("team.notMember",
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    // ---------- Task 10：一次交付通過率（FPY）----------
    //
    // 契約（設計 §13.2／§13.4）：
    //   分母 = 曾指派過審查者且非封存的卡片；分子 = 其中第一筆 CardReviewEntry 為 approved 的卡片。
    //   **沒有審查者的卡片不進分母**——「指派審查者」是一個管理動作。
    //   分母 < 5 張時不列入 S 資格（其餘兩個條件照算）。
    //
    // 所有的斷言都用「回應裡的欄位」而不是直接呼叫 `RatingFor`（private）：這一條契約的
    // 三個輸出路徑共用同一個函式，端到端才驗得到接線（Task 10 之前就有過「三份三元式
    // 各寫一次、漏改一條不會有任何錯誤訊息」的紀錄）。

    /// <summary>
    /// 建一個乾淨的團隊／專案／看板／列表（**沒有任何卡片**），回傳 (teamId, projectId, listId)。
    /// 既有 `SetupTeamAndDataAsync` 會順手建好幾張卡，對 FPY 的分子分母是雜訊。
    ///
    /// 團隊／專案一律由回傳的 id 帶走——`WithDbReset()` 是 per-class，這個類別每一支測試
    /// 都建同名的團隊，用名稱查會抓到別支測試的（`ReviewLifecycleTests.AddSecondReviewerAsync`
    /// 踩過同一個坑）。
    ///
    /// `projectId` 只有需要造**第二個成員**的測試用得到（卡片指派的不變量要求指派對象
    /// 是專案成員，見 `CreateProjectMemberAsync`）；其餘的測試以 `_` 丟掉它。
    /// </summary>
    private async Task<(string TeamId, string ProjectId, string ListId)> SetupBareTeamAsync()
    {
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "Report Team" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var adminId = await AdminUserIdAsync();
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { userIds = new[] { adminId } }));

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", teamId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        return (teamId, pId, lId);
    }

    private async Task<Guid> AdminUserIdAsync() =>
        (await _client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("userId").GetGuid();

    /// <summary>建一張卡並回傳它的 id（`POST /api/lists/{id}/cards` 直接回 CardResponse）。</summary>
    private async Task<string> CreateCardAsync(string listId, string title) =>
        (await (await _client.PostAsync($"/api/lists/{listId}/cards", JsonContent.Create(new { title })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

    /// <summary>交付（`PUT /completion`）——沒有審查者的卡片走 complete，有的走 delivery_submitted。</summary>
    private async Task CompleteAsync(string cardId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 指派唯一的審查者並回傳該列的 reviewId。
    /// **指派本身不寫 history entry**（設計 §5.3：四個會改到立場的地方只有提交寫 entry），
    /// 所以「指派了卻沒審」的卡片進分母、不進分子。
    /// </summary>
    private async Task<string> AssignReviewerAsync(string cardId, Guid reviewerUserId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { reviewerUserId } }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        var rows = await res.Content.ReadFromJsonAsync<JsonElement>();
        return rows.EnumerateArray()
            .Single(r => r.GetProperty("reviewerUserId").GetGuid() == reviewerUserId)
            .GetProperty("id").GetString()!;
    }

    private async Task SubmitReviewAsync(string cardId, string reviewId, string status, string? comment = null,
        int? score = null)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status, comment, score }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>有審查者、交付一次就通過：第一筆 entry 即 approved。進分母也進分子。</summary>
    private async Task CreateFirstPassCardAsync(string listId, string title, Guid reviewerId)
    {
        var cardId = await CreateCardAsync(listId, title);
        var reviewId = await AssignReviewerAsync(cardId, reviewerId);
        await CompleteAsync(cardId);
        await SubmitReviewAsync(cardId, reviewId, ReviewStatuses.Approved);
    }

    /// <summary>
    /// 有審查者、被退回後重新交付才通過：第一筆 entry 是 rejected。**只進分母、不進分子。**
    ///
    /// 走的是設計 §13.6 的完整鏈：交付 → 退回（清掉 CompletedAt）→ 重新交付 → 通過。
    /// 最後仍是「完成」，所以完成率不受影響——差異只可能落在 FPY 上。
    /// （準時率自 2026-09-21 起只算**有截止日**的已交付卡片，而這裡的卡片都沒有截止日
    /// ⇒ 那個條件對這個 fixture 是「樣本不足」、不列入評等，與修改前同值。）
    /// </summary>
    private async Task CreateReworkedCardAsync(string listId, string title, Guid reviewerId)
    {
        var cardId = await CreateCardAsync(listId, title);
        var reviewId = await AssignReviewerAsync(cardId, reviewerId);
        await CompleteAsync(cardId);
        await SubmitReviewAsync(cardId, reviewId, ReviewStatuses.Rejected, comment: "退回重做");
        await CompleteAsync(cardId);
        await SubmitReviewAsync(cardId, reviewId, ReviewStatuses.Approved);
    }

    /// <summary>
    /// 建一張卡、把截止日設在過去、再交付——「完成但不準時」。
    /// 報表的準時率是 `CompletedAt &lt;= DueAt`（`TeamReportEndpoints` 三條路徑同式），
    /// 而 2020 一定早於剛剛才寫入的 `CompletedAt`。
    /// </summary>
    private async Task CreateLateCardAsync(string listId, string title)
    {
        var cardId = await CreateCardAsync(listId, title);
        var res = await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { dueAt = "2020-01-01T00:00:00Z" }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        await CompleteAsync(cardId);
    }

    /// <summary>
    /// 建一張卡、把截止日設在**未來**、再交付——「完成且準時」。
    ///
    /// 與 `CreateLateCardAsync` 對稱，而它**必須存在**：`CreateCardAsync` 建出來的卡片
    /// 沒有截止日，自 2026-09-21 起那種卡片**兩邊都不進**準時率（使用者裁定），
    /// 拿它假裝「準時」會得到樣本不足而不是 1.0。
    ///
    /// 日期寫死 2099 而不是 `UtcNow.AddDays(1)`：這條要斷言的是「早於截止日」，
    /// 用相對時間會讓斷言的成功取決於執行時刻（`CreateLateCardAsync` 的 2020 同理）。
    /// </summary>
    private async Task CreateOnTimeCardAsync(string listId, string title)
    {
        var cardId = await CreateCardAsync(listId, title);
        var res = await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { dueAt = "2099-01-01T00:00:00Z" }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        await CompleteAsync(cardId);
    }

    /// <summary>把截止日設成 `dueAt`（ISO 8601 字串）。不交付——呼叫端自己決定完成時機。</summary>
    private async Task SetDueDateAsync(string cardId, string dueAt)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}", JsonContent.Create(new { dueAt }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 在該團隊／專案裡造一個成員（建帳號 → 取「工程師」角色 → **加進專案名冊**），回傳 userId。
    ///
    /// 進專案名冊是**必要**的，不是儀式：卡片指派的不變量（2026-09-19）要求指派對象必須是
    /// 該專案的成員，少了這一步 `PUT /api/cards/{id}/members` 直接回 400。
    /// </summary>
    private async Task<Guid> CreateProjectMemberAsync(string teamId, string projectId, string username)
    {
        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName = username }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;

        var userId = UserIdByName(username);
        var added = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { roleId } }));
        Assert.True(added.IsSuccessStatusCode, await added.Content.ReadAsStringAsync());

        return userId;
    }

    /// <summary>
    /// 把卡片指派給某位成員（**送出的清單就是最終清單**）。指派之後這張卡的責任歸屬
    /// 就從建立者（admin）換成被指派者——團隊報表的 `userCardMap` 正是這樣算的。
    /// </summary>
    private async Task AssignCardMemberAsync(string cardId, Guid userId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { userId } }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 直接寫一列 `EffortLog`。**這是造「有工時、零卡片」成員唯一的路**：成員名冊是
    /// `userCardMap.Keys ∪ memberEffortMap.Keys`，而工時端點要求先有一張看得到的卡片，
    /// 所以「零卡片但有工時」在 API 上到不了（真實世界裡它來自卡片被改派或封存之後）。
    /// </summary>
    private async Task AddEffortLogAsync(string cardId, Guid userId, decimal hours)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var loggedAt = DateTime.UtcNow;
        db.EffortLogs.Add(new Entask.Core.Entities.EffortLog
        {
            CardId = Guid.Parse(cardId),
            UserId = userId,
            Hours = hours,
            LoggedAt = loggedAt,
            LocalDate = DateOnly.FromDateTime(loggedAt),
            LoggedAtLocal = DateTime.SpecifyKind(loggedAt, DateTimeKind.Unspecified),
        });
        await db.SaveChangesAsync();
    }

    private Guid UserIdByName(string username)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        return db.Users.First(u => u.UserName == username).Id;
    }

    /// <summary>
    /// 報表裡某位成員的那一列。以 **userId** 指名，不用名稱。
    ///
    /// `from`／`to` 是**選填**的窗框（ISO 8601 字串）——不帶時與加參數之前逐位相同，
    /// 既有的呼叫端因此一字未改。兩個參數各自獨立（只帶 `to` 也成立）。
    /// </summary>
    private async Task<JsonElement> MemberRowAsync(string teamId, Guid userId, string? from = null, string? to = null)
    {
        var res = await _client.GetAsync($"/api/teams/{teamId}/report{WindowQuery(from, to)}");
        if (res.StatusCode != HttpStatusCode.OK)
            throw new Exception($"Failed GET /api/teams/{teamId}/report with {res.StatusCode}: {await res.Content.ReadAsStringAsync()}");
        return (await res.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("members").EnumerateArray()
            .Single(m => m.GetProperty("userId").GetGuid() == userId);
    }

    /// <summary>
    /// 把 `from`／`to` 收成查詢字串（`?from=…&amp;to=…`；兩者皆 null 時是空字串）。
    /// **三個端點（report／export／export-excel）吃的是同一組參數**，所以三條路徑的取法共用這一處。
    /// </summary>
    private static string WindowQuery(string? from, string? to)
    {
        var query = new List<string>();
        if (from is not null) query.Add($"from={Uri.EscapeDataString(from)}");
        if (to is not null) query.Add($"to={Uri.EscapeDataString(to)}");
        return query.Count == 0 ? "" : "?" + string.Join("&", query);
    }

    /// <summary>GET 一個端點並回傳 body。非 200 時把 body 一起帶進失敗訊息（否則只看到一個狀態碼）。</summary>
    private async Task<string> FetchAsync(string url)
    {
        var res = await _client.GetAsync(url);
        Assert.True(res.IsSuccessStatusCode, $"GET {url} → {(int)res.StatusCode}: {await res.Content.ReadAsStringAsync()}");
        return await res.Content.ReadAsStringAsync();
    }

    /// <summary>
    /// 直接寫一列**回填風格**的 `CardReviewEntry`：`Status = rejected` 卻帶分數。
    ///
    /// **API 造不出這種列**（`ReviewEndpoints` 對「退回 ＋ 分數」回 400，那道驗證是
    /// `02feacb` 才有的），只有 Task 1 的回填與它之前的歷史資料長這樣——回填的述詞是
    /// `WHERE "Status" &lt;&gt; 'pending'`（`20260916145055_AddCardReviewEntries.cs`），
    /// 所以 `CardReviews(Status='rejected', Score=1)` 會原樣變成這裡的一列。繞過端點、
    /// 直接進 DbContext 是**唯一**造得出來的方法。
    /// </summary>
    private async Task AddBackfilledRejectedScoreAsync(Guid cardId, Guid reviewerUserId, int score)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        db.CardReviewEntries.Add(new Entask.Core.Entities.CardReviewEntry
        {
            CardId = cardId,
            ReviewerUserId = reviewerUserId,
            Status = ReviewStatuses.Rejected,
            Score = score,
            Comment = "退回重做",
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// 分母不含沒有審查者的卡片（設計 §13.8 第 2 項）。
    /// A：有審查者、一次通過 ⇒ 進分子也進分母；B：有審查者、退回後重新交付才通過 ⇒ 只進分母；
    /// C：**沒有審查者**、直接完成 ⇒ 兩者都不進。
    /// </summary>
    [Fact]
    public async Task FirstPassYield_ExcludesCardsWithoutReviewers()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        await CreateFirstPassCardAsync(listId, "A-一次通過", adminId);
        await CreateReworkedCardAsync(listId, "B-退回後才通過", adminId);

        // C：沒有審查者。admin 是它的建立者，所以完成率算得到它（3 張卡全完成 → 1.0），
        // 但它不該出現在 FPY 的分母裡——這就是本測試要釘的那一格。
        await CompleteAsync(await CreateCardAsync(listId, "C-無審查者"));

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(3, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(2, member.GetProperty("reviewed").GetInt32());
        Assert.Equal(1, member.GetProperty("firstPass").GetInt32());
        // 分母 2 < 5 ⇒ 樣本不足 ⇒ fpy 必須是 **null**（不是 0）。
        // `null` 與 `0` 在畫面上是兩件事（「樣本不足」vs「一次都沒通過」），
        // 而 Task 11 的調整項／前端就是靠這個區別決定要不要顯示這一格。
        Assert.Equal(JsonValueKind.Null, member.GetProperty("fpy").ValueKind);
    }

    /// <summary>
    /// FPY 的**分母語意**那一條（設計 §6.1 第 1 條；D1／§4.2）：審查者被**全部移除**之後，
    /// 卡片仍留在分母裡——分母問的是「**曾**指派過審查者」，不是「現在有審查者」。
    ///
    /// A：一次通過 ⇒ 進分子也進分母；B：第一筆 entry 是 rejected ⇒ 只進分母。
    /// **B 就是「移除就會作弊」的那一張**：把它的審查者全部移除，若分母跟著縮，
    /// reviewed 會從 2 掉到 1（firstPass 不變）⇒ FPY 由 1/2 變成 1/1。
    /// 能做這件事的權限是 `card.assign`，而 FPY ≥ 0.80 是 S 級的第三個資格條件。
    ///
    /// 斷言的是移除**前後**的兩個整數（`reviewed`／`firstPass`）都不變——不是 fpy 本身：
    /// 樣本 2 < 5，fpy 依設計是 null（見上一支）。
    /// </summary>
    [Fact]
    public async Task FirstPassYield_DenominatorIsUnchanged_WhenReviewersAreAllRemoved()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        await CreateFirstPassCardAsync(listId, "A-一次通過", adminId);

        // B：有審查者、第一筆 entry 是 rejected。形狀與 `CreateReworkedCardAsync` 相同，
        // 但這裡需要它的 cardId（下面要把它的審查者全部移除），所以不走那支 helper。
        var reworkedCardId = await CreateCardAsync(listId, "B-退回後才通過");
        var reviewId = await AssignReviewerAsync(reworkedCardId, adminId);
        await CompleteAsync(reworkedCardId);
        await SubmitReviewAsync(reworkedCardId, reviewId, ReviewStatuses.Rejected, comment: "退回重做");
        await CompleteAsync(reworkedCardId);
        await SubmitReviewAsync(reworkedCardId, reviewId, ReviewStatuses.Approved);

        var before = await MemberRowAsync(teamId, adminId);
        Assert.Equal(2, before.GetProperty("reviewed").GetInt32());
        Assert.Equal(1, before.GetProperty("firstPass").GetInt32());

        var res = await _client.PutAsync($"/api/cards/{reworkedCardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());

        var after = await MemberRowAsync(teamId, adminId);
        Assert.Equal(2, after.GetProperty("reviewed").GetInt32());
        Assert.Equal(1, after.GetProperty("firstPass").GetInt32());
    }

    /// <summary>
    /// 樣本門檻（設計 §13.4／§13.8 第 3 項）：被審查的卡片 <strong>少於 5 張</strong>時
    /// **S 只看完成率與準時率**，fpy 為 null ⇒ 該條件不列入、不影響 S。
    ///
    /// **這一支是 `fpy` null 語意的守門員**：把 `reviewed >= 5 ? (double)firstPass / reviewed : null`
    /// 的 `null` 換成任何數字，這裡就會掉出 S。
    /// 兩組資料刻意都取「有審查者、第一筆 entry 全是 rejected」⇒ firstPass = 0 ⇒
    /// 「照算不誤」的實作算出來是 0.0，低於 0.80，當場掉到 A。
    ///
    /// 資料列取 2 與 4：2 是 brief 指定的值，4 是門檻的正下方——少了 4 這一列，
    /// 一個把門檻寫成 3 的實作照樣全綠（2 與 4 都「樣本不足」的實作則擋不住 3）。
    /// </summary>
    [Theory]
    [InlineData(2)]
    [InlineData(4)]
    public async Task Rating_S_RequiresFpy_ButOnlyAboveSampleThreshold(int reviewed)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        for (var i = 0; i < reviewed; i++)
            await CreateReworkedCardAsync(listId, $"R{i}-退回後才通過", adminId);

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(reviewed, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(reviewed, member.GetProperty("reviewed").GetInt32());
        Assert.Equal(0, member.GetProperty("firstPass").GetInt32());
        Assert.Equal(JsonValueKind.Null, member.GetProperty("fpy").ValueKind);
        Assert.Equal(RatingCodes.S, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// FPY 低於 0.80 ⇒ S 的第三個條件不成立 ⇒ **A**（設計 §13.8 第 1 項）。
    ///
    /// 與上一支成對，缺一不可：只有上一支的話，「fpy 永遠回 null」的實作全綠；
    /// 只有這一支的話，「不看樣本門檻、一律照算」的實作全綠（反正這裡樣本夠）。
    ///
    /// 3/5 = 0.60；完成率與準時率都是 1.0——差異只可能在 FPY 這一格。
    /// </summary>
    [Fact]
    public async Task Rating_S_FallsToA_WhenFpyBelowThreshold()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        for (var i = 0; i < 3; i++) await CreateFirstPassCardAsync(listId, $"P{i}-一次通過", adminId);
        for (var i = 0; i < 2; i++) await CreateReworkedCardAsync(listId, $"R{i}-退回後才通過", adminId);

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(5, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(5, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(5, member.GetProperty("reviewed").GetInt32());
        Assert.Equal(3, member.GetProperty("firstPass").GetInt32());
        Assert.Equal(0.6, member.GetProperty("fpy").GetDouble(), 3);
        Assert.Equal(RatingCodes.A, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// 門檻的**等號那一格**：設計 §13.2 寫的是「一次交付通過率 **≥** 0.80」，
    /// 所以 4/5 = 0.80 恰好合格 ⇒ **S**。
    ///
    /// 上一支用的是 3/5 = 0.60，那個值對 `>=` 與 `>` **都是 A**——少了這一支，
    /// 把 `fpy >= 0.80` 改成 `fpy > 0.80` 不會有任何紅燈。兩支合起來才是「門檻在 0.80」。
    /// </summary>
    [Fact]
    public async Task Rating_S_AtFpyBoundary_StaysS()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        for (var i = 0; i < 4; i++) await CreateFirstPassCardAsync(listId, $"P{i}-一次通過", adminId);
        await CreateReworkedCardAsync(listId, "R0-退回後才通過", adminId);

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(5, member.GetProperty("reviewed").GetInt32());
        Assert.Equal(4, member.GetProperty("firstPass").GetInt32());
        Assert.Equal(0.8, member.GetProperty("fpy").GetDouble(), 3);
        Assert.Equal(RatingCodes.S, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// S 的三個條件逐一負向（設計 §13.8 第 1 項）——**準時率那一格**：
    /// 完成率 1.0（≥ 0.85）、fpy 為 null（條件不適用）、但準時率 3/4 = 0.75 &lt; 0.85 ⇒ **A**。
    ///
    /// 另外兩格各有專屬的測試（完成率＝上一支的 `(4, 3)`、fpy＝`Rating_S_FallsToA_WhenFpyBelowThreshold`），
    /// 缺了這一支的話，把 `onTimeRate >= 0.85` 整個拿掉不會有任何紅燈——而它與 fpy
    /// 一樣是複合條件的一員（§13.2：「S 本來就是複合條件，加第三個是同形的擴充」）。
    /// </summary>
    [Fact]
    public async Task Rating_FallsToA_WhenOnTimeRateBelowThreshold()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        // 沒有任何審查者 ⇒ fpy 為 null（條件不適用），所以這一支只驗準時率那一格。
        // 三張「準時」的卡片**必須帶未來截止日**（`CreateOnTimeCardAsync`）：自 2026-09-21 起
        // 沒有截止日的卡片兩邊都不進準時率 ⇒ 用 `CreateCardAsync` 會讓這一支變成「樣本不足、
        // 條件不適用」，S 反而成立，整支測試失去判別力。
        for (var i = 0; i < 3; i++) await CreateOnTimeCardAsync(listId, $"O{i}-準時");
        await CreateLateCardAsync(listId, "L0-遲交");

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(4, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(4, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(3, member.GetProperty("onTimeCards").GetInt32());
        Assert.Equal(1.0, member.GetProperty("completionRate").GetDouble(), 3);
        Assert.Equal(0.75, member.GetProperty("onTimeRate").GetDouble(), 3);
        Assert.Equal(JsonValueKind.Null, member.GetProperty("fpy").ValueKind);
        Assert.Equal(RatingCodes.A, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// 沒有審查紀錄的成員，等級與動工前完全相同（設計 §13.8 第 7 項；`AGENTS.md` 指名
    /// 給本批次的第二條輸入）。**這一支取代了設計 §8 第 7 項那條已作廢的
    /// 「績效不受審查影響」鎖**——它防的是「新公式誤傷沒有審查紀錄的人」。
    ///
    /// 期望值一律寫成**字面值**（`RatingCodes.S` 是 `const string`，不是再抄一次新公式）
    /// ——抄公式的斷言會與實作一起錯、一起綠，那正是這條迴歸鎖要防的事。
    /// 兩組 (完成率, 準時率)：4/4 = 1.0 ⇒ S；3/4 = 0.75 ⇒ A。
    ///
    /// **這一支同時是 `RatingFor` 的 `(onTimeRate is null || …)` 那一格的唯一守門員**
    /// （2026-09-21）：它的卡片都沒有截止日 ⇒ 準時率**樣本不足**（null）。少了「null 視為
    /// 條件不適用」這一半，`null >= 0.85` 在 C# 是 false ⇒ 這一位會直接掉出 S，
    /// 第一列 `(4, 4, S)` 當場變紅。第二列 (4,3) 在 A／C 的分界上，不受那個條件影響
    /// ——它守的是「新公式沒有誤傷 A」。
    /// </summary>
    [Theory]
    [InlineData(4, 4, RatingCodes.S)]
    [InlineData(4, 3, RatingCodes.A)]
    public async Task Rating_Unchanged_ForMembersWithoutReviewRecords(int total, int completed, string expected)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        // 全程不碰 `/api/cards/{id}/reviews`：這個成員沒有任何審查紀錄。
        for (var i = 0; i < total; i++)
        {
            var cardId = await CreateCardAsync(listId, $"C{i}");
            if (i < completed) await CompleteAsync(cardId);
        }

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(total, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(completed, member.GetProperty("completedCards").GetInt32());
        // 前提本身也要釘住：真的沒有任何被審查的卡片，否則這條迴歸鎖就鎖錯了對象。
        Assert.Equal(0, member.GetProperty("reviewed").GetInt32());
        Assert.Equal(JsonValueKind.Null, member.GetProperty("fpy").ValueKind);
        // 零筆樣本時 `averageScore` 是 **null**、`scoreSamples` 是 **0**（Task 11 審查的 F4）。
        // 這是 API 契約上的區分——`(null, 0)` 寫成 `(0, 0)` 在畫面上完全一樣（前端分支的鍵
        // 是 `scoreSamples`），所以少了這兩條就沒有任何紅燈。
        Assert.Equal(JsonValueKind.Null, member.GetProperty("averageScore").ValueKind);
        Assert.Equal(0, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(expected, member.GetProperty("rating").GetString());
    }

    // ---------- Task 11：主管評分的 ±1 級調整項 ----------
    //
    // 契約（設計 §13.3／§13.4）：
    //   平均分 ≥ 4.5 ⇒ 升一級；≤ 2.0 ⇒ 降一級；其餘 ⇒ 不動。**最多一級**。
    //   樣本 < 3 筆時完全不調整（樣本不足）。
    //   來源一律 `CardReviewEntry`（append-only），不是 `CardReview`（原地覆寫的當前立場）。
    //
    // 調整項是**包在 `RatingFor` 外面的獨立一層**（`ApplyScoreAdjustment`）——客觀公式
    // 不碰主觀分數（設計 §13.3 的架構決定）。三條輸出路徑（JSON／CSV／xls）共用同一個
    // `RatingForMember`，所以這些測試一律走端到端（回應裡的 `rating`）：只有端到端驗得到接線。

    /// <summary>
    /// 建 `total` 張卡、完成前 `completed` 張，再對前 `scores.Length` 張指派審查者並以
    /// `scores[i]` 分通過，回傳該成員在團隊報表上的那一列。
    ///
    /// **先完成、後評分**：交付會把審查立場重設為 pending（`ReviewEndpoints`／設計 §5.3），
    /// 順序顛倒會讓當前立場與歷史 entry 分岔。歷史 entry 不受影響（append-only），
    /// 但讓 fixture 與真實流程同序就不必倚賴那個區別。
    ///
    /// 分數逐張指定而不是一個常數，因為**門檻的等號那一格只有非整數平均分才測得到**
    /// （1–5 的整數、3 筆樣本的算術平均不可能是 4.5，要 4 筆）。
    ///
    /// `scores.Length ≤ completed`：本類別的 fixture 不對「還沒交付的卡片」送出通過。
    /// </summary>
    private async Task<JsonElement> MemberAfterScoredWorkAsync(
        string teamId, string listId, Guid memberId, int total, int completed, params int[] scores)
    {
        var cardIds = new List<string>();
        for (var i = 0; i < total; i++) cardIds.Add(await CreateCardAsync(listId, $"C{i}"));
        for (var i = 0; i < completed; i++) await CompleteAsync(cardIds[i]);
        for (var i = 0; i < scores.Length; i++)
        {
            var reviewId = await AssignReviewerAsync(cardIds[i], memberId);
            await SubmitReviewAsync(cardIds[i], reviewId, ReviewStatuses.Approved, score: scores[i]);
        }
        return await MemberRowAsync(teamId, memberId);
    }

    /// <summary>
    /// **最多一級**（設計 §13.3）。兩列的樣本都是 3 筆、平均 5.0、fpy 為 null
    /// （被審查的卡片 3 張 &lt; 5），差別只在完成率：
    ///
    ///   (4, 3)：完成率 0.75 ⇒ 本應 A ⇒ 升一級 **S**（0.75 &lt; 0.85，S 只可能來自調整項）
    ///   (6, 3)：完成率 0.50 ⇒ 本應 B ⇒ 升一級 **A**，不是 S
    ///
    /// 第二列才是「最多一級」那一格：少了它，一個「平均分 ≥ 4.5 就直接給 S」的實作全綠。
    /// </summary>
    [Theory]
    [InlineData(4, 3, RatingCodes.S)]
    [InlineData(6, 3, RatingCodes.A)]
    public async Task ScoreAdjustment_UpOneLevel_Only(int total, int completed, string expected)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var member = await MemberAfterScoredWorkAsync(teamId, listId, adminId, total, completed,
            Enumerable.Repeat(5, completed).ToArray());

        // 評等放第一條：RED 的訊息才會是「Expected S, Actual A」而不是「欄位不存在」——
        // 這一支測的是評等的行為，欄位只是它的理由。
        Assert.Equal(expected, member.GetProperty("rating").GetString());
        Assert.Equal(total, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(completed, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(3, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(5.0, member.GetProperty("averageScore").GetDouble(), 3);
    }

    /// <summary>
    /// **已經在最高一級時不再往上**（設計 §13.3；上界的判別力）。
    ///
    /// 基準評等是 **S**（完成率與準時率都是 1.0、被審查的 3 張 &lt; 5 ⇒ fpy 為 null），
    /// 平均分 5.0 ⇒ `ApplyScoreAdjustment` 會走到 `Math.Min(i + 1, RatingLadder.Length - 1)`
    /// 那一格。少了 `Math.Min` 就是 `RatingLadder[4]` ⇒ `IndexOutOfRangeException` ⇒ 報表端點 500。
    ///
    /// **這一格原本沒有任何測試**：2026-09-17 的 final whole-branch review 實測，
    /// **只**拿掉 `Math.Min` 時整個類別 28/28 全綠（下界的 `Math.Max` 則有
    /// `ScoreAdjustment_DownOneLevel_AndFloorAtC` 的 (7, 3) 守著）。
    /// `RatingLadder` 的兩端在註解裡是「最多一級」與「不會溢出」的同一份實作，
    /// 這一支補上後者。
    /// </summary>
    [Fact]
    public async Task ScoreAdjustment_AtCeiling_StaysS()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var member = await MemberAfterScoredWorkAsync(teamId, listId, adminId, 4, 4, 5, 5, 5);

        Assert.Equal(RatingCodes.S, member.GetProperty("rating").GetString());
        Assert.Equal(3, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(5.0, member.GetProperty("averageScore").GetDouble(), 3);
    }

    /// <summary>
    /// **降一級，且 C 不能再降**（設計 §13.3／§13.8 第 4 項）。兩列的樣本都是 3 筆、平均 1.0：
    ///
    ///   (5, 3)：完成率 0.60 ⇒ 本應 B ⇒ 降一級 **C**
    ///   (7, 3)：完成率 0.4286 ⇒ 本應 C ⇒ 仍是 **C**（已是最低）
    ///
    /// 第二列是下界：把 `Math.Max(i - 1, 0)` 寫成 `i - 1` 會在這裡拿到索引 -1
    /// （拋例外而不是靜默給錯等級，但仍是一支會紅的測試），寫成環繞則直接給 S。
    /// </summary>
    [Theory]
    [InlineData(5, 3, RatingCodes.C)]
    [InlineData(7, 3, RatingCodes.C)]
    public async Task ScoreAdjustment_DownOneLevel_AndFloorAtC(int total, int completed, string expected)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var member = await MemberAfterScoredWorkAsync(teamId, listId, adminId, total, completed,
            Enumerable.Repeat(1, completed).ToArray());

        Assert.Equal(expected, member.GetProperty("rating").GetString());
        Assert.Equal(3, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(1.0, member.GetProperty("averageScore").GetDouble(), 3);
    }

    /// <summary>
    /// **樣本 &lt; 3 筆時完全不調整**（設計 §13.4／§13.8 第 5 項）。
    ///
    /// 兩列是**同一個 fixture**（5 張卡、完成 3 張 ⇒ 完成率 0.60 ⇒ 本應 B），
    /// 平均分也都是 1.0（≤ 2.0），差別只在評分筆數：
    ///
    ///   2 筆 ⇒ 樣本不足 ⇒ **B**（不調整）
    ///   3 筆 ⇒ 降一級 ⇒ **C**
    ///
    /// 第二列是這支測試的判別力所在：只有第一列的話，「調整項根本是死碼」的實作也是綠的
    /// ——它證明了「沒有調整」，證明不了「該調整時會調整」。
    /// </summary>
    [Theory]
    [InlineData(2, RatingCodes.B)]
    [InlineData(3, RatingCodes.C)]
    public async Task ScoreAdjustment_Skipped_WhenSamplesBelowThree(int scored, string expected)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var member = await MemberAfterScoredWorkAsync(teamId, listId, adminId, 5, 3,
            Enumerable.Repeat(1, scored).ToArray());

        Assert.Equal(expected, member.GetProperty("rating").GetString());
        Assert.Equal(scored, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(1.0, member.GetProperty("averageScore").GetDouble(), 3);
    }

    /// <summary>
    /// **門檻就在 4.5 與 2.0 上**（設計 §13.3）——四列兩兩成對，形狀與同檔的
    /// `Rating_S_AtFpyBoundary_StaysS`（FPY 門檻的等號那一格）相同，理由也相同。
    ///
    /// 基準一律是 B（完成率 0.60 ⇒ 升一級 A／不動 B／降一級 C）：
    ///
    ///   (4,4,5,5) ⇒ 平均 **4.5** ⇒ 升一級 A　← 等號那一格：`>= 4.5` 與 `> 4.5` 的分界
    ///   (4,4,4,5) ⇒ 平均 4.25 ⇒ 不動 B　　← 4.25 不夠；把門檻寫成 4.0／4.25 的實作會紅
    ///   (2,2,3)   ⇒ 平均 2.333 ⇒ 不動 B　　← 2.333 不夠；把門檻寫成 2.5／2.3333 的實作會紅
    ///   (2,2,2)   ⇒ 平均 **2.0** ⇒ 降一級 C　← 等號那一格：`<= 2.0` 與 `< 2.0` 的分界
    ///
    /// **4 筆樣本那一列是必要的**：1–5 的整數分在 3 筆樣本下算不出 4.5（和必須是 13.5）。
    /// 少了它，「平均分 ≥ 4.5 升一級」這一條只被 5.0 這一格測過，門檻寫成 4.0 照樣全綠。
    /// </summary>
    [Theory]
    [InlineData(new[] { 4, 4, 5, 5 }, RatingCodes.A)]
    [InlineData(new[] { 4, 4, 4, 5 }, RatingCodes.B)]
    [InlineData(new[] { 2, 2, 3 }, RatingCodes.B)]
    [InlineData(new[] { 2, 2, 2 }, RatingCodes.C)]
    public async Task ScoreAdjustment_Thresholds_Are4Point5And2Point0(int[] scores, string expected)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var member = await MemberAfterScoredWorkAsync(teamId, listId, adminId, 6, 4, scores);

        Assert.Equal(expected, member.GetProperty("rating").GetString());
        Assert.Equal(scores.Length, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(scores.Average(), member.GetProperty("averageScore").GetDouble(), 3);
    }

    /// <summary>
    /// **回填列的分數不進樣本**（Task 11 審查的 F1）。
    ///
    /// 設計 §13.3 的樣本範圍是「**已通過的提交**」。3 張被審查的卡一次通過、各 5 分
    /// ⇒ 樣本 3、平均 5.0；完成率 0.75 ⇒ 本應 A ⇒ 調整後 **S**。
    /// 再加一列**回填風格**的列（`rejected` ＋ 分數 1，用 `AddBackfilledRejectedScoreAsync`
    /// 直接寫入——API 對這種組合回 400），它**不算樣本**。
    ///
    /// 判別力：述詞少了 `Status == ReviewStatuses.Approved` ⇒ 平均變成 (5+5+5+1)/4 = 4.0
    /// ⇒ 不調整 ⇒ 第一條斷言當場變紅（Expected S, Actual A）。
    /// 這一支與 `ScoreAdjustment_UpOneLevel_Only` 的 (4, 3) 那一列同一個基準（A → S），
    /// 所以它單獨測的就是「那一列有沒有被算進去」。
    /// </summary>
    [Fact]
    public async Task ScoreAdjustment_IgnoresRejectedScoresFromBackfill()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var cardIds = new List<string>();
        for (var i = 0; i < 4; i++) cardIds.Add(await CreateCardAsync(listId, $"C{i}"));
        for (var i = 0; i < 3; i++) await CompleteAsync(cardIds[i]);
        for (var i = 0; i < 3; i++)
        {
            var reviewId = await AssignReviewerAsync(cardIds[i], adminId);
            await SubmitReviewAsync(cardIds[i], reviewId, ReviewStatuses.Approved, score: 5);
        }

        // 模擬回填：這一列在「退回不可帶分數」那道 400 之前是合法的提交。
        await AddBackfilledRejectedScoreAsync(Guid.Parse(cardIds[0]), adminId, score: 1);

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(RatingCodes.S, member.GetProperty("rating").GetString());
        Assert.Equal(3, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(5.0, member.GetProperty("averageScore").GetDouble(), 3);
    }

    // ---------- 比率的「樣本不足」語意（2026-09-21，使用者回報） ----------
    //
    // 回報原文：「沒有一張完成的卡片，但準時交付率 100%，一次交付通過率和平均評分都是
    // 『樣本不足』」——同一個詞在相鄰三欄有兩種語意。
    //
    // 根因是三條輸出路徑各寫了一次的 `completed > 0 ? (double)onTime / completed : 1.0`：
    // **零樣本被寫成「100% 準時」**，而隔壁的 `fpy` 走 `FirstPassYieldOrNull`、零樣本回
    // **null**（畫面顯示「樣本不足」）。修法就是讓準時率與達成率接到同一條慣例上：
    // **沒有樣本 ⇒ null，不是 0 也不是 1**（設計 §13.4：不要靜默套用）。
    //
    // 下面六支是同一條契約的六個面：前兩支與第三支是使用者回報的那一格與它的細化，
    // 第四支是「零卡片」（使用者 2026-09-21 裁定：達成率也樣本不足、不給評等），
    // 第五支是**反向對照**（有卡片、只是沒完成 ⇒ 0.0 與 C，不是樣本不足），
    // 第六支是排序（使用者 2026-09-21 裁定：依評等，同級再依達成率）。

    /// <summary>
    /// 一張都沒交付 ⇒ 準時率是 **null**，不是 1.0。**這就是使用者回報的那一格。**
    ///
    /// 舊制 `completed > 0 ? … : 1.0` 讓零樣本顯示「100% 準時」——而同一份回應裡的
    /// `fpy` 與 `averageScore` 在零樣本時是 null（「樣本不足」），矛盾因此顯形。
    /// 完成率**不是** null：這個成員有卡片、只是都沒完成，「分母是 0」與「分子是 0」
    /// 是兩件事（後者見 `CompletionRate_IsZero_WhenHasCardsButNoneCompleted`）。
    /// </summary>
    [Fact]
    public async Task OnTimeRate_IsNull_WhenNothingDelivered()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        for (var i = 0; i < 3; i++) await CreateCardAsync(listId, $"C{i}");

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(3, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(0, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(0, member.GetProperty("onTimeCards").GetInt32());
        Assert.Equal(0, member.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(JsonValueKind.Null, member.GetProperty("onTimeRate").ValueKind);
        Assert.Equal(0.0, member.GetProperty("completionRate").GetDouble(), 3);
        // 0/3 的完成率落在 C 的區間（沒有任何審查紀錄 ⇒ 沒有調整項）。
        Assert.Equal(RatingCodes.C, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// 交付的卡片**全都沒有截止日** ⇒ 準時率樣本不足，而該條件**不列入**評等
    /// ⇒ 完成率 1.0 ＋ fpy 樣本不足 ⇒ 仍是 **S**（不是掉到 A）。
    ///
    /// 這一支釘的是 `RatingFor` 的 `(onTimeRate is null || …)`：寫成 `onTimeRate >= 0.85`
    /// 的話 `null >= 0.85` 在 C# 是 false，每一個「只交付沒有截止日的卡片」的人都會
    /// 無聲無息地掉一級。`Rating_Unchanged_ForMembersWithoutReviewRecords` 是同一件事的
    /// 另一支（那裡走的是 `[Theory]`），兩支一起才涵蓋「不列入」與「不誤傷 A」。
    /// </summary>
    [Fact]
    public async Task Rating_IsS_WhenDeliveredCardsHaveNoDueDate()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        // 沒有任何審查者 ⇒ fpy 樣本不足（條件不適用），所以這一支只驗準時率那一格。
        for (var i = 0; i < 4; i++) await CompleteAsync(await CreateCardAsync(listId, $"C{i}"));

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(4, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(0, member.GetProperty("onTimeCards").GetInt32());
        Assert.Equal(0, member.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(JsonValueKind.Null, member.GetProperty("onTimeRate").ValueKind);
        Assert.Equal(1.0, member.GetProperty("completionRate").GetDouble(), 3);
        Assert.Equal(RatingCodes.S, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// **沒有截止日的卡片兩邊都不進準時率**（使用者 2026-09-21 裁定）：
    /// 1 張有截止日且準時 ＋ 1 張有截止日遲交 ＋ 1 張無截止日但已交付
    /// ⇒ 分子 1、分母 2、準時率 **0.5**。
    ///
    /// 舊制把「無截止日」當成準時（`c.DueAt == null ||`），同一份資料會算出 **2/3 ≈ 0.667**
    /// ——分子 1 增為 2、分母 2 增為 3。**兩邊都動**，所以這一條同時釘住「分子」與「分母」：
    /// 只改分母會得到 1/3，只改分子會得到 2/2。
    ///
    /// 分母的消費端是 `onTimeSamples`（與 `firstPass`／`reviewed` 同一個道理：
    /// 原料與比率一起回傳，否則 `onTimeRate: null` 分不出是樣本不足還是別的原因）。
    /// </summary>
    [Fact]
    public async Task CardsWithoutDueDate_AreExcludedFromOnTimeRate()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        await CreateOnTimeCardAsync(listId, "O-準時");
        await CreateLateCardAsync(listId, "L-遲交");
        await CompleteAsync(await CreateCardAsync(listId, "N-無截止日"));

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(3, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(3, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(1, member.GetProperty("onTimeCards").GetInt32());
        Assert.Equal(2, member.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(0.5, member.GetProperty("onTimeRate").GetDouble(), 3);
    }

    /// <summary>
    /// 一張卡片都沒有的成員 ⇒ **達成率與準時率都是 null、也**不給評等**
    /// （使用者 2026-09-21 裁定）。
    ///
    /// `completionRate` 舊制是 `total > 0 ? … : 0` ⇒ 零卡片的人顯示「0%」並落到 **C**：
    /// 那不是「他做得不好」，是「沒有依據」，而畫面上兩者一模一樣。裁定是後者。
    ///
    /// fixture 靠**工時**把這個人帶進名冊（成員名冊是 `userCardMap ∪ memberEffortMap`）；
    /// 這也是「有工時、零卡片」唯一造得出來的方法（見 `AddEffortLogAsync`）。斷言
    /// `loggedHours` 是為了讓「他為什麼在榜上」有正向證據——少了它，這一支在名冊漏掉他時
    /// 會以 `MemberRowAsync` 的 `Single()` 拋例外收場，訊息完全指不到原因。
    /// </summary>
    [Fact]
    public async Task MemberWithoutCards_HasNoRatesAndNoRating()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var cardId = await CreateCardAsync(listId, "C1");
        var noCardsId = await CreateProjectMemberAsync(teamId, projectId, "nocards");
        await AddEffortLogAsync(cardId, noCardsId, 3.5m);

        var member = await MemberRowAsync(teamId, noCardsId);

        Assert.Equal(3.5, member.GetProperty("loggedHours").GetDouble(), 3);
        Assert.Equal(0, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(0, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(JsonValueKind.Null, member.GetProperty("completionRate").ValueKind);
        Assert.Equal(0, member.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(JsonValueKind.Null, member.GetProperty("onTimeRate").ValueKind);
        // 沒有基準就沒有調整項（`ApplyScoreAdjustment` 吃的是 `string`，null 到不了它那裡）。
        Assert.Equal(JsonValueKind.Null, member.GetProperty("rating").ValueKind);
    }

    /// <summary>
    /// **反向對照**（這一支與上一支互為兩半，缺一不可）：有卡片、只是一張都沒完成
    /// ⇒ 達成率 **0.0**、評等 **C**，**不是**「樣本不足」。
    ///
    /// 少了它，「把 0 也當成樣本不足」的過度修正不會有任何紅燈——而那會讓「做得很差」
    /// 與「沒有依據」在畫面上變成同一件事，正好是這次要修的那個矛盾的鏡像。
    /// 判準：**分母是 0 才是樣本不足，分子是 0 不是。**
    /// </summary>
    [Fact]
    public async Task CompletionRate_IsZero_WhenHasCardsButNoneCompleted()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        for (var i = 0; i < 2; i++) await CreateCardAsync(listId, $"C{i}");

        var member = await MemberRowAsync(teamId, adminId);

        Assert.Equal(2, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(0.0, member.GetProperty("completionRate").GetDouble(), 3);
        Assert.Equal(RatingCodes.C, member.GetProperty("rating").GetString());
    }

    /// <summary>
    /// 榜單排序：**依評等，同級再依達成率**（使用者 2026-09-21 裁定）。
    ///
    /// 三個成員刻意讓「評等序」與「達成率序」**不一致**，這是判別力的來源：
    ///
    ///   S  6/7 = 0.857  （全無截止日 ⇒ 準時率樣本不足 ⇒ S 成立）
    ///   A  4/4 = 1.0    （1 遲交 ＋ 3 準時 ⇒ 準時率 0.75 < 0.85 ⇒ 掉出 S）
    ///   A  5/6 = 0.833
    ///
    /// 期望 S → A(1.0) → A(0.833)。**兩個突變各自紅在不一樣的地方**：
    /// ① 沿用舊的 `OrderByDescending(completionRate)` ⇒ A(1.0) 跑到 S 前面（前兩名對調）；
    /// ② 次鍵寫成 `completedCards`（舊的次鍵）⇒ 5 > 4 讓 A(0.833) 與 A(1.0) 對調。
    ///
    /// 為什麼不是「一位 S 一位 C」：評等是達成率的階梯函數（S 要 ≥ 0.85、C 是 &lt; 0.50），
    /// 所以 S 的達成率**必然**高於 C ⇒ 那種組合在舊制下順序完全相同、一次都不會紅。
    /// **要讓「先看評等」可觀測，S 的對手必須是「達成率更高、卻因為準時率或 fpy 掉出 S」
    /// 的那種 A。**
    /// </summary>
    [Fact]
    public async Task Ranking_SortsByRatingThenByCompletionRate()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();

        var sId = await CreateProjectMemberAsync(teamId, projectId, "sMember");
        var aLowId = await CreateProjectMemberAsync(teamId, projectId, "aLowMember");

        // S：7 張、完成 6 張、全部不帶截止日（準時率樣本不足，不影響評等）。
        for (var i = 0; i < 7; i++)
        {
            var cardId = await CreateCardAsync(listId, $"S{i}");
            await AssignCardMemberAsync(cardId, sId);
            if (i < 6) await CompleteAsync(cardId);
        }

        // A（admin）：1 遲交 ＋ 3 準時 ⇒ 達成率 1.0、準時率 0.75 ⇒ 掉出 S，落在 A。
        await CreateLateCardAsync(listId, "X-遲交");
        for (var i = 0; i < 3; i++) await CreateOnTimeCardAsync(listId, $"X{i}-準時");

        // A：6 張、完成 5 張（達成率 0.833 < 1.0，但完成張數 5 > 4 ⇒ 兩種次鍵會給不同順序）。
        for (var i = 0; i < 6; i++)
        {
            var cardId = await CreateCardAsync(listId, $"W{i}");
            await AssignCardMemberAsync(cardId, aLowId);
            if (i < 5) await CompleteAsync(cardId);
        }

        var res = await _client.GetAsync($"/api/teams/{teamId}/report");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var members = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("members").EnumerateArray().ToList();

        // 先釘住三列的評等（沒有這一步，順序錯了也分不出是評等算錯還是排序寫錯）。
        Assert.Equal(new[] { RatingCodes.S, RatingCodes.A, RatingCodes.A },
            members.Select(m => m.GetProperty("rating").GetString()).ToArray());
        // 6/7 與 5/6 是無盡小數 ⇒ 逐位比較要帶精度，不能拿 double 陣列做精確相等。
        var rates = members.Select(m => m.GetProperty("completionRate").GetDouble()).ToArray();
        Assert.Equal(0.857, rates[0], 3);
        Assert.Equal(1.0, rates[1], 3);
        Assert.Equal(0.833, rates[2], 3);

        Assert.Equal(new[] { sId, adminId, aLowId },
            members.Select(m => m.GetProperty("userId").GetGuid()).ToArray());
    }

    // ---------- 窗框語意（達成率取「乙」；2026-09-21 本批） ----------
    //
    // 契約（設計 §1.3／§4；ledger D4）。窗 = [from, to)，上界排他：
    //   分母(窗) = { CreatedAt ∈ 窗 } ∪ { CompletedAt ∈ 窗 }　分子(窗) = { CompletedAt ∈ 窗 }
    // **述詞是「非該年交付」，不是「還沒交」**——後者會讓前一年建卡的數字在交付後回溯上升
    // （丙的形狀，使用者已否決）。`from`／`to` 皆 null ⇒ 分母＝全部、分子＝已交付
    // ⇒ 與加窗框之前的行為逐位相同（`Unwindowed_Report_IsUnchangedByTheYearWindow` 就是那一格）。

    /// <summary>
    /// **全期回歸鎖**：不帶 from／to 時，窗框改動前後的輸出必須逐格相同。
    /// 這支在改動前就該綠——characterization test 的判別力不在「先紅」，
    /// 在於它把「全期＝今天的行為」這條極限性質釘成契約（突變 M5 會讓它紅）。
    /// </summary>
    [Fact]
    public async Task Unwindowed_Report_IsUnchangedByTheYearWindow()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-window");

        // 混合 fixture：一張準時交付、一張已交付但無截止日、一張未交付
        var onTime = await CreateCardAsync(listId, "W-on-time");
        await AssignCardMemberAsync(onTime, dave);
        await SetDueDateAsync(onTime, "2099-01-01T00:00:00Z");
        await CompleteAsync(onTime);

        var noDue = await CreateCardAsync(listId, "W-no-due");
        await AssignCardMemberAsync(noDue, dave);
        await CompleteAsync(noDue);

        var open = await CreateCardAsync(listId, "W-open");
        await AssignCardMemberAsync(open, dave);

        var row = await MemberRowAsync(teamId, dave);
        Assert.Equal(3, row.GetProperty("totalCards").GetInt32());
        Assert.Equal(2, row.GetProperty("completedCards").GetInt32());
        Assert.Equal(1, row.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(1, row.GetProperty("onTimeCards").GetInt32());
    }

    /// <summary>
    /// 把 `Card.CreatedAt` 直接寫成 `utc`。
    ///
    /// **API 造不出過去的建卡時間**（`POST /api/lists/{id}/cards` 一律蓋 `DateTime.UtcNow`），
    /// 而窗框的測試需要「2026 建、2027 交付」這種卡片；繞過端點直接進 `DbContext`
    /// 是唯一的路（手法與 `AddEffortLogAsync` 相同）。
    ///
    /// `Card` 沒有 query filter（全庫唯一的 `HasQueryFilter` 在 `CardReview`，
    /// `EntaskDbContext.cs:105`）⇒ 不需要 `IgnoreQueryFilters()`。`SaveChangesAsync`
    /// 也沒有覆寫或攔截器（實查 `src/` 的 `SaveChanges` 覆寫與 `Interceptor`）⇒
    /// 不會有 audit 欄位被連帶改寫；`UpdatedAt` 就算被改也不影響窗框
    /// （窗框只讀 `CreatedAt`／`CompletedAt`）。
    /// </summary>
    private async Task ForceCreatedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.CreatedAt = utc;
        await db.SaveChangesAsync();
    }

    /// <summary>同 `ForceCreatedAtAsync`，改的是 `CompletedAt`（交付日）。</summary>
    private async Task ForceCompletedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.CompletedAt = utc;
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// 把某張卡**第一筆** `CardReviewEntry` 的 `CreatedAt` 直接寫成 `utc`。
    ///
    /// **API 造不出過去的打分時間**（提交一律蓋 `DateTime.UtcNow`），而「2026 交付的卡、
    /// 2027 初才打分」正是本批的動機情境 ⇒ 繞過端點直接進 `DbContext` 是唯一的路
    /// （手法與 `ForceCreatedAtAsync` 相同）。呼叫端負責確保該卡只有一筆 entry。
    /// </summary>
    private async Task ForceReviewEntryCreatedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var entry = await db.CardReviewEntries.FirstAsync(e => e.CardId == Guid.Parse(cardId));
        entry.CreatedAt = utc;
        await db.SaveChangesAsync();
    }

    // xls 是手寫的 SpreadsheetML。資料列一律是 `<Row>`（表頭那一列帶 ss:Height ⇒ 不命中），
    // 每一格是 `<Cell …>…</Cell>` 或自閉合的 `<Cell …/>`（沒有 <Data> 的空格：樣本不足的
    // 比率格與零卡片的評等格都是這一種）。
    private static readonly Regex ExcelRows = new("<Row>(.*?)</Row>", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex ExcelCells = new("<Cell ([^>]*?)(/>|>(.*?)</Cell>)", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex ExcelCellText = new("<Data [^>]*>(.*?)</Data>", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex ExcelStyleId = new("ss:StyleID=\"([^\"]+)\"", RegexOptions.Compiled);

    /// <summary>
    /// T8：JSON／CSV／xls **三條輸出路徑必須同源**——同一組 `from`／`to` 之下，匯出檔的每一格
    /// 都要等於畫面上那一列的值。
    ///
    /// 三條路徑各自有一份卡片窗與一個 `CardStats` 呼叫端（原本三處都錨 `CreatedAt`、都傳全期）
    /// ——**只改了 JSON 的話，畫面是該年、匯出檔是全期，而沒有任何閘門看得到它**（兩支既有的
    /// 匯出測試都不帶窗框，帶了也只看 content-type 與表頭）。
    ///
    /// fixture 用 T1／T2 的跨年卡（建於 2026-12-20、交付於 2027-01-05）：**只有它的兩年給出
    /// 不同的答案**，而兩年各擋一種「只改半套」：
    /// * **2026 窗**——卡片建於窗內、交付於窗外 ⇒ JSON 是 0.0 %／C。查詢改了而 `CardStats`
    ///   留在全期的實作會說 100.0 %／S（分子把窗外交付的那張算進去了）。
    /// * **2027 窗**——卡片靠交付日進分母 ⇒ JSON 是 100.0 %／S。`CardStats` 改了而查詢仍錨
    ///   `CreatedAt` 的實作**整張卡都撈不到** ⇒ 匯出檔連這一列都沒有。
    ///
    /// 每一年的斷言都同時涵蓋 CSV 與 xls——只接了一條匯出路徑也會紅。
    /// </summary>
    [Fact]
    public async Task ThreeOutputPaths_AgreeOnTheSameWindow()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-3paths");

        var card = await CreateCardAsync(listId, "W-cross-year");
        await AssignCardMemberAsync(card, dave);
        await ForceCreatedAtAsync(card, new DateTime(2026, 12, 20, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(card);
        await ForceCompletedAtAsync(card, new DateTime(2027, 1, 5, 0, 0, 0, DateTimeKind.Utc));

        await AssertExportPathsAgreeWithJsonAsync(teamId, dave, "dave-3paths",
            "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        await AssertExportPathsAgreeWithJsonAsync(teamId, dave, "dave-3paths",
            "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
    }

    /// <summary>
    /// 同一個窗框下，CSV 與 xls 的每一格都必須等於 JSON 那一列的值。比的是**值**（張數、達成率、
    /// 評等）——三種格式的**呈現**各有各的既有測試，這裡只問「同一個窗框是不是同一份統計」。
    /// </summary>
    private async Task AssertExportPathsAgreeWithJsonAsync(string teamId, Guid userId, string username,
        string from, string to)
    {
        var json = await MemberRowAsync(teamId, userId, from, to);
        var total = json.GetProperty("totalCards").GetInt32();
        var completed = json.GetProperty("completedCards").GetInt32();
        var rate = json.GetProperty("completionRate");
        var rating = json.GetProperty("rating").GetString();
        Assert.Equal(JsonValueKind.Number, rate.ValueKind);   // 這個 fixture 的分母是 1，不是 0

        // CSV：九欄，第 4～7 欄是 Rating／CompletedCards／TotalCards／CompletionRate。
        // `Username`／`DisplayName` 不含逗號（見 `CreateProjectMemberAsync`），直接切欄不會錯位。
        var csvLine = (await FetchAsync($"/api/teams/{teamId}/report/export{WindowQuery(from, to)}"))
            .Split('\n').Select(l => l.TrimEnd('\r'))
            .FirstOrDefault(l => l.StartsWith(userId.ToString()));
        Assert.True(csvLine is not null, $"{from}～{to}：CSV 沒有 {userId} 的那一列");
        var csv = csvLine!.Split(',');
        Assert.Equal(total.ToString(CultureInfo.InvariantCulture), csv[5]);
        Assert.Equal(completed.ToString(CultureInfo.InvariantCulture), csv[4]);
        // 比率欄的格式是 `P1` ＋ InvariantCulture（端點那一側相同的呼叫），不是自己另訂一個。
        Assert.Equal(rate.GetDouble().ToString("P1", CultureInfo.InvariantCulture), csv[6]);
        Assert.Equal(rating ?? "", csv[3]);

        // xls：沒有 userId 欄，只能用名稱認列。
        var xls = ExcelRowOf(await FetchAsync($"/api/teams/{teamId}/report/export-excel{WindowQuery(from, to)}"),
            username);
        Assert.Equal(8, xls.Count);   // Username／DisplayName／Rating／Completed／Total／兩個比率／Hours
        Assert.Equal(total.ToString(CultureInfo.InvariantCulture), xls[4].Text);
        Assert.Equal(completed.ToString(CultureInfo.InvariantCulture), xls[3].Text);
        Assert.Equal(rate.GetDouble().ToString(CultureInfo.InvariantCulture), xls[5].Text);
        // 評等格另外釘樣式：沒有評等的那一格仍是 `DataCell`（不是某個 Rating 色）。
        Assert.Equal(rating is null ? "DataCell" : $"Rating{rating}", xls[2].StyleId);
    }

    /// <summary>
    /// xls 裡某位成員的那一列，逐格回傳 (StyleID, 文字)——沒有 `&lt;Data&gt;` 的空格文字是空字串。
    /// 找不到該列時直接拋 `XunitException`：**這一條本身就是契約的一半**（查詢若整批撈不到卡片，
    /// 匯出檔裡不會有這個人——那正是「只改了 `CardStats`、沒改查詢」的長相）。
    /// </summary>
    private static List<(string StyleId, string Text)> ExcelRowOf(string xml, string username)
    {
        foreach (Match row in ExcelRows.Matches(xml))
        {
            var cells = ExcelCells.Matches(row.Groups[1].Value).Cast<Match>().ToList();
            if (cells.Count == 0) continue;
            var first = ExcelCellText.Match(cells[0].Groups[3].Value);
            if (!first.Success || first.Groups[1].Value != username) continue;

            return cells.Select(c => (
                StyleId: ExcelStyleId.Match(c.Groups[1].Value).Groups[1].Value,
                Text: ExcelCellText.Match(c.Groups[3].Value) is { Success: true } data ? data.Groups[1].Value : ""
            )).ToList();
        }
        throw new Xunit.Sdk.XunitException($"xls 裡沒有 {username} 的那一列");
    }

    /// <summary>T1／T2：跨年交付的卡——建卡年進分母、交付年進分子，且**真值不漂移**。</summary>
    [Fact]
    public async Task CrossYearCard_CountsInCreationYearDenominator_AndDeliveryYearNumerator()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-cross");

        var card = await CreateCardAsync(listId, "W-cross-year");
        await AssignCardMemberAsync(card, dave);
        await ForceCreatedAtAsync(card, new DateTime(2026, 12, 20, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(card);
        await ForceCompletedAtAsync(card, new DateTime(2027, 1, 5, 0, 0, 0, DateTimeKind.Utc));

        var y2026 = await MemberRowAsync(teamId, dave, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(1, y2026.GetProperty("totalCards").GetInt32());      // 分母有它
        Assert.Equal(0, y2026.GetProperty("completedCards").GetInt32());  // 分子沒有它

        var y2027 = await MemberRowAsync(teamId, dave, "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
        Assert.Equal(1, y2027.GetProperty("totalCards").GetInt32());
        Assert.Equal(1, y2027.GetProperty("completedCards").GetInt32());
    }

    /// <summary>
    /// T3：該年建卡而未在該年交付 ⇒ 進分母、不進分子。
    ///
    /// 判別力在「分母也是交付年」那個突變上（設計 §1.3 說達成率會恆為 1.0、B／C 變成不可達）：
    /// 分母若只看 `CompletedAt ∈ 窗`，這張從未交付的卡根本不在清單裡，
    /// 而它既是唯一的一張 ⇒ 成員連列都不存在（`MemberRowAsync` 的 `Single()` 當場拋例外）。
    /// </summary>
    [Fact]
    public async Task CardCreatedInYearButNotDelivered_IsInDenominatorOnly()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-open");

        var card = await CreateCardAsync(listId, "W-open-in-year");
        await AssignCardMemberAsync(card, dave);
        await ForceCreatedAtAsync(card, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        // 不交付——它只在分母裡。

        var y2026 = await MemberRowAsync(teamId, dave, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(1, y2026.GetProperty("totalCards").GetInt32());
        Assert.Equal(0, y2026.GetProperty("completedCards").GetInt32());
        // 「有卡片但一張都沒完成是 0.0，不是 null」（分母是 0 才是樣本不足，分子是 0 不是）
        Assert.Equal(0.0, y2026.GetProperty("completionRate").GetDouble(), 3);
    }

    /// <summary>
    /// T4：準時率的樣本只算「該年交付」的卡（窗外交付的卡不進樣本）。
    /// **少了這一條，「窗外交付的卡」會混進樣本而沒有任何紅燈**
    /// ——那張卡的建卡年在窗內（分母有它），交付年在窗外（分子與樣本都不該有它）。
    ///
    /// 兩張卡都建於 2026：一張 2026 交付且準時（截止日在未來 ⇒ 進樣本、算準時）、
    /// 一張 2027 交付且遲交（截止日在過去 ⇒ **不進 2026 的樣本**）。
    /// 2027 那一半是它的反面：該卡在 2027 進分子、進樣本、算遲交。
    /// </summary>
    [Fact]
    public async Task OnTimeSamples_OnlyCountCardsDeliveredInsideTheWindow()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-ontime");

        var onTime = await CreateCardAsync(listId, "W-2026-on-time");
        await AssignCardMemberAsync(onTime, dave);
        await SetDueDateAsync(onTime, "2099-01-01T00:00:00Z");
        await ForceCreatedAtAsync(onTime, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(onTime);
        await ForceCompletedAtAsync(onTime, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));

        var late2027 = await CreateCardAsync(listId, "W-2027-late");
        await AssignCardMemberAsync(late2027, dave);
        await SetDueDateAsync(late2027, "2020-01-01T00:00:00Z");
        await ForceCreatedAtAsync(late2027, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(late2027);
        await ForceCompletedAtAsync(late2027, new DateTime(2027, 3, 1, 0, 0, 0, DateTimeKind.Utc));

        var y2026 = await MemberRowAsync(teamId, dave, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(2, y2026.GetProperty("totalCards").GetInt32());      // 兩張都建於 2026
        Assert.Equal(1, y2026.GetProperty("completedCards").GetInt32());  // 只有一張交付於 2026
        Assert.Equal(1, y2026.GetProperty("onTimeSamples").GetInt32());   // 窗外交付的那張不進樣本
        Assert.Equal(1, y2026.GetProperty("onTimeCards").GetInt32());
        Assert.Equal(1.0, y2026.GetProperty("onTimeRate").GetDouble(), 3);

        var y2027 = await MemberRowAsync(teamId, dave, "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
        Assert.Equal(1, y2027.GetProperty("totalCards").GetInt32());      // 只有那張跨年卡的交付年在 2027
        Assert.Equal(1, y2027.GetProperty("completedCards").GetInt32());
        Assert.Equal(1, y2027.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(0, y2027.GetProperty("onTimeCards").GetInt32());
        Assert.Equal(0.0, y2027.GetProperty("onTimeRate").GetDouble(), 3);
    }

    /// <summary>
    /// T5：2026 交付的卡、2027 初才打的分數 ⇒ 算 2026。
    ///
    /// 錨在**打分時間**會把它推到 2027——而那正是本批的動機情境（2027 初打 2026 考績）；
    /// 錨在**建卡時間**則是這批改動之前的行為，它會推到 2025。三個年份各擋一種錨，
    /// 所以三條斷言都要有：只驗 2026 那一格的話，「錨在提交時間」與正確實作看不出分別。
    ///
    /// 2025 與 2027 兩格要撈得到成員的那一列（`MemberRowAsync` 的 `Single` 找不到就拋），
    /// 而成員是靠該年的分母進榜的：卡片自己撐住 2025（建於 2025），另備一張**建於 2027**
    /// 的載體卡撐住 2027（它不帶審查者 ⇒ 對 FPY 與評分都無樣本貢獻）。
    /// </summary>
    [Fact]
    public async Task ReviewStats_FollowTheCardDeliveryYear_NotTheScoringTime()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-review-anchor");

        // 建於 2025-06、交付於 2026-06、分數 2027-01 才提交（approved ＋ 5 分）。
        var card = await CreateCardAsync(listId, "R-delivered-2026");
        await AssignCardMemberAsync(card, dave);
        var reviewId = await AssignReviewerAsync(card, adminId);
        await ForceCreatedAtAsync(card, new DateTime(2025, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(card);
        await SubmitReviewAsync(card, reviewId, ReviewStatuses.Approved, score: 5);
        await ForceCompletedAtAsync(card, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        await ForceReviewEntryCreatedAtAsync(card, new DateTime(2027, 1, 15, 0, 0, 0, DateTimeKind.Utc));

        var carrier = await CreateCardAsync(listId, "R-carrier-2027");
        await AssignCardMemberAsync(carrier, dave);
        await ForceCreatedAtAsync(carrier, new DateTime(2027, 3, 1, 0, 0, 0, DateTimeKind.Utc));

        // 交付年 ⇒ 有樣本（放第一條：RED 的訊息才是「Expected 1, Actual 0」而不是欄位不存在）
        var y2026 = await MemberRowAsync(teamId, dave, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(1, y2026.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(5.0, y2026.GetProperty("averageScore").GetDouble(), 3);

        // 建卡年 ⇒ 無樣本（錨在 `Card.CreatedAt` 的實作在這裡紅）
        var y2025 = await MemberRowAsync(teamId, dave, "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
        Assert.Equal(0, y2025.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(JsonValueKind.Null, y2025.GetProperty("averageScore").ValueKind);

        // 打分年 ⇒ 無樣本（錨在「提交時間」的實作在這裡紅）
        var y2027 = await MemberRowAsync(teamId, dave, "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
        Assert.Equal(0, y2027.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(JsonValueKind.Null, y2027.GetProperty("averageScore").ValueKind);
    }

    /// <summary>
    /// FPY 的母體改變：**有窗框時，未交付的卡離開樣本**（設計 §4.4）。
    ///
    /// 今天 FPY 只要求 `c.Reviews.Any()`（曾指派過審查者），不問交付 ⇒ 未交付的卡也在樣本裡。
    /// 改錨 `Card.CompletedAt` 之後，未交付的卡（`CompletedAt == null`）沒有年份 ⇒ 離開樣本。
    /// 兩位成員分開驗兩個方向（一列一人，互不干擾）：
    ///
    /// * **dave（母體變小）**：5 張 2026 交付（指派了審查者、從未提交 ⇒ 只進分母）
    ///   ＋ 1 張 2026 建、**未交付**、已通過。有窗框時 reviewed 是 **5 不是 6**、
    ///   firstPass 是 **0 不是 1**；全期仍是 6／1（沒有述詞可加 ⇒ 與今天逐位相同）。
    /// * **erin（樣本跨門檻 ⇒ S 資格改變）**：5 張 **2025 建、2026 交付**（指派了、從未提交）。
    ///   改錨**之前**，2026 窗的樣本是「建於 2026 且有審查者」＝空集合 ⇒ fpy 為 null
    ///   ⇒ 該條件不列入（完成率 1.0、準時率無樣本）＝ **S**；改錨之後樣本是那 5 張
    ///   ⇒ fpy ＝ 0.0 &lt; 0.80 ⇒ **A**。本 task 唯一動到 S 資格的改動就是這條述詞。
    ///
    /// **未交付的卡離開樣本，有兩條通往降級的路**（原本這裡寫成「另一邊的差別是**動不了評等**」
    /// ——**那句是錯的**，Task 4 review 給出反例後改寫）：
    /// * ① **門檻那一跨**（樣本 < 5 ⇒ fpy 為 null）：fpy 由數字變成 null 只是讓該條件
    ///   **不列入**（見 `RatingFor`：null 是「沒有樣本」）⇒ **fpy 這一側不降級**。
    ///   dave 是這一跨的變體——他那 1 張離開後樣本是 5 不是 4，所以連門檻都沒跨。
    /// * ② **值那一跨**（離開的是**通過**的卡、樣本仍 ≥ 5）：fpy 由 0.80 掉到 0.778
    ///   ⇒ 該條件由「滿足」變成「不滿足」⇒ **降級**。觀測在下一支
    ///   `FirstPassYield_ValueCrossing_DropsRatingFromS_WhenUndeliveredPassLeavesSample`
    ///   （同一個 fixture 查兩次：全期 8/10 ＝ 0.80 ⇒ S、2026 窗 7/9 ＝ 0.778 ⇒ A）。
    /// 另一邊（erin）是反方向——「交付在窗內、建卡在窗外」讓樣本從無到有、把 fpy
    /// 從 null 變成數字。
    /// </summary>
    [Fact]
    public async Task FirstPassYield_ExcludesUndeliveredCards_WhenWindowed()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();
        var dave = await CreateProjectMemberAsync(teamId, projectId, "dave-fpy-window");
        var erin = await CreateProjectMemberAsync(teamId, projectId, "erin-fpy-window");

        // dave：5 張建於 2026-06、交付於 2026-08，審查者指派了卻從未提交
        for (var i = 0; i < 5; i++)
        {
            var cardId = await CreateCardAsync(listId, $"F-dave-{i}");
            await AssignCardMemberAsync(cardId, dave);
            await AssignReviewerAsync(cardId, adminId);
            await ForceCreatedAtAsync(cardId, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
            await CompleteAsync(cardId);
            await ForceCompletedAtAsync(cardId, new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc));
        }

        // dave：1 張建於 2026、**從未交付**、已通過——改錨前它進分母也進分子。
        // 提交審查不要求先交付（`ReviewEndpoints` 只驗狀態與分數），所以這條路走得通。
        var undelivered = await CreateCardAsync(listId, "F-dave-undelivered");
        await AssignCardMemberAsync(undelivered, dave);
        var undeliveredReview = await AssignReviewerAsync(undelivered, adminId);
        await ForceCreatedAtAsync(undelivered, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        await SubmitReviewAsync(undelivered, undeliveredReview, ReviewStatuses.Approved);

        // erin：5 張**建於 2025-06**、交付於 2026-08，審查者指派了卻從未提交
        for (var i = 0; i < 5; i++)
        {
            var cardId = await CreateCardAsync(listId, $"F-erin-{i}");
            await AssignCardMemberAsync(cardId, erin);
            await AssignReviewerAsync(cardId, adminId);
            await ForceCreatedAtAsync(cardId, new DateTime(2025, 6, 1, 0, 0, 0, DateTimeKind.Utc));
            await CompleteAsync(cardId);
            await ForceCompletedAtAsync(cardId, new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc));
        }

        // 全期＝今天的行為（沒有窗框就沒有述詞可加）：未交付那張仍在樣本裡，6／1。
        var allPeriod = await MemberRowAsync(teamId, dave);
        Assert.Equal(6, allPeriod.GetProperty("reviewed").GetInt32());
        Assert.Equal(1, allPeriod.GetProperty("firstPass").GetInt32());

        // dave 有窗框 ⇒ 未交付那張離開樣本（分母仍有它：分母是「乙」，建卡日在窗內）
        var daveRow = await MemberRowAsync(teamId, dave, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(5, daveRow.GetProperty("reviewed").GetInt32());
        Assert.Equal(0, daveRow.GetProperty("firstPass").GetInt32());
        Assert.Equal(0.0, daveRow.GetProperty("fpy").GetDouble(), 3);
        Assert.Equal(6, daveRow.GetProperty("totalCards").GetInt32());
        Assert.Equal(5, daveRow.GetProperty("completedCards").GetInt32());

        // erin：交付在窗內、建卡在窗外 ⇒ 樣本由無到 5 筆 ⇒ 跨過 5 筆門檻、S 變 A
        var erinRow = await MemberRowAsync(teamId, erin, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(5, erinRow.GetProperty("reviewed").GetInt32());
        Assert.Equal(0, erinRow.GetProperty("firstPass").GetInt32());
        Assert.Equal(1.0, erinRow.GetProperty("completionRate").GetDouble(), 3);
        Assert.Equal(0.0, erinRow.GetProperty("fpy").GetDouble(), 3);
        Assert.Equal(RatingCodes.A, erinRow.GetProperty("rating").GetString());
    }

    /// <summary>
    /// FPY 的**值那一跨**：離開樣本的那張卡是**通過**的，而樣本**仍 ≥ 5**
    /// ⇒ `FirstPassYieldOrNull` 不會把它變成 null，於是 `7/9 = 0.778 &lt; 0.80`
    /// 是**值**的跨越、不是門檻的跨越 ⇒ **評等由 S 落到 A**。
    /// （Task 4 review 的反例；原本的錯誤敘述說這個方向「動不了評等」。）
    ///
    /// **觀測形式刻意不需要任何突變**：同一個 fixture 查兩次，唯一差別是窗框。
    /// 全期（無界線 ⇒ 未交付那張仍在樣本裡）：樣本 **10**、分子 **8**（7 張交付通過
    /// ＋ 那 1 張未交付就通過）、fpy `8/10 = 0.80`（**`>= 0.80` 成立**）⇒ **S**；
    /// 2026 窗：未交付那張沒有交付年 ⇒ 離開樣本 ⇒ 樣本 **9**、分子 **7**、fpy `0.778` ⇒ **A**。
    ///
    /// 兩側的其餘輸入刻意不動，降級因此唯一可能來自 FPY：
    /// 完成率兩邊都是 `9/10 = 0.9`（乙＝建卡在窗內，10 張全在；9 張已交付）；
    /// 9 張都沒有截止日 ⇒ 準時率**無樣本、不列入**；分數 0 筆 ⇒ 調整項不進場
    /// （`ApplyScoreAdjustment` 的 `scoreSamples &lt; 3`）。
    /// </summary>
    [Fact]
    public async Task FirstPassYield_ValueCrossing_DropsRatingFromS_WhenUndeliveredPassLeavesSample()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        var adminId = await AdminUserIdAsync();
        var frank = await CreateProjectMemberAsync(teamId, projectId, "frank-fpy-value-crossing");

        // 7 張：2026-06 建、2026-08 交付、第一筆 entry 即 approved（進樣本也進分子）
        for (var i = 0; i < 7; i++)
        {
            var cardId = await CreateCardAsync(listId, $"V-pass-{i}");
            await AssignCardMemberAsync(cardId, frank);
            var reviewId = await AssignReviewerAsync(cardId, adminId);
            await ForceCreatedAtAsync(cardId, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
            await CompleteAsync(cardId);
            await SubmitReviewAsync(cardId, reviewId, ReviewStatuses.Approved);
            await ForceCompletedAtAsync(cardId, new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc));
        }

        // 2 張：2026-06 建、2026-08 交付、審查者指派了卻從未提交（進樣本、不進分子）
        for (var i = 0; i < 2; i++)
        {
            var cardId = await CreateCardAsync(listId, $"V-noreview-{i}");
            await AssignCardMemberAsync(cardId, frank);
            await AssignReviewerAsync(cardId, adminId);
            await ForceCreatedAtAsync(cardId, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
            await CompleteAsync(cardId);
            await ForceCompletedAtAsync(cardId, new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc));
        }

        // 1 張：2026-06 建、**從未交付**、第一筆 entry 即 approved——就是「值那一跨」的那一張。
        // 提交審查不要求先交付，所以這條路走得通（與上一支的 dave 同一手法）。
        var undelivered = await CreateCardAsync(listId, "V-undelivered-pass");
        await AssignCardMemberAsync(undelivered, frank);
        var undeliveredReview = await AssignReviewerAsync(undelivered, adminId);
        await ForceCreatedAtAsync(undelivered, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        await SubmitReviewAsync(undelivered, undeliveredReview, ReviewStatuses.Approved);

        // 全期：樣本 10、分子 8 ⇒ fpy 0.80 ⇒ S
        var allPeriod = await MemberRowAsync(teamId, frank);
        Assert.Equal(10, allPeriod.GetProperty("reviewed").GetInt32());
        Assert.Equal(8, allPeriod.GetProperty("firstPass").GetInt32());
        Assert.Equal(0.8, allPeriod.GetProperty("fpy").GetDouble(), 3);
        Assert.Equal(0.9, allPeriod.GetProperty("completionRate").GetDouble(), 3);
        Assert.Equal(RatingCodes.S, allPeriod.GetProperty("rating").GetString());

        // 2026 窗：未交付那張離開樣本（樣本 9，仍 ≥ 5 ⇒ 不是門檻那一跨）⇒ fpy 0.778 ⇒ A
        var windowed = await MemberRowAsync(teamId, frank, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
        Assert.Equal(9, windowed.GetProperty("reviewed").GetInt32());
        Assert.Equal(7, windowed.GetProperty("firstPass").GetInt32());
        Assert.Equal(0.778, windowed.GetProperty("fpy").GetDouble(), 3);
        Assert.Equal(0.9, windowed.GetProperty("completionRate").GetDouble(), 3);
        Assert.Equal(10, windowed.GetProperty("totalCards").GetInt32());
        Assert.Equal(9, windowed.GetProperty("completedCards").GetInt32());
        Assert.Equal(RatingCodes.A, windowed.GetProperty("rating").GetString());
    }

    /// <summary>
    /// T6：`availableYears` ＝**資料涵蓋的年份**、由大到小，且**不因伺服器時鐘而含今年**
    /// （設計 §5.3／D3：後端不得讀時鐘判年份）。
    ///
    /// fixture **刻意偏離 brief 的字面版本**（2026 建、2027 交付）：本機的「今年」就是 2026，
    /// 照抄那份 fixture 的話「不含今年」這條斷言**恆真**——資料自己把今年帶進來了，
    /// 驗不到時鐘洩漏。所以每一張卡都放在**非今年**的年份，期望值因此完全由資料決定：
    /// 一張建於 2021、交付於 2022（**兩個年份各撐住一半的查詢**），一張建於 2023、從未交付
    /// （只有建卡年那一半）。`[2023, 2022, 2021]`。
    ///
    /// 三種壞實作各有各的紅燈（精確相等 ＋ 缺席兩條一起）：
    /// * **讀時鐘把今年併進來** ⇒ 清單多一個 2026（精確相等紅）**且** 2026 在結果裡（缺席紅）；
    /// * **少了交付年那一半** ⇒ `[2023, 2021]`（精確相等紅）；
    /// * **排序反了** ⇒ `[2021, 2022, 2023]`（精確相等紅）。
    ///
    /// 與 brief 那句「不含未來年份」的關係：清單**不為未來年份保留位置**——資料裡沒有 2024
    /// 以後的年份，清單裡就不會有；真的有的話它會在，那正是「由資料決定」的意思。
    ///
    /// `DateTime.Now.Year` 是**測試自己讀機器的年份**去檢查它的缺席——那正是契約要驗的
    /// 那一件事（後端沒有讀時鐘的權利），不是實作端的讀取。
    ///
    /// **M-6 補的那一半（2026-09-22，final review）**：上面全部不帶 `from`／`to`，而全期下
    /// `DenominatorClause()` 恆真 ⇒ 「`availableYears` 與窗框無關」這條**刻意保留**的性質
    /// 在此之前沒有守門員（接到已加窗的查詢也照綠）。所以同一支測試再帶一個窗取一次，
    /// 斷言同一組年份，並以 `summary.totalCards` 對照窗框真的生效。
    /// </summary>
    [Fact]
    public async Task AvailableYears_ComeFromDataOnly()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();

        // 建於 2021、交付於 2022：建卡年與交付年各來自不同的一半。
        var delivered = await CreateCardAsync(listId, "Y-delivered");
        await ForceCreatedAtAsync(delivered, new DateTime(2021, 3, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(delivered);   // 先交付（端點會蓋上今天的時間戳）再改寫成交付年
        await ForceCompletedAtAsync(delivered, new DateTime(2022, 5, 1, 0, 0, 0, DateTimeKind.Utc));

        // 建於 2023、從未交付：**只有建卡年**在資料裡（少了建卡年那一半就整年漏掉）。
        var open = await CreateCardAsync(listId, "Y-open");
        await ForceCreatedAtAsync(open, new DateTime(2023, 7, 1, 0, 0, 0, DateTimeKind.Utc));

        var res = await _client.GetAsync($"/api/teams/{teamId}/report");
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        var years = (await res.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("availableYears").EnumerateArray().Select(y => y.GetInt32()).ToList();

        // 精確相等：降冪、兩半的聯集、不多不少，全在這一條裡。
        Assert.Equal(new[] { 2023, 2022, 2021 }, years);
        // 契約的另一半：今年**不在**裡面（後端若讀了時鐘把它併進來，這裡紅）。
        Assert.DoesNotContain(DateTime.Now.Year, years);

        // ---- M-6：窗框無關性（2026-09-22，final review）----
        // 上面那一組**不帶** `from`／`to`，而全期下 `DenominatorClause()` 恆真
        // ⇒ 把 `availableYears` 接到**已加窗**的 `cardsQuery` 也照綠——「與窗框無關」
        // 這條性質在此之前沒有守門員。帶一個真的排除掉資料的窗再取一次。
        // 窗＝2023 曆年：窗內只剩「建於 2023、從未交付」那一張（另兩張整張落在窗外）。
        var windowedRes = await _client.GetAsync(
            $"/api/teams/{teamId}/report?from=2023-01-01T00:00:00Z&to=2024-01-01T00:00:00Z");
        Assert.True(windowedRes.IsSuccessStatusCode, await windowedRes.Content.ReadAsStringAsync());
        var windowedBody = await windowedRes.Content.ReadFromJsonAsync<JsonElement>();

        // **對照：窗框真的生效了。** 少了這一條，一個完全不看 `from`／`to` 的實作也會讓
        // 下面那條年份斷言成立——測不到東西的綠燈與正確的綠燈長得一樣。
        Assert.Equal(1, windowedBody.GetProperty("summary").GetProperty("totalCards").GetInt32());

        var windowedYears = windowedBody.GetProperty("availableYears")
            .EnumerateArray().Select(y => y.GetInt32()).ToList();
        Assert.Equal(years, windowedYears);
    }

    /// <summary>
    /// T7：窗框的兩個邊界瞬間——交付時間**恰為 `to` ⇒ 不含**（排他上界）、**恰為 `from` ⇒ 含**。
    ///
    /// 兩張卡的建卡日都在窗內 ⇒ 分母都是 2（`to` 那張靠建卡日進分母）。於是**分子**一分為二：
    /// 上界寫成 `&lt;=` 時恰在 `to` 的那張會進來（completed = 2）、下界寫成 `&gt;` 時恰在
    /// `from` 的那張會掉出去（completed = 0）。`ReportWindowTests` 的絕對值格點測試釘住
    /// 同一條界線的**單元**層；這一支釘的是它真的接進了查詢（DB 與 Npgsql 這一側）。
    ///
    /// **第二列（naive 字串，無時區標記）釘的是 Kind 正規化的那一半**：它與帶 `Z` 的那一列
    /// 落在同一格 ⇒ 斷言完全相同、不得 500。第一次量測時它**紅**，而紅的地點暴露了一件事：
    /// 那個 500 不出自 `ReportWindow.Create` 的正規化（拿掉正規化，紅在同一個地方），
    /// 而出自三對**吃原始 `from`／`to`** 的工時窗（`TeamReportEndpoints.cs` 的
    /// `e.LoggedAt &gt;= from`／`e.LoggedAt &lt; to`，JSON／CSV／xls 各一對）——它們不經
    /// `ReportWindow`，正規化蓋不到。修正輪把三處改成餵已正規化的 `window.From`／`window.To`
    /// （各一行；帶 `Z` 時逐位等價），這一列才回得到這裡。CSV／xls 兩條匯出路徑另有
    /// `ExportEndpoints_AcceptNaiveWindowStrings` 釘住。實測細節見 `task-6-report.md`。
    /// </summary>
    [Theory]
    [InlineData("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")]
    [InlineData("2026-01-01T00:00:00", "2027-01-01T00:00:00")]
    public async Task WindowBoundary_IsExclusiveAtTo(string from, string to)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        // `WithDbReset()` 是 per-class：同一支 theory 的各列共用一個資料庫 ⇒ 帳號逐列不同，
        // 否則第二列紅在「Username … already taken」——那不是這一支要驗的東西。
        var dave = await CreateProjectMemberAsync(teamId, projectId,
            $"dave-boundary-{(from.EndsWith('Z') ? "z" : "naive")}");

        // 恰在 from 交付 ⇒ 在窗內的最前一刻，算。
        var atFrom = await CreateCardAsync(listId, "B-at-from");
        await AssignCardMemberAsync(atFrom, dave);
        await ForceCreatedAtAsync(atFrom, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(atFrom);
        await ForceCompletedAtAsync(atFrom, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        // 恰在 to 交付 ⇒ 排他上界的那一刻，不算（它的建卡日在窗內，所以仍在分母裡）。
        var atTo = await CreateCardAsync(listId, "B-at-to");
        await AssignCardMemberAsync(atTo, dave);
        await ForceCreatedAtAsync(atTo, new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        await CompleteAsync(atTo);
        await ForceCompletedAtAsync(atTo, new DateTime(2027, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var row = await MemberRowAsync(teamId, dave, from, to);
        Assert.Equal(2, row.GetProperty("totalCards").GetInt32());
        Assert.Equal(1, row.GetProperty("completedCards").GetInt32());
    }

    /// <summary>
    /// 匯出檔名帶年度（設計 §5.4）：年份由**窗框左界**推導，全期時不帶後綴。
    ///
    /// 年份刻意選 **2021**——與「今天」差五年以上 ⇒ 實作若改讀時鐘（`DateTime.Now.Year`），
    /// 這一支當場紅：**這一行就是「年份不是時鐘」的判別力**。兩條輸出路徑在同一個 case 裡
    /// 一起驗，因為檔名是她們唯一共用的契約（CSV 與 xls 的**內容**各有各的既有測試）。
    ///
    /// 第二列（全期）守的是另一半：沒有窗框時不得產生後綴——只驗有窗框的那一半，
    /// 「一律附加」的實作照樣綠。
    /// </summary>
    [Theory]
    [InlineData("2021-01-01T00:00:00Z", "2022-01-01T00:00:00Z", "-2021")]
    [InlineData(null, null, "")]                                        // 全期 ⇒ 不帶年份後綴
    public async Task ExportFileNames_UseTheWindowYear(string? from, string? to, string expectedSuffix)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, projectId, listId) = await SetupBareTeamAsync();
        await CreateCardAsync(listId, "N-filename");

        var csv = await _client.GetAsync($"/api/teams/{teamId}/report/export{WindowQuery(from, to)}");
        Assert.True(csv.IsSuccessStatusCode, await csv.Content.ReadAsStringAsync());
        Assert.Equal($"team-{teamId}-performance{expectedSuffix}.csv", FileNameOf(csv));

        // xls 檔名只帶 teamId（2026-10-08 批次 A，`state/36` 最小解；原本內插使用者可控的隊名）
        var xls = await _client.GetAsync($"/api/teams/{teamId}/report/export-excel{WindowQuery(from, to)}");
        Assert.True(xls.IsSuccessStatusCode, await xls.Content.ReadAsStringAsync());
        Assert.Equal($"team-performance-{teamId}{expectedSuffix}.xls", FileNameOf(xls));
    }

    /// <summary>
    /// naive 窗框字串（無時區標記，裁定範例的形狀）在**兩條匯出路徑**上同樣不得 500
    /// ——把「同形狀所以一起修好了」從對稱性宣稱變成實查。**逐路徑一列**：兩條路徑各自紅過、各自綠。
    ///
    /// Task 6 的實測把 naive 500 的成因定位到三對**吃原始 `from`／`to`** 的工時窗
    /// （JSON／CSV／xls 各一對），修正輪三處各改一行、改成餵已正規化的
    /// `window.From`／`window.To`。JSON 那一對由 T7 的 naive 列釘住；這一支釘住另外兩對
    /// ——修正**之前**這兩條路徑各自紅在自己的 500 上（實測），修正之後各自綠。
    ///
    /// 除了 200，另驗檔名後綴是 `-2026`：naive 的 `2026-01-01T00:00:00` 正規化後仍是 2026 年
    /// （`SpecifyKind` 只貼標籤、不改值）；哪天有人把它換成對 naive 呼叫 `ToUniversalTime()`
    /// （那會引入機器時區——UTC 以東就退到前一個 UTC 年）這裡也會紅。
    /// </summary>
    [Theory]
    [InlineData("export", "csv")]
    [InlineData("export-excel", "xls")]
    public async Task ExportEndpoints_AcceptNaiveWindowStrings(string route, string ext)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        await CreateCardAsync(listId, "N-naive");

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/report/{route}{WindowQuery("2026-01-01T00:00:00", "2027-01-01T00:00:00")}");
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());

        var expected = ext == "csv"
            ? $"team-{teamId}-performance-2026.csv"
            : $"team-performance-{teamId}-2026.xls";
        Assert.Equal(expected, FileNameOf(res));
    }

    /// <summary>
    /// 隊名是**使用者可控**的，且原本被內插進 `Results.File` 的 `fileDownloadName`
    /// ⇒ 跟著 `Content-Disposition` 走出去。
    /// T1（2026-10-09，`ValidateTeamName`）起**端點自己就會拒絕**含控制字元的隊名
    /// （400 `team.nameInvalid`）⇒ 敵意隊名**只可能以「既有列」的身分存在**（舊資料不回填）。
    /// 這一支因此釘住兩件事：①端點拒絕（PUT 400 且 code 正確）；
    /// ②xls 匯出的檔名**不含隊名**（D1）——隊名以直塞 DB 的既有列餵入，匯出照常 200。
    /// 突變：把檔名改回內插 `team.Name` ⇒ 這一支紅。
    /// </summary>
    [Fact]
    public async Task TeamXlsExport_FilenameIgnoresHostileTeamName()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, listId) = await SetupBareTeamAsync();
        await CreateCardAsync(listId, "N-hostile");

        // 新契約（T1 起 `ValidateTeamName`）：控制字元不再是靜默接受，而是 400 `team.nameInvalid`。
        var rename = await _client.PutAsync($"/api/teams/{teamId}", JsonContent.Create(new { name = "x\r\nY" }));
        Assert.Equal(HttpStatusCode.BadRequest, rename.StatusCode);
        Assert.Equal(ErrorCodes.TeamNameInvalid, await ErrorBody.CodeOfAsync(rename));

        // 敵意隊名改走「既有列」這條路（直塞 DB）——本支真正要守的是 D1：xls 檔名不吃隊名。
        // 走 API 已到不了這裡（上面那行就是理由），所以模擬 T1 之前就落庫的舊資料。
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
            db.Teams.First(t => t.Id == Guid.Parse(teamId)).Name = "x\r\nY";
            await db.SaveChangesAsync();
        }

        var xls = await _client.GetAsync($"/api/teams/{teamId}/report/export-excel");
        Assert.True(xls.IsSuccessStatusCode, await xls.Content.ReadAsStringAsync());
        Assert.Equal($"team-performance-{teamId}.xls", FileNameOf(xls));
    }

    /// <summary>
    /// 三條團隊報表路由對**顛倒窗框**一致回 400（裁定 6，2026-09-22 使用者定案）。
    ///
    /// 在此之前三條**全都不擋**：`from &gt; to` 會靜默回一份空報告／空 CSV／空 xls
    /// （HTTP 200），使用者只看到「匯出成功但檔案是空的」——與專案報表的 JSON 路由
    /// （2026-09-21 窗框收斂起就有這道 guard）不對稱。裁定的理由是 fail-fast：
    /// 商業級 API 對同一種錯誤輸入不該有兩種行為。
    ///
    /// **`code` 也要斷言**，不只狀態碼：`ErrorCodes.cs` 的檔頭寫明 `code` 是機器契約、
    /// `message` 是除錯與後備。少了它，一個回 400 卻帶著別種 code 的實作照樣綠。
    ///
    /// 三條路由收在同一支 theory 裡，是因為**它們的查詢各有一份、guard 也是複製三份的**
    /// ——只驗一條的話，另外兩條哪天被漏掉不會有人知道（`ReportWindow` 的檔頭就是為了
    /// 這個形狀而存在的）。
    /// </summary>
    [Theory]
    [InlineData("report")]
    [InlineData("report/export")]
    [InlineData("report/export-excel")]
    public async Task ReportRoutes_FromNotBeforeTo_Return400(string route)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, _) = await SetupBareTeamAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/{route}{WindowQuery("2027-01-01T00:00:00Z", "2026-01-01T00:00:00Z")}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(res));
    }

    /// <summary>
    /// 三條團隊報表路由對**超過 366 天**一致回 400（外部報告 C 類第 4 條）。三條收在同一支
    /// theory 的理由同下一支：guard 是複製三份的，只驗一條的話另外兩條哪天被漏掉不會有人知道。
    /// </summary>
    [Theory]
    [InlineData("report")]
    [InlineData("report/export")]
    [InlineData("report/export-excel")]
    public async Task ReportRoutes_RangeOver366Days_Return400(string route)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, _) = await SetupBareTeamAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/{route}{WindowQuery("2030-01-01T00:00:00Z", "2031-06-01T00:00:00Z")}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.QueryRangeTooLong, await ErrorBody.CodeOfAsync(res));
    }

    /// <summary>
    /// 區間上限的**下界**（與上一支成對）：恰 366 天必須放行。判準被寫成 `&gt;=` 的實作
    /// 在上一支照樣綠，只有這一支分得開——邊界 off-by-one 要兩側各一格。
    /// 2030 非閏年：2030-01-01 → 2031-01-02 恰 366 天。
    /// </summary>
    [Theory]
    [InlineData("report")]
    [InlineData("report/export")]
    [InlineData("report/export-excel")]
    public async Task ReportRoutes_RangeAt366Days_Return200(string route)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var (teamId, _, _) = await SetupBareTeamAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/{route}{WindowQuery("2030-01-01T00:00:00Z", "2031-01-02T00:00:00Z")}");

        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 回應的 `Content-Disposition` 檔名。`Results.File` 對純 ASCII 檔名只填 `filename`
    /// （含空白時帶引號），非 ASCII 才會多填 `filename*`——這裡取有值的那一個並去引號。
    /// </summary>
    private static string FileNameOf(HttpResponseMessage res)
    {
        var cd = res.Content.Headers.ContentDisposition;
        Assert.NotNull(cd);
        return (cd!.FileNameStar ?? cd.FileName ?? "").Trim('"');
    }
}










