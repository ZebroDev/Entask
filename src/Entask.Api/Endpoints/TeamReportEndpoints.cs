using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core.Abstractions;
using Entask.Infrastructure.Data;
using Entask.Performance;
using Entask.Core;
using System.Security.Claims;

namespace Entask.Api.Endpoints;

/// <summary>
/// 團隊報表的三條輸出（JSON／CSV／xls）與 drill-down。**partial**：grade 分解、匯出呈現
/// 與 drill-down 的輔助各自一個檔（2026-10-21 拆檔，主檔硬上限 800 行）。
///
/// **門檻常數與兩組比較站點留在這個檔**（`RatingFor`／`FpyGateStatus`、
/// `ApplyScoreAdjustment`／`AdjustmentSamplesInsufficient`）：`check:thresholds` 讀的是
/// 這個路徑，而它要求每一組「恰好兩個站點、同一個值」。
/// </summary>
public static partial class TeamReportEndpoints
{
    // ---- 評等門檻（設計 §13.2／§13.3／§13.4）----
    //
    // **公式與 grade 分解（`BuildRatingBreakdown`）共用這一份常數**：分解回給前端的
    // `tiers`／`sampleThreshold` 與這裡算出來的值因此不可能各寫一份。前端不得再寫字面值。
    private const double CompletionS = 0.85;
    private const double CompletionA = 0.70;
    private const double CompletionB = 0.50;
    private const double OnTimeS = 0.85;
    private const double FpyS = 0.80;
    private const int FpySampleThreshold = 5;
    private const double AdjustmentUp = 4.5;
    private const double AdjustmentDown = 2.0;
    private const int AdjustmentSampleThreshold = 3;

    /// <summary>
    /// 績效評等。**三條輸出路徑（JSON／CSV／xls）共用這一處**——原本是三份各寫一次的三元式，
    /// 新增等級時要改三個地方，而漏改的那條不會有任何錯誤訊息，只會讓匯出檔與畫面上的
    /// 評級靜默不一致。
    ///
    /// S 的三個條件都是複合條件——第三個（一次交付通過率）是 2026-09-16 追加的
    /// （設計 §13.2）。**A／B／C 的門檻刻意不動**。
    ///
    /// **fpy 為 null ＝樣本不足＝這個條件不列入**，不是「不滿足」。寫成 `fpy >= 0.80` 的
    /// 話，C# 對 `double?` 的抬升比較會讓 null 直接是 false ⇒ 沒有審查紀錄的人**一律拿不到 S**
    /// ——那正是設計 §13.4「不足時不列入 S 資格（完成率與準時率照算）」與 §13.2
    /// 「沒有審查紀錄的人，等級與今天一模一樣」明文排除的結果（實測：`RatingFor` 少了
    /// `fpy is null ||` 時，`TeamReportTests` 有四支之中的兩支、共三個 case 當場變紅）。
    ///
    /// 2026-09-21 起**三個輸入都可為 null**，null 一律讀作「該條件沒有樣本 ⇒ 不列入」：
    /// * `completionRate` 為 null ＝ **一張卡片都沒有** ⇒ 回傳 **null（不給評等）**。
    ///   使用者 2026-09-21 裁定：零卡片成員的達成率顯示「樣本不足」、不給評等——
    ///   舊制讓這種人拿到 **C**，與「有卡片但一張都沒完成」在畫面上長得一模一樣，
    ///   而前者是「沒有依據」、後者才是「做得不好」（對照組見
    ///   `TeamReportTests.CompletionRate_IsZero_WhenHasCardsButNoneCompleted`）。
    /// * `onTimeRate` 為 null ＝ **已交付的卡片全都沒有截止日** ⇒ 不列入（見 `CardStats`）。
    /// </summary>
    private static string? RatingFor(double? completionRate, double? onTimeRate, double? fpy)
    {
        var tier = CompletionTier(completionRate);
        if (tier is null) return null;
        // S 是唯一要三個條件的等級：完成率對到 S 之後，兩個 gate 任一不成立就落回 A。
        // 其餘三級只由完成率決定（設計 §13.2 的欄位關係）。
        if (tier != RatingCodes.S) return tier;
        return (onTimeRate is null || onTimeRate >= OnTimeS) && (fpy is null || fpy >= FpyS)
            ? RatingCodes.S : RatingCodes.A;
    }

    /// <summary>
    /// 完成率自己的階梯（不含 S 的兩個 gate）。`RatingFor` 與 `RatingComponentDto.AchievedTier`
    /// 共用這一支——**兩份階梯就會有兩份先漂移的門檻**（0.85／0.70／0.50）。
    ///
    /// `AchievedTier` 的語意是「**完成率**對到哪一級」，不是 `baseRating`：完成率 1.0 而
    /// 準時率 0.75 的人 base 是 A，但把他解釋成「完成率 100% → A」是錯的——掉出 S 的原因
    /// 在 onTime 那一格（設計 §4.4 的 sGate），completion 這一格只說完成率自己的結論。
    /// </summary>
    private static string? CompletionTier(double? completionRate) =>
        completionRate is null ? null :
        completionRate >= CompletionS ? RatingCodes.S :
        completionRate >= CompletionA ? RatingCodes.A :
        completionRate >= CompletionB ? RatingCodes.B : RatingCodes.C;

    /// <summary>
    /// 樣本門檻與「樣本不足 ⇒ 該條件不適用」的**唯一出處**（設計 §13.4／D10）。
    /// 回傳 null 表示「不適用」，不是 0——畫面靠這個區別顯示「樣本不足」而不是「0%」。
    /// </summary>
    private static double? FirstPassYieldOrNull(int firstPass, int reviewed) =>
        reviewed >= FpySampleThreshold ? (double)firstPass / reviewed : null;

    /// <summary>
    /// 成員的卡片統計與兩個比率。**三條輸出路徑（JSON／CSV／xls）共用這一處**——原本三份
    /// 各寫一次，而 `completed > 0 ? … : 1.0` 那個後備就是這樣在三個地方同時說出
    /// 「沒交付過的人準時率 100%」（使用者 2026-09-21 回報的那一格：同一個人的相鄰三欄
    /// 裡，一次交付通過率與平均評分顯示「樣本不足」、準時率卻是 100%）。
    ///
    /// **準時率的分母是「已交付**且**有截止日」的卡片**，不是「已交付」（使用者 2026-09-21
    /// 裁定）。沒有截止日的卡片**分子分母都不進**：無從判定準時與否的卡片既不該算準時、
    /// 也不該算遲交。舊制把它算成準時（`c.DueAt == null ||`），於是「交付十張沒有截止日的
    /// 卡片」與「交付十張全部準時的卡片」在畫面上都是 100%——而前者根本沒有依據。
    ///
    /// **兩個比率在分母為 0 時都是 null**，與 `FirstPassYieldOrNull` 同一條慣例
    /// （設計 §13.4：報表要標示「樣本不足」，不要靜默套用）。`OnTimeSamples` 與
    /// `OnTimeCards` 就是那個分母與分子，與 `firstPass`／`reviewed` 同一個道理——
    /// 原料與比率一起回傳，消費端才分得出「樣本不足」與「別的原因」。
    ///
    /// 注意 `CompletionRate` 的 null 只涵蓋「一張卡片都沒有」：**有卡片而一張都沒完成
    /// 是 0.0，不是 null**（分母是 0 才是樣本不足，分子是 0 不是）。
    ///
    /// 2026-09-21 起多收一個 `window`：「已交付」的判斷改由 `ReportWindow.IsDeliveredInWindow`
    /// 決定（**窗框語意的唯一出處**）。裸的 `CompletedAt != null` 是第二份實作——全期時
    /// 它就是 `IsDeliveredInWindow` 的極限（`from`／`to` 皆 null ⇒ 退化為 `is not null`），
    /// 所以這一改對不帶窗框的呼叫端逐位等價。
    /// </summary>
    private static (int Total, int Completed, int OnTimeCards, int OnTimeSamples,
                    double? CompletionRate, double? OnTimeRate) CardStats(List<dynamic> cards, ReportWindow window)
    {
        var total = cards.Count;
        // 「交付」的判斷只有 ReportWindow 那一份——裸的 CompletedAt != null 是第二份實作。
        var completed = cards.Count(c => window.IsDeliveredInWindow((DateTime?)c.CompletedAt));
        var onTimeSamples = cards.Count(c => window.IsDeliveredInWindow((DateTime?)c.CompletedAt) && c.DueAt != null);
        var onTimeCards = cards.Count(c => window.IsDeliveredInWindow((DateTime?)c.CompletedAt) && c.DueAt != null && c.CompletedAt <= c.DueAt);

        return (total, completed, onTimeCards, onTimeSamples,
                total > 0 ? (double)completed / total : null,
                onTimeSamples > 0 ? (double)onTimeCards / onTimeSamples : null);
    }

    /// <summary>
    /// 榜單排序用的等級序（使用者 2026-09-21 裁定：**依評等，同級再依達成率**）。
    /// 重用既有的 `RatingLadder`——它的宣告順序就是由低到高，所以索引即等級，
    /// 不必再維護第二份階梯。
    ///
    /// **`null` 與認不得的等級都回 −1**（排最後）：沒有評等的人不該排在 A 與 B 之間，
    /// 而 `Array.IndexOf` 對認不得的值本來就回 −1，兩者同組是順帶的、也是對的。
    /// 一個 `< 0` 的值同時保證它落在 `C` 之後（`C` 的索引是 0）。
    /// </summary>
    private static int RatingRank(string? rating) =>
        rating is null ? -1 : Array.IndexOf(RatingLadder, rating);

    /// <summary>
    /// 等級由低到高的階梯。調整項**只能在相鄰兩格之間移動**——索引運算的邊界就靠這個陣列的
    /// 兩端（`Math.Min`／`Math.Max`），所以它同時是「最多一級」與「不會溢出」的實作。
    /// </summary>
    private static readonly string[] RatingLadder = [RatingCodes.C, RatingCodes.B, RatingCodes.A, RatingCodes.S];

    /// <summary>
    /// 主管評分的調整項（設計 §13.3）。最多升／降一級——單一主管的偏好不能把 C 變成 S。
    /// 樣本不足（&lt; 3 筆）時完全不調整，這是刻意的：兩筆評分不足以代表一季的表現。
    /// 門檻（4.5／2.0）刻意設在兩端，讓「不動」是預設結果。
    ///
    /// **這一支是獨立一層，不進 `RatingFor`**（設計 §13.3 的架構決定）：分數是主觀的，
    /// 客觀公式不碰它。唯一的呼叫端是 `Rate`——三條輸出路徑都經過那裡。
    ///
    /// 認不得的基準評等回傳原值：`RatingLadder` 與 `RatingCodes` 同源，走不到那一格，
    /// 但真的發生時「不調整」比「猜一個索引 0 的 C」安全。
    /// </summary>
    private static string ApplyScoreAdjustment(string baseRating, double? averageScore, int scoreSamples)
    {
        if (averageScore is null || scoreSamples < AdjustmentSampleThreshold) return baseRating;
        var i = Array.IndexOf(RatingLadder, baseRating);
        if (i < 0) return baseRating;
        if (averageScore >= AdjustmentUp) return RatingLadder[Math.Min(i + 1, RatingLadder.Length - 1)];
        if (averageScore <= AdjustmentDown) return RatingLadder[Math.Max(i - 1, 0)];
        return baseRating;
    }

    /// <summary>
    /// 評等的**唯一出口**：一次算出 base（客觀公式）與 final（加上調整項）。
    /// JSON 的 `ratingBreakdown` 需要兩者，CSV／xls 只需要 final——三個呼叫端都走這裡，
    /// 「畫面說的 base」與「匯出檔的 rating」因此不可能各算一次（Task 10／11 的同一條理由）。
    /// </summary>
    private static (string? Base, string? Final) Rate(
        double? completionRate, double? onTimeRate,
        int firstPass, int reviewed, double? averageScore, int scoreSamples)
    {
        var baseRating = RatingFor(completionRate, onTimeRate, FirstPassYieldOrNull(firstPass, reviewed));
        // 調整項是「在既有等級上加減」，沒有等級（零卡片）就沒有加減的對象。
        var finalRating = baseRating is null ? null : ApplyScoreAdjustment(baseRating, averageScore, scoreSamples);
        return (baseRating, finalRating);
    }

    /// <summary>
    /// 樣本門檻 ＋ 評等的**匯出轉接**（只剩 CSV／xls 兩條路徑呼叫；JSON 直接走 `Rate`）。
    /// `fpy` 為 null 表示樣本不足——該條件**不適用**，不是不成立（見 `RatingFor` 的說明：
    /// `null >= 0.80` 在 C# 是 false）。
    ///
    /// 這一層存在的理由與 `RatingFor` 相同：門檻值（`5`）與 null 的判斷原本在三條路徑
    /// 各寫一次，而 CSV／xls 那兩份**沒有任何測試打到**——寫死 `null`（跳過整條 FPY 條件）
    /// 或把門檻寫成別的數字，都不會有紅燈。現在兩條匯出路徑都只經過這裡。
    ///
    /// Task 11 的調整項由 `Rate` 套用：**`ApplyScoreAdjustment` 是包在 `RatingFor`
    /// 外面的獨立一層**（設計 §13.3），不是它的第四個參數——客觀公式不碰主觀分數；
    /// 集中在 `Rate` 而不是各呼叫端各包一次。這一支因此只是 `Rate(...).Final` 的轉接。
    /// </summary>
    /// 2026-09-21 起回傳 **`string?`**：沒有基準評等（零卡片）時就沒有可調整的東西。
    /// `rating is null` 在 `Rate` 擋掉，所以 `ApplyScoreAdjustment` 的簽章仍是 `string`
    /// ——**調整項是「在既有等級上加減」，沒有等級就沒有加減的對象**。
    /// </summary>
    private static string? RatingForMember(double? completionRate, double? onTimeRate,
        int firstPass, int reviewed, double? averageScore, int scoreSamples) =>
        Rate(completionRate, onTimeRate, firstPass, reviewed, averageScore, scoreSamples).Final;

    /// <summary>
    /// FPY 的 S gate 狀態（`met`／`failed`）——`BuildRatingBreakdown`（partial 檔）用它，
    /// 而 `RatingFor` 用它**同一條界線**決定 S 的資格。**兩個站點都在這個檔**：門檻值與
    /// 比較式只有一份宣告（`check:thresholds` 的 fpy 那一列守著「兩個站點同值」）。
    /// `fpy` 為 null 不是 `failed`——那是「樣本不足、不列入」，由呼叫端判成 `notApplicable`。
    /// </summary>
    private static string FpyGateStatus(double fpy) => fpy >= FpyS ? "met" : "failed";

    /// <summary>
    /// 調整項的樣本門檻（設計 §13.3）：樣本不足 ⇒ 不調整，`notApplied` 的原因即
    /// `sampleInsufficient`。**`ApplyScoreAdjustment` 的早退與 `NotAppliedReason`
    /// （partial 檔）共用同一條界線**——比較式留在這個檔，`check:thresholds` 的
    /// scoreSamples 那一列要求兩個站點都在這裡、且指著同一個常數。
    /// </summary>
    private static bool AdjustmentSamplesInsufficient(double? averageScore, int scoreSamples) =>
        averageScore is null || scoreSamples < AdjustmentSampleThreshold;

    public static IEndpointRouteBuilder MapTeamReports(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/teams/{teamId:guid}/report", async (Guid teamId, DateTime? from, DateTime? to, EntaskDbContext db) =>
        {
            // 顛倒窗框回 400（裁定 6，2026-09-22）：三條團隊路由與專案的兩條從此一致。
            // 在此之前本條會靜默回一份空報告（HTTP 200）——使用者看到的是「這個團隊沒資料」，
            // 而不是「你選的期間反了」。字面值與 `ReportEndpoints` 逐字相同（見該檔的註解）。
            if (from is not null && to is not null && from >= to)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
            if (from is not null && to is not null && (to.Value - from.Value).TotalDays > WorkLogQueries.MaxRangeDays)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.QueryRangeTooLong,
                    message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                    @params = new { max = WorkLogQueries.MaxRangeDays }
                });
            var projectIds = await db.Projects.Where(p => p.TeamId == teamId).Select(p => p.Id).ToListAsync();

            // 卡片窗＝「乙」：建卡日在窗內**或**交付日在窗內（分母），分子另由同一組界線判定。
            // 窗框語意（含上界排他與 Kind 正規化）只在 `ReportWindow` 這一處。
            var window = ReportWindow.Create(from, to);
            var cardsQuery = db.Cards.Where(c => projectIds.Contains(c.List.Board.ProjectId) && !c.IsArchived);
            cardsQuery = cardsQuery.Where(window.DenominatorClause());

            var rawCards = await cardsQuery
                .Select(c => new
                {
                    c.Id,
                    c.CompletedAt,
                    c.DueAt,
                    c.CreatedById,
                    AssigneeIds = c.Members.Select(m => m.UserId).ToList()
                })
                .ToListAsync();

            // 個人登記工時統計 (僅統計該成員自己填寫的 EffortLog)
            var effortQuery = db.EffortLogs.Where(e => projectIds.Contains(e.Card.List.Board.ProjectId) && !e.Card.IsArchived);
            if (window.From is not null) effortQuery = effortQuery.Where(e => e.LoggedAt >= window.From);
            if (window.To is not null) effortQuery = effortQuery.Where(e => e.LoggedAt < window.To);
            var memberEffortMap = await effortQuery
                .GroupBy(e => e.UserId)
                .Select(g => new { UserId = g.Key, Hours = (decimal)g.Sum(e => (double)e.Hours) })
                .ToDictionaryAsync(g => g.UserId, g => g.Hours);

            // 責任歸屬：若有指派成員則歸屬所有指派成員，未指派時歸屬建立者
            var userCardMap = new Dictionary<Guid, List<dynamic>>();
            foreach (var c in rawCards)
            {
                var owners = c.AssigneeIds.Count > 0 ? c.AssigneeIds : new List<Guid> { c.CreatedById };
                foreach (var ownerId in owners)
                {
                    if (!userCardMap.TryGetValue(ownerId, out var list))
                    {
                        list = new List<dynamic>();
                        userCardMap[ownerId] = list;
                    }
                    list.Add(c);
                }
            }

            var userIds = userCardMap.Keys.Union(memberEffortMap.Keys).Distinct().ToList();
            var users = await ActivityEndpoints.GetUsersAsync(db, userIds);

            // 一次交付通過率（設計 §13.2）。**窗錨交付年**（`Card.CompletedAt`）——與上面的
            // 卡片窗「乙」刻意不同源（乙含「該年建卡而未在該年交付」，那不是成果面，設計 §4.3）；
            // 兩個比率要拼進同一條評等公式，分子這一側的基準必須一致。
            // 字典在成員迴圈「之前」查一次，迴圈裡只查表（不查 DB）。
            var firstPassYield = await ProjectReportQueries.GetFirstPassYieldAsync(db, projectIds, window, userIds);
            // 主管評分的平均與樣本數（設計 §13.3），同一個理由先查好。
            var reviewStats = await ProjectReportQueries.GetTeamReviewStatsAsync(db, projectIds, window, userIds);

            var membersList = userIds.Select(uId =>
            {
                var cards = userCardMap.GetValueOrDefault(uId) ?? new List<dynamic>();
                var loggedHours = memberEffortMap.GetValueOrDefault(uId, 0m);

                // 統計與兩個比率只有 `CardStats` 這一處（三條輸出路徑共用），
                // 「樣本不足」的語意因此不可能在 JSON／CSV／xls 之間分裂。
                var (total, completed, onTime, onTimeSamples, completionRate, onTimeRate) = CardStats(cards, window);
                var (firstPass, reviewed) = firstPassYield.GetValueOrDefault(uId, (0, 0));
                var (averageScore, scoreSamples) = reviewStats.GetValueOrDefault(uId, (null, 0));
                // fpy 另存一份給回應（畫面要顯示「樣本不足」）。門檻與 null 的判斷只有
                // `FirstPassYieldOrNull` 這一處，所以這一格與評等用的那一個不可能不一致。
                double? fpy = FirstPassYieldOrNull(firstPass, reviewed);
                // 評等的唯一出口：base 與 final 一次算好——`rating` 與 `ratingBreakdown`
                // 因此是同一個 base／final 的兩個視圖，不是兩次計算。
                var (baseRating, finalRating) = Rate(completionRate, onTimeRate, firstPass, reviewed, averageScore, scoreSamples);

                return new
                {
                    userId = uId,
                    username = users.GetValueOrDefault(uId)?.UserName ?? "",
                    displayName = users.GetValueOrDefault(uId)?.DisplayName ?? "",
                    avatarUrl = users.GetValueOrDefault(uId)?.AvatarUrl,
                    completedCards = completed,
                    totalCards = total,
                    // 兩個比率可為 null（「樣本不足」），與相鄰的 fpy／averageScore 同一條慣例。
                    completionRate = completionRate,
                    onTimeCards = onTime,
                    // 準時率的分母（已交付且有截止日的卡片）。與 firstPass／reviewed 同一個
                    // 道理：沒有它，`onTimeRate: null` 分不出是「沒有樣本」還是別的原因。
                    onTimeSamples = onTimeSamples,
                    onTimeRate = onTimeRate,
                    loggedHours = loggedHours,
                    // 原料與比率一起回傳：fpy 為 null 時畫面要顯示「樣本不足」而不是 0%
                    firstPass = firstPass,
                    reviewed = reviewed,
                    fpy = fpy,
                    // 與餵給 `Rate` 的**是同一個字典查出來的同一個值**（Task 10 的 I2
                    // 消滅的正是「同一件事算兩次」）：畫面顯示的取捨依據必須等於評等用的依據。
                    averageScore = averageScore,
                    scoreSamples = scoreSamples,
                    rating = finalRating,
                    // 分解完全用上面已算好的值（不新增 DB 查詢）；門檻由伺服器帶，前端只渲染。
                    ratingBreakdown = BuildRatingBreakdown(
                        completionRate, total, onTimeRate, onTimeSamples,
                        reviewed, fpy, averageScore, scoreSamples,
                        baseRating, finalRating)
                };
            })
            // **依評等，同級再依達成率**（使用者 2026-09-21 裁定）。
            // 舊制是單純的達成率遞減——那與「依評等」在大部分情況下同序，**只有在 S 的邊界上
            // 分道揚鑣**：S 除了達成率 ≥ 0.85 還要準時率 ≥ 0.85 與 fpy ≥ 0.80，所以一位
            // 「達成率 1.0、但準時率 0.75」的 A 會排在一位「達成率 0.86 的 S」前面。
            // 榜單既然把評等當成主要結論，第一眼就該照評等排。
            // 次鍵是達成率（`?? -1`：沒有達成率的人排在同級的最後），第三鍵才是完成張數
            // ——它只在「達成率完全相同」時才輪得到（見 `Ranking_SortsByRatingThenByCompletionRate`）。
            .OrderByDescending(m => RatingRank(m.rating))
            .ThenByDescending(m => m.completionRate ?? -1)
            .ThenByDescending(m => m.completedCards).ToList();

            // 年份清單的推導已抽到 `ProjectReportQueries.GetAvailableYearsAsync`（2026-09-22）
            // ——專案報表要同一份清單，兩邊各寫一份就是 `CardStats` 那種 bug 的形狀。
            // 「為什麼不吃窗框」與「為什麼不併入今年」的理由跟著方法走，這一側不再複寫。
            var availableYears = await ProjectReportQueries.GetAvailableYearsAsync(db, projectIds);

            var result = new
            {
                members = membersList,
                availableYears = availableYears,
                summary = new
                {
                    totalCompleted = membersList.Sum(m => m.completedCards),
                    totalCards = membersList.Sum(m => m.totalCards),
                    overallCompletionRate = membersList.Sum(m => m.totalCards) > 0 
                        ? (double)membersList.Sum(m => m.completedCards) / membersList.Sum(m => m.totalCards) 
                        : 0,
                    totalHours = membersList.Sum(m => m.loggedHours)
                }
            };

            return Results.Ok(result);
        }).RequireAuthorization().RequirePermission(PermissionCodes.ReportView);

        // **刻意不統一**（改動它之前先讀 `docs/STATE.md` 的 **兩種「年度」語意並存（刻意不統一）**）。
        // 本端點仍用「`int? year` ＋ **建卡年**（`c.CreatedAt.Year`，UTC）」，而上面那三條路徑
        // 用「交付年 ＋ 自然年 ＋ 前端傳 `from`／`to`」——同一支檔案裡兩個都叫年度，這裡是
        // 最容易被後人「統一」的一格。不改的理由：它**全庫沒有前端呼叫端**，沒有消費者的
        // 契約變更沒有任何紅燈看著（設計 §10 明文不做）。連帶的兩件小事也一樣留著：
        // 零卡片仍回 `completionRate: 0`（不是「沒有樣本回 null」那條慣例），且它不帶
        // `availableYears`（那是團隊報表的欄位，形狀不同）。
        app.MapGet("/api/users/{userId:guid}/performance", async (Guid userId, int? year, EntaskDbContext db, ClaimsPrincipal principal) =>
        {
            var currentUserId = BoardEndpoints.CurrentUserId(principal);
            // 管理員身分是自訂 claim（entask:admin），JWT 不發 Identity Role——IsInRole("Admin") 恆 false
            var isAdmin = principal.FindFirstValue(Entask.Identity.AdminClaim.Type) == Entask.Identity.AdminClaim.Value;
            if (currentUserId != userId && !isAdmin)
            {
                var callerTeams = await db.TeamMembers
                    .Where(m => m.UserId == currentUserId &&
                                m.Role.RolePermissions.Any(rp => rp.Permission.Code == PermissionCodes.TeamMemberManage ||
                                                                 rp.Permission.Code == PermissionCodes.TeamRoleManage))
                    .Select(m => m.TeamId)
                    .ToListAsync();
                var isSharedManager = callerTeams.Any() && await db.TeamMembers.AnyAsync(m => callerTeams.Contains(m.TeamId) && m.UserId == userId);
                if (!isSharedManager)
                    return Results.Json(new { code = ErrorCodes.TeamNotMember, message = "你不是這個團隊的成員，無法檢視績效報表" },
                        statusCode: StatusCodes.Status403Forbidden);
            }

            var cardsQuery = db.Cards.Where(c => (c.Members.Any(m => m.UserId == userId) || (!c.Members.Any() && c.CreatedById == userId)) && !c.IsArchived);
            if (year.HasValue)
            {
                cardsQuery = cardsQuery.Where(c => c.CreatedAt.Year == year.Value);
            }

            var stats = await cardsQuery
                .GroupBy(c => 1)
                .Select(g => new { Completed = g.Count(c => c.CompletedAt != null), Total = g.Count() })
                .FirstOrDefaultAsync();

            return Results.Ok(new
            {
                userId,
                completedCards = stats?.Completed ?? 0,
                totalCards = stats?.Total ?? 0,
                completionRate = stats?.Total > 0 ? (double)stats.Completed / stats.Total : 0
            });
        }).RequireAuthorization();

        app.MapGet("/api/teams/{teamId:guid}/report/export", async (Guid teamId, DateTime? from, DateTime? to, EntaskDbContext db) =>
        {
            // 同 JSON 路由的 guard（裁定 6）：顛倒窗框原本會匯出一張只有表頭的 CSV。
            if (from is not null && to is not null && from >= to)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
            if (from is not null && to is not null && (to.Value - from.Value).TotalDays > WorkLogQueries.MaxRangeDays)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.QueryRangeTooLong,
                    message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                    @params = new { max = WorkLogQueries.MaxRangeDays }
                });
            var projectIds = await db.Projects.Where(p => p.TeamId == teamId).Select(p => p.Id).ToListAsync();

            // 卡片窗＝「乙」：建卡日在窗內**或**交付日在窗內（與 JSON 路徑同一條規則）。
            // 三條輸出路徑各有一份查詢，而抄錯一份的後果是「畫面是該年、匯出檔是全期」
            // ——沒有任何閘門看得到，所以窗框語意只在 `ReportWindow` 這一處。
            var window = ReportWindow.Create(from, to);
            var cardsQuery = db.Cards.Where(c => projectIds.Contains(c.List.Board.ProjectId) && !c.IsArchived);
            cardsQuery = cardsQuery.Where(window.DenominatorClause());

            var rawCards = await cardsQuery
                .Select(c => new
                {
                    c.Id,
                    c.CompletedAt,
                    c.DueAt,
                    c.CreatedById,
                    AssigneeIds = c.Members.Select(m => m.UserId).ToList()
                })
                .ToListAsync();

            var effortQuery = db.EffortLogs.Where(e => projectIds.Contains(e.Card.List.Board.ProjectId) && !e.Card.IsArchived);
            if (window.From is not null) effortQuery = effortQuery.Where(e => e.LoggedAt >= window.From);
            if (window.To is not null) effortQuery = effortQuery.Where(e => e.LoggedAt < window.To);
            var memberEffortMap = await effortQuery
                .GroupBy(e => e.UserId)
                .Select(g => new { UserId = g.Key, Hours = (decimal)g.Sum(e => (double)e.Hours) })
                .ToDictionaryAsync(g => g.UserId, g => g.Hours);

            var userCardMap = new Dictionary<Guid, List<dynamic>>();
            foreach (var c in rawCards)
            {
                var owners = c.AssigneeIds.Count > 0 ? c.AssigneeIds : new List<Guid> { c.CreatedById };
                foreach (var ownerId in owners)
                {
                    if (!userCardMap.TryGetValue(ownerId, out var list))
                    {
                        list = new List<dynamic>();
                        userCardMap[ownerId] = list;
                    }
                    list.Add(c);
                }
            }

            var userIds = userCardMap.Keys.Union(memberEffortMap.Keys).Distinct().ToList();
            var users = await ActivityEndpoints.GetUsersAsync(db, userIds);

            // 與 JSON 路徑同一份 FPY：兩個比率拼進同一條公式，匯出檔的評級必須與畫面一致。
            // 欄位不加寬（表頭是寫死的英文，加欄位是匯出格式的破壞性變更）——Task 11 的
            // 平均分與樣本數因此**只影響評級、不新增欄位**，這與 Task 10 對 FPY 的裁定相同。
            var firstPassYield = await ProjectReportQueries.GetFirstPassYieldAsync(db, projectIds, window, userIds);
            var reviewStats = await ProjectReportQueries.GetTeamReviewStatsAsync(db, projectIds, window, userIds);

            var sb = new System.Text.StringBuilder();
            sb.AppendLine("UserId,Username,DisplayName,Rating,CompletedCards,TotalCards,CompletionRate,OnTimeRate,LoggedHours");
            foreach (var uId in userIds)
            {
                var cards = userCardMap.GetValueOrDefault(uId) ?? new List<dynamic>();
                var loggedHours = memberEffortMap.GetValueOrDefault(uId, 0m);

                // 卡片統計與 JSON 路徑同一個窗框——三條輸出路徑對同一組 from／to 同源。
                var (total, completed, _, _, completionRate, onTimeRate) = CardStats(cards, window);
                var (firstPass, reviewed) = firstPassYield.GetValueOrDefault(uId, (0, 0));
                var (averageScore, scoreSamples) = reviewStats.GetValueOrDefault(uId, (null, 0));
                var rating = RatingForMember(completionRate, onTimeRate, firstPass, reviewed, averageScore, scoreSamples);

                var uname = CsvField.Escape(users.GetValueOrDefault(uId)?.UserName ?? "");
                var dname = CsvField.Escape(users.GetValueOrDefault(uId)?.DisplayName ?? "");
                // 匯出檔是**機器格式**：欄位以逗號分隔，而這裡的三個數值一律 InvariantCulture。
                // 少了它，在逗號小數點的主機文化（de-DE／fr-FR 這一族）下 `{completionRate:P1}`
                // 會印成「33,3 %」——欄位未加引號 ⇒ 這一列多出一個逗號，往後的欄位全盤位移；
                // `{loggedHours}` 同理（1,5）。XLS 那一側見下方 PercentCell／NumberCell 的註解。
                // 附帶效果：InvariantCulture 的百分比樣式是「33.3 %」（有空格），與 zh-TW／en-US
                // 的「33.3%」不同——這是修掉地雷時一併發生的呈現變更，不是格式重新設計。
                // 欄位不加寬（表頭是寫死的英文）⇒ 三個可為 null 的欄位（評等與兩個比率）
                // **一律寫成空欄位**。這裡刻意寫成顯式條件，**不倚賴 `{null:P1}` 的空字串行為**
                // ——那個行為是隱含的，而且是這一格唯一的防線。
                // 不在機器格式裡塞「樣本不足」：那是畫面層的用語，語系化與欄寬都是另一個決定。
                var completionCell = completionRate is null
                    ? "" : completionRate.Value.ToString("P1", CultureInfo.InvariantCulture);
                var onTimeCell = onTimeRate is null
                    ? "" : onTimeRate.Value.ToString("P1", CultureInfo.InvariantCulture);
                sb.AppendLine(string.Create(CultureInfo.InvariantCulture,
                    $"{uId},\"{uname}\",\"{dname}\",{rating ?? ""},{completed},{total},{completionCell},{onTimeCell},{loggedHours}"));
            }
            
            var bytes = System.Text.Encoding.UTF8.GetBytes(sb.ToString());
            var bom = new byte[] { 0xEF, 0xBB, 0xBF };
            var result = new byte[bom.Length + bytes.Length];
            Buffer.BlockCopy(bom, 0, result, 0, bom.Length);
            Buffer.BlockCopy(bytes, 0, result, bom.Length, bytes.Length);
            
            return Results.File(result, "text/csv", $"team-{teamId}-performance{YearSuffix(window)}.csv");
        }).RequireAuthorization().RequirePermission(PermissionCodes.ReportView);

        app.MapGet("/api/teams/{teamId:guid}/report/export-excel", async (Guid teamId, DateTime? from, DateTime? to, string? locale, EntaskDbContext db) =>
        {
            // 同 JSON 路由的 guard（裁定 6）：顛倒窗框原本會匯出一張只有表頭的 xls。
            // **放在 `ExportLabels.For(locale)` 之前**——三條路由的順序一致，錯誤輸入的
            // 回應就不會因為 locale 認不認得而變。
            if (from is not null && to is not null && from >= to)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
            if (from is not null && to is not null && (to.Value - from.Value).TotalDays > WorkLogQueries.MaxRangeDays)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.QueryRangeTooLong,
                    message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                    @params = new { max = WorkLogQueries.MaxRangeDays }
                });
            var labels = ExportLabels.For(locale);
            var projectIds = await db.Projects.Where(p => p.TeamId == teamId).Select(p => p.Id).ToListAsync();

            // 卡片窗＝「乙」：建卡日在窗內**或**交付日在窗內（與 JSON／CSV 路徑同一條規則，
            // 語意只在 `ReportWindow` 這一處）。
            var window = ReportWindow.Create(from, to);
            var cardsQuery = db.Cards.Where(c => projectIds.Contains(c.List.Board.ProjectId) && !c.IsArchived);
            cardsQuery = cardsQuery.Where(window.DenominatorClause());

            var rawCards = await cardsQuery
                .Select(c => new
                {
                    c.Id,
                    c.CompletedAt,
                    c.DueAt,
                    c.CreatedById,
                    AssigneeIds = c.Members.Select(m => m.UserId).ToList()
                })
                .ToListAsync();

            var effortQuery = db.EffortLogs.Where(e => projectIds.Contains(e.Card.List.Board.ProjectId) && !e.Card.IsArchived);
            if (window.From is not null) effortQuery = effortQuery.Where(e => e.LoggedAt >= window.From);
            if (window.To is not null) effortQuery = effortQuery.Where(e => e.LoggedAt < window.To);
            var memberEffortMap = await effortQuery
                .GroupBy(e => e.UserId)
                .Select(g => new { UserId = g.Key, Hours = (decimal)g.Sum(e => (double)e.Hours) })
                .ToDictionaryAsync(g => g.UserId, g => g.Hours);

            var userCardMap = new Dictionary<Guid, List<dynamic>>();
            foreach (var c in rawCards)
            {
                var owners = c.AssigneeIds.Count > 0 ? c.AssigneeIds : new List<Guid> { c.CreatedById };
                foreach (var ownerId in owners)
                {
                    if (!userCardMap.TryGetValue(ownerId, out var list))
                    {
                        list = new List<dynamic>();
                        userCardMap[ownerId] = list;
                    }
                    list.Add(c);
                }
            }

            var userIds = userCardMap.Keys.Union(memberEffortMap.Keys).Distinct().ToList();
            var users = await ActivityEndpoints.GetUsersAsync(db, userIds);

            // 與 JSON／CSV 路徑同一份 FPY（欄位同樣不加寬，見 CSV 路徑的註解）。
            var firstPassYield = await ProjectReportQueries.GetFirstPassYieldAsync(db, projectIds, window, userIds);
            var reviewStats = await ProjectReportQueries.GetTeamReviewStatsAsync(db, projectIds, window, userIds);

            // Generate SpreadsheetML (Native Excel XML format)
            var sb = new System.Text.StringBuilder();
            sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
            sb.AppendLine("<?mso-application progid=\"Excel.Sheet\"?>");
            sb.AppendLine("<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\"");
            sb.AppendLine(" xmlns:o=\"urn:schemas-microsoft-com:office:office\"");
            sb.AppendLine(" xmlns:x=\"urn:schemas-microsoft-com:office:excel\"");
            sb.AppendLine(" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">");
            
            // Styles
            sb.AppendLine("<Styles>");
            sb.AppendLine(" <Style ss:ID=\"Header\">");
            sb.AppendLine("  <Font ss:Bold=\"1\" ss:Color=\"#FFFFFF\" ss:Size=\"11\" ss:FontName=\"Microsoft JhengHei\"/>");
            sb.AppendLine("  <Interior ss:Color=\"#4F46E5\" ss:Pattern=\"Solid\"/>");
            sb.AppendLine("  <Alignment ss:Horizontal=\"Center\" ss:Vertical=\"Center\"/>");
            sb.AppendLine(" </Style>");
            // 樣式與評級同源：這一圈同時產生 <Style> 區塊與每一格查的 StyleID，
            // 「有評級、沒有樣式」因此在結構上不可能只發生在一邊。走 RatingCodes.All
            // 而不是 RatingStyles 的列舉順序——Dictionary 的列舉順序在 .NET 沒有保證，
            // 會讓匯出檔的 diff 不穩定。表裡少了某個評級在這裡直接爆，不讓它靜默變無色。
            foreach (var rating in RatingCodes.All)
            {
                var (font, interior, bold) = RatingStyles[rating];
                var boldAttr = bold ? " ss:Bold=\"1\"" : "";
                sb.AppendLine($" <Style ss:ID=\"Rating{rating}\">");
                sb.AppendLine($"  <Font{boldAttr} ss:Color=\"{font}\" ss:FontName=\"Microsoft JhengHei\"/>");
                sb.AppendLine($"  <Interior ss:Color=\"{interior}\" ss:Pattern=\"Solid\"/>");
                sb.AppendLine("  <Alignment ss:Horizontal=\"Center\" ss:Vertical=\"Center\"/>");
                sb.AppendLine(" </Style>");
            }
            sb.AppendLine(" <Style ss:ID=\"DataCell\">");
            sb.AppendLine("  <Font ss:FontName=\"Microsoft JhengHei\" ss:Size=\"10\"/>");
            sb.AppendLine("  <Alignment ss:Vertical=\"Center\"/>");
            sb.AppendLine(" </Style>");
            sb.AppendLine(" <Style ss:ID=\"NumberCell\">");
            sb.AppendLine("  <Font ss:FontName=\"Microsoft JhengHei\" ss:Size=\"10\"/>");
            sb.AppendLine("  <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>");
            sb.AppendLine(" </Style>");
            sb.AppendLine(" <Style ss:ID=\"PercentCell\">");
            sb.AppendLine("  <Font ss:FontName=\"Microsoft JhengHei\" ss:Size=\"10\"/>");
            sb.AppendLine("  <NumberFormat ss:Format=\"0.0%\"/>");
            sb.AppendLine("  <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>");
            sb.AppendLine(" </Style>");
            sb.AppendLine("</Styles>");

            sb.AppendLine($"<Worksheet ss:Name=\"{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamSheet])}\">");
            sb.AppendLine("<Table ss:DefaultRowHeight=\"20\">");
            sb.AppendLine("<Column ss:Width=\"120\"/>");
            sb.AppendLine("<Column ss:Width=\"130\"/>");
            sb.AppendLine("<Column ss:Width=\"90\"/>");
            sb.AppendLine("<Column ss:Width=\"90\"/>");
            sb.AppendLine("<Column ss:Width=\"90\"/>");
            sb.AppendLine("<Column ss:Width=\"100\"/>");
            sb.AppendLine("<Column ss:Width=\"100\"/>");
            sb.AppendLine("<Column ss:Width=\"100\"/>");

            // Header Row
            sb.AppendLine("<Row ss:Height=\"24\">");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberUsername])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberName])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberRating])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberCompleted])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberTotal])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberRateCompletion])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberRateOnTime])}</Data></Cell>");
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{System.Security.SecurityElement.Escape(labels[ExportKeys.TeamMemberHours])}</Data></Cell>");
            sb.AppendLine("</Row>");

            // Data Rows
            foreach (var uId in userIds)
            {
                var cards = userCardMap.GetValueOrDefault(uId) ?? new List<dynamic>();
                var loggedHours = memberEffortMap.GetValueOrDefault(uId, 0m);

                // 卡片統計與 JSON 路徑同一個窗框——三條輸出路徑對同一組 from／to 同源。
                var (total, completed, _, _, completionRate, onTimeRate) = CardStats(cards, window);
                var (firstPass, reviewed) = firstPassYield.GetValueOrDefault(uId, (0, 0));
                var (averageScore, scoreSamples) = reviewStats.GetValueOrDefault(uId, (null, 0));
                var rating = RatingForMember(completionRate, onTimeRate, firstPass, reviewed, averageScore, scoreSamples);

                var uname = SpreadsheetMl.Escape(users.GetValueOrDefault(uId)?.UserName ?? "");
                var dname = SpreadsheetMl.Escape(users.GetValueOrDefault(uId)?.DisplayName ?? "");
                var ratingStyle = RatingStyleId(rating);

                sb.AppendLine("<Row>");
                sb.AppendLine($"<Cell ss:StyleID=\"DataCell\"><Data ss:Type=\"String\">{uname}</Data></Cell>");
                sb.AppendLine($"<Cell ss:StyleID=\"DataCell\"><Data ss:Type=\"String\">{dname}</Data></Cell>");
                // 「{{rating}} 級」的文案在資源檔（`rating.suffix`），評等識別碼仍是 `RatingCodes`
                // ——`RatingStyleId` 依它選樣式，兩者同源。`rating` 是常數，但標籤來自檔案，
                // 故仍過 Escape。
                // **`rating` 可為 null**（零卡片）⇒ 空字串：不套樣板，否則會印出一個沒有主詞的
                // 「級」。與 CSV 那一側同一個決定（空欄位，不塞中文），空白格仍套 `DataCell`。
                var ratingText = rating is null
                    ? "" : System.Security.SecurityElement.Escape(labels.Format(ExportKeys.RatingSuffix, ("rating", rating)));
                sb.AppendLine($"<Cell ss:StyleID=\"{ratingStyle}\"><Data ss:Type=\"String\">{ratingText}</Data></Cell>");
                sb.AppendLine($"<Cell ss:StyleID=\"NumberCell\"><Data ss:Type=\"Number\">{completed}</Data></Cell>");
                sb.AppendLine($"<Cell ss:StyleID=\"NumberCell\"><Data ss:Type=\"Number\">{total}</Data></Cell>");
                // 同 CSV 那一側的守衛：`ss:Type="Number"` 的儲存格在逗號小數點的主機文化下會寫成
                // 「0,333」——那不是 Excel 讀得懂的數字。上面兩列整數不受影響，故不動。
                // **樣本不足時不產生 `<Data>`**（保留 `PercentCell` 樣式的空格）：空值不是 0，
                // 寫成 `<Data ss:Type="Number"></Data>` 或 `0` 都會讓 Excel 顯示一個假的數字。
                sb.AppendLine(completionRate is null
                    ? "<Cell ss:StyleID=\"PercentCell\"/>"
                    : string.Create(CultureInfo.InvariantCulture,
                        $"<Cell ss:StyleID=\"PercentCell\"><Data ss:Type=\"Number\">{completionRate}</Data></Cell>"));
                sb.AppendLine(onTimeRate is null
                    ? "<Cell ss:StyleID=\"PercentCell\"/>"
                    : string.Create(CultureInfo.InvariantCulture,
                        $"<Cell ss:StyleID=\"PercentCell\"><Data ss:Type=\"Number\">{onTimeRate}</Data></Cell>"));
                sb.AppendLine(string.Create(CultureInfo.InvariantCulture,
                    $"<Cell ss:StyleID=\"NumberCell\"><Data ss:Type=\"Number\">{loggedHours}</Data></Cell>"));
                sb.AppendLine("</Row>");
            }

            sb.AppendLine("</Table>");
            sb.AppendLine("</Worksheet>");
            sb.AppendLine("</Workbook>");

            var bytes = System.Text.Encoding.UTF8.GetBytes(sb.ToString());
            // 檔名只帶 teamId，與 CSV 同型：隊名是使用者可控的（`POST /api/teams` 對 `Name`
            // 零驗證、更新路線只 `Trim()`），內插它等於把使用者字串送進 `Content-Disposition`
            // （含 CR／LF 也送得出去）。**不要改回 `team.Name`**——判別力在
            // `TeamReportTests.TeamXlsExport_FilenameIgnoresHostileTeamName`。
            return Results.File(bytes, "application/vnd.ms-excel", $"team-performance-{teamId}{YearSuffix(window)}.xls");
        }).RequireAuthorization().RequirePermission(PermissionCodes.ReportView);

        // ---- drill-down（2026-10-20 報表可解釋性，Task 1）----
        //
        // 母體／分子的語意全部住在 `ReportDrilldownQueries`（逐條沿用團隊報表那一份）；
        // 這一層只負責參數驗證、權限過濾、補名與 wire DTO。
        app.MapGet("/api/teams/{teamId:guid}/report/drilldown",
            async (Guid teamId, Guid userId, string metric, DateTime? from, DateTime? to,
                   int page = 1, int pageSize = 50, EntaskDbContext db = default!,
                   IPermissionChecker permissionChecker = default!, ClaimsPrincipal principal = default!) =>
            {
                // 窗框驗證與團隊報表相同（顛倒、天數上限），錯誤碼與訊息逐字相同。
                if (from is not null && to is not null && from >= to)
                    return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
                if (from is not null && to is not null && (to.Value - from.Value).TotalDays > WorkLogQueries.MaxRangeDays)
                    return Results.BadRequest(new
                    {
                        code = ErrorCodes.QueryRangeTooLong,
                        message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                        @params = new { max = WorkLogQueries.MaxRangeDays }
                    });

                // **只接受具名值**：`Enum.TryParse` 連數字字串都收（`metric=3` ⇒ `AverageScore`），
                // 那是列舉的底層值、不是這條路由的契約——數字與未知字串走同一條 400。
                if (!TryParseMetricName(metric, out var parsed))
                    return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "metric 無效" });
                if (page < 1 || pageSize < 1 || pageSize > 200)
                    return Results.BadRequest(new
                    {
                        code = ErrorCodes.RequestInvalid,
                        message = "page 須大於等於 1，pageSize 須介於 1 與 200",
                    });

                // 窗框語意只在 `ReportWindow` —— 不自己 normalize。
                var window = ReportWindow.Create(from, to);
                var teamProjectIds = await db.Projects.Where(p => p.TeamId == teamId).Select(p => p.Id).ToListAsync();

                // 可見範圍問的是**呼叫者**的 `card.read`（設計 §4.3「只回傳呼叫者有 card.read
                // 的專案列」），不是被檢視成員的權限。逐專案走 `IPermissionChecker`（30 秒快取）
                // ——不另寫一份 bulk 權限查詢，那是第二份授權語意。
                var callerId = BoardEndpoints.CurrentUserId(principal);
                var readableProjectIds = new List<Guid>();
                foreach (var projectId in teamProjectIds)
                {
                    if (await permissionChecker.HasProjectPermissionAsync(callerId, projectId, PermissionCodes.CardRead))
                        readableProjectIds.Add(projectId);
                }

                var result = await ReportDrilldownQueries.GetAsync(
                    db, teamProjectIds, readableProjectIds, userId, parsed, window, page, pageSize);

                // 每頁**一次**補名（`GetUsersAsync` 是既有模式）；不得逐列查詢。
                var reviewerIds = result.Rows
                    .SelectMany(r => new[] { r.FirstReviewerUserId, r.ReviewerUserId })
                    .Where(id => id is not null)
                    .Select(id => id!.Value)
                    .Distinct()
                    .ToList();
                var users = await ActivityEndpoints.GetUsersAsync(db, reviewerIds);

                var rows = result.Rows.Select(r => new ReportDrilldownItemDto(
                    r.CardId, r.Title, r.ProjectId, r.ProjectName, r.CompletedAt, r.DueAt, r.Qualifies,
                    r.FirstReviewEntryId, r.FirstReviewStatus, r.FirstReviewAt,
                    ResolveUserName(users, r.FirstReviewerUserId),
                    r.ReviewEntryId, r.Score, r.ReviewCreatedAt,
                    ResolveUserName(users, r.ReviewerUserId),
                    r.DueChanges?.Select(d => new DueChangeDto(d.ChangedAt, d.From, d.To)).ToList())).ToList();

                return Results.Ok(new ReportDrilldownResponseDto(
                    Metric: MetricKey(parsed),
                    RowKind: result.RowKind == ReportRowKind.ReviewEntry ? "reviewEntry" : "card",
                    PopulationCount: result.PopulationCount,
                    QualifyingCount: result.QualifyingCount,
                    VisiblePopulationCount: result.VisiblePopulationCount,
                    VisibleQualifyingCount: result.VisibleQualifyingCount,
                    HiddenCount: result.PopulationCount - result.VisiblePopulationCount,
                    Rows: rows, Page: page, PageSize: pageSize));
            }).RequireAuthorization().RequirePermission(PermissionCodes.ReportView);

        return app;
    }
}
