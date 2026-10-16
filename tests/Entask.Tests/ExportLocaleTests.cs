using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Entask.Tests;

/// <summary>
/// 匯出檔的語系（設計 §6）。三個工作日誌端點與團隊年度績效端點共用同一組標籤。
///
/// **這一支的存在理由與 `TeamReportExcelExportTests` 相同**：這兩條路由原本沒有測試打到
/// （`ExportTests` 打的是 CSV、`TeamReportTests` 打的是 JSON），一個壞掉的標籤在
/// Excel 裡是靜默的——檔案照樣開得起來，只是那一格是空的或是識別碼。
/// </summary>
[Collection("ApiTests")]
public class ExportLocaleTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ExportLocaleTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<string> AdminTokenAsync()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return token;
    }

    private static string Body(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    // 工作日誌的三條讀取端點自 2026-10-08 批次起收**必填的本地日區間**（`to` 排他、`tzOffsetMinutes`
    // 已移除）：這裡只需要一個合法的空窗——本檔驗的是標籤，資料列不在斷言範圍。
    private const string WorklogRange = "from=2026-09-01&to=2026-09-30";

    [Fact]
    public async Task 工作日誌匯出_預設語系的表頭逐字不變()
    {
        await AdminTokenAsync();
        var bytes = await _client.GetByteArrayAsync($"/api/me/worklog/export?{WorklogRange}");
        var xml = Body(bytes);

        Assert.Contains("<Worksheet ss:Name=\"明細\">", xml);
        Assert.Contains("<Worksheet ss:Name=\"彙總\">", xml);
        Assert.Contains(">日期<", xml);
        Assert.Contains(">回報時間<", xml);
        Assert.Contains(">未回報工作日<", xml);
    }

    [Fact]
    public async Task 工作日誌匯出_locale_en_給英文表頭()
    {
        await AdminTokenAsync();
        var xml = Body(await _client.GetByteArrayAsync($"/api/me/worklog/export?{WorklogRange}&locale=en"));

        Assert.Contains("<Worksheet ss:Name=\"Details\">", xml);
        Assert.Contains("<Worksheet ss:Name=\"Summary\">", xml);
        Assert.Contains(">Date<", xml);
        Assert.Contains(">Reported at<", xml);
        Assert.Contains(">Missing workdays<", xml);
        Assert.DoesNotContain("明細", xml);
    }

    [Fact]
    public async Task 認不得的語系回退_zh_TW_而不是_400()
    {
        await AdminTokenAsync();
        var res = await _client.GetAsync($"/api/me/worklog/export?{WorklogRange}&locale=fr");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("<Worksheet ss:Name=\"明細\">", Body(await res.Content.ReadAsByteArrayAsync()));
    }

    [Fact]
    public async Task 語系大小寫無關()
    {
        await AdminTokenAsync();
        var xml = Body(await _client.GetByteArrayAsync($"/api/me/worklog/export?{WorklogRange}&locale=EN"));

        Assert.Contains("<Worksheet ss:Name=\"Details\">", xml);
    }

    [Fact]
    public async Task 換語系只改標籤_機器可讀的骨架不變()
    {
        await AdminTokenAsync();

        // 對照組與實驗組的資料相同（同一個空日誌），只有標籤不同。
        // 護欄是 P21 泰曆年份事件的同一條：`InvariantCulture` 與 XML 骨架一律不隨語系改變。
        const string q = "?from=2026-09-01&to=2026-09-30";
        var zh = Body(await _client.GetByteArrayAsync($"/api/me/worklog/export{q}&locale=zh-TW"));
        var en = Body(await _client.GetByteArrayAsync($"/api/me/worklog/export{q}&locale=en"));

        foreach (var invariant in new[]
                 {
                     "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                     "<Style ss:ID=\"Header\">",
                     "<Style ss:ID=\"DataCell\">",
                     "<Style ss:ID=\"NumberCell\">",
                     "<Table ss:DefaultRowHeight=\"20\">",
                     "Microsoft JhengHei",
                 })
        {
            Assert.Contains(invariant, zh);
            Assert.Contains(invariant, en);
        }
    }

    /// <summary>
    /// 建立團隊 ＋ 一張**未完成**的卡片。名單來源是卡片（指派者，沒有指派者時取建立者）
    /// 與工時紀錄的聯集，所以只有團隊、沒有卡片時匯出檔是**零資料列**——評等那一支
    /// 需要真的有一列才驗得到（首版 RED 實測：`>C 級<` 兩邊都找不到）。
    /// 達成率 0、準時率 1.0 → `RatingFor` 回 C。
    ///
    /// 專案 id 一併回傳：團隊年度績效走的是 `/api/teams/{teamId}/…`，而工作日誌的專案
    /// 範疇走 `/api/projects/{projectId}/worklog/export`——兩者是同一個 fixture 建出來的。
    /// </summary>
    private async Task<(string TeamId, string ProjectId)> TeamAndProjectIdAsync()
    {
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "匯出團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", teamId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var projectId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // 刻意不呼叫 completion：未完成 → 達成率 0 → 評等 C。
        await _client.PostAsync($"/api/lists/{listId}/cards", JsonContent.Create(new { title = "C1" }));

        return (teamId, projectId);
    }

    [Fact]
    public async Task 團隊年度績效匯出_locale_en_給英文標籤()
    {
        await AdminTokenAsync();
        var (teamId, _) = await TeamAndProjectIdAsync();

        var xml = Body(await _client.GetByteArrayAsync($"/api/teams/{teamId}/report/export-excel?locale=en"));

        Assert.Contains("<Worksheet ss:Name=\"Annual performance\">", xml);
        Assert.Contains(">Member account<", xml);
        Assert.Contains(">Total hours (hr)<", xml);
        Assert.DoesNotContain("年度績效總表", xml);
        // 百分比欄的樣式不隨語系改變——P21 泰曆年份事件的護欄在這條路徑上的形狀
        Assert.Contains("ss:Format=\"0.0%\"", xml);
    }

    [Fact]
    public async Task 評等格依來源語系產生_級_與_Grade()
    {
        await AdminTokenAsync();
        var (teamId, _) = await TeamAndProjectIdAsync();

        // 未完成的卡片 → 達成率 0、準時率 1.0 → RatingFor 回 C，admin 一定在名單裡
        // （他是**卡片**建立者；名單以卡片擁有者為準，不是團隊建立者——見 `TeamAndProjectIdAsync`）。
        var zh = Body(await _client.GetByteArrayAsync($"/api/teams/{teamId}/report/export-excel?locale=zh-TW"));
        var en = Body(await _client.GetByteArrayAsync($"/api/teams/{teamId}/report/export-excel?locale=en"));

        Assert.Contains(">C 級<", zh);
        Assert.Contains(">Grade C<", en);
    }

    /// <summary>
    /// **三條**工作日誌匯出端點都要吃 `?locale=`。它們是三個近乎相同的單行轉發
    /// （`WorkLogEndpoints.cs` 的三個 `ExportAsync(... locale)`），而本階段動的正是這條
    /// 水管的接線——先前只有 `/api/me/worklog/export` 有測試打到，專案與團隊兩條從來
    /// 沒被送過這個參數（`WorkLogTests` 打的是 `/worklog/export` 但不帶 locale）。
    ///
    /// 斷言用兩個**工作表名**：`明細`／`Details` 與 `彙總`／`Summary`。zh-TW 那一半在上面
    /// 幾支已經逐字驗過，這裡驗的是「這個 scope 也收到了參數」。
    ///
    /// admin 能直接通過兩條非 me 路由的權限檢查（`RequirePermission`／`RequireProjectPermission`
    /// 都是 admin claim 優先於 header 需求），所以三條的差別只有網址。
    /// </summary>
    [Theory]
    [InlineData("me")]
    [InlineData("project")]
    [InlineData("team")]
    public async Task 三個工作日誌匯出端點都吃_locale(string scope)
    {
        await AdminTokenAsync();
        var (teamId, projectId) = await TeamAndProjectIdAsync();
        var url = scope switch
        {
            "me" => "/api/me/worklog/export",
            "project" => $"/api/projects/{projectId}/worklog/export",
            _ => $"/api/teams/{teamId}/worklog/export",
        };

        var zh = Body(await _client.GetByteArrayAsync($"{url}?{WorklogRange}&locale=zh-TW"));
        var en = Body(await _client.GetByteArrayAsync($"{url}?{WorklogRange}&locale=en"));

        Assert.Contains("<Worksheet ss:Name=\"明細\">", zh);
        Assert.Contains("<Worksheet ss:Name=\"Details\">", en);
        Assert.Contains("<Worksheet ss:Name=\"彙總\">", zh);
        Assert.Contains("<Worksheet ss:Name=\"Summary\">", en);
    }
}
