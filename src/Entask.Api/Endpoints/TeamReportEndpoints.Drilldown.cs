using Entask.Identity.Models;
using Entask.Performance;

namespace Entask.Api.Endpoints;

/// <summary>
/// drill-down 端點專用的兩個小輔助（wire 名稱與審查者顯示名）。拆檔的理由是行數
/// （主檔硬上限 800）；兩者都只被 drill-down 的處理常式呼叫。
/// </summary>
public static partial class TeamReportEndpoints
{
    /// <summary>
    /// drill-down 的 metric 參數：**只接受具名值**（大小寫不敏感，與 `Enum.TryParse` 的
    /// 既有語意一致）。`Enum.TryParse` 的預設行為連數字字串也吃——`metric=3` 會解析成
    /// `AverageScore`——那是列舉的底層值，不是這條路由的 wire 契約。數字與未知字串因此
    /// 走同一條 400（守門員：`Drilldown_RejectsNumericMetric`）。
    /// </summary>
    private static bool TryParseMetricName(string? raw, out ReportMetric metric)
    {
        foreach (var candidate in Enum.GetValues<ReportMetric>())
        {
            if (string.Equals(Enum.GetName(candidate), raw, StringComparison.OrdinalIgnoreCase))
            {
                metric = candidate;
                return true;
            }
        }
        metric = default;
        return false;
    }

    /// <summary>
    /// drill-down 的 metric wire 名稱（camelCase 字串契約，前端 `DrilldownMetric` 對齊）。
    /// 列舉本身留在 `Entask.Performance`；字串只在這裡決定，兩者靠這支方法對應。
    /// </summary>
    private static string MetricKey(ReportMetric metric) => metric switch
    {
        ReportMetric.Completion => "completion",
        ReportMetric.OnTime => "onTime",
        ReportMetric.FirstPassYield => "firstPassYield",
        ReportMetric.AverageScore => "averageScore",
        _ => throw new ArgumentOutOfRangeException(nameof(metric), metric, "未知的 drill-down metric"),
    };

    /// <summary>
    /// 審查者的顯示名稱。與 `ReviewEndpoints` 的 `user.DisplayName ?? user.UserName`
    /// 同一條慣例（`ApplicationUser.DisplayName` 非 null、預設空字串 ⇒ 空字串才退回帳號）。
    /// 查無此人時回 null——不捏造一個空字串假裝有名字。
    /// </summary>
    private static string? ResolveUserName(Dictionary<Guid, ApplicationUser> users, Guid? userId) =>
        userId is not null && users.TryGetValue(userId.Value, out var user)
            ? (string.IsNullOrWhiteSpace(user.DisplayName) ? user.UserName : user.DisplayName)
            : null;
}
