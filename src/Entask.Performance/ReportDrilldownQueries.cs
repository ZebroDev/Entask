using System.Linq.Expressions;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Performance;

public enum ReportMetric { Completion, OnTime, FirstPassYield, AverageScore }

public enum ReportRowKind { Card, ReviewEntry }

/// <summary>
/// due date 變更的一筆紀錄（2026-10-20 報表可解釋性，Task 3）。
/// 由 on-time drill-down 從 `due_change` 活動的 `Detail`（jsonb）還原——每張卡一份、依
/// `ChangedAt` 遞增；其他 metric 的 `DueChanges` 維持 null（不填）。
/// </summary>
public sealed record DueChangeEntry(DateTime ChangedAt, DateTime? From, DateTime? To);

/// <summary>
/// 待解析的 `due_change` 活動——`ActivityItems` 的最小投影（`Detail` 是 jsonb → 字串）。
/// 供 <see cref="ReportDrilldownQueries.GroupDueChanges"/> 這個純函式使用。
/// </summary>
public sealed record DueChangeActivity(Guid CardId, DateTime CreatedAt, Guid Id, string? Detail);

public sealed record ReportDrilldownRow(
    Guid CardId, string Title, Guid ProjectId, string ProjectName,
    DateTime? CompletedAt, DateTime? DueAt, bool Qualifies,
    Guid? FirstReviewEntryId, string? FirstReviewStatus, DateTime? FirstReviewAt,
    Guid? FirstReviewerUserId,
    Guid? ReviewEntryId, double? Score, DateTime? ReviewCreatedAt, Guid? ReviewerUserId,
    IReadOnlyList<DueChangeEntry>? DueChanges);

public sealed record ReportDrilldownResult(
    ReportMetric Metric, ReportRowKind RowKind,
    int PopulationCount, int QualifyingCount,
    int VisiblePopulationCount, int VisibleQualifyingCount,
    IReadOnlyList<ReportDrilldownRow> Rows);

/// <summary>
/// 團隊報表 drill-down 的母體／分子查詢（純查詢、零寫入、零新實體）。
///
/// **四個 metric 的述詞逐條沿用團隊報表那一份的既有實作，不另寫第二份定義**：
/// * <see cref="ReportMetric.Completion"/>：母體是 <see cref="ReportWindow.DenominatorClause"/>；
///   分子是 <see cref="ReportWindow.IsDeliveredInWindow"/>（在記憶體判定，與
///   `CardStats` 同一個方法——不是手寫的第三種形式）。
/// * <see cref="ReportMetric.OnTime"/>：母體／分子照 `CardStats` 的
///   `IsDeliveredInWindow(CompletedAt) &amp;&amp; DueAt != null` 與 `CompletedAt &lt;= DueAt`。
/// * <see cref="ReportMetric.FirstPassYield"/>：照
///   <see cref="ProjectReportQueries.GetFirstPassYieldAsync"/> 的母體——兩者**共用**
///   <see cref="ProjectReportQueries.GetFirstPassCardsAsync"/>（全庫唯一的 query filter
///   破例住在那裡：曾指派過審查者，移除審查者不會讓卡片離開分母）；有窗框時才要求
///   `CompletedAt` 落在窗內；第一筆 entry 的排序也在那一支查詢裡（`CreatedAt`、`Id`）。
/// * <see cref="ReportMetric.AverageScore"/>：照
///   <see cref="ProjectReportQueries.GetTeamReviewStatsAsync"/>——`CardReviewEntries` 中
///   `Status == Approved &amp;&amp; Score != null`、非封存、窗錨 `Card.CompletedAt`
///   （同上：有界線才加述詞，全期時未交付的卡仍在樣本裡）。**粒度和報表一樣是 entry**。
///
/// 計數分兩層：`*Count` 是**全團隊**（含呼叫者無權檢視的專案），
/// `Visible*Count` 只算呼叫者可讀的專案——前者才等於報表上的數字，
/// 後者才是列清單的範圍。分頁在可見性過濾之後套用。
/// </summary>
public static class ReportDrilldownQueries
{
    /// <summary>
    /// 把一筆 `due_change` 活動的 `Detail`（jsonb → 字串）解析成 <see cref="DueChangeEntry"/>。
    ///
    /// **容錯逐欄位獨立、任何情況都不拋例外**：Task 3 之前寫入的 `due_change` 沒有 detail
    /// （或 detail 是別的形狀，例如 `{"hours":1}`），而這條路徑一次要讀一整頁的歷史——
    /// 任何一筆舊資料不得讓整份 drill-down 500。detail 為 null／不是合法 JSON／根不是物件
    /// ⇒ 兩欄皆 null；缺 `from`／`to`、顯式 null、型別不是字串、字串不是日期 ⇒ **該欄**
    /// null，另一欄照讀。`ChangedAt` 永遠保留傳入值。
    /// </summary>
    public static DueChangeEntry ParseDueChangeEntry(DateTime changedAt, string? detail)
    {
        if (string.IsNullOrWhiteSpace(detail)) return new DueChangeEntry(changedAt, null, null);
        try
        {
            using var doc = JsonDocument.Parse(detail);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                return new DueChangeEntry(changedAt, null, null);
            return new DueChangeEntry(
                changedAt,
                ReadDueField(doc.RootElement, "from"),
                ReadDueField(doc.RootElement, "to"));
        }
        catch (JsonException)
        {
            return new DueChangeEntry(changedAt, null, null);
        }
    }

    /// <summary>
    /// 讀單一欄位：缺欄位、`null`、非字串、非日期一律 null——與另一欄互不影響。
    /// </summary>
    private static DateTime? ReadDueField(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.String)
            return null;
        return element.TryGetDateTime(out var value) ? value : null;
    }

    /// <summary>
    /// 把一頁的 `due_change` 活動依卡片分組、排序、解析成 <see cref="DueChangeEntry"/>。
    ///
    /// **純函式**：輸入已 materialize（<see cref="DueChangeActivity"/> 序列）、輸出只依輸入
    /// 決定——排序契約的紅燈因此在記憶體裡成立，不依賴資料庫 planner 選了哪顆 index
    /// （`ActivityItems (CardId, CreatedAt, Id)` 被選中時，列序本來就是 `CreatedAt` 遞增）。
    /// 每張卡內依 `ChangedAt` 遞增，同一時間以 `Id` 遞增打破平手（沿用 repo 對 first-entry
    /// 的排序慣例：`ProjectReportQueries` 也是 `CreatedAt`、`Id`）。`Guid.CompareTo` 的比較序
    /// 與 Postgres `uuid` 的位元序不同——這裡只要求**穩定**，不要求與 SQL 的 ORDER BY 同源
    /// （那是 cursor 分頁的要求，見 `ActivityEndpoints`）。
    /// </summary>
    public static IReadOnlyDictionary<Guid, IReadOnlyList<DueChangeEntry>> GroupDueChanges(
        IEnumerable<DueChangeActivity> activities) =>
        activities
            .GroupBy(a => a.CardId)
            .ToDictionary(
                g => g.Key,
                g => (IReadOnlyList<DueChangeEntry>)g
                    .OrderBy(a => a.CreatedAt).ThenBy(a => a.Id)
                    .Select(a => ParseDueChangeEntry(a.CreatedAt, a.Detail))
                    .ToList());

    public static async Task<ReportDrilldownResult> GetAsync(
        EntaskDbContext db,
        IReadOnlyCollection<Guid> teamProjectIds,
        IReadOnlyCollection<Guid> readableProjectIds,
        Guid userId, ReportMetric metric, ReportWindow window,
        int page, int pageSize)
    {
        var rows = metric switch
        {
            ReportMetric.Completion => await CompletionRowsAsync(db, teamProjectIds, userId, window),
            ReportMetric.OnTime => await OnTimeRowsAsync(db, teamProjectIds, userId, window),
            ReportMetric.FirstPassYield => await FirstPassYieldRowsAsync(db, teamProjectIds, userId, window),
            ReportMetric.AverageScore => await AverageScoreRowsAsync(db, teamProjectIds, userId, window),
            _ => throw new ArgumentOutOfRangeException(nameof(metric), metric, "未知的 drill-down metric"),
        };

        var readable = readableProjectIds as ISet<Guid> ?? readableProjectIds.ToHashSet();
        var visible = rows.Where(r => readable.Contains(r.ProjectId)).ToList();

        // 排序：卡片類 `CompletedAt` 由新到舊、null 最後（`DateTime?` 的預設比較子把 null
        // 視為最小，遞減排序自然排到最後），再以 id 穩定；entry 類 `CreatedAt` 由新到舊。
        var ordered = (metric == ReportMetric.AverageScore
            ? visible.OrderByDescending(r => r.ReviewCreatedAt).ThenBy(r => r.ReviewEntryId)
            : visible.OrderByDescending(r => r.CompletedAt).ThenBy(r => r.CardId)).ToList();

        // skip 以 long 計算：極大的 page（`int` 上限附近）乘上 pageSize 會溢位成負數，
        // 而 `Skip(負數)` 等於不跳過 ⇒ 會把第一頁當成那一頁回出去。超出範圍就回空頁。
        var skip = (long)(page - 1) * pageSize;
        var pageRows = skip >= ordered.Count
            ? new List<ReportDrilldownRow>()
            : ordered.Skip((int)skip).Take(pageSize).ToList();

        // due 變更紀錄只在 on-time 這一格有值；其他 metric 維持 null（設計 §4.6）。
        // **一次 IN 查詢涵蓋這一頁的所有卡片**——不得逐列查詢。
        if (metric == ReportMetric.OnTime && pageRows.Count > 0)
        {
            var cardIds = pageRows.Select(r => r.CardId).Distinct().ToList();
            var activities = await db.ActivityItems
                .Where(a => cardIds.Contains(a.CardId) && a.Type == ActivityTypes.DueChange)
                .Select(a => new { a.CardId, a.Id, a.CreatedAt, a.Detail })
                .ToListAsync();

            // 分組、排序、解析在純函式裡（`GroupDueChanges`）——契約紅燈住在那裡，不靠這裡的列序。
            var dueChangesByCard = GroupDueChanges(activities
                .Select(a => new DueChangeActivity(a.CardId, a.CreatedAt, a.Id, a.Detail)));

            // 沒有變更的卡片是空清單、不是 null——前端不必區分「這張卡沒有紀錄」與
            // 「這個 metric 不提供紀錄」。
            pageRows = pageRows.Select(r => r with
            {
                DueChanges = dueChangesByCard.TryGetValue(r.CardId, out var entries)
                    ? entries
                    : Array.Empty<DueChangeEntry>(),
            }).ToList();
        }

        return new ReportDrilldownResult(
            Metric: metric,
            RowKind: metric == ReportMetric.AverageScore ? ReportRowKind.ReviewEntry : ReportRowKind.Card,
            PopulationCount: rows.Count,
            QualifyingCount: rows.Count(r => r.Qualifies),
            VisiblePopulationCount: visible.Count,
            VisibleQualifyingCount: visible.Count(r => r.Qualifies),
            Rows: pageRows);
    }

    /// <summary>
    /// 完成率：母體＝分母述詞（建卡日在窗內**或**交付日在窗內）；分子＝窗內交付。
    /// 與團隊報表的 `CardStats` 同一個判定方法（`IsDeliveredInWindow`），不是手寫的第三份。
    /// </summary>
    private static async Task<List<ReportDrilldownRow>> CompletionRowsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> teamProjectIds, Guid userId, ReportWindow window)
    {
        var cards = await DenominatorCards(db, teamProjectIds, userId, window)
            .Select(c => new
            {
                c.Id, c.Title,
                ProjectId = c.List.Board.ProjectId,
                ProjectName = c.List.Board.Project.Name,
                c.CompletedAt, c.DueAt,
            })
            .ToListAsync();

        return cards.Select(c => CardRow(c.Id, c.Title, c.ProjectId, c.ProjectName, c.CompletedAt, c.DueAt,
            qualifies: window.IsDeliveredInWindow(c.CompletedAt))).ToList();
    }

    /// <summary>
    /// 準時率：母體＝窗內交付**且**有截止日的卡片（沒有截止日的卡片兩邊都不進——這是
    /// 2026-09-21 使用者裁定，`CardStats` 的註解寫著理由）；分子＝`CompletedAt &lt;= DueAt`。
    /// </summary>
    private static async Task<List<ReportDrilldownRow>> OnTimeRowsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> teamProjectIds, Guid userId, ReportWindow window)
    {
        var cards = await DenominatorCards(db, teamProjectIds, userId, window)
            .Select(c => new
            {
                c.Id, c.Title,
                ProjectId = c.List.Board.ProjectId,
                ProjectName = c.List.Board.Project.Name,
                c.CompletedAt, c.DueAt,
            })
            .ToListAsync();

        // 母體與分子的兩條件與 `CardStats.CardStats` 逐字同形（窗框判定走同一個方法）。
        return cards
            .Where(c => window.IsDeliveredInWindow(c.CompletedAt) && c.DueAt is not null)
            .Select(c => CardRow(c.Id, c.Title, c.ProjectId, c.ProjectName, c.CompletedAt, c.DueAt,
                qualifies: c.CompletedAt <= c.DueAt))
            .ToList();
    }

    /// <summary>
    /// 一次交付通過率：母體與第一筆 entry 都來自
    /// <see cref="ProjectReportQueries.GetFirstPassCardsAsync"/>——**全庫唯一的 query filter
    /// 破例住在那裡**（曾指派過審查者），本檔沒有第二處。那支查詢同時決定了第一筆 entry
    /// （`CreatedAt`、`Id`）與卡片欄位，兩個呼叫端的答案因此逐位相同。
    /// </summary>
    private static async Task<List<ReportDrilldownRow>> FirstPassYieldRowsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> teamProjectIds, Guid userId, ReportWindow window)
    {
        var cards = await ProjectReportQueries.GetFirstPassCardsAsync(db, teamProjectIds, window);

        // 責任歸屬在記憶體判定，語意與團隊報表的 `userCardMap` 相同：有指派成員時歸所有
        // 指派成員，未指派時歸建立者。
        return cards
            .Where(c => c.Owners.Count > 0 ? c.Owners.Contains(userId) : c.CreatedById == userId)
            .Select(c => CardRow(c.CardId, c.Title, c.ProjectId, c.ProjectName, c.CompletedAt, c.DueAt,
                qualifies: c.FirstEntryStatus == ReviewStatuses.Approved,
                firstEntryId: c.FirstEntryId, firstStatus: c.FirstEntryStatus,
                firstAt: c.FirstEntryCreatedAt, firstReviewerUserId: c.FirstEntryReviewerUserId))
            .ToList();
    }

    /// <summary>
    /// 平均分：照 <see cref="ProjectReportQueries.GetTeamReviewStatsAsync"/>——一列是一次
    /// **審查提交**（`CardReviewEntry`），不是一張卡；`approved` 且帶分數才算樣本。
    /// 窗錨 `Card.CompletedAt`（**交付年**），有界線才加述詞（全期時未交付的卡仍在樣本裡）。
    /// 這個 metric 的母體與分子是同一組列 ⇒ `Qualifies` 恆為 true。
    /// </summary>
    private static async Task<List<ReportDrilldownRow>> AverageScoreRowsAsync(
        EntaskDbContext db, IReadOnlyCollection<Guid> teamProjectIds, Guid userId, ReportWindow window)
    {
        var query = db.CardReviewEntries
            .Where(e => teamProjectIds.Contains(e.Card.List.Board.ProjectId) && !e.Card.IsArchived
                && e.Score != null && e.Status == ReviewStatuses.Approved)
            // 責任歸屬與 FPY／團隊報表同語意：有指派成員時歸所有指派成員，未指派時歸建立者。
            .Where(e => e.Card.Members.Any(m => m.UserId == userId)
                || (!e.Card.Members.Any() && e.Card.CreatedById == userId));
        if (window.From is not null) query = query.Where(e => e.Card.CompletedAt != null && e.Card.CompletedAt >= window.From);
        if (window.To is not null) query = query.Where(e => e.Card.CompletedAt != null && e.Card.CompletedAt < window.To);

        var entries = await query
            .Select(e => new
            {
                e.Id, e.CardId, CardTitle = e.Card.Title,
                ProjectId = e.Card.List.Board.ProjectId,
                ProjectName = e.Card.List.Board.Project.Name,
                e.Card.CompletedAt, e.Card.DueAt,
                Score = e.Score!.Value, e.CreatedAt, e.ReviewerUserId,
            })
            .ToListAsync();

        return entries.Select(e => new ReportDrilldownRow(
            CardId: e.CardId, Title: e.CardTitle, ProjectId: e.ProjectId, ProjectName: e.ProjectName,
            CompletedAt: e.CompletedAt, DueAt: e.DueAt, Qualifies: true,
            FirstReviewEntryId: null, FirstReviewStatus: null, FirstReviewAt: null, FirstReviewerUserId: null,
            ReviewEntryId: e.Id, Score: e.Score, ReviewCreatedAt: e.CreatedAt, ReviewerUserId: e.ReviewerUserId,
            // 本 metric（entry 粒度）不帶 due 變更紀錄——只有 on-time 的卡片列有。
            DueChanges: null)).ToList();
    }

    /// <summary>
    /// 完成率／準時率共用的母體：團隊專案內非封存、符合分母述詞、且歸屬該成員的卡片。
    /// **分母述詞只有 <see cref="ReportWindow.DenominatorClause"/> 這一處**。
    /// </summary>
    private static IQueryable<Card> DenominatorCards(
        EntaskDbContext db, IReadOnlyCollection<Guid> teamProjectIds, Guid userId, ReportWindow window) =>
        db.Cards
            .Where(c => teamProjectIds.Contains(c.List.Board.ProjectId) && !c.IsArchived)
            .Where(window.DenominatorClause())
            .Where(OwnedBy(userId));

    /// <summary>
    /// 責任歸屬述詞，與團隊報表 `userCardMap`／`GetFirstPassYieldAsync`／
    /// `GetTeamReviewStatsAsync` 逐字同語意：有指派成員時歸所有指派成員，未指派時歸建立者。
    /// </summary>
    private static Expression<Func<Card, bool>> OwnedBy(Guid userId) =>
        c => c.Members.Any(m => m.UserId == userId) || (!c.Members.Any() && c.CreatedById == userId);

    private static ReportDrilldownRow CardRow(
        Guid cardId, string title, Guid projectId, string projectName,
        DateTime? completedAt, DateTime? dueAt, bool qualifies,
        Guid? firstEntryId = null, string? firstStatus = null,
        DateTime? firstAt = null, Guid? firstReviewerUserId = null) =>
        new(CardId: cardId, Title: title, ProjectId: projectId, ProjectName: projectName,
            CompletedAt: completedAt, DueAt: dueAt, Qualifies: qualifies,
            FirstReviewEntryId: firstEntryId, FirstReviewStatus: firstStatus,
            FirstReviewAt: firstAt, FirstReviewerUserId: firstReviewerUserId,
            ReviewEntryId: null, Score: null, ReviewCreatedAt: null, ReviewerUserId: null,
            // 先留 null；on-time 的頁面在 `GetAsync` 出頁後統一補上（其他 metric 一直是 null）。
            DueChanges: null);
}
