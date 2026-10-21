using System.Net;
using Entask.Core;

namespace Entask.Tests;

/// <summary>
/// drill-down 的參數驗證（窗框、metric、分頁）。2026-10-21 自 `ReportDrilldownTests.cs`
/// 拆出——那個檔加上封存邊界與數字 metric 的測試之後會超過 800 行。
///
/// **用 partial class 而不是另一個測試類別**：這幾支和主檔用的是同一組 fixture
/// （`ApiWebApplicationFactory` ＋ `WithDbReset`）與同一批私有 helper
/// （`AdminTokenAsync`／`SetupTeamAsync`／`AdminUserIdAsync`）。另開類別就得把 helper
/// 抄第二份，而 partial 讓兩個檔共用同一個型別、同一個 fixture 實例——原本的
/// `--filter FullyQualifiedName~ReportDrilldownTests` 也照舊涵蓋它們。
/// </summary>
public partial class ReportDrilldownTests
{
    /// <summary>顛倒窗框 ⇒ 400 `request.invalid`（與團隊報表三條路由同一條 guard）。</summary>
    [Fact]
    public async Task Drilldown_RejectsInvertedWindow()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-inverted");
        var adminId = await AdminUserIdAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/report/drilldown?userId={adminId}&metric=completion"
            + "&from=2027-01-01T00:00:00Z&to=2026-01-01T00:00:00Z");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(res));
    }

    /// <summary>認不得的 metric ⇒ 400（不是靜默回一個空清單）。</summary>
    [Fact]
    public async Task Drilldown_RejectsUnknownMetric()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-metric");
        var adminId = await AdminUserIdAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/report/drilldown?userId={adminId}&metric=nope");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(res));
    }

    /// <summary>
    /// 數字字串**不是** metric 的 wire 名稱。`Enum.TryParse` 的預設行為會把 `metric=3`
    /// 讀成列舉的底層值（`AverageScore`）——那是實作細節，不是這個端點的契約。它必須與
    /// 未知字串（`metric=nope`）走同一條 400。
    /// </summary>
    [Fact]
    public async Task Drilldown_RejectsNumericMetric()
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync("drilldown-metric-numeric");
        var adminId = await AdminUserIdAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/report/drilldown?userId={adminId}&metric=3");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(res));
    }

    /// <summary>分頁參數的下界與上界（page ≥ 1、1 ≤ pageSize ≤ 200）。</summary>
    [Theory]
    [InlineData("page=0")]
    [InlineData("pageSize=0")]
    [InlineData("pageSize=201")]
    public async Task Drilldown_RejectsOutOfRangePaging(string query)
    {
        await AdminTokenAsync();
        var teamId = await SetupTeamAsync($"drilldown-paging-{query.Replace('=', '-')}");
        var adminId = await AdminUserIdAsync();

        var res = await _client.GetAsync(
            $"/api/teams/{teamId}/report/drilldown?userId={adminId}&metric=completion&{query}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(res));
    }
}
