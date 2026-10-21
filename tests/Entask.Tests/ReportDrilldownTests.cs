using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Entask.Tests.ReportDrilldownTestTime;

namespace Entask.Tests;

/// <summary>
/// 團隊報表 drill-down（2026-10-20 報表可解釋性，Task 1）的端到端契約。
///
/// 驗收條件是**計數相等**：同一窗框、同一成員之下，drill-down 的
/// `populationCount`／`qualifyingCount` 必須等於團隊報表回應的「分母／分子」那一組
/// （`totalCards`／`completedCards`、`onTimeSamples`／`onTimeCards`、
/// `reviewed`／`firstPass`、`scoreSamples`／`scoreSamples`）。
/// 每一支都先取報表那一列再比對——**不是**在測試裡把公式抄第二遍。
///
/// 沿用 `TeamReportTests` 的測試基建（`ApiWebApplicationFactory` ＋ `WithDbReset`、
/// 以 API 造卡片／審查／窗框，必要時直接寫 DbContext 偽造過去時間）。
/// </summary>
[Collection("ApiTests")]
public partial class ReportDrilldownTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ReportDrilldownTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // ---------- 完成率 ----------

    /// <summary>
    /// 4 張卡：2 張窗內完成、1 張窗內建卡未完成、1 張窗內建卡但**窗外完成**。
    /// 分母是 `ReportWindow.DenominatorClause()`（建卡日在窗內 **或** 交付日在窗內）
    /// ⇒ 第四張仍在母體裡，但不算分子。drill-down 的兩個計數因此必須等於報表那一列。
    /// </summary>
    [Fact]
    public async Task Completion_CountsMatchTeamReport()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-completion");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var adminId = await AdminUserIdAsync();

        var inWindow1 = await CreateCardAsync(listId, "A-窗內完成1");
        await ForceCreatedAtAsync(inWindow1, Utc(2026, 6, 1));
        await CompleteAsync(inWindow1);
        await ForceCompletedAtAsync(inWindow1, Utc(2026, 7, 1));

        var inWindow2 = await CreateCardAsync(listId, "B-窗內完成2");
        await ForceCreatedAtAsync(inWindow2, Utc(2026, 6, 2));
        await CompleteAsync(inWindow2);
        await ForceCompletedAtAsync(inWindow2, Utc(2026, 8, 1));

        var open = await CreateCardAsync(listId, "C-窗內建卡未完成");
        await ForceCreatedAtAsync(open, Utc(2026, 6, 3));

        var completedOutside = await CreateCardAsync(listId, "D-窗外完成");
        await ForceCreatedAtAsync(completedOutside, Utc(2026, 6, 4));
        await CompleteAsync(completedOutside);
        await ForceCompletedAtAsync(completedOutside, Utc(2027, 3, 1));

        const string from = "2026-01-01T00:00:00Z";
        const string to = "2027-01-01T00:00:00Z";
        var member = await MemberRowAsync(teamId, adminId, from, to);
        Assert.Equal(4, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(2, member.GetProperty("completedCards").GetInt32());

        var json = await DrilldownAsync(teamId, adminId, "completion", from, to);

        Assert.Equal("completion", json.GetProperty("metric").GetString());
        Assert.Equal("card", json.GetProperty("rowKind").GetString());
        Assert.Equal(member.GetProperty("totalCards").GetInt32(), json.GetProperty("populationCount").GetInt32());
        Assert.Equal(member.GetProperty("completedCards").GetInt32(), json.GetProperty("qualifyingCount").GetInt32());
        Assert.Equal(4, json.GetProperty("visiblePopulationCount").GetInt32());
        Assert.Equal(2, json.GetProperty("visibleQualifyingCount").GetInt32());
        Assert.Equal(0, json.GetProperty("hiddenCount").GetInt32());

        var rows = json.GetProperty("rows").EnumerateArray().ToList();
        Assert.Equal(4, rows.Count);
        Assert.Equal(2, rows.Count(r => r.GetProperty("qualifies").GetBoolean()));
        // due 變更清單只在 on-time 這一格有值：其他 metric 的列一律 null。
        Assert.All(rows, r => Assert.Equal(JsonValueKind.Null, r.GetProperty("dueChanges").ValueKind));
    }

    // ---------- 準時率 ----------

    /// <summary>
    /// 3 張已交付：2 張有截止日（1 準時、1 遲交）、1 張沒有截止日。
    /// 沒有截止日的卡片**兩邊都不進**（2026-09-21 使用者裁定）⇒ 母體 2、分子 1；
    /// 那一張也不得出現在 drill-down 的列裡。
    /// </summary>
    [Fact]
    public async Task OnTime_CountsMatchTeamReport_AndSkipsCardsWithoutDue()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-ontime");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var adminId = await AdminUserIdAsync();

        var onTime = await CreateCardAsync(listId, "O-準時");
        await SetDueDateAsync(onTime, "2099-01-01T00:00:00Z");
        await CompleteAsync(onTime);

        var late = await CreateCardAsync(listId, "L-遲交");
        await SetDueDateAsync(late, "2020-01-01T00:00:00Z");
        await CompleteAsync(late);

        var noDue = await CreateCardAsync(listId, "N-無截止日");
        await CompleteAsync(noDue);

        var member = await MemberRowAsync(teamId, adminId);
        Assert.Equal(3, member.GetProperty("completedCards").GetInt32());
        Assert.Equal(2, member.GetProperty("onTimeSamples").GetInt32());
        Assert.Equal(1, member.GetProperty("onTimeCards").GetInt32());

        var json = await DrilldownAsync(teamId, adminId, "onTime");

        Assert.Equal("onTime", json.GetProperty("metric").GetString());
        Assert.Equal("card", json.GetProperty("rowKind").GetString());
        Assert.Equal(member.GetProperty("onTimeSamples").GetInt32(), json.GetProperty("populationCount").GetInt32());
        Assert.Equal(member.GetProperty("onTimeCards").GetInt32(), json.GetProperty("qualifyingCount").GetInt32());

        var titles = json.GetProperty("rows").EnumerateArray()
            .Select(r => r.GetProperty("title").GetString()).ToList();
        Assert.Equal(2, titles.Count);
        Assert.Contains("O-準時", titles);
        Assert.Contains("L-遲交", titles);
        Assert.DoesNotContain("N-無截止日", titles);
    }

    // ---------- 一次交付通過率 ----------

    /// <summary>
    /// A：第一筆 entry 是 rejected（退回後重新交付才通過）⇒ 只進分母。
    /// B：第一筆即 approved，**之後審查者被全部移除**——母體問的是「曾指派過」，
    /// 所以它仍在分母裡，且列上仍看得到當初的審查者（entry 是 append-only 的）。
    /// </summary>
    [Fact]
    public async Task FirstPassYield_UsesFirstEntry_AndKeepsRemovedReviewers()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-fpy");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var adminId = await AdminUserIdAsync();

        var reworked = await CreateCardAsync(listId, "A-退回後才通過");
        var reworkedReview = await AssignReviewerAsync(reworked, adminId);
        await CompleteAsync(reworked);
        await SubmitReviewAsync(reworked, reworkedReview, ReviewStatuses.Rejected, comment: "退回重做");
        await CompleteAsync(reworked);
        await SubmitReviewAsync(reworked, reworkedReview, ReviewStatuses.Approved);

        var removed = await CreateCardAsync(listId, "B-審查者被移除");
        var removedReview = await AssignReviewerAsync(removed, adminId);
        await CompleteAsync(removed);
        await SubmitReviewAsync(removed, removedReview, ReviewStatuses.Approved);
        await RemoveAllReviewersAsync(removed);

        var member = await MemberRowAsync(teamId, adminId);
        Assert.Equal(2, member.GetProperty("reviewed").GetInt32());
        Assert.Equal(1, member.GetProperty("firstPass").GetInt32());

        var json = await DrilldownAsync(teamId, adminId, "firstPassYield");

        Assert.Equal("firstPassYield", json.GetProperty("metric").GetString());
        Assert.Equal("card", json.GetProperty("rowKind").GetString());
        Assert.Equal(member.GetProperty("reviewed").GetInt32(), json.GetProperty("populationCount").GetInt32());
        Assert.Equal(member.GetProperty("firstPass").GetInt32(), json.GetProperty("qualifyingCount").GetInt32());

        var rows = json.GetProperty("rows").EnumerateArray().ToList();
        Assert.Equal(2, rows.Count);
        // due 變更清單只在 on-time 有值：FPY 的列一律 null。
        Assert.All(rows, r => Assert.Equal(JsonValueKind.Null, r.GetProperty("dueChanges").ValueKind));
        var byTitle = rows.ToDictionary(r => r.GetProperty("title").GetString()!, r => r);
        Assert.Equal(ReviewStatuses.Rejected,
            byTitle["A-退回後才通過"].GetProperty("firstReviewStatus").GetString());
        Assert.False(byTitle["A-退回後才通過"].GetProperty("qualifies").GetBoolean());
        Assert.Equal(ReviewStatuses.Approved,
            byTitle["B-審查者被移除"].GetProperty("firstReviewStatus").GetString());
        Assert.True(byTitle["B-審查者被移除"].GetProperty("qualifies").GetBoolean());
        // 審查者被移除之後，entry 仍留著 ⇒ 名字仍查得到（entry 的 ReviewerUserId 不是目前立場）。
        Assert.False(string.IsNullOrEmpty(
            byTitle["B-審查者被移除"].GetProperty("firstReviewerName").GetString()));
    }

    // ---------- 平均分 ----------

    /// <summary>
    /// 同一張卡兩筆 approved 且有分數的 entry ⇒ **兩列**（粒度和報表一樣是 entry）。
    /// `populationCount = qualifyingCount = scoreSamples`。
    /// </summary>
    [Fact]
    public async Task AverageScore_IsEntryGrain()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-score");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var adminId = await AdminUserIdAsync();

        var card = await CreateCardAsync(listId, "S-兩筆評分");
        var reviewId = await AssignReviewerAsync(card, adminId);
        await SubmitReviewAsync(card, reviewId, ReviewStatuses.Approved, score: 5);
        // 第二次提交：狀態相同但分數不同 ⇒ 不是 no-op ⇒ 再 append 一筆 entry。
        await SubmitReviewAsync(card, reviewId, ReviewStatuses.Approved, score: 4);

        var member = await MemberRowAsync(teamId, adminId);
        Assert.Equal(2, member.GetProperty("scoreSamples").GetInt32());
        Assert.Equal(4.5, member.GetProperty("averageScore").GetDouble(), 3);

        var json = await DrilldownAsync(teamId, adminId, "averageScore");

        Assert.Equal("averageScore", json.GetProperty("metric").GetString());
        Assert.Equal("reviewEntry", json.GetProperty("rowKind").GetString());
        Assert.Equal(member.GetProperty("scoreSamples").GetInt32(), json.GetProperty("populationCount").GetInt32());
        Assert.Equal(member.GetProperty("scoreSamples").GetInt32(), json.GetProperty("qualifyingCount").GetInt32());

        var rows = json.GetProperty("rows").EnumerateArray().ToList();
        Assert.Equal(2, rows.Count);
        // due 變更清單只在 on-time 有值：平均分的列一律 null。
        Assert.All(rows, r => Assert.Equal(JsonValueKind.Null, r.GetProperty("dueChanges").ValueKind));
        Assert.All(rows, r => Assert.NotEqual(JsonValueKind.Null, r.GetProperty("reviewEntryId").ValueKind));
        Assert.All(rows, r => Assert.Equal(JsonValueKind.Null, r.GetProperty("firstReviewEntryId").ValueKind));
        Assert.Equal(new[] { 4.0, 5.0 }, rows.Select(r => r.GetProperty("score").GetDouble()).Order().ToArray());
        Assert.Equal(2, rows.Select(r => r.GetProperty("reviewEntryId").GetString()).Distinct().Count());
    }

    // ---------- 封存卡片（設計 §4.7 的邊界）----------

    /// <summary>
    /// **封存卡片同時被報表與 drill-down 排除**（設計 §4.7）。這一支是那個邊界的唯一
    /// 判別力：在此之前沒有任何封存 fixture，drill-down 開始算封存卡、或報表停止算，
    /// 兩邊都會綠。
    ///
    /// 封存卡刻意**什麼都有**：指派成員、審查者、approved 且有分數的 review——三個母體
    /// 各有一條會把它撿進去的原因，才驗得到三個 `!IsArchived` 都真的在。活卡片留一張並
    /// 完成它，讓「排除」與「根本沒資料」分得開（兩個 0 看起來一樣）。
    ///
    /// 斷言分兩層：①報表那一列不含它（三個母體各自的原料）；②drill-down 的計數等於
    /// 報表——後者單獨不夠（FPY 的報表與 drill-down 共用 `GetFirstPassCardsAsync`，
    /// 兩邊一起錯仍然相等），所以①不能省。
    /// </summary>
    [Fact]
    public async Task ArchivedCard_IsExcludedFromReportAndDrilldown()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-archived");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var adminId = await AdminUserIdAsync();

        // 活卡片：讓報表那一列不是 0。
        var live = await CreateCardAsync(listId, "活卡-完成");
        await CompleteAsync(live);

        // 封存卡：有指派成員、審查者、approved review（帶分數）。
        var archived = await CreateCardAsync(listId, "封存卡-全部條件都符合");
        await AssignMemberAsync(archived, adminId);
        var reviewId = await AssignReviewerAsync(archived, adminId);
        await CompleteAsync(archived);
        await SubmitReviewAsync(archived, reviewId, ReviewStatuses.Approved, score: 5);
        await ArchiveAsync(archived);

        var member = await MemberRowAsync(teamId, adminId);
        // 完成率：分母與分子都只有活卡。
        Assert.Equal(1, member.GetProperty("totalCards").GetInt32());
        Assert.Equal(1, member.GetProperty("completedCards").GetInt32());
        // FPY：封存卡的審查者不得讓它進母體。
        Assert.Equal(0, member.GetProperty("reviewed").GetInt32());
        // 平均分：封存卡的 approved 分數不得進樣本。
        Assert.Equal(0, member.GetProperty("scoreSamples").GetInt32());

        var completion = await DrilldownAsync(teamId, adminId, "completion");
        Assert.Equal(member.GetProperty("totalCards").GetInt32(), completion.GetProperty("populationCount").GetInt32());
        Assert.Equal(member.GetProperty("completedCards").GetInt32(), completion.GetProperty("qualifyingCount").GetInt32());
        var titles = completion.GetProperty("rows").EnumerateArray()
            .Select(r => r.GetProperty("title").GetString()).ToList();
        Assert.Contains("活卡-完成", titles);
        Assert.DoesNotContain("封存卡-全部條件都符合", titles);

        var fpy = await DrilldownAsync(teamId, adminId, "firstPassYield");
        Assert.Equal(member.GetProperty("reviewed").GetInt32(), fpy.GetProperty("populationCount").GetInt32());
        Assert.Equal(0, fpy.GetProperty("populationCount").GetInt32());

        var scores = await DrilldownAsync(teamId, adminId, "averageScore");
        Assert.Equal(member.GetProperty("scoreSamples").GetInt32(), scores.GetProperty("populationCount").GetInt32());
    }

    // ---------- 權限差集 ----------

    /// <summary>
    /// 呼叫者只有 P1 的 `card.read`（團隊角色只有 `report.view`，且不是 P2 成員）
    /// ⇒ P2 的列不出現、`hiddenCount` 等於差額，但**計數仍等於報表**（含不可見專案）。
    /// </summary>
    [Fact]
    public async Task HiddenProjects_CountsStillMatchReport()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-hidden");
        var (p1, list1) = await CreateProjectAsync(teamId, "P1");
        var (_, list2) = await CreateProjectAsync(teamId, "P2");
        var adminId = await AdminUserIdAsync();

        await CompleteAsync(await CreateCardAsync(list1, "P1-可見1"));
        await CompleteAsync(await CreateCardAsync(list1, "P1-可見2"));
        await CompleteAsync(await CreateCardAsync(list2, "P2-隱藏1"));
        await CompleteAsync(await CreateCardAsync(list2, "P2-隱藏2"));

        var eve = await CreateRestrictedCallerAsync(teamId, p1, "eve-hidden");

        // 報表由 admin 取（一般成員的報表端點也需要 report.view；這裡只比數字）。
        var member = await MemberRowAsync(teamId, adminId);

        var json = await DrilldownAsync(teamId, adminId, "completion", token: eve.Token, xTeamId: teamId);

        Assert.Equal(member.GetProperty("totalCards").GetInt32(), json.GetProperty("populationCount").GetInt32());
        Assert.Equal(member.GetProperty("completedCards").GetInt32(), json.GetProperty("qualifyingCount").GetInt32());
        Assert.Equal(4, json.GetProperty("populationCount").GetInt32());
        Assert.Equal(2, json.GetProperty("visiblePopulationCount").GetInt32());
        Assert.Equal(2, json.GetProperty("visibleQualifyingCount").GetInt32());
        Assert.Equal(
            json.GetProperty("populationCount").GetInt32() - json.GetProperty("visiblePopulationCount").GetInt32(),
            json.GetProperty("hiddenCount").GetInt32());

        var titles = json.GetProperty("rows").EnumerateArray()
            .Select(r => r.GetProperty("title").GetString()).ToList();
        Assert.Equal(2, titles.Count);
        Assert.Contains("P1-可見1", titles);
        Assert.Contains("P1-可見2", titles);
        Assert.DoesNotContain("P2-隱藏1", titles);
        Assert.DoesNotContain("P2-隱藏2", titles);
    }

    /// <summary>
    /// 分頁必須在權限過濾**之後**：可見的只有 P1 的 3 張，`pageSize=2` 時
    /// 第一頁不是空的、第二頁拿到剩下的 1 張，兩頁沒有重複。
    /// （若先分頁再過濾，第一頁會落在全團隊的排序上，可能整頁都是不可見專案。）
    /// </summary>
    [Fact]
    public async Task Pagination_AppliesAfterPermissionFilter()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-paging");
        var (p1, list1) = await CreateProjectAsync(teamId, "P1");
        var (_, list2) = await CreateProjectAsync(teamId, "P2");
        var adminId = await AdminUserIdAsync();

        for (var i = 0; i < 3; i++) await CreateCardAsync(list1, $"P1-{i}");
        for (var i = 0; i < 3; i++) await CreateCardAsync(list2, $"P2-{i}");

        var eve = await CreateRestrictedCallerAsync(teamId, p1, "eve-paging");

        var page1 = await DrilldownAsync(teamId, adminId, "completion", page: 1, pageSize: 2,
            token: eve.Token, xTeamId: teamId);
        var page2 = await DrilldownAsync(teamId, adminId, "completion", page: 2, pageSize: 2,
            token: eve.Token, xTeamId: teamId);

        Assert.Equal(3, page1.GetProperty("visiblePopulationCount").GetInt32());
        Assert.Equal(3, page1.GetProperty("hiddenCount").GetInt32());
        Assert.Equal(1, page1.GetProperty("page").GetInt32());
        Assert.Equal(2, page1.GetProperty("pageSize").GetInt32());

        var rows1 = page1.GetProperty("rows").EnumerateArray().ToList();
        var rows2 = page2.GetProperty("rows").EnumerateArray().ToList();
        Assert.Equal(2, rows1.Count);
        Assert.Single(rows2);
        Assert.All(rows1.Concat(rows2), r =>
            Assert.Equal(p1, r.GetProperty("projectId").GetString()));
        var ids1 = rows1.Select(r => r.GetProperty("cardId").GetString()).ToHashSet();
        var ids2 = rows2.Select(r => r.GetProperty("cardId").GetString()).ToHashSet();
        Assert.Empty(ids1.Intersect(ids2));
    }

    // 參數驗證（窗框／metric／分頁）在 `ReportDrilldownTests.Validation.cs`——同一個
    // partial class，共用這裡的 fixture 與 helper。

    // ---------- due date 變更（2026-10-20 報表可解釋性，Task 3）----------

    /// <summary>
    /// `due_change` 活動的 detail 要帶「變更前／變更後」：第一次設定截止日時 `from` 是 null、
    /// `to` 是這次的值；第二次變更時 `from` 是第一次的值、`to` 是第二次的值。
    ///
    /// 兩筆以**配對**斷言而非「第二筆」：兩次 PUT 若落在同一個 `CreatedAt` tick，
    /// 活動牆以隨機的 `Id` 打破平手（見 `ActivityEndpoints`），wire 上的先後不保證是寫入先後。
    /// </summary>
    [Fact]
    public async Task DueChange_WritesFromAndTo()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-due-write");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var cardId = await CreateCardAsync(listId, "D-due 變更");

        await SetDueDateAsync(cardId, "2026-09-01T00:00:00Z");
        await SetDueDateAsync(cardId, "2026-09-15T00:00:00Z");

        var activity = await (await _client.GetAsync($"/api/cards/{cardId}/activity"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var entries = activity.GetProperty("items").EnumerateArray()
            .Where(a => a.GetProperty("type").GetString() == ActivityTypes.DueChange)
            .Select(ParseActivityDetail)
            .ToList();

        Assert.Equal(2, entries.Count);
        // 第一次設定：原本沒有截止日 ⇒ from 是 null。
        var initial = entries.Single(d => d.GetProperty("from").ValueKind == JsonValueKind.Null);
        Assert.Equal(Utc(2026, 9, 1), initial.GetProperty("to").GetDateTime());
        // 第二次變更：from 是第一次的值、to 是第二次的值。
        var changed = entries.Single(d => d.GetProperty("to").GetDateTime() == Utc(2026, 9, 15));
        Assert.Equal(Utc(2026, 9, 1), changed.GetProperty("from").GetDateTime());
    }

    /// <summary>
    /// on-time drill-down 的每一列都帶 due 變更清單：**沒有變更的卡片是空清單、不是 null**，
    /// 且每張卡內依 `changedAt` 遞增。
    ///
    /// A 卡走真正的端點寫入路徑，驗證 writer 的 detail 一路流進 drill-down。
    /// B 卡的兩筆是直接寫 `ActivityItems`、插入順序與 changedAt 遞增相反（09-10 先插、09-05 後插）
    /// ——這是 **wiring 證據**，不是排序的契約紅燈：它對「忘了排序」的判別力**依賴 planner
    /// 行為**（`ActivityItems (CardId, CreatedAt, Id)` 一旦被選中，列序本來就是 `CreatedAt`
    /// 遞增，這支會存活）。排序契約的紅燈在純函式測試
    /// `GroupDueChanges_SortsByChangedAt_EvenWhenInputIsDescending`。
    /// C 卡是 Task 3 之前就存在的資料形狀：有截止日、但沒有任何 due 變更紀錄。
    /// D 卡的 due 變更發生在**交付之後**——伺服器端不過濾（設計 §4.6 由前端標記），照樣列出。
    /// </summary>
    [Fact]
    public async Task OnTimeDrilldown_IncludesDueChanges_InOrder()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-due-order");
        var (_, listId) = await CreateProjectAsync(teamId, "P1");
        var adminId = await AdminUserIdAsync();

        // A：真正的寫入路徑（PUT → activity service → jsonb detail）。
        var viaApi = await CreateCardAsync(listId, "A-端點寫入");
        await SetDueDateAsync(viaApi, "2026-09-01T00:00:00Z");
        await SetDueDateAsync(viaApi, "2026-09-20T00:00:00Z");
        await CompleteAsync(viaApi);

        // B：截止日直接寫 DB（不產生 activity），再插入兩筆 due 變更，插入順序與時間相反。
        var shuffled = await CreateCardAsync(listId, "B-插入順序相反");
        await ForceDueAtAsync(shuffled, Utc(2026, 8, 1));
        await CompleteAsync(shuffled);
        await InsertDueChangeAsync(shuffled, adminId, Utc(2026, 9, 10),
            from: Utc(2026, 8, 1), to: Utc(2026, 9, 20));
        await InsertDueChangeAsync(shuffled, adminId, Utc(2026, 9, 5),
            from: Utc(2026, 9, 20), to: Utc(2026, 10, 1));

        // C：有截止日、但沒有任何 due 變更紀錄（Task 3 之前就存在的資料）。
        var legacy = await CreateCardAsync(listId, "C-無變更紀錄");
        await ForceDueAtAsync(legacy, Utc(2026, 12, 31));
        await CompleteAsync(legacy);

        // D：變更時間在交付之後（`CompleteAsync` 蓋的是牆鐘）。伺服器端不過濾，
        // 這裡必須原樣看到它——否則「完成後才發生的變更」會從可解釋性裡消失。
        // 時間由該卡實際的 `CompletedAt` 推導（＋1 天），**不寫死日期**：寫死的日期
        // 過了那一天就會讓「changedAt > completedAt」這個前提自動變假（會腐爛的斷言）。
        var afterCompletion = await CreateCardAsync(listId, "D-交付後才變更");
        await ForceDueAtAsync(afterCompletion, Utc(2026, 9, 30));
        await CompleteAsync(afterCompletion);
        var afterCompletionAt = await CompletedAtAsync(afterCompletion);
        var changedAfterCompletionAt = afterCompletionAt.AddDays(1);
        await InsertDueChangeAsync(afterCompletion, adminId, changedAfterCompletionAt,
            from: Utc(2026, 9, 30), to: Utc(2026, 12, 31));

        var json = await DrilldownAsync(teamId, adminId, "onTime");
        var rows = json.GetProperty("rows").EnumerateArray()
            .ToDictionary(r => r.GetProperty("title").GetString()!, r => r);

        // 每一列都有清單（不是 null），包含沒有任何變更的那一列。
        Assert.All(rows.Values, r => Assert.NotEqual(JsonValueKind.Null, r.GetProperty("dueChanges").ValueKind));

        var apiChanges = rows["A-端點寫入"].GetProperty("dueChanges").EnumerateArray().ToList();
        Assert.Equal(2, apiChanges.Count);
        Assert.True(apiChanges[0].GetProperty("changedAt").GetDateTime()
            <= apiChanges[1].GetProperty("changedAt").GetDateTime());
        Assert.Equal(Utc(2026, 9, 1), apiChanges[^1].GetProperty("from").GetDateTime());
        Assert.Equal(Utc(2026, 9, 20), apiChanges[^1].GetProperty("to").GetDateTime());

        var shuffledChanges = rows["B-插入順序相反"].GetProperty("dueChanges").EnumerateArray().ToList();
        Assert.Equal(2, shuffledChanges.Count);
        Assert.Equal(Utc(2026, 9, 5), shuffledChanges[0].GetProperty("changedAt").GetDateTime());
        Assert.Equal(Utc(2026, 9, 10), shuffledChanges[1].GetProperty("changedAt").GetDateTime());
        // 每一筆的 from／to 跟著自己的 changedAt 走（不是把兩筆的內容對調）。
        Assert.Equal(Utc(2026, 9, 20), shuffledChanges[0].GetProperty("from").GetDateTime());
        Assert.Equal(Utc(2026, 10, 1), shuffledChanges[0].GetProperty("to").GetDateTime());
        Assert.Equal(Utc(2026, 8, 1), shuffledChanges[1].GetProperty("from").GetDateTime());
        Assert.Equal(Utc(2026, 9, 20), shuffledChanges[1].GetProperty("to").GetDateTime());

        Assert.Empty(rows["C-無變更紀錄"].GetProperty("dueChanges").EnumerateArray());

        var afterChanges = rows["D-交付後才變更"].GetProperty("dueChanges").EnumerateArray().ToList();
        var late = Assert.Single(afterChanges);
        // 這一筆發生在該卡交付之後（時間由 `CompletedAt` 推導），伺服器端並未過濾掉它。
        Assert.True(late.GetProperty("changedAt").GetDateTime() > afterCompletionAt);
        Assert.Equal(changedAfterCompletionAt, late.GetProperty("changedAt").GetDateTime());
        Assert.Equal(Utc(2026, 12, 31), late.GetProperty("to").GetDateTime());
    }

    // ---------- fixture helpers ----------
    //
    // 純函式那一組（`ParseDueChangeEntry_*`／`GroupDueChanges_*`）在
    // `ReportDrilldownDueChangeTests.cs`；兩檔共用 `Utc`（`using static` 匯入）。

    private async Task<string> AdminTokenAsync()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return token;
    }

    private async Task<Guid> AdminUserIdAsync() =>
        (await _client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("userId").GetGuid();

    private async Task<string> SetupTeamAsync(string name)
    {
        var res = await _client.PostAsync("/api/teams", JsonContent.Create(new { name }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
    }

    private async Task<(string ProjectId, string ListId)> CreateProjectAsync(string teamId, string name)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        req.Headers.Add("X-Team-Id", teamId);
        req.Content = JsonContent.Create(new { name });
        var res = await _client.SendAsync(req);
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        var projectId = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "B1" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "L1" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        return (projectId, listId);
    }

    private async Task<string> CreateCardAsync(string listId, string title)
    {
        var res = await _client.PostAsync($"/api/lists/{listId}/cards", JsonContent.Create(new { title }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
    }

    private async Task CompleteAsync(string cardId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/completion",
            JsonContent.Create(new { isCompleted = true }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    private async Task SetDueDateAsync(string cardId, string dueAt)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}", JsonContent.Create(new { dueAt }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>指派唯一的審查者並回傳該列的 reviewId。</summary>
    private async Task<string> AssignReviewerAsync(string cardId, Guid reviewerUserId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { reviewerUserId } }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()
            .Single(r => r.GetProperty("reviewerUserId").GetGuid() == reviewerUserId)
            .GetProperty("id").GetString()!;
    }

    private async Task SubmitReviewAsync(string cardId, string reviewId, string status,
        int? score = null, string? comment = null)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status, comment, score }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    private async Task RemoveAllReviewersAsync(string cardId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = Array.Empty<string>() }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 把單一成員指派到卡片上——責任歸屬因此走「有指派成員」那一條分支，不是
    /// 「未指派時歸建立者」。封存邊界那一支靠它讓封存卡在三個母體裡都真的夠格。
    /// </summary>
    private async Task AssignMemberAsync(string cardId, Guid userId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { userId } }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>封存卡片（`PUT /api/cards/{id}` 的 `isArchived`）。</summary>
    private async Task ArchiveAsync(string cardId)
    {
        var res = await _client.PutAsync($"/api/cards/{cardId}", JsonContent.Create(new { isArchived = true }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// 造一個受限的呼叫者：團隊角色只有 `report.view`、只有指定的專案給 `card.read`。
    /// 專案角色是**團隊自訂角色**（`ProjectMembers.RoleId` 指向 `Roles`，系統範本或該團隊
    /// 的自訂角色皆可）；兩個角色分開，權限才不會互相滲透到另一個專案。
    /// </summary>
    private async Task<(Guid UserId, string Token)> CreateRestrictedCallerAsync(
        string teamId, string readableProjectId, string username)
    {
        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName = username }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        var userId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid();

        var teamRoleId = await CreateCustomRoleAsync(teamId, $"{username}-team", new[] { PermissionCodes.ReportView });
        var teamMember = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username, roleIds = new[] { teamRoleId } }));
        Assert.True(teamMember.IsSuccessStatusCode, await teamMember.Content.ReadAsStringAsync());

        var projectRoleId = await CreateCustomRoleAsync(teamId, $"{username}-project", new[] { PermissionCodes.CardRead });
        var projectMember = await _client.PostAsync($"/api/projects/{readableProjectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { projectRoleId } }));
        Assert.True(projectMember.IsSuccessStatusCode, await projectMember.Content.ReadAsStringAsync());

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        Assert.True(login.IsSuccessStatusCode, await login.Content.ReadAsStringAsync());
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        return (userId, token);
    }

    private async Task<Guid> CreateCustomRoleAsync(string teamId, string name, string[] permissionCodes)
    {
        var res = await _client.PostAsync($"/api/teams/{teamId}/roles",
            JsonContent.Create(new { name, description = name, permissionCodes }));
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>報表裡某位成員的那一列（以 userId 指名，不用名稱）。</summary>
    private async Task<JsonElement> MemberRowAsync(string teamId, Guid userId, string? from = null, string? to = null)
    {
        var res = await _client.GetAsync($"/api/teams/{teamId}/report{WindowQuery(from, to)}");
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        return (await res.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("members").EnumerateArray()
            .Single(m => m.GetProperty("userId").GetGuid() == userId);
    }

    private async Task<JsonElement> DrilldownAsync(string teamId, Guid userId, string metric,
        string? from = null, string? to = null, int? page = null, int? pageSize = null,
        string? token = null, string? xTeamId = null)
    {
        var query = new List<string> { $"userId={userId}", $"metric={Uri.EscapeDataString(metric)}" };
        if (from is not null) query.Add($"from={Uri.EscapeDataString(from)}");
        if (to is not null) query.Add($"to={Uri.EscapeDataString(to)}");
        if (page is not null) query.Add($"page={page}");
        if (pageSize is not null) query.Add($"pageSize={pageSize}");

        var req = new HttpRequestMessage(HttpMethod.Get,
            $"/api/teams/{teamId}/report/drilldown?{string.Join("&", query)}");
        if (token is not null) req.Headers.Authorization = new("Bearer", token);
        if (xTeamId is not null) req.Headers.Add("X-Team-Id", xTeamId);

        var res = await _client.SendAsync(req);
        Assert.True(res.IsSuccessStatusCode,
            $"GET drilldown（{metric}）→ {(int)res.StatusCode}: {await res.Content.ReadAsStringAsync()}");
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static string WindowQuery(string? from, string? to)
    {
        var query = new List<string>();
        if (from is not null) query.Add($"from={Uri.EscapeDataString(from)}");
        if (to is not null) query.Add($"to={Uri.EscapeDataString(to)}");
        return query.Count == 0 ? "" : "?" + string.Join("&", query);
    }

    // ---------- 直接寫 DbContext（API 造不出過去的時間） ----------
    //
    // 手法與 `TeamReportTests` 相同：建卡與交付端點一律蓋 `DateTime.UtcNow`，
    // 窗框的測試需要「2026 建、2027 交付」這種卡片。

    private async Task ForceCreatedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.CreatedAt = utc;
        await db.SaveChangesAsync();
    }

    private async Task ForceCompletedAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.CompletedAt = utc;
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// 讀該卡實際的 `CompletedAt`：`CompleteAsync` 蓋的是牆鐘，測試要拿它推導相對時間，
    /// 不得把「今天之後的某一天」寫死（那種斷言會在該日之後無故變紅）。
    /// </summary>
    private async Task<DateTime> CompletedAtAsync(string cardId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        return await db.Cards.Where(c => c.Id == Guid.Parse(cardId))
            .Select(c => c.CompletedAt!.Value).FirstAsync();
    }

    /// <summary>直接寫截止日、**不產生** `due_change` 活動（造「有截止日但沒有變更紀錄」的舊資料）。</summary>
    private async Task ForceDueAtAsync(string cardId, DateTime utc)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        var card = await db.Cards.FirstAsync(c => c.Id == Guid.Parse(cardId));
        card.DueAt = utc;
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// 直接寫一筆 `due_change` 活動，時間由呼叫端指定（端點一律蓋 `DateTime.UtcNow`，
    /// 造不出「插入順序與 changedAt 相反」的資料——那是排序的判別力來源）。
    /// detail 形狀刻意與 `CardEndpoints` 的 writer 相同（小寫 `from`／`to`）。
    /// </summary>
    private async Task InsertDueChangeAsync(string cardId, Guid userId, DateTime changedAt,
        DateTime? from, DateTime? to)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Entask.Infrastructure.Data.EntaskDbContext>();
        db.ActivityItems.Add(new Entask.Core.Entities.ActivityItem
        {
            CardId = Guid.Parse(cardId),
            UserId = userId,
            Type = ActivityTypes.DueChange,
            Detail = JsonSerializer.Serialize(new { @from = from, to }),
            CreatedAt = changedAt,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>活動牆的 `detail` 是 jsonb 序列化後的字串，不是內嵌物件。</summary>
    private static JsonElement ParseActivityDetail(JsonElement item)
    {
        using var doc = JsonDocument.Parse(item.GetProperty("detail").GetString()!);
        return doc.RootElement.Clone();
    }
}
