using Entask.Core;
using Entask.Performance;

namespace Entask.Api.Endpoints;

/// <summary>
/// 匯出路徑（CSV／xls）專用的呈現輔助。拆檔的理由是行數（主檔硬上限 800）；
/// 這些成員沒有一個參與評等公式或 drill-down。
/// </summary>
public static partial class TeamReportEndpoints
{
    /// <summary>
    /// 評級 → xls 儲存格樣式（字色、底色、是否粗體）。
    ///
    /// **這一張表同時產生 &lt;Style&gt; 區塊與每一格的 StyleID**，所以「有評級、沒有樣式」
    /// 在結構上不可能只發生在一邊。原本四個 &lt;Style ss:ID="RatingX"&gt; 是寫死的，而每一格
    /// 是 `$"Rating{rating}"` 拼出來的——新增一個評級就會產生一個指向不存在樣式的參考，
    /// 而 Excel 對 dangling 的 StyleID 是**靜默容忍**，沒有任何既有防線看得到。
    /// </summary>
    private static readonly Dictionary<string, (string Font, string Interior, bool Bold)> RatingStyles = new()
    {
        [RatingCodes.S] = ("#B45309", "#FEF3C7", true),
        [RatingCodes.A] = ("#15803D", "#DCFCE7", true),
        [RatingCodes.B] = ("#1D4ED8", "#DBEAFE", true),
        [RatingCodes.C] = ("#4B5563", "#F3F4F6", false),
    };

    /// <summary>
    /// 評級的 StyleID。**不在表裡的評級落回 DataCell**——寧可沒有顏色，也不要產生一個
    /// 指向不存在樣式的參考。
    ///
    /// **`rating` 可為 null（2026-09-21）**：沒有評等的人（零卡片、或沒有任何可評依據）
    /// 也要落回 `DataCell`。少了這一格，`RatingStyles.ContainsKey(null)` 對
    /// `Dictionary<string, …>` 會拋 `ArgumentNullException`——而它的觸發條件是「團隊裡有
    /// 一個沒被評等的人」，正是這一版要新增的合法狀態。
    /// </summary>
    private static string RatingStyleId(string? rating) =>
        rating is not null && RatingStyles.ContainsKey(rating) ? $"Rating{rating}" : "DataCell";

    /// <summary>
    /// 匯出檔名的年份後綴（設計 §5.4）：由**窗框左界**推導，全期時是空字串。
    ///
    /// **不得改讀時鐘**（`DateTime.Now.Year`）：哪一年是使用者選的，後端只反映窗框（設計 D3）。
    /// 兩條有檔名的輸出路徑（CSV／xls；JSON 沒有檔名）共用這一處，理由與 `CardStats` 相同
    /// ——同一個式子抄兩份就會有一個地方先漂移。
    ///
    /// **已知且刻意接受的誤差**（裁定與理由見設計 §5.4 的更正標記）：前端送的是本地年頭轉
    /// UTC（`new Date(2026, 0, 1).toISOString()`），且設計**明文不送時區位移**（D8③）
    /// ——後端因此還原不了使用者選的本地年：在 UTC 以東，`window.From` 落在**前一個 UTC 年**
    /// ——台北的使用者選 2026 會拿到 `-2025` 的檔名。修它要動前端的送法，
    /// 或加一個參數（D8③ 明文不加），代價與一個檔名後綴不成比例。殘餘待本批收尾寫進
    /// `docs/STATE.md`。
    /// </summary>
    private static string YearSuffix(ReportWindow window) =>
        window.From is null ? "" : $"-{window.From.Value.Year}";
}
