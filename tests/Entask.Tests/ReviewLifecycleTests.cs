using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ReviewLifecycleTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ReviewLifecycleTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    /// <summary>
    /// 建一個團隊／專案／看板／列表／卡片，並把 admin 指派為審查者。
    /// 回傳常用 id。形狀沿用 ReviewEffortTests.SetupAsync。
    ///
    /// 副作用（下面兩支測試都依賴）：指派審查者會為該卡片留下一列
    /// Status = pending 的 CardReviews；除此之外該卡片沒有任何審查資料。
    /// </summary>
    private async Task<(string CardId, Guid ReviewId, string EngineerToken)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "審查生命週期團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;

        var projectReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        projectReq.Headers.Authorization = new("Bearer", adminToken);
        projectReq.Headers.Add("X-Team-Id", teamId);
        projectReq.Content = JsonContent.Create(new { name = "審查專案" });
        var project = await (await _client.SendAsync(projectReq)).Content.ReadFromJsonAsync<JsonElement>();
        var projectId = project.GetProperty("id").GetString()!;

        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards", JsonContent.Create(new { name = "看板" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;

        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;

        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards", JsonContent.Create(new { title = "卡片" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var cardId = card.GetProperty("id").GetString()!;

        // 計畫原文此處是 `GET /api/me` 取自己的 id，但該路由不存在——
        // `/api/me` 底下只有 profile／password／avatar 的 PUT/DELETE，
        // GET 會 404 且 body 為空，`ReadFromJsonAsync` 當場拋例外。
        // 改走 ReviewEffortTests／NotificationPayloadTests 既有的做法：直接查 seed admin。
        Guid myId;
        using (var scope = _factory.Services.CreateScope())
            myId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Users.First(u => u.UserName == _factory.SeedCredentials().Username).Id;

        await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { myId } }));
        var reviews = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = reviews.EnumerateArray().First().GetProperty("id").GetString()!;

        return (cardId, Guid.Parse(reviewId), adminToken);
    }

    /// <summary>
    /// 開一個 scope 與它底下的 DbContext。兩者都由呼叫端負責處置
    /// （scope 不 dispose 的話，每個呼叫端都會在背景多留一個 DI scope）。
    /// </summary>
    private (EntaskDbContext Db, IServiceScope Scope) Db()
    {
        var scope = _factory.Services.CreateScope();
        return (scope.ServiceProvider.GetRequiredService<EntaskDbContext>(), scope);
    }

    /// <summary>
    /// 建立 bob、加進該卡片所屬專案（必須是成員——`RequireProjectPermission`
    /// 對非 admin 是 fail-closed）、指派為該卡片的第二位審查者，並回傳他的登入憑證與 reviewId。
    /// 骨架沿用 Reject_ClearsCompletedAt_AndKeepsOtherReviewersStance（含兩個實測踩到的陷阱：
    /// 專案／團隊一律由卡片反推，不可用名稱查——WithDbReset() 是 per-class）。
    ///
    /// `roleName` 是他拿到的專案角色，預設「測試工程師」（有 `card.review`，無 `card.edit`／`card.rate`）。
    /// **角色的性質屬於呼叫端、不屬於這支 helper**：`card.rate`（Task 9）之後，提交**帶分數**
    /// 的審查需要主管角色，所以帶分數的呼叫端一律顯式傳「工程組長」；
    /// 傳非主管角色的只有 `NonManager_CannotSubmitScore`，它驗的正是被擋下的那一半——
    /// 其中「測試工程師」那一列刻意不傳角色名，走的就是這裡的預設值。
    ///
    /// bob 走真實的指派／登入路徑；admin 的審查列不受影響（`PUT /reviews` 的差集更新
    /// 只新增 bob 那一列），所以呼叫端手上的 `reviewId` 仍是 admin 的。
    /// </summary>
    private async Task<(Guid BobId, string BobReviewId, string BobToken)> AddSecondReviewerAsync(
        string cardId, string roleName = "測試工程師")
    {
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "bob", password = "Password1!", displayName = "小包" }));
        Guid adminId, bobId, projectId, teamId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db0 = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            adminId = db0.Users.First(u => u.UserName == _factory.SeedCredentials().Username).Id;
            bobId = db0.Users.First(u => u.UserName == "bob").Id;
            // 專案與團隊一律由**卡片**反推：`WithDbReset()` 是 per-class（`IClassFixture` 共用 host），
            // 同一個類別的每一支測試都建了同名的團隊／專案，用名稱查會抓到別支測試的（實測踩到：
            // bob 被加進另一個專案，送審一路 403）。
            var cardGuid = Guid.Parse(cardId);
            projectId = db0.Cards.Where(c => c.Id == cardGuid).Select(c => c.List.Board.ProjectId).First();
            teamId = db0.Projects.Where(p => p.Id == projectId).Select(p => p.TeamId).First();
        }
        // bob **必須是專案成員**：`RequireProjectPermission` 對非 admin 是 fail-closed，
        // 少了這一格他送審會拿到 403 而不是 200（實測踩到）。
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == roleName).GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = bobId, roleIds = new[] { roleId } }))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { adminId, bobId } }))).StatusCode);
        var rows = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var bobReviewId = rows.EnumerateArray()
            .Single(r => r.GetProperty("reviewerUserId").GetString() == bobId.ToString())
            .GetProperty("id").GetString()!;

        var bobToken = (await (await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "bob", password = "Password1!" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        return (bobId, bobReviewId, bobToken);
    }

    [Fact]
    public async Task SubmitReview_WritesHistoryEntry()
    {
        // 這一支驗的是端點行為：提交審查會同步寫入一筆歷史 entry（雙寫）。
        // 它不覆蓋 migration 的回填——WithDbReset 是 EnsureDeletedAsync + MigrateAsync，
        // 回填的 INSERT 每次都跑在空的 CardReviews 上（見回填那支的說明）。
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = 4, comment = "還行" }));

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var entry = await db.CardReviewEntries.SingleAsync(e => e.CardId == Guid.Parse(cardId));
            Assert.Equal(ReviewStatuses.Approved, entry.Status);
            Assert.Equal(4, entry.Score);
            Assert.Equal("還行", entry.Comment);
        }
    }

    [Fact]
    public async Task Backfill_MapsUpdatedAtToCreatedAtAndSkipsPending()
    {
        // 這一支驗的是 migration 的回填語意，不是端點行為。
        // 回填的 INSERT 只在「CardReviewEntries 剛被建立、CardReviews 已有資料」時跑得到，
        // 所以先用 IMigrator 降回上一支 migration（AddCardReviewEntries.Down 會把
        // CardReviewEntries 整張表刪掉），再以裸 SQL 種一列已決定、一列 pending 的
        // CardReviews，然後往上遷移讓回填真的跑在「有資料」的表上。
        // 端點雙寫寫下的 entry 在降級時已一併抹除，因此下面查到的 entry 只可能來自回填。
        var (cardId, _, _) = await SetupAsync();
        var cardGuid = Guid.Parse(cardId);

        // 微秒對齊且遠離 now()：前者讓 PostgreSQL 往返後仍逐微秒相等，
        // 後者讓「SELECT 的 UpdatedAt 被改寫成 now()」這種改壞當場現形。
        var decidedAt = new DateTime(2026, 1, 2, 3, 4, 5, 123, DateTimeKind.Utc);

        // 來源列的 CreatedAt 刻意與 UpdatedAt 差一小時：回填取的是 UpdatedAt，
        // 這兩欄若同值，「把來源的 CreatedAt 寫進 CreatedAt」這種改壞不會被
        // 下面的斷言區辨出來（設計 §8 第 8 項要求的正是「以 UpdatedAt 為 CreatedAt」）。
        var createdEarlier = decidedAt.AddHours(-1);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            // 前置：這張新卡片上只有 SetupAsync 留下的那一列（pending）。順帶取得它的
            // ReviewerUserId——entry 與 CardReviews 之間沒有外鍵，那是唯一能對回它的欄位。
            // `RemovedAt == null` 是設計 §4.5／D3 的述詞：軟刪除之後同一個人可以有第二列
            // （移除後重新指派），`SingleAsync` 假設的是「至多一列」。query filter 已在做
            // 同一件事，所以這個述詞今天是 no-op——價值在把那個假設寫成程式碼，而不是
            // 留在「這支測試剛好不會踩到」（本階段 §6.2 的實查項）。
            var pendingReviewerId = await db.CardReviews
                .Where(r => r.CardId == cardGuid && r.RemovedAt == null)
                .Select(r => r.ReviewerUserId)
                .SingleAsync();

            var migrator = db.Database.GetService<IMigrator>();
            try
            {
                await migrator.MigrateAsync("20260915152140_AddNotificationPayload");
                await db.Database.ExecuteSqlAsync($"""
                    INSERT INTO "CardReviews"
                        ("Id", "CardId", "ReviewerUserId", "Status", "Score", "Comment", "CreatedAt", "UpdatedAt")
                    VALUES
                        ({Guid.NewGuid()}, {cardGuid}, {Guid.NewGuid()},
                         {ReviewStatuses.Approved}, {4}, {"回填註記"}, {createdEarlier}, {decidedAt});
                    """);
            }
            finally
            {
                // 一定要回到最新版：斷言中途失敗卻把共享測試 DB 留在降級狀態的話，
                // 這個類別之後的每一支測試都會紅。這個 finally 不可移除。
                await migrator.MigrateAsync();
            }

            // 以聚合查詢斷言，避免把結果集補完（`SingleAsync` 在共享資料表上
            // 一旦同卡片有兩列就會炸，而這裡要驗的正是「有幾列」）。
            var decidedCount = await db.CardReviewEntries
                .CountAsync(e => e.CardId == cardGuid && e.Status != ReviewStatuses.Pending);
            Assert.Equal(1, decidedCount);

            // 設計 §8 的第 8 項：回填的 CreatedAt 必須是該列當時的 UpdatedAt。
            var backfilledAt = await db.CardReviewEntries
                .Where(e => e.CardId == cardGuid && e.Status != ReviewStatuses.Pending)
                .MaxAsync(e => e.CreatedAt);
            Assert.Equal(decidedAt, backfilledAt);

            // 欄位對位：回填的 SELECT 是整支 migration 唯一的手寫行，沒有其他閘門守著。
            var decided = await db.CardReviewEntries
                .Where(e => e.CardId == cardGuid && e.Status != ReviewStatuses.Pending)
                .Select(e => new { e.Status, e.Score })
                .Distinct()
                .ToListAsync();
            Assert.Single(decided);
            Assert.Equal(ReviewStatuses.Approved, decided[0].Status);
            Assert.Equal(4, decided[0].Score);

            // pending 的那一列（SetupAsync 留下的）不得被回填。
            var pendingEntries = await db.CardReviewEntries
                .CountAsync(e => e.CardId == cardGuid && e.ReviewerUserId == pendingReviewerId);
            Assert.Equal(0, pendingEntries);
        }
    }

    /// <summary>
    /// 設計 §7 第 1 項的兩半：退回 ⇒ 清除 `CompletedAt`，且**其他審查者的立場不受影響**
    /// （只有「重新交付」才會把所有 stance 重設為 `pending`）。
    ///
    /// 名字的另一半要有東西撐著，所以第二個審查者是必要的：**單一審查者的卡片驗不到
    /// 「不影響別人」**——把退回寫成「重設所有人的 stance」照樣會綠。
    /// bob 的建立步驟（角色、專案成員、指派、登入）抽在 <see cref="AddSecondReviewerAsync"/>；
    /// 呼叫端傳入的角色是 `工程組長`，因為 bob 要帶分數提交（Task 9 起只有主管角色有 `card.rate`）。
    /// </summary>
    [Fact]
    public async Task Reject_ClearsCompletedAt_AndKeepsOtherReviewersStance()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        // bob 帶分數提交 → 需要 card.rate（Task 9 起只有主管角色有）
        var (bobId, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId, "工程組長");

        await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));

        // bob 先通過，admin 再退回——順序有意義：被退回的一方要蓋不掉已提交的另一方
        var bobApprove = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        bobApprove.Headers.Authorization = new("Bearer", bobToken);
        bobApprove.Content = JsonContent.Create(new { status = "approved", score = 5, comment = "我這邊沒問題" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(bobApprove)).StatusCode);

        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "測試失敗，請修正" }));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, card.GetProperty("completedAt").ValueKind);

        var (db, scope2) = Db();
        using (scope2)
        await using (db)
        {
            // `RemovedAt == null` 的理由與上一支的 `pendingReviewerId` 相同（設計 §4.5／D3）：
            // 這是全庫唯一按 `CardId + ReviewerUserId` 查一列的形狀，而那正是重新指派
            // 會讓它變成兩列的組合。今天是 no-op，明寫出來才是把假設寫成程式碼。
            var bobStance = await db.CardReviews.AsNoTracking()
                .SingleAsync(r => r.CardId == Guid.Parse(cardId) && r.ReviewerUserId == bobId
                    && r.RemovedAt == null);
            Assert.Equal(ReviewStatuses.Approved, bobStance.Status);
        }
    }

    [Fact]
    public async Task Reject_WithScore_Returns400()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = 3, comment = "不行" }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.ReviewScoreNotAllowedOnReject, body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Reject_WithoutComment_Returns400()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "   " }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.ReviewCommentRequiredOnReject, body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task SubmittingPending_Returns400()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "pending", score = (int?)null, comment = (string?)null }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.ReviewStatusNotSubmittable, body.GetProperty("code").GetString());
    }

    /// <summary>
    /// 設計 §13.5（D8，使用者逐條裁定）：**只有主管角色能填寫評分**。
    /// 非主管的審查者仍可提交通過／退回（技術複核人人可做），只是不能帶分數——
    /// 這一支的兩半合起來才是那個契約：**同一個人在同一個端點上，帶分數 400、不帶分數 200**。
    /// 少了後半，「把整個端點關掉」也會讓前半綠燈。
    ///
    /// 兩列涵蓋 D8 明文排除的三個角色之中的兩個，而且刻意不是同一種形狀：
    /// 「工程師」有 `card.edit`（最常見的審查者），「測試工程師」**沒有 `card.edit`**——
    /// 後者的技術複核只靠 `card.review`，正是閘門最容易被寫成「唯讀者一律擋」的那一類；
    /// 這一列也不傳角色名，走 <see cref="AddSecondReviewerAsync"/> 的預設值。
    /// 第三個被排除的角色「專案助理」到不了這道閘門（沒有 `card.review`，送審先 403），
    /// 三個角色的授予與否由 `RoleSeedTests` 的種子守衛釘住。
    ///
    /// **正向對照（帶分數 200）不在這裡**，而在 `ReviewEffortTests.Reviews_AssignSubmitOwnOnly_Works`
    /// 與 `ReportTests`：那兩支的審查者都是「工程組長」，帶分數提交並斷言分數落地——
    /// 這一支若被寫成「一律 400」他們會當場變紅。
    /// </summary>
    [Theory]
    [InlineData("工程師", false)]
    // 第二列不傳角色名 ⇒ 走 helper 的預設值（測試工程師），讓預設值本身有呼叫端
    [InlineData("測試工程師", true)]
    public async Task NonManager_CannotSubmitScore(string roleName, bool useHelperDefault)
    {
        var (cardId, _, _) = await SetupAsync();
        var (_, bobReviewId, bobToken) = useHelperDefault
            ? await AddSecondReviewerAsync(cardId)
            : await AddSecondReviewerAsync(cardId, roleName);

        // 帶分數 → 400 ＋ 新錯誤碼（不是 403：設計 §13.5 與 brief 都寫 400）
        var withScore = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        withScore.Headers.Authorization = new("Bearer", bobToken);
        withScore.Content = JsonContent.Create(new { status = "approved", score = 5, comment = "我這邊沒問題" });
        var denied = await _client.SendAsync(withScore);
        Assert.Equal(HttpStatusCode.BadRequest, denied.StatusCode);
        Assert.Equal(ErrorCodes.ReviewRateNotPermitted,
            (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // 不帶分數 → 200：被擋下的只有分數，技術複核的能力不變
        var withoutScore = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        withoutScore.Headers.Authorization = new("Bearer", bobToken);
        withoutScore.Content = JsonContent.Create(new { status = "approved", comment = "我這邊沒問題" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(withoutScore)).StatusCode);
    }

    /// <summary>
    /// 設計 §7 第 1 項交付的那一半：有審查者的卡片被交付時，**所有人的當前立場重設為
    /// `pending`、`Score` 與 `Comment` 一併清空**，而歷史 entry 是 append-only——
    /// 第一輪的兩筆都必須原封不動留著。兩件事一起斷言才驗得到「重設的是立場、不是歷史」：
    /// 只驗立場的話，「交付時順手刪掉 entry」的實作照樣會綠。
    ///
    /// 第二位審查者（bob）在這裡是**辨別力**而不是重現度：第一輪若是「交付 → 退回」，
    /// 退回的 `score` 依契約本來就必須是 `null`，於是「交付時把 `Score` 清成 null」那一行
    /// 整行刪掉也不會有紅燈。讓 bob 在第一輪**通過並給 5 分**，第二次交付時那一格才真的
    /// 有東西可以掉。活動型別同理：`delivery_submitted` 的**唯一**生產者就是這個分支，
    /// 少了下面的正向斷言，那整行刪掉也不會有紅燈（`Delivery_OnCardWithoutReviewers_IsUnchanged`
    /// 只驗另一條分支不含它）。
    /// </summary>
    [Fact]
    public async Task Delivery_ResetsStances_AndKeepsHistory()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        // bob 帶分數提交 → 需要 card.rate（Task 9 起只有主管角色有）
        var (bobId, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId, "工程組長");

        // 第一輪：交付 → bob 通過（給分）→ admin 退回
        await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
        var bobApprove = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        bobApprove.Headers.Authorization = new("Bearer", bobToken);
        bobApprove.Content = JsonContent.Create(new { status = "approved", score = 5, comment = "我這邊沒問題" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(bobApprove)).StatusCode);
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "第一輪不合格" }));

        // 第二輪：重新交付——兩個人的立場都要被重設
        await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));

        var reviews = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var rows = reviews.EnumerateArray().ToList();
        Assert.Equal(2, rows.Count);
        // 兩列都要被重設，所以逐列斷言三個欄位——只挑 bob 那一列的話，
        // 「重設寫成只重設第一個審查者」的實作照樣會綠。
        // `score` 這一格有辨別力的來源是 bob：他第一輪真的給了 5 分，
        // 而 admin 那一列在第二輪之前本來就是 null（退回不可帶分）。
        foreach (var row in rows)
        {
            Assert.Equal(ReviewStatuses.Pending, row.GetProperty("status").GetString());
            Assert.Equal(JsonValueKind.Null, row.GetProperty("score").ValueKind);
            Assert.Equal(JsonValueKind.Null, row.GetProperty("comment").ValueKind);
        }

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            // 歷史保留：第一輪的兩筆都還在，而且逐欄原封不動
            var entries = await db.CardReviewEntries.Where(e => e.CardId == Guid.Parse(cardId)).ToListAsync();
            Assert.Equal(2, entries.Count);
            var bobEntry = entries.Single(e => e.ReviewerUserId == bobId);
            Assert.Equal(ReviewStatuses.Approved, bobEntry.Status);
            Assert.Equal(5, bobEntry.Score);
            Assert.Equal("我這邊沒問題", bobEntry.Comment);
            var adminEntry = entries.Single(e => e.ReviewerUserId != bobId);
            Assert.Equal(ReviewStatuses.Rejected, adminEntry.Status);
            Assert.Null(adminEntry.Score);
            Assert.Equal("第一輪不合格", adminEntry.Comment);

            // 交付分支的活動型別是 delivery_submitted 而不是 complete——這個常數的
            // 唯一生產者就是該分支。
            var types = await db.ActivityItems.Where(a => a.CardId == Guid.Parse(cardId)).Select(a => a.Type).ToListAsync();
            Assert.Contains(ActivityTypes.DeliverySubmitted, types);
        }
    }

    /// <summary>
    /// 沒有審查者的卡片（使用者的行政工作場景）走原本的完成路徑：交付分支不得查寫任何
    /// 審查資料，活動型別也必須仍是 `complete`——把「完成」記成「交付」會讓那一類卡片的
    /// 活動牆說謊。
    /// </summary>
    [Fact]
    public async Task Delivery_OnCardWithoutReviewers_IsUnchanged()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        // 把審查者全部移除
        await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }));

        await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotEqual(JsonValueKind.Null, card.GetProperty("completedAt").ValueKind);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            Assert.Empty(await db.CardReviewEntries.Where(e => e.CardId == Guid.Parse(cardId)).ToListAsync());
            // 活動型別必須是既有的 complete，不是 delivery_submitted
            var types = await db.ActivityItems.Where(a => a.CardId == Guid.Parse(cardId)).Select(a => a.Type).ToListAsync();
            Assert.Contains(ActivityTypes.Complete, types);
            Assert.DoesNotContain(ActivityTypes.DeliverySubmitted, types);
        }
    }

    /// <summary>
    /// 三輪交付／退回之後：entry 累積三筆且依 CreatedAt（同分時再依 Id）排序；
    /// **以提交收尾的狀態下**，CardReview（當前立場）等於最新那一筆——兩張表的分工在
    /// 來回多輪之後仍然成立（設計 §8 的不變量）。
    ///
    /// 「以提交收尾」是必要的限定：交付會把立場重設為 `pending` 而歷史不動，在那個窗口裡
    /// 立場**不**等於最新那一筆（最新一筆仍是上一輪的結果）。本迴圈以退回（一次提交）收尾，
    /// 所以等式成立；交付重設那個窗口刻意不在等式內，由
    /// Delivery_ResetsStances_AndKeepsHistory 另行覆蓋。
    /// </summary>
    [Fact]
    public async Task ThreeRounds_AccumulateThreeEntriesInOrder()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        for (var i = 1; i <= 3; i++)
        {
            await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
            await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
                JsonContent.Create(new { status = "rejected", score = (int?)null, comment = $"第 {i} 輪" }));
        }

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            // ThenBy(Id) 是 2026-09-12 起的既有慣例：CreatedAt 同分的兩列不靠資料庫的任意順序。
            var entries = await db.CardReviewEntries.Where(e => e.CardId == Guid.Parse(cardId))
                .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id).ToListAsync();
            Assert.Equal(3, entries.Count);
            Assert.Equal(["第 1 輪", "第 2 輪", "第 3 輪"], entries.Select(e => e.Comment));

            // 不變量：CardReview 的當前立場等於最新一筆 entry
            var current = await db.CardReviews.SingleAsync(r => r.Id == reviewId);
            Assert.Equal(entries[^1].Status, current.Status);
            Assert.Equal(entries[^1].Comment, current.Comment);
        }
    }

    /// <summary>
    /// 同值重送不是一次新的核定（2026-10-14，使用者回報「誤觸會重複計算」）：
    /// 立場／分數／評語三者皆未改變時回 200，但**不寫第二筆 entry、不動 UpdatedAt**。
    ///
    /// 為什麼這是績效問題而不是美觀問題：`GetTeamReviewStatsAsync` 對**每一筆**
    /// approved ＋ 有分數的 entry 各算一個樣本，而 `ApplyScoreAdjustment` 的
    /// `scoreSamples &lt; 3` 是早退、4.5／2.0 是升降級的界線（`TeamReportEndpoints.cs`）
    /// ⇒ 多一筆樣本可以直接改掉一個人的評等。entry 又是 append-only——送錯的分數
    /// 不會被下一次更正蓋掉，它留在平均的分母裡。
    /// </summary>
    [Fact]
    public async Task Resubmit_IdenticalValues_WritesNoSecondEntry()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var body = new { status = "approved", score = (int?)4, comment = "還行" };
        Assert.Equal(HttpStatusCode.OK,
            (await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}", JsonContent.Create(body))).StatusCode);

        DateTime firstUpdatedAt;
        var (db0, scope0) = Db();
        using (scope0)
        await using (db0)
            firstUpdatedAt = (await db0.CardReviews.SingleAsync(r => r.Id == reviewId)).UpdatedAt;

        var resubmit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}", JsonContent.Create(body));
        Assert.Equal(HttpStatusCode.OK, resubmit.StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            Assert.Equal(1, await db.CardReviewEntries.CountAsync(e => e.CardId == Guid.Parse(cardId)));
            var current = await db.CardReviews.SingleAsync(r => r.Id == reviewId);
            // `UpdatedAt` 的語意是「立場最後一次改變」（`CardReview.cs:16` 逐字用它）——
            // 立場沒變就不動。這一條與上一條各擋一種退化：只寫 entry 不動 UpdatedAt
            // 的實作紅在上面，只動 UpdatedAt 不寫 entry 的紅在下面。
            Assert.Equal(firstUpdatedAt, current.UpdatedAt);
            Assert.Equal(ReviewStatuses.Approved, current.Status);
            Assert.Equal(4, current.Score);
            Assert.Equal("還行", current.Comment);
        }
    }

    /// <summary>
    /// 對照組，判別力來自反向：**只有分數**改變時仍須寫第二筆 entry。
    /// 少了這一支，一個「第一次提交之後就再也不寫 entry」的實作會全綠
    /// ——那會讓更正分數消失，比誤觸更糟。兩次提交的 status 與 comment 逐字相同，
    /// 所以這一支紅的原因只可能是「比對把分數一起當成沒變」。
    /// </summary>
    [Fact]
    public async Task Resubmit_ChangedScore_WritesSecondEntry()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = (int?)4, comment = "還行" }));
        var resubmit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = (int?)5, comment = "還行" }));
        Assert.Equal(HttpStatusCode.OK, resubmit.StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var entries = await db.CardReviewEntries.Where(e => e.CardId == Guid.Parse(cardId))
                .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id).ToListAsync();
            Assert.Equal(2, entries.Count);
            Assert.Equal([4, 5], entries.Select(e => e.Score));
        }
    }

    /// <summary>
    /// 退回那一支的同值重送：兩邊的 `score` 都是 null。比對若寫成對可為 null 的欄位
    /// 直接呼叫方法（`.Equals`）或先字串化，這一格是唯一會紅的地方。
    /// </summary>
    [Fact]
    public async Task Resubmit_IdenticalReject_WritesNoSecondEntry()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var body = new { status = "rejected", score = (int?)null, comment = "規格不符" };
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}", JsonContent.Create(body));
        var resubmit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}", JsonContent.Create(body));
        Assert.Equal(HttpStatusCode.OK, resubmit.StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
            Assert.Equal(1, await db.CardReviewEntries.CountAsync(e => e.CardId == Guid.Parse(cardId)));
    }

    /// <summary>
    /// 同值重送也不重發通知。與 entry／UpdatedAt 那一支是**不同的觀測面**：
    /// 那兩者在交易內，通知在 `tx.CommitAsync()` 之後才寫——早退若被挪到那段之後，
    /// 只有這一支會紅。
    ///
    /// 由 bob 提交（收件者是建立者 admin）：admin 自己提交時 `card.CreatedById == userId`，
    /// 那條分支本來就不發通知，驗不到東西。
    ///
    /// **這一支量的是差值，不是絕對值**：`WithDbReset()` 是 per-class
    /// （`ApiWebApplicationFactory.cs:157-161` 的 `_pendingReset` 只消費一次），
    /// 同一個類別的其他測試留下的 Review 通知全在同一個 admin 名下——實測第一版寫成
    /// `Assert.Equal(1, …)` 時拿到 6。差值同時釘住正向的一半：第一次提交真的發了 1 則。
    /// </summary>
    [Fact]
    public async Task Resubmit_IdenticalValues_SendsNoSecondNotification()
    {
        var (cardId, _, _) = await SetupAsync();
        var (_, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId);

        var (db0, scope0) = Db();
        Guid adminId;
        int before;
        using (scope0)
        await using (db0)
        {
            adminId = (await db0.Users.FirstAsync(u => u.UserName == _factory.SeedCredentials().Username)).Id;
            before = await db0.Notifications.CountAsync(n => n.UserId == adminId && n.Type == NotificationTypes.Review);
        }

        var body = new { status = "approved", score = (int?)null, comment = "技術複核" };
        for (var i = 0; i < 2; i++)
        {
            var req = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
            req.Headers.Authorization = new("Bearer", bobToken);
            req.Content = JsonContent.Create(body);
            Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(req)).StatusCode);
        }

        var (db, scope) = Db();
        using (scope)
        await using (db)
            Assert.Equal(before + 1,
                await db.Notifications.CountAsync(n => n.UserId == adminId && n.Type == NotificationTypes.Review));
    }

    /// <summary>
    /// 沒有 `card.rate` 的人提交時，**分數不屬於這次提交**：保留這一列既有的分數，
    /// 而不是因為一個他看不到的欄位把它清成 null。
    ///
    /// 來源是 2026-10-14 的複審：`ReviewEndpoints` 的 `card.rate` 閘門只在
    /// `req.Score is not null` 時觸發，而前端在 `!canRate` 時**固定送 null**
    /// （`ItemDetailsTab.tsx`：欄位不渲染，「表單送出的內容必須是它顯示的內容」）
    /// ⇒ 那個 null 穿過閘門、進了同值比對（null ≠ 3）。少了這一格，畫面上什麼都沒變的
    /// 一次提交會寫入第二筆 entry、發通知，並讓 `CardReviews.Score` 消失
    /// （`GetReviewStatsAsync` 取的就是它，專案報表的 averageScore 跟著改變）
    /// ——正是本批要擋的那一類誤觸。
    ///
    /// 情境用**直接種列狀態**而不是「把角色改掉再重送」：權限集合有 30 秒
    /// `IMemoryCache` 且全 repo 沒有任何地方主動失效（`PermissionChecker.cs` 的
    /// `perm:p:{projectId}:{userId}`；以 grep `IMemoryCache|perm:` 實查，命中的只有那一個檔），
    /// 改完角色立刻重送仍會讀到舊權限 ⇒ 那會是一支假紅的測試。
    /// 列狀態本身就是端點唯一讀的東西。
    /// </summary>
    [Fact]
    public async Task Resubmit_ByReviewerWithoutRate_PreservesScoreAndWritesNoEntry()
    {
        var (cardId, _, _) = await SetupAsync();
        var (_, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId);

        // 這一列的形狀＝「他在還有 `card.rate` 時核定過，之後被調離主管職」
        // （`ItemDetailsTab.tsx` 對 `!canRate` 的說明逐字舉了這個例子）。
        // 這一支不對歷史 entry 的完整性做主訴——要驗的是「這次提交什麼都沒寫」。
        var (db0, scope0) = Db();
        using (scope0)
        await using (db0)
        {
            var row = await db0.CardReviews.SingleAsync(r => r.Id == Guid.Parse(bobReviewId));
            row.Status = ReviewStatuses.Approved;
            row.Score = 4;
            row.Comment = "技術複核";
            await db0.SaveChangesAsync();
        }

        var resubmit = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        resubmit.Headers.Authorization = new("Bearer", bobToken);
        // 沒有 card.rate ⇒ 前端不會送分數（body 裡根本沒有那一格）
        resubmit.Content = JsonContent.Create(new { status = "approved", comment = "技術複核" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(resubmit)).StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            Assert.Equal(0, await db.CardReviewEntries.CountAsync(e => e.CardId == Guid.Parse(cardId)));
            Assert.Equal(4, (await db.CardReviews.SingleAsync(r => r.Id == Guid.Parse(bobReviewId))).Score);
        }
    }

    /// <summary>
    /// 對照組（2026-10-14 複審的 MEDIUM）：**只有評語**改變時仍須寫第二筆。
    /// 少了它，把評語那一項從比對裡拿掉（或對它先 `Trim()`）的實作會全綠
    /// ——那正是「使用者的更正被吃掉」的方向，比誤觸更糟。
    /// 兩次提交的 status 與 score 逐字相同，所以這一支紅的原因只可能是評語那一項。
    /// </summary>
    [Fact]
    public async Task Resubmit_ChangedCommentOnly_WritesSecondEntry()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = (int?)4, comment = "還行" }));
        var resubmit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = (int?)4, comment = "改過之後可以" }));
        Assert.Equal(HttpStatusCode.OK, resubmit.StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var entries = await db.CardReviewEntries.Where(e => e.CardId == Guid.Parse(cardId))
                .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id).ToListAsync();
            Assert.Equal(2, entries.Count);
            Assert.Equal(["還行", "改過之後可以"], entries.Select(e => e.Comment));
        }
    }

    /// <summary>
    /// 對照組的第二半（同一個 MEDIUM）：**只有立場**改變時仍須寫第二筆。
    /// 兩次都不帶分數（退回本來就不許帶），評語逐字相同 ⇒ 這一支紅的原因只可能是
    /// 立場那一項。少了它，一個只比分數與評語的實作會讓「通過改退回」變成 no-op
    /// ——那是一次沒有任何痕跡的立場變更。
    /// </summary>
    [Fact]
    public async Task Resubmit_ChangedStatusOnly_WritesSecondEntry()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = (int?)null, comment = "規格沒有問題" }));
        var resubmit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "規格沒有問題" }));
        Assert.Equal(HttpStatusCode.OK, resubmit.StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var entries = await db.CardReviewEntries.Where(e => e.CardId == Guid.Parse(cardId))
                .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id).ToListAsync();
            Assert.Equal(2, entries.Count);
            Assert.Equal([ReviewStatuses.Approved, ReviewStatuses.Rejected], entries.Select(e => e.Status));
        }
    }

    /// <summary>
    /// 設計 §6.3：歷史端點回傳**全部**的提交，依 `CreatedAt` 升冪——不是只有最後一筆。
    /// 兩輪之間夾一次重新交付，正好覆蓋使用者回報的「來回多次卻只看得到最後狀態」。
    /// </summary>
    [Fact]
    public async Task ReviewHistory_ReturnsEntriesAscending()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "退一" }));
        await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", score = 5, comment = "這次可以" }));

        var history = await (await _client.GetAsync($"/api/cards/{cardId}/review-history")).Content.ReadFromJsonAsync<JsonElement>();
        var rows = history.EnumerateArray().ToList();
        Assert.Equal(2, rows.Count);
        Assert.Equal("rejected", rows[0].GetProperty("status").GetString());
        Assert.Equal("退一", rows[0].GetProperty("comment").GetString());
        Assert.Equal("approved", rows[1].GetProperty("status").GetString());
        Assert.Equal(5, rows[1].GetProperty("score").GetInt32());
        // 審查者名稱走兩步查 User（Core 不可引用 Identity），拼錯了會回空字串而不是炸掉
        // ——這一條是那條路徑唯一的斷言。
        Assert.False(string.IsNullOrEmpty(rows[0].GetProperty("reviewerDisplayName").GetString()));
    }

    /// <summary>
    /// 設計 §4.2 的 rollup 表逐格：單一審查者的三個狀態各對到自己的值。
    /// `pending` 那一筆不提交（指派時就是 `pending`），其餘兩筆以真實的提交端點送。
    /// </summary>
    [Theory]
    [InlineData("rejected", "rejected")]
    [InlineData("approved", "approved")]
    [InlineData("pending", "pending")]
    public async Task ReviewState_Rollup_OnCard(string submitStatus, string expected)
    {
        var (cardId, reviewId, _) = await SetupAsync();
        if (submitStatus != "pending")
        {
            var comment = submitStatus == "rejected" ? "不行" : null;
            await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
                JsonContent.Create(new { status = submitStatus, score = submitStatus == "approved" ? 4 : (int?)null, comment }));
        }
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, card.GetProperty("reviewState").GetString());
    }

    /// <summary>
    /// 設計 §4.2 表的第一列：沒有審查者的卡片（使用者的行政工作場景）`reviewState` 為 null，
    /// 不是 `pending`——「沒有審查者」與「還沒審」在畫面上是兩種不同的顯示。
    /// </summary>
    [Fact]
    public async Task ReviewState_IsNull_WithoutReviewers()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }));
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, card.GetProperty("reviewState").ValueKind);
    }

    /// <summary>
    /// 設計 D5／§4.2 的招牌規則：**任一審查者退回 ⇒ 卡片是 rejected**，即使另一位已經通過。
    ///
    /// **不要把它當成前面那支單一審查者 `rejected` 案例的重複**——兩者守的是不同語意：
    /// 把 `Contains(Rejected)` 改成 `All(s => s == Rejected)`（語意變成「全部退回才退回」）時，
    /// **只有這一支會紅**；單獨**刪掉**那一行則是**所有斷言 `rejected` 的測試一起紅**
    /// （單卡案例、本支、以及看板案例）。
    ///
    /// brief 增補原本寫的「刪掉那一行、其餘測試不得紅」是**做不到的驗收條件**，
    /// 已於 2026-09-17 的審查以實測更正（見 ledger 的 R22）。
    /// **這裡刻意不寫支數**：上一版寫了「2 支／14 支」這種絕對數字，而同一個 commit
    /// 新增的 `ReviewState_Rollup_OnBoard` 當場把它變成 3 支／17 支
    /// （fix round 1 的 scoped re-review 的 Minor-1）。要寫數字就得連「當時有幾支」一起寫。
    /// </summary>
    [Fact]
    public async Task ReviewState_RejectedWins_OverApproved()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        // bob 帶分數提交 → 需要 card.rate（Task 9 起只有主管角色有）
        var (_, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId, "工程組長");

        // bob 先通過，admin 再退回——順序有意義：後到的退回不得被先到的通過蓋掉。
        var bobApprove = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        bobApprove.Headers.Authorization = new("Bearer", bobToken);
        bobApprove.Content = JsonContent.Create(new { status = "approved", score = 5, comment = "我這邊沒問題" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(bobApprove)).StatusCode);
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "測試失敗" }));

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ReviewStatuses.Rejected, card.GetProperty("reviewState").GetString());
    }

    /// <summary>
    /// 設計 D5 的**後半**：「**全數**通過才通過」。
    /// 上一支（`ReviewState_RejectedWins_OverApproved`）守的是前半「任一退回即退回」，
    /// 這一支守後半——`Rollup` 的三行就是三個語意，每一行都要各自有一格。
    ///
    /// 沒有這一條的話，把 `list.All(s => s == ReviewStatuses.Approved)` 改成
    /// `list.Any(...)`，**全套 15 支照樣全綠**（2026-09-17 審查實測）。
    /// 那會讓「A 通過、B 還沒審」的卡片顯示**綠色「已通過」**——正是 D5 要防的那個狀態的
    /// 鏡像：D5 的理由寫「避免『有人說有問題，但卡片仍是已完成』」，而另一半是
    /// 「避免『有人說沒問題，但另一個人還沒看』」。
    /// </summary>
    [Fact]
    public async Task ReviewState_PendingWins_OverPartialApproval()
    {
        var (cardId, adminReviewId, _) = await SetupAsync();
        // bob 帶分數提交 → 需要 card.rate（Task 9 起只有主管角色有）
        var (_, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId, "工程組長");

        // 只有 bob 通過；admin 那一列仍是 pending（指派時就是）。
        var bobApprove = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        bobApprove.Headers.Authorization = new("Bearer", bobToken);
        bobApprove.Content = JsonContent.Create(new { status = "approved", score = 5, comment = "我這邊沒問題" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(bobApprove)).StatusCode);

        var partial = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ReviewStatuses.Pending, partial.GetProperty("reviewState").GetString());

        // 正對照：admin 也通過之後才變 approved——證明上面那個 pending 不是「永遠 pending」
        // （否則把 `All` 改成 `Any` 也一樣會紅，這一支就沒有辨別力了）。
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{adminReviewId}",
            JsonContent.Create(new { status = "approved", score = 4, comment = "我也通過" }));
        var full = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ReviewStatuses.Approved, full.GetProperty("reviewState").GetString());
    }

    /// <summary>
    /// 設計 §4.2 稱 rollup 為「**徽章的依據**」，而徽章畫在**看板**上——這一支補的是
    /// `BoardCardResponse.ReviewState` 的接線（`BoardEndpoints.cs` 的 Step 7）。
    ///
    /// 沒有這一條的話，把那四行整段刪掉、**六個相關測試類別 38 支照樣全綠**
    /// （2026-09-17 審查實測）：既有的 `reviewState` 斷言全部走單卡端點
    /// （`GET /api/cards/{cardId}`），偵測不到看板酬載少了這一欄。
    /// 這也正是 Task 5 的前端接線踩不到的那條——它吃的是 mock 資料。
    ///
    /// 看板 id 由卡片反推（`CardResponse.boardId`），不用名稱查——沿用本檔既有的陷阱註記。
    /// </summary>
    [Fact]
    public async Task ReviewState_Rollup_OnBoard()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "不行" }));

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = card.GetProperty("boardId").GetString()!;
        var listId = card.GetProperty("listId").GetString()!;

        // 第二張卡：沒有任何審查者。**它不是這支測試的辨別力來源**——`ReviewState` 是帶預設值
        // `null` 的選擇性參數，所以「Step 7 不存在」與「Step 7 存在但該卡沒有審查者」在酬載上
        // **同形**（都是 null）：刪掉 Step 7 時紅的是上面那條 `rejected` 斷言，這一條恆真。
        // 留著它擋的是**另一類**突變——rollup 被套給整個清單（`.First()` 那類寫法），
        // 順帶釘住 §4.2 第一列在看板上也成立。
        var plain = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "沒有審查者的卡片" }))).Content.ReadFromJsonAsync<JsonElement>();
        var plainId = plain.GetProperty("id").GetString()!;

        var board = await (await _client.GetAsync($"/api/boards/{boardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var cards = board.GetProperty("lists").EnumerateArray()
            .SelectMany(l => l.GetProperty("cards").EnumerateArray())
            .ToDictionary(c => c.GetProperty("id").GetString()!, c => c);

        Assert.Equal(ReviewStatuses.Rejected, cards[cardId].GetProperty("reviewState").GetString());
        Assert.Equal(JsonValueKind.Null, cards[plainId].GetProperty("reviewState").ValueKind);
    }

    /// <summary>
    /// 設計 §6.3：歷史端點回傳依 `CreatedAt` **升冪**。
    ///
    /// 既有的 `ReviewHistory_ReturnsEntriesAscending` 驗不到這一條：它的兩列是**照順序
    /// 插入**的，而小表的堆積順序**就是**插入順序——「有排序」與「沒排序」在那一支裡同形。
    /// 2026-09-17 審查實測：刪掉端點的 `.OrderBy(...).ThenBy(...)` 仍是 15/15 全綠。
    ///
    /// 這一支直接寫 DB，讓**插入順序與 `CreatedAt` 順序相反**，次序才有辨別力——
    /// 端點若回堆積順序就會是「晚、早、中」而非「早、中、晚」。
    /// （直接寫 DB 的前例：同檔的 `Backfill_MapsUpdatedAtToCreatedAtAndSkipsPending`。）
    ///
    /// **殘餘（誠實標示）**：這份辨別力建立在「這個查詢**當下的計畫**回傳堆積（插入）順序」
    /// 這個實測事實之上。若日後計畫改變（例如改走 `IX_CardReviewEntries_CardId` 的索引掃描、
    /// 或統計值讓 planner 換路徑），它可能**靜默失去辨別力**（不會變紅）——與本階段反覆遇到的
    /// 「**掃描器的性質 ≠ 程式庫的性質**」同一類：宣告它有辨別力時，要連「用什麼計畫量到的」一起看。
    /// </summary>
    [Fact]
    public async Task ReviewHistory_OrdersByCreatedAt_NotInsertionOrder()
    {
        var (cardId, _, _) = await SetupAsync();
        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var cardGuid = Guid.Parse(cardId);
            var reviewerId = db.CardReviews.First(r => r.CardId == cardGuid).ReviewerUserId;
            var baseTime = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            // 插入順序：晚 → 早 → 中。`CreatedAt` 升冪應為：早 → 中 → 晚。
            db.CardReviewEntries.AddRange(
                new CardReviewEntry { CardId = cardGuid, ReviewerUserId = reviewerId, Status = ReviewStatuses.Approved, Comment = "晚", CreatedAt = baseTime.AddMinutes(3) },
                new CardReviewEntry { CardId = cardGuid, ReviewerUserId = reviewerId, Status = ReviewStatuses.Rejected, Comment = "早", CreatedAt = baseTime.AddMinutes(1) },
                new CardReviewEntry { CardId = cardGuid, ReviewerUserId = reviewerId, Status = ReviewStatuses.Approved, Comment = "中", CreatedAt = baseTime.AddMinutes(2) });
            await db.SaveChangesAsync();
        }

        var history = await (await _client.GetAsync($"/api/cards/{cardId}/review-history")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(3, history.GetArrayLength());
        Assert.Equal("早", history[0].GetProperty("comment").GetString());
        Assert.Equal("中", history[1].GetProperty("comment").GetString());
        Assert.Equal("晚", history[2].GetProperty("comment").GetString());
    }

    // ---------- 設計 §6.1 第 2–5 條：移除審查者改軟刪除（2026-09-18）----------
    //
    // T2（`c7873a3`）起，移除分支不再 `RemoveRange`，而是把 `RemovedAt` 寫上；「已移除」
    // 與否由 `EntaskDbContext` 的全域 query filter（`r.RemovedAt == null`）決定。以下四支
    // 是那個契約在測試端的落點。
    //
    // **這幾支用 `IgnoreQueryFilters()` 是刻意的**：契約是「`src/` 全庫恰好一處破例」
    // （設計 §5），T4 起由閘門 `npm run check:query-filters` 守著
    // （`web/package.json` ⇒ `scripts/check-query-filter-exceptions.mjs`）。閘門的掃描範圍
    // 只有 `src/`、不含 `tests/`——測試要斷言「列還在」就只能顯式破例，不違反那個契約。

    /// <summary>
    /// 設計 §6.1 第 2 條：移除之後**列還在**（軟刪除），而 query filter 讓它從此不出現在
    /// 任何既有查詢裡。
    ///
    /// 兩個斷言各釘一半，缺一不可：`IgnoreQueryFilters()` 之下看得到＝沒有被硬刪；
    /// 不用它時看不到＝filter 有生效。少了後半，把 `HasQueryFilter` 整行拿掉照樣綠
    /// ——那會讓已移除的審查者重新出現在卡片酬載、徽章 rollup、專案報表與待我審查清單
    /// （設計 §3.1 的 12 個讀取點裡有 11 個靠這個 filter）。
    /// </summary>
    [Fact]
    public async Task RemovedReviewer_RowSurvives_ButIsHiddenByQueryFilter()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var cardGuid = Guid.Parse(cardId);

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }))).StatusCode);

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            // ① 破例查得到：列還在、屬於這張卡、而且 `RemovedAt` 真的被寫了。
            // 「真的被寫了」是必要的另一半——只斷言「列還在」的話，一個 no-op 的假軟刪除
            // （移除分支什麼都不做）照樣會綠（T2 task review 的 Minor）。
            var removedRow = await db.CardReviews.IgnoreQueryFilters().SingleAsync(r => r.Id == reviewId);
            Assert.Equal(cardGuid, removedRow.CardId);
            Assert.NotNull(removedRow.RemovedAt);

            // ② 預設查不到：這是「排除已移除」成為預設值的實證，也是 §6.3 第 2 列的標的。
            Assert.Null(await db.CardReviews.SingleOrDefaultAsync(r => r.Id == reviewId));
        }
    }

    /// <summary>
    /// 設計 §6.1 第 3 條／§4.5／D3：被移除之後再重新指派**同一個人** ⇒ 新增一列，
    /// 不復活舊列。於是 `(CardId, ReviewerUserId)` 可以有多列，但**最多一列是現任的**。
    ///
    /// 「新增而不是復活」由三個斷言合起來釘住：新列的 `Id` 與舊列不同（不是把舊列改回來）、
    /// 舊列仍在且 `RemovedAt` 仍非 null（沒有被清掉）、兩列同屬一個人。
    /// 這是 D3 的核心，也是既有那兩處 `SingleAsync` 的地雷來源（§6.2 的實查項）。
    /// </summary>
    [Fact]
    public async Task ReassigningSameReviewer_AddsSecondRow_AndExactlyOneIsCurrent()
    {
        var (cardId, reviewId, _) = await SetupAsync();
        var cardGuid = Guid.Parse(cardId);

        // 之後要重新指派的那個人＝原本那一列的審查者。走 `IgnoreQueryFilters()` 取，
        // 這樣不必另外查 admin 的 id，而且還原順序上不受移除的影響。
        Guid reviewerId;
        var (db0, scope0) = Db();
        using (scope0)
        await using (db0)
        {
            reviewerId = await db0.CardReviews.IgnoreQueryFilters()
                .Where(r => r.Id == reviewId).Select(r => r.ReviewerUserId).SingleAsync();
        }

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { reviewerId } }))).StatusCode);

        // 現任清單只有一列：被移除過的人不在 `current` 裡，所以走的是 `newlyAdded`。
        var current = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var rows = current.EnumerateArray().ToList();
        Assert.Single(rows);
        Assert.Equal(reviewerId.ToString(), rows[0].GetProperty("reviewerUserId").GetString());
        Assert.NotEqual(reviewId, Guid.Parse(rows[0].GetProperty("id").GetString()!));

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var all = await db.CardReviews.IgnoreQueryFilters()
                .Where(r => r.CardId == cardGuid && r.ReviewerUserId == reviewerId).ToListAsync();
            // 兩列、同一個人、恰好一列現任
            Assert.Equal(2, all.Count);
            Assert.Equal(1, all.Count(r => r.RemovedAt == null));
            Assert.Equal(1, all.Count(r => r.RemovedAt != null));
            // 兩列的身分：舊的那一列是 reviewId 且仍是「已移除」，沒有被復活或改寫。
            Assert.Equal(reviewId, all.Single(r => r.RemovedAt != null).Id);
            Assert.Equal(rows[0].GetProperty("id").GetString(),
                all.Single(r => r.RemovedAt == null).Id.ToString());
        }
    }

    /// <summary>
    /// 設計 §6.1 第 4 條／§3.1 第 6 列：已移除者送審 ⇒ **404**（與今天相同）——
    /// 找列的查詢吃 query filter，找不到就是 404，不是 200 也不是 403。
    ///
    /// 前面的 200 是**正向對照**：同一個 URL、同一個形狀的 body 在移除之前是通的，
    /// 所以後面的 404 只可能來自移除。少了它，一條打錯的 URL 也會綠。
    /// </summary>
    [Fact]
    public async Task RemovedReviewer_SubmittingReview_Returns404()
    {
        var (cardId, reviewId, _) = await SetupAsync();

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", comment = "移除前送得出去" }))).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }))).StatusCode);

        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "approved", comment = "移除後再送一次" }));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        // 這條 404 來自 ReviewEndpoints.cs:142 的 review 查詢（吃 query filter、被移除的列看不到）
        // ⇒ 碼是 review.notFound，不是 card.notFound。見 task-4-report.md 的顧慮 1。
        Assert.Equal(ErrorCodes.ReviewNotFound, await ErrorBody.CodeOfAsync(res));
    }

    /// <summary>
    /// 設計 §6.1 第 5 條／§3.1 第 1–2 列：交付時的重設迴圈**只重設現任者**。
    /// 指派兩位、移除其中一位、交付 ⇒ 只有現任那一位被重設為 `pending`／`null`／`null`，
    /// 被移除的那一列**完全不動**（含 `UpdatedAt`——重設迴圈會寫它）。
    ///
    /// 辨別力刻意做成對稱的兩半，因為少了任何一半，「不重設」與「重設」就同形：
    /// ① 現任者（admin）在交付**之前先提交過**——否則「被重設成 pending」與「本來就是
    ///    pending」看不出差別；
    /// ② 被移除者（bob）在移除**之前也提交過**——否則「沒動他」與「把他重設成 pending」
    ///    也看不出差別。而這正是本條要防的：重設迴圈若少了 query filter（例如被順手加上
    ///    `IgnoreQueryFilters()`），交付會把已移除者的意見清成 null。
    ///
    /// `UpdatedAt` 的相等是第三個見證：它證明那一列是「連碰都沒碰」，不只是「值剛好一樣」。
    /// </summary>
    [Fact]
    public async Task Delivery_DoesNotResetRemovedReviewersStance()
    {
        var (cardId, adminReviewId, _) = await SetupAsync();
        var (bobId, bobReviewId, bobToken) = await AddSecondReviewerAsync(cardId);

        // 兩位都先提交：admin 退回（退回不可帶分、必須有意見），bob 通過（測試工程師沒有
        // `card.rate`，不帶分提交才是 200）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews/{adminReviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "admin 的意見" }))).StatusCode);
        var bobApprove = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{bobReviewId}");
        bobApprove.Headers.Authorization = new("Bearer", bobToken);
        bobApprove.Content = JsonContent.Create(new { status = "approved", comment = "bob 的意見" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(bobApprove)).StatusCode);

        // 移除 bob、留下 admin：現任清單只剩 admin 一位，交付因此仍走「有審查者」那條分支。
        var current = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var adminId = current.EnumerateArray()
            .Single(r => r.GetProperty("reviewerUserId").GetString() != bobId.ToString())
            .GetProperty("reviewerUserId").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { adminId } }))).StatusCode);

        // 交付之前記下被移除那一列——交付之後逐欄比對
        var bobRowBefore = await ReadRowIgnoringFilterAsync(bobReviewId);

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/completion",
            JsonContent.Create(new { isCompleted = true }))).StatusCode);

        // ① 現任者被重設。現任清單只有他（被移除那位不出現），三個欄位逐一驗。
        var after = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var rows = after.EnumerateArray().ToList();
        Assert.Single(rows);
        Assert.Equal(adminId, rows[0].GetProperty("reviewerUserId").GetString());
        Assert.Equal(ReviewStatuses.Pending, rows[0].GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, rows[0].GetProperty("score").ValueKind);
        Assert.Equal(JsonValueKind.Null, rows[0].GetProperty("comment").ValueKind);

        // ② 被移除的那一列完全不動
        var bobRowAfter = await ReadRowIgnoringFilterAsync(bobReviewId);
        Assert.Equal(ReviewStatuses.Approved, bobRowAfter.Status);
        Assert.Equal("bob 的意見", bobRowAfter.Comment);
        Assert.Equal(bobRowBefore.UpdatedAt, bobRowAfter.UpdatedAt);
        Assert.NotNull(bobRowAfter.RemovedAt);
    }

    /// <summary>
    /// final fix 任務 1：一次移除**多位**審查者時，每一個人都要真的被寫上 `RemovedAt`。
    /// 突變體是把 `ReviewEndpoints` 的 `foreach (var row in removals) row.RemovedAt = removedAt;`
    /// 換成只處理第一列（`removals.Take(1)`）——上面四支都只移除**一位**，
    /// `removals` 永遠只有一列，那個突變在她們底下**全綠**；要判別就得讓 `removals` 真的有多列。
    ///
    /// 兩個落點各看一半：`GET /reviews` 清空是**使用者可見**的那一半（filter 生效）；
    /// `IgnoreQueryFilters()` 之下兩列都在、且**兩列的 `RemovedAt` 都非 null** 是資料層那一半
    /// ——後者才是這個突變的判別點（只寫第一列的話，第二列會停在 `RemovedAt == null`）。
    /// </summary>
    [Fact]
    public async Task RemovingMultipleReviewersAtOnce_SoftDeletesEveryRow()
    {
        var (cardId, adminReviewId, _) = await SetupAsync();
        var (bobId, bobReviewId, _) = await AddSecondReviewerAsync(cardId);
        var bobReviewGuid = Guid.Parse(bobReviewId);

        // 正向對照：移除之前現任清單是兩位。少了它，「清單清空」可能只是清單本來就空的。
        var before = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var beforeIds = before.EnumerateArray().Select(r => r.GetProperty("reviewerUserId").GetString()).ToList();
        Assert.Equal(2, beforeIds.Count);
        Assert.Contains(bobId.ToString(), beforeIds);

        // 一次移除兩位：`removals` 這一輪有兩列（兩位的 id 都在 `removed` 裡）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }))).StatusCode);

        var current = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, current.GetArrayLength());

        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            var rows = await db.CardReviews.IgnoreQueryFilters()
                .Where(r => r.Id == adminReviewId || r.Id == bobReviewGuid).ToListAsync();
            // 兩列都還在（軟刪除不是刪列），而且**兩列都被寫了** `RemovedAt`——
            // 「只寫第一列」的突變會讓這裡剩一列 `RemovedAt == null`。
            Assert.Equal(2, rows.Count);
            Assert.Equal(2, rows.Count(r => r.RemovedAt != null));
        }
    }

    /// <summary>
    /// final fix 任務 2：重新指派之後**再移除一次**時，只有**現任**那一列被寫上 `RemovedAt`，
    /// 上一輪已經移除的那一列完全不動。突變體是在 `ReviewEndpoints` 的 `removals` 查詢
    /// （`db.CardReviews.Where(r => r.CardId == cardId && …)`）加上 `IgnoreQueryFilters()`——
    /// 那會讓「已移除」的舊列一起進到迴圈，被蓋上這次的 `RemovedAt`；而 `(CardId, ReviewerUserId)`
    /// 不唯一之後（D3），這是那條查詢唯一可能多收列的情境。
    ///
    /// 判別**刻意不靠時鐘走得夠遠**：兩次移除之間把舊列的 `RemovedAt` 釘成一個哨兵值，
    /// 第二次移除若覆寫它，值會變成當下的 UTC（必與哨兵不等）。若改成斷言「兩個時間戳不同」，
    /// 兩次呼叫落在同一個時鐘刻度時這支就沒有判別力——而那是可能發生的（同一個行程連續兩次
    /// HTTP 呼叫，間隔沒有任何保證）。哨兵讓兩個方向都確定：綠的時候值不動、紅的時候必變。
    /// </summary>
    [Fact]
    public async Task RemovingAgainAfterReassignment_LeavesEarlierRemovedRowUntouched()
    {
        var (cardId, firstReviewId, _) = await SetupAsync();

        // 要重新指派的人＝第一列的審查者（走 `IgnoreQueryFilters()` 取，與第 3 條同一招）。
        Guid reviewerId;
        var (db0, scope0) = Db();
        using (scope0)
        await using (db0)
        {
            reviewerId = await db0.CardReviews.IgnoreQueryFilters()
                .Where(r => r.Id == firstReviewId).Select(r => r.ReviewerUserId).SingleAsync();
        }

        // 第一次移除 → 重新指派同一個人：舊列留著（已移除）、新列是現任。
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { reviewerId } }))).StatusCode);

        var current = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        var secondReviewId = Guid.Parse(current.EnumerateArray().Single().GetProperty("id").GetString()!);
        Assert.NotEqual(firstReviewId, secondReviewId);

        // 把舊列的 `RemovedAt` 釘成哨兵（理由見 summary——這是判別力的來源，不是造場景）。
        var sentinel = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var (db1, scope1) = Db();
        using (scope1)
        await using (db1)
        {
            var firstRow = await db1.CardReviews.IgnoreQueryFilters().SingleAsync(r => r.Id == firstReviewId);
            firstRow.RemovedAt = sentinel;
            await db1.SaveChangesAsync();
        }

        // 第二次移除同一個人：現任的只有第二列。
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }))).StatusCode);
        var after = await (await _client.GetAsync($"/api/cards/{cardId}/reviews")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, after.GetArrayLength());

        var (db2, scope2) = Db();
        using (scope2)
        await using (db2)
        {
            // 一次要兩列，所以不用 `ReadRowIgnoringFilterAsync`（它是 `SingleAsync`）——
            // 這裡自己寫一條同形的查詢（`IgnoreQueryFilters()` ＋ `AsNoTracking()`）。
            var rows = await db2.CardReviews.IgnoreQueryFilters().AsNoTracking()
                .Where(r => r.Id == firstReviewId || r.Id == secondReviewId).ToListAsync();
            Assert.Equal(2, rows.Count);
            // 現任那一列：第二次移除真的生效了（正向的一半）。
            Assert.NotNull(rows.Single(r => r.Id == secondReviewId).RemovedAt);
            // 舊列：哨兵原樣——第二次移除沒有回頭覆寫它（突變的那一半）。
            Assert.Equal(sentinel, rows.Single(r => r.Id == firstReviewId).RemovedAt);
        }
    }

    /// <summary>
    /// 以 `IgnoreQueryFilters()` ＋ `AsNoTracking()` 取一列快照（軟刪除的列才看得到）。
    /// 回傳已 detach 的實體，所以呼叫端拿到的是「讀出來當下」的值，之後的寫入不會回滲。
    /// </summary>
    private async Task<CardReview> ReadRowIgnoringFilterAsync(string reviewId)
    {
        var (db, scope) = Db();
        using (scope)
        await using (db)
        {
            return await db.CardReviews.IgnoreQueryFilters().AsNoTracking()
                .SingleAsync(r => r.Id == Guid.Parse(reviewId));
        }
    }
}
