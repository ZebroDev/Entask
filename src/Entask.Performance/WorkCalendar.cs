using Entask.Core.Entities;

namespace Entask.Performance;

/// <summary>
/// 工作日判定。基準是週一至週五，再加上逐日期的例外（<see cref="WorkCalendarException"/>，日曆掛在 team）。
/// 例外表由呼叫端查好後傳入——這個類別維持純函式、不碰 DB（它的測試因此不需要資料庫）。
/// 前端只消費 WorkLogQueries 產出的 Workdays 清單、不自行判斷星期，所以改日曆不動 DTO 與前端。
/// </summary>
public static class WorkCalendar
{
    public static bool IsWorkday(DateOnly date, IReadOnlyDictionary<DateOnly, WorkCalendarKind>? exceptions = null) =>
        exceptions is not null && exceptions.TryGetValue(date, out var kind)
            ? kind == WorkCalendarKind.Workday
            : date.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday);

    /// <summary>[fromLocal, toLocalExclusive) 區間內的工作日，升冪。</summary>
    public static List<DateOnly> WorkdaysBetween(DateOnly fromLocal, DateOnly toLocalExclusive,
        IReadOnlyDictionary<DateOnly, WorkCalendarKind>? exceptions = null)
    {
        var days = new List<DateOnly>();
        for (var d = fromLocal; d < toLocalExclusive; d = d.AddDays(1))
            if (IsWorkday(d, exceptions)) days.Add(d);
        return days;
    }

    /// <summary>
    /// 把多個團隊的例外列合成一張「日期 → 種類」的表。
    /// **R4：衝突時 Holiday 勝**（同一天被不同團隊分別標成放假與補班時，寬鬆的那一邊算數）。
    /// 這個規則是契約、與輸入順序無關 ⇒ 後到的 Workday 覆蓋不掉既有的 Holiday。
    /// </summary>
    public static IReadOnlyDictionary<DateOnly, WorkCalendarKind> MergeExceptions(
        IEnumerable<WorkCalendarException> rows)
    {
        var map = new Dictionary<DateOnly, WorkCalendarKind>();
        foreach (var row in rows)
        {
            if (map.TryGetValue(row.Date, out var existing) && existing == WorkCalendarKind.Holiday) continue;
            map[row.Date] = row.Kind;
        }
        return map;
    }
}
