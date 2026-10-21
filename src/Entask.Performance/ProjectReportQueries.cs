using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Performance;

/// <summary>
/// 專案績效報表聚合查詢（純查詢、零寫入、零新實體）。
/// 時間窗（`ReportWindow`）僅過濾 EffortLogs.LoggedAt；卡片清單與審查統計為「現況」。
/// **吃窗框的三支一律收 `ReportWindow`，原始 `from`／`to` 不進查詢**（`ReportWindow` 的檔頭
/// 就是這條不變量）——`LoggedAt` 是 `timestamp with time zone`，naive 的 `Kind=Unspecified`
/// 會被 Npgsql 擋下、整個請求 500（2026-09-22 實測）。
/// 例外是 <see cref="GetFirstPassYieldAsync"/> 與 <see cref="GetTeamReviewStatsAsync"/>：
/// 兩者都吃同一個 <see cref="ReportWindow"/>，而**錨的是 `Card.CompletedAt`（交付年）**
/// ——與分母的「乙」（建卡年 ∪ 交付年）**刻意不同源**，理由見各方法的註解。
/// 兩者共有的性質只有這一條：產物要拼進同一條評等公式，所以分子這一側的基準必須一致。
/// 封存卡片一律排除（spec §6 預設）。回傳 row records，由 Api 端點組裝線路 DTO＋兩步補名。
/// </summary>
public static class ProjectReportQueries
{
    public record MemberHourRow(Guid UserId, decimal Hours, int CardCount);
    public record MemberRemainingRow(Guid UserId, decimal EstimatedHours, decimal LoggedHours);
    public record ReviewStatRow(string Status, int Count, double? AverageScore);
    public record CardRow(Guid Id, string Title, Guid BoardId, string BoardName, Guid ListId, string ListName,
        List<Guid> AssigneeUserIds, decimal? EstimatedHours, decimal LoggedHours, decimal? RemainingHours,
        string? ReviewStatus, string? Priority);

    public static async Task<List<MemberHourRow>> GetMemberHourRowsAsync(
        EntaskDbContext db, Guid projectId, ReportWindow window)
    {
        var query = db.EffortLogs.Where(e => e.Card.List.Board.ProjectId == projectId && !e.Card.IsArchived);
        // 邊界一律取自 `ReportWindow`，原始 `from`／`to` 不越過它——`LoggedAt` 是
        // `timestamp with time zone`，naive（`Kind=Unspecified`）會被 Npgsql 以
        // `ArgumentException` 擋下、整個請求 500（2026-09-22 實測）。
        if (window.From is not null) query = query.Where(e => e.LoggedAt >= window.From);
        if (window.To is not null) query = query.Where(e => e.LoggedAt < window.To);
        return await query.GroupBy(e => e.UserId)
            .Select(g => new MemberHourRow(g.Key, g.Sum(e => e.Hours), g.Select(e => e.CardId).Distinct().Count()))
            .ToListAsync();
    }

    public static async Task<List<MemberRemainingRow>> GetMemberRemainingRowsAsync(
        EntaskDbContext db, Guid projectId, ReportWindow window)
    {
        // 僅統計有預估工時的指派卡片（無預估者無「剩餘」可言）；
        // logged 為該批卡片上所有人記的工時（剩餘 = 指派卡預估 − 該批卡已記）
        var assigned = await db.CardMembers
            .Where(m => m.Card.List.Board.ProjectId == projectId && !m.Card.IsArchived && m.Card.EstimatedHours != null)
            .GroupBy(m => m.UserId)
            .Select(g => new
            {
                UserId = g.Key,
                Estimated = g.Sum(m => (decimal)m.Card.EstimatedHours!),
                Cards = g.Select(m => m.CardId).Distinct().ToList(),
            })
            .ToListAsync();
        var logs = db.EffortLogs.Where(e => e.Card.List.Board.ProjectId == projectId && !e.Card.IsArchived);
        if (window.From is not null) logs = logs.Where(e => e.LoggedAt >= window.From);
        if (window.To is not null) logs = logs.Where(e => e.LoggedAt < window.To);
        var loggedByCard = await logs.GroupBy(e => e.CardId)
            .Select(g => new { CardId = g.Key, Sum = g.Sum(e => e.Hours) })
            .ToDictionaryAsync(x => x.CardId, x => x.Sum);
        return assigned
            .Select(a => new MemberRemainingRow(a.UserId, a.Estimated,
                a.Cards.Sum(c => loggedByCard.GetValueOrDefault(c))))
            .ToList();
    }

    public static async Task<(List<ReviewStatRow> Rows, double? AverageScore)> GetReviewStatsAsync(
        EntaskDbContext db, Guid projectId)
    {
        var rows = await db.CardReviews
            .Where(r => r.Card.List.Board.ProjectId == projectId && !r.Card.IsArchived)
            .GroupBy(r => r.Status)
            .Select(g => new ReviewStatRow(g.Key, g.Count(), g.Average(r => (double?)r.Score)))
            .ToListAsync();
        var average = await db.CardReviews
            .Where(r => r.Card.List.Board.ProjectId == projectId && !r.Card.IsArchived && r.Score != null)
            .AverageAsync(r => (double?)r.Score);
        return (rows, average);
    }

    /// <summary>
    /// 這份資料涵蓋哪些年份（由大到小、去重），供前端的年份下拉使用。
    ///
    /// **刻意不吃 `ReportWindow`**——這是全檔唯一一支不吃的查詢，而「對稱起見也給它一個」
    /// 是最自然的退化。它問的是「這份資料涵蓋哪些年份」（`CreatedAt` ∪ `CompletedAt`），
    /// 不是「有沒有在該年交付」；換一個窗框，這份清單**不變**，所以兩者之間沒有窗框語意
    /// 可以共用。`CardStats` 那種 bug 的形狀（同一件事有第二份實作）與這裡不同：那裡問的是
    /// 「該年交付了嗎」，這裡問的是「哪些年有交付過」。EF 的 expression 樹也確實叫不動
    /// `ReportWindow` 的一般方法（`IsDeliveredInWindow`），字面值因此是唯一寫得出來的形式。
    ///
    /// **不併入「今年」**：判定「今年是哪一年」要讀伺服器時鐘，而後端不得隱式判定年份
    /// （設計 D3——窗框由前端傳入）。使用者的本地年由前端自己併，見 `TeamReportTab` 的
    /// `yearOptions`。
    ///
    /// 守門員是 `TeamReportTests.AvailableYears_ComeFromDataOnly`：**黑箱 HTTP、不指涉任何
    /// C# 符號**，所以把 `TeamReportEndpoints` 的內嵌版本換成這一支不會使它失效——那正是
    /// 這次抽取的驗收訊號（該檔零改動全綠）。
    /// </summary>
    public static async Task<List<int>> GetAvailableYearsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> projectIds)
    {
        var cards = db.Cards.Where(c => projectIds.Contains(c.List.Board.ProjectId) && !c.IsArchived);
        var createdYears = await cards.Select(c => c.CreatedAt.Year).Distinct().ToListAsync();
        var completedYears = await cards.Where(c => c.CompletedAt != null)
            .Select(c => c.CompletedAt!.Value.Year).Distinct().ToListAsync();
        return createdYears.Concat(completedYears).Distinct().OrderByDescending(y => y).ToList();
    }

    /// <summary>
    /// 一次交付通過率（first-pass yield）的原料。
    ///
    /// 分母＝曾指派過審查者且非封存的卡片；分子＝其中第一筆 entry 就是 approved 的卡片。
    /// **沒有審查者的卡片不進分母**——主管要考核誰就對誰指派審查者，「指派審查者」因此
    /// 是一個管理動作（設計 §13.2）。查詢刻意回傳原料而不是比率，讓樣本門檻由呼叫端決定。
    ///
    /// 與同檔的 `GetReviewStatsAsync` **刻意不同源**：那一支讀 `CardReviews`（原地覆寫的
    /// 當前立場），本支讀 `CardReviewEntries`（append-only 的歷史）——「第一筆 entry 是不是
    /// approved」問的是歷史，當前立場答不了（設計 §5.3）。
    ///
    /// 時間窗錨 `Card.CompletedAt`（**交付年**，**有窗框時**語意同 `ReportWindow.IsDeliveredInWindow`）。
    /// 兩者不等價的那一格是「兩個界線都不帶」：`IsDeliveredInWindow` **一律**要求 `CompletedAt`
    /// 非 null，而下面的述詞是「界線在才加」⇒ 全期時未交付的卡仍在樣本裡（下一段）。
    /// **與 `TeamReportEndpoints` 的分母「乙」刻意不同源**：乙含「該年建卡而未在該年交付」，
    /// 那不是成果面；FPY 問的是「這一年的交付裡有多少一次就過」（設計 §4.3）。
    ///
    /// **未交付的卡（`CompletedAt == null`）在有窗框時離開樣本**——它們沒有年份可言，
    /// 而在加窗框之前它們**是在樣本裡的**（本查詢只要求 `c.Reviews.Any()`）；全期
    /// （`window.IsAll`）時兩個述詞都不加，行為與加窗框之前逐位相同。
    /// 這條述詞是**本 task 唯一會動到 S 資格的改動**——離開樣本的可能是**通過**的卡，
    /// 兩條路不同命：①樣本掉到 5 筆以下 ⇒ fpy 為 null ⇒ 該條件**不列入**（門檻那一跨，
    /// 對 fpy 這一側而言**不是降級**）；②樣本仍 ≥ 5 ⇒ fpy 由 0.80 掉到 0.778
    /// （值那一跨，**是降級**）。守門員分別是
    /// `FirstPassYield_ExcludesUndeliveredCards_WhenWindowed` 與
    /// `FirstPassYield_ValueCrossing_DropsRatingFromS_WhenUndeliveredPassLeavesSample`。
    /// </summary>
    public static async Task<Dictionary<Guid, (int FirstPass, int Reviewed)>> GetFirstPassYieldAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> projectIds, ReportWindow window,
        IReadOnlyCollection<Guid> userIds)
    {
        var cards = await GetFirstPassCardsAsync(db, projectIds, window);

        var result = userIds.ToDictionary(u => u, _ => (FirstPass: 0, Reviewed: 0));
        foreach (var c in cards)
        {
            // 責任歸屬與 `TeamReportEndpoints` 逐字同語意（未指派時歸屬建立者）。少了這一格，
            // 同一張未指派的卡片在 FPY 與完成率兩處會歸給不同的人，而兩個指標要接進同一條公式。
            var owners = c.Owners.Count > 0 ? c.Owners : new List<Guid> { c.CreatedById };
            foreach (var owner in owners.Where(userIds.Contains))
            {
                var (first, reviewed) = result[owner];
                result[owner] = (first + (c.FirstEntryStatus == ReviewStatuses.Approved ? 1 : 0), reviewed + 1);
            }
        }
        return result;
    }

    /// <summary>
    /// 一次交付通過率的**母體列**：一張卡＋它的第一筆 entry。
    /// `GetFirstPassYieldAsync`（團隊報表的 FPY 原料）與 `ReportDrilldownQueries`
    /// （FPY drill-down）**共用這一支**——同一個母體只有一個實作，兩邊的數字因此
    /// 不可能各自漂移。
    ///
    /// **全庫唯一的 query filter 破例就在這裡**（設計 §4.4／D2）：`IgnoreQueryFilters()`
    /// 的存在就是「**曾**指派過審查者」的實作本體。`c.Reviews` 是導覽屬性，而 EF 的
    /// query filter **也作用在導覽屬性上**——少了它，這裡會退化成「**現在**有審查者」，
    /// 把某張卡的審查者全部移除就能讓它離開分母（10 張卡有審查者、5 張沒過時，
    /// 移除那 5 張的審查者即可讓 FPY 從 50% 變成 100%）。拿掉那一行，這個設計整體失效，
    /// 設計 §6.3 的判別力測試會紅。`check:query-filters` 把關「恰好一處」。
    ///
    /// **已知代價**：`IgnoreQueryFilters()` 是鈍的——它關掉**整個查詢裡所有實體**的 filter，
    /// 不只 `CardReview`。未來 `Card` 若自己也掛上 filter（例如卡片軟刪除），
    /// 這一支會靜默跟著受影響、沒有任何症狀。目前 `Card` 沒有任何 filter，接受這個代價。
    ///
    /// **第一筆 entry 的排序（`CreatedAt`、再 `Id`）在**這一個查詢**裡決定**，兩個呼叫端
    /// 共用同一個答案——不要在任何一側另外排序一次：`Guid` 在 .NET 的 `CompareTo` 與
    /// PostgreSQL uuid 的排序不是同一個順序，`CreatedAt` 撞在一起時兩側會挑到不同的 entry。
    /// </summary>
    public record FirstPassCardRow(
        Guid CardId, string Title, Guid ProjectId, string ProjectName,
        DateTime? CompletedAt, DateTime? DueAt, Guid CreatedById, List<Guid> Owners,
        Guid? FirstEntryId, string? FirstEntryStatus, DateTime? FirstEntryCreatedAt,
        Guid? FirstEntryReviewerUserId);

    public static async Task<List<FirstPassCardRow>> GetFirstPassCardsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> projectIds, ReportWindow window)
    {
        var cardsQuery = db.Cards.IgnoreQueryFilters().Where(c =>
            projectIds.Contains(c.List.Board.ProjectId) && !c.IsArchived && c.Reviews.Any());
        // 述詞形狀在兩支方法各手寫一次（lambda 參數型別不同：`Card` / `CardReviewEntry`），
        // 但**值一律取自 `ReportWindow`**——`window.From`／`window.To` 不越過它。
        if (window.From is not null) cardsQuery = cardsQuery.Where(c => c.CompletedAt != null && c.CompletedAt >= window.From);
        if (window.To is not null) cardsQuery = cardsQuery.Where(c => c.CompletedAt != null && c.CompletedAt < window.To);

        // 四個第一筆欄位各自是一支相關子查詢，**排序條件逐字相同**（`CreatedAt`、`Id`）
        // ⇒ 它們一定落在同一列。沒有 entry 時 `FirstOrDefault()` 回各自型別的 default
        // （`null`），與 approved 不相等 ⇒ 只進分母。指派了卻沒審＝沒通過，不是免計。
        var rows = await cardsQuery
            .Select(c => new
            {
                c.Id,
                c.Title,
                ProjectId = c.List.Board.ProjectId,
                ProjectName = c.List.Board.Project.Name,
                c.CompletedAt,
                c.DueAt,
                c.CreatedById,
                Owners = c.Members.Select(m => m.UserId).ToList(),
                FirstEntryId = c.ReviewEntries.OrderBy(e => e.CreatedAt).ThenBy(e => e.Id)
                    .Select(e => (Guid?)e.Id).FirstOrDefault(),
                FirstEntryStatus = c.ReviewEntries.OrderBy(e => e.CreatedAt).ThenBy(e => e.Id)
                    .Select(e => e.Status).FirstOrDefault(),
                FirstEntryCreatedAt = c.ReviewEntries.OrderBy(e => e.CreatedAt).ThenBy(e => e.Id)
                    .Select(e => (DateTime?)e.CreatedAt).FirstOrDefault(),
                FirstEntryReviewerUserId = c.ReviewEntries.OrderBy(e => e.CreatedAt).ThenBy(e => e.Id)
                    .Select(e => (Guid?)e.ReviewerUserId).FirstOrDefault(),
            })
            .ToListAsync();

        return rows.Select(r => new FirstPassCardRow(
            r.Id, r.Title, r.ProjectId, r.ProjectName, r.CompletedAt, r.DueAt, r.CreatedById, r.Owners,
            r.FirstEntryId, r.FirstEntryStatus, r.FirstEntryCreatedAt, r.FirstEntryReviewerUserId)).ToList();
    }

    /// <summary>
    /// 主管評分的平均與樣本數（團隊範疇；Task 11 的 ±1 級調整項的原料，設計 §13.3／§13.4）。
    ///
    /// **來源一律 `CardReviewEntries`，不是 `CardReviews`**——後者是原地覆寫的當前立場
    /// （`ReviewEndpoints` 的提交直接蓋掉 Status／Score），用它算平均會漏掉「上個月打了
    /// 2 分、這個月重審打 5 分」裡的前一筆。這是與同檔 `GetReviewStatsAsync` **刻意不同源**
    /// 的第二處；兩者若再出現第三處就該合併（計畫「已知殘餘」第 4 條）。
    ///
    /// **述詞必須同時是 `Score != null` 與 `Status == Approved`**：設計 §13.3 的樣本範圍
    /// 是「**已通過的提交**」，不是「有分數的列」。這兩者對新資料等價（退回不可帶分數，
    /// `ReviewEndpoints` 對「退回 ＋ 分數」回 400），但**對回填列不成立**——那道 400 是
    /// `02feacb`（2026-09-17）才有的契約，而 Task 1 的回填 SQL 是
    /// `WHERE "Status" &lt;&gt; 'pending'`（`20260916145055_AddCardReviewEntries.cs`），
    /// 它把 `CardReviews` 裡**歷史上「退回 ＋ 有分數」**的列原樣搬進這張表。
    /// 少了這個條件，那些分數會進平均，還會把樣本推過 3 筆的門檻
    /// （`ApplyScoreAdjustment` 的早退），**改變某一級的評等**而且沒有任何紅燈。
    ///
    /// 這一條不是「再過一次 status」的畫蛇添足，是回填列的必要條件——設計 §13.3
    /// 那句話的兌現。
    ///
    /// 時間窗與成員導覽照 `GetFirstPassYieldAsync` 逐字同形（`Card.CompletedAt`、**交付年**、
    /// `Card.Members` 空集合退回 `CreatedById`）：這兩個數字要拼進同一條評等公式，
    /// 基準與歸屬必須一致。**與分母「乙」刻意不同源**（同 FPY，設計 §4.3）：2026 交付、
    /// 2027 初才打的分數算 **2026**——錨在打分時間會把它推到 2027，而那正是本批的動機情境。
    /// 回傳原料（和與筆數）而不是平均，讓樣本門檻由呼叫端決定。
    /// </summary>
    public static async Task<Dictionary<Guid, (double? Average, int Samples)>> GetTeamReviewStatsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> projectIds, ReportWindow window,
        IReadOnlyCollection<Guid> userIds)
    {
        var entriesQuery = db.CardReviewEntries.Where(e =>
            projectIds.Contains(e.Card.List.Board.ProjectId) && !e.Card.IsArchived
            && e.Score != null && e.Status == ReviewStatuses.Approved);
        if (window.From is not null) entriesQuery = entriesQuery.Where(e => e.Card.CompletedAt != null && e.Card.CompletedAt >= window.From);
        if (window.To is not null) entriesQuery = entriesQuery.Where(e => e.Card.CompletedAt != null && e.Card.CompletedAt < window.To);

        var entries = await entriesQuery
            .Select(e => new
            {
                Score = e.Score!.Value,
                e.Card.CreatedById,
                Owners = e.Card.Members.Select(m => m.UserId).ToList(),
            })
            .ToListAsync();

        var totals = userIds.ToDictionary(u => u, _ => (Sum: 0, Samples: 0));
        foreach (var e in entries)
        {
            // 責任歸屬與 `TeamReportEndpoints` 逐字同語意（未指派時歸屬建立者）。
            var owners = e.Owners.Count > 0 ? e.Owners : new List<Guid> { e.CreatedById };
            foreach (var owner in owners.Where(userIds.Contains))
            {
                var (sum, samples) = totals[owner];
                totals[owner] = (sum + e.Score, samples + 1);
            }
        }

        // 零筆樣本的成員回 (null, 0)，不是 (0, 0)——這是 **API 契約**上的區分：回應裡
        // `averageScore` 為 null 與 0 是可分辨的，與 `fpy` 的 null 語意同型。目前的消費端
        // （團隊報表）兩者**渲染相同**，因為它分支的鍵是 `scoreSamples` 而不是 `averageScore`
        // ——0 筆一律顯示「樣本不足」。所以這一格靠 `TeamReportTests` 的
        // `Rating_Unchanged_ForMembersWithoutReviewRecords` 釘住，不是靠畫面。
        // 回傳原料（和與筆數）而不是平均值，讓「平均 0 分」與「沒有分數」在型別上分得開。
        return totals.ToDictionary(
            kv => kv.Key,
            kv => (kv.Value.Samples > 0 ? (double?)kv.Value.Sum / kv.Value.Samples : null, kv.Value.Samples));
    }

    /// <summary>
    /// 卡片明細列。**同一列裡兩個工時欄刻意不同源**（2026-09-22 使用者裁定）：
    /// `LoggedHours`（畫面的「已報」欄）是**流量**、吃窗框；`RemainingHours`（「剩餘」欄）
    /// 是**存量**、固定全期（＝預估 − **全期**已記；`GetMemberRemainingRowsAsync` 的**唯一呼叫端**
    /// 傳的也是 `ReportWindow.All`，見 `ReportEndpoints.cs` 的「**剩餘工時刻意吃全期**」那段註解裡
    /// 「這裡是 `ReportWindow.All` 的唯一呼叫端」那一句——**那支方法本身收 `window` 參數**，
    /// 所以「同一個定義」是靠呼叫端成立，不是靠簽章）。
    /// 整頁的規則因此收斂成一句話：**沒標的跟著期間選擇器、標了「（全期）」的固定**。
    ///
    /// **改革前的缺陷是「同一個和被拿去當剩餘的減項」**，於是同一張卡的剩餘會隨窗框跳動
    /// （選 2030 之後由 5 變 10，讀起來像「越做剩餘越多」）。現在是**兩個和**：
    /// 窗框內那支（流量）與全期那支（存量）。守門員是
    /// `ReportTests.CardDetail_RemainingIsAllTime_WhileLoggedFollowsWindow`（含對照組）與
    /// 匯出那一半 `ReportExport_CardRemainingIsAllTime`（兩條路由各自呼叫一次）。
    ///
    /// ★★ **兩個和是兩支查詢，不要「順手」合成一支條件式聚合**——合起來會踩到**刻度的陷阱**，
    /// 而它只在一種形狀下顯形：窗框內一筆工時都沒有的卡片。條件式聚合給它的是**SQL 算出來的
    /// 零**，`Sum(… : 0m)` 與 nullable 的 `Sum(…)` 兩者都實測到 `0.0`（**刻度 1**）；
    /// 而**字典這條路**給它的 key 不存在 ⇒ C# 的 `default(decimal)`（**刻度 0**）。
    /// `decimal` 的刻度會一路帶到 CSV（`ReportEndpoints.cs` 的專案 CSV 建構器把三個工時欄直接
    /// 內插進 `string.Create(CultureInfo.InvariantCulture, …)`）⇒ 合成一支的話
    /// **同一個欄位在同一份匯出檔裡**會是「有記工時的那列印 `5`、沒有的印 `0.0`」。
    /// 三跑的實測：`tmp/red.log:22`（改動前，字典）紅在 `:400` ⇒ `:397` 的 `Assert.Equal("0", …)`
    /// **是過的**；`tmp/green.log`（`Sum(… : 0m)`）與 `tmp/green3.log`（nullable）都紅在 `:397`。
    /// ⇒ **字典 ＋ `GetValueOrDefault` 是這一格唯一實測過的綠**。
    /// （EF 實際送出的 SQL **沒有量**；成因只到「SQL 算出來的零帶著刻度 1」為止，再上去是推論。）
    ///
    /// ★ **Σ 這一欄的剩餘 ≠ KPI 的「總剩餘預估工時」**：後者是**逐指派者**歸戶
    /// （`GetMemberRemainingRowsAsync` 依 `CardMembers` 分組），一張卡有兩位指派者時它的預估
    /// 與已記在專案總和裡**各算兩次**。那是 KPI 那一側既有的定義，不是本方法的缺陷——
    /// 但兩者現在都標著「全期」，使用者可能把它們相加 ⇒ 已記在 `docs/STATE.md`。
    /// </summary>
    public static async Task<List<CardRow>> GetCardRowsAsync(
        EntaskDbContext db, Guid projectId, ReportWindow window)
    {
        var cards = await db.Cards
            .Where(c => c.List.Board.ProjectId == projectId && !c.IsArchived)
            .OrderBy(c => c.List.Board.Name).ThenBy(c => c.List.Name).ThenBy(c => c.Title)
            .Select(c => new CardRow(c.Id, c.Title, c.List.BoardId, c.List.Board.Name, c.ListId, c.List.Name,
                new List<Guid>(), c.EstimatedHours, 0, null, null, null))
            .ToListAsync();
        var cardIds = cards.Select(c => c.Id).ToList();

        var memberRows = await db.CardMembers.Where(m => cardIds.Contains(m.CardId))
            .Select(m => new { m.CardId, m.UserId }).ToListAsync();
        var membersByCard = memberRows.GroupBy(m => m.CardId)
            .ToDictionary(g => g.Key, g => g.Select(m => m.UserId).ToList());

        // **窗框內 ＝ 流量**（`LoggedHours`）：**逐字沿用**改動前的形狀（先過濾窗框、再分組求和）
        // ——不是為了保守，是為了**刻度**，見上面的 XML 註解。窗框的兩行**刻意不參與全期那個和**，
        // 那才是本方法的不變量（流量吃窗框、存量不吃）。
        var windowLogs = db.EffortLogs.Where(e => cardIds.Contains(e.CardId));
        if (window.From is not null) windowLogs = windowLogs.Where(e => e.LoggedAt >= window.From);
        if (window.To is not null) windowLogs = windowLogs.Where(e => e.LoggedAt < window.To);
        var loggedByCard = await windowLogs.GroupBy(e => e.CardId)
            .Select(g => new { CardId = g.Key, Sum = g.Sum(e => e.Hours) })
            .ToDictionaryAsync(x => x.CardId, x => x.Sum);

        // **全期 ＝ 存量**（`RemainingHours` 的減項）：同一組卡片、不帶窗框。兩個字典都走
        // `GetValueOrDefault`，所以「這張卡沒有工時列」與「窗框內一筆都沒有」拿到的是**同一個
        // C# `default(decimal)`**，而不是 SQL 算出來的零——那正是上一段要保住的性質。
        var totalByCard = await db.EffortLogs.Where(e => cardIds.Contains(e.CardId))
            .GroupBy(e => e.CardId)
            .Select(g => new { CardId = g.Key, Sum = g.Sum(e => e.Hours) })
            .ToDictionaryAsync(x => x.CardId, x => x.Sum);

        var reviewRows = await db.CardReviews.Where(r => cardIds.Contains(r.CardId))
            .Select(r => new { r.CardId, r.Status }).ToListAsync();
        var reviewByCard = reviewRows.GroupBy(r => r.CardId)
            .ToDictionary(g => g.Key, g => g.Select(r => r.Status).ToList());

        // 優先級＝專案範疇的系統優先級欄位（CardEndpoints 同型 ValueJson 解析）。
        // 以 SystemKey 查找而非 Name：名稱可被使用者自由更改（CustomFieldEndpoints PUT），
        // 以名稱查找會在改名後靜默回空。SystemKey 為 null 的舊資料列才退回名稱比對。
        var priorityFieldId = await db.CustomFieldDefinitions
            .Where(f => f.ScopeType == "project" && f.ScopeId == projectId &&
                (f.SystemKey == SystemFieldKeys.Priority || (f.SystemKey == null && f.Name == "優先級")))
            .Select(f => (Guid?)f.Id).FirstOrDefaultAsync();
        var priorityByCard = new Dictionary<Guid, string?>();
        if (priorityFieldId is not null)
        {
            var values = await db.CardFieldValues
                .Where(v => v.FieldDefinitionId == priorityFieldId && cardIds.Contains(v.CardId))
                .Select(v => new { v.CardId, v.ValueJson }).ToListAsync();
            foreach (var v in values)
            {
                using var doc = JsonDocument.Parse(v.ValueJson);
                priorityByCard[v.CardId] =
                    doc.RootElement.ValueKind == JsonValueKind.String ? doc.RootElement.GetString() : null;
            }
        }

        return cards.Select(c =>
        {
            var statuses = reviewByCard.GetValueOrDefault(c.Id) ?? [];
            var reviewStatus = statuses.Contains(ReviewStatuses.Rejected) ? ReviewStatuses.Rejected
                : statuses.Contains(ReviewStatuses.Pending) ? ReviewStatuses.Pending
                : statuses.Count > 0 ? ReviewStatuses.Approved : null;
            return c with
            {
                AssigneeUserIds = membersByCard.GetValueOrDefault(c.Id) ?? [],
                LoggedHours = loggedByCard.GetValueOrDefault(c.Id),
                RemainingHours = c.EstimatedHours is null ? null : c.EstimatedHours - totalByCard.GetValueOrDefault(c.Id),
                ReviewStatus = reviewStatus,
                Priority = priorityByCard.GetValueOrDefault(c.Id),
            };
        }).ToList();
    }
}
