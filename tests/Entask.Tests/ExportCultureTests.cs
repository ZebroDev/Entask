using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Entask.Tests;

/// <summary>
/// 匯出檔的**機器格式**部分不得隨主機文化改變：CSV 的欄位以逗號分隔，而 XLS 的
/// `ss:Type="Number"` 儲存格由 Excel 以不變文化解析。兩者都在 G1 之前失守——
/// 三個數值走 C# 的內插字串，於是逗號小數點的主機文化（de-DE／fr-FR 這一族）
/// 把 `33.3%` 寫成 `33,3 %`、把 `1.5` 寫成 `1,5`：
/// CSV 那一列因此多出逗號（欄位全盤位移）、XLS 那一格不再是 Excel 讀得懂的數字。
///
/// **為什麼這支測試非有不可**：在點號小數點的主機（zh-TW／en-US，本機預設就是 zh-TW）上，
/// 壞掉的實作與修好的實作**輸出逐位元組相同** ⇒ 十道閘門與全部既有測試都看不到它。
/// 要看見它，只能**把主機文化換成逗號小數點的那一族**再匯出一次，而全測試套件裡
/// 只有這裡做這件事。樣板是 `WorkLogTests.NonGregorianHostCulture_StillEmitsGregorianDates`
/// （泰曆事件——同一個「機器格式 vs 主機文化」的坑，只是踩在日期上）。
/// </summary>
[Collection("ApiTests")]
public class ExportCultureTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ExportCultureTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task TeamReportExport_DoesNotDependOnHostCulture()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (teamId, _) = await SetupTeamWithFractionalNumbersAsync(token);

        var host = await CaptureAsync(teamId);

        // `de-DE` 而**不是** `th-TH`：後者的數字格式與 en-US 同為點號小數點，換過去
        // 什麼都不會變——是一個「跑得動、也綠、但什麼都沒證明」的假突變（實測）。
        var de = CultureInfo.GetCultureInfo("de-DE");

        // 這兩條是**判別力的前提**，不是裝飾：行程若跑在 globalization-invariant 模式，
        // `GetCultureInfo("de-DE")` 會回不變文化（沒有逗號小數點）⇒ 底下每一條斷言都恆真。
        // 少了它們，「測試通過」與「測試根本沒在測」長得一模一樣。
        Assert.Equal(",", de.NumberFormat.NumberDecimalSeparator);
        Assert.Equal("1,5", 1.5.ToString("0.0", de));

        var savedCurrent = CultureInfo.CurrentCulture;
        var savedDefault = CultureInfo.DefaultThreadCurrentCulture;
        CultureInfo.CurrentCulture = de;
        // TestServer 的請求處理不繼承呼叫端的 ExecutionContext（AsyncLocal 不流動），單設
        // CurrentCulture 進不了 handler，釘子會假綠。行程級覆寫於此安全：本組件已全域關閉
        // 測試平行化（AssemblyInfo.cs）。finally 一定要還原，洩漏出去會污染同組的其他測試。
        CultureInfo.DefaultThreadCurrentCulture = de;

        ExportSnapshot under;
        try
        {
            under = await CaptureAsync(teamId);
        }
        finally
        {
            CultureInfo.CurrentCulture = savedCurrent;
            CultureInfo.DefaultThreadCurrentCulture = savedDefault;
        }

        AssertCsvShape(under.Csv);
        AssertXlsNumbers(under.Xls);

        // 最強的一條：這份匯出檔**完全不看主機文化**，兩次匯出的位元組逐位元相同。
        // 它同時是下面兩條的收斂點——前兩條各自只盯著自己那一側。
        Assert.Equal(host.Csv, under.Csv);
        Assert.Equal(host.Xls, under.Xls);

        // 反向對照：主機文化那一份也要是同樣的形狀。少了它，「兩邊一樣」有可能只是
        // 「兩邊一樣壞」——主機文化本身就是逗號小數點時就是這個情況（例如 CI 跑在 de-DE）。
        AssertCsvShape(host.Csv);
        AssertXlsNumbers(host.Xls);
    }

    /// <summary>
    /// 專案 CSV 的數值欄同樣不得隨主機文化改變——**這一支是補的**：專案建構器在
    /// 2026-10-08 之前沒走 InvariantCulture（兄弟建構器早就走了），而點點小數點的主機上
    /// 壞掉與修好輸出逐位元組相同 ⇒ 只有換到 de-DE 才看得見（同團隊那一支的理由）。
    /// </summary>
    [Fact]
    public async Task ProjectReportExport_DoesNotDependOnHostCulture()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (_, projectId) = await SetupTeamWithFractionalNumbersAsync(token);

        var host = await _client.GetStringAsync($"/api/projects/{projectId}/report/export");

        var de = CultureInfo.GetCultureInfo("de-DE");
        Assert.Equal(",", de.NumberFormat.NumberDecimalSeparator);
        Assert.Equal("1,5", 1.5.ToString("0.0", de));

        var savedCurrent = CultureInfo.CurrentCulture;
        var savedDefault = CultureInfo.DefaultThreadCurrentCulture;
        CultureInfo.CurrentCulture = de;
        CultureInfo.DefaultThreadCurrentCulture = de;

        string under;
        try
        {
            under = await _client.GetStringAsync($"/api/projects/{projectId}/report/export");
        }
        finally
        {
            CultureInfo.CurrentCulture = savedCurrent;
            CultureInfo.DefaultThreadCurrentCulture = savedDefault;
        }

        // ① ★ 紅燈格：1.5 小時在 de-DE 下修前寫成 `1,5` ⇒ 這一格找不到。
        Assert.Contains("1.5", under);
        // ② 欄位不得位移：表頭與每一列資料的欄數相同（引號內的逗號不切——用同一把尺量兩邊）。
        var lines = under.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToArray();
        Assert.All(lines.Skip(1), l => Assert.Equal(lines[0].Split(',').Length, l.Split(',').Length));
        // ③ 兩次匯出逐位元組相同（最強的一條，同團隊那一支）。
        Assert.Equal(host, under);
    }

    /// <summary>
    /// CSV：資料列的欄數必須與表頭相同，且三個數值欄逐字等於不變文化的 renders。
    ///
    /// 欄數與**表頭**比而不是寫死 9：日後加欄位時表頭會跟著長，這條不會變成假紅
    /// （而「表頭與資料列不一致」本身就是這條要抓的位移）。
    /// 逐字斷言那三欄是刻意的：`33.3 %` 的**空格**是不變文化的 PercentPositivePattern
    /// （`33.3%` 是 zh-TW／en-US 的），它是修掉地雷時一併發生的呈現變更——寫在這裡，
    /// 是為了讓這件事在程式庫裡留下一份可讀的記錄，而不是只存在於當次對話。
    /// </summary>
    private static void AssertCsvShape(string csv)
    {
        var lines = csv.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToArray();

        // 恰好一列資料：這是下面「位元組相同」能成立的前提（多列時列的順序得另外證明穩定）。
        Assert.Equal(2, lines.Length);
        Assert.Equal(lines[0].Split(',').Length, lines[1].Split(',').Length);

        var fields = lines[1].Split(',');
        Assert.Equal("1", fields[4]);          // CompletedCards
        Assert.Equal("3", fields[5]);          // TotalCards
        Assert.Equal("33.3 %", fields[6]);     // CompletionRate = 1/3
        Assert.Equal("100.0 %", fields[7]);    // OnTimeRate = 1/1（那張完成的卡片帶未來截止日）
        Assert.Equal("1.5", fields[8]);        // LoggedHours
    }

    /// <summary>
    /// XLS：每一個 `ss:Type="Number"` 的儲存格都必須是**不變文化**解析得動的數字。
    /// 壞掉的實作寫出 `0,3333333333333333`——`NumberStyles.Float` 不含 AllowThousands
    /// ⇒ 解析失敗（那甚至不是千分位，Excel 也讀不懂）。
    /// M2（只還原 XLS 那三處）實測：紅在這一條，訊息逐字為
    /// `不是不變文化數字：&lt;0,3333333333333333&gt;` 與 `&lt;1,5&gt;`（5 格中 2 格）。
    /// </summary>
    private static void AssertXlsNumbers(string xls)
    {
        var cells = Regex.Matches(xls, "<Data ss:Type=\"Number\">([^<]*)</Data>")
            .Select(m => m.Groups[1].Value).ToArray();

        // 空集合會讓 Assert.All 恆真——這一條擋的是「正则沒對上、於是什麼都沒驗」。
        Assert.Equal(5, cells.Length);
        Assert.All(cells, cell => Assert.True(
            double.TryParse(cell, NumberStyles.Float, CultureInfo.InvariantCulture, out _),
            $"不是不變文化數字：<{cell}>"));
    }

    private async Task<ExportSnapshot> CaptureAsync(string teamId)
    {
        var csvRes = await _client.GetAsync($"/api/teams/{teamId}/report/export");
        if (csvRes.StatusCode != HttpStatusCode.OK)
        {
            throw new Exception($"CSV 匯出失敗 {csvRes.StatusCode}: {await csvRes.Content.ReadAsStringAsync()}");
        }

        var xlsRes = await _client.GetAsync($"/api/teams/{teamId}/report/export-excel");
        if (xlsRes.StatusCode != HttpStatusCode.OK)
        {
            throw new Exception($"XLS 匯出失敗 {xlsRes.StatusCode}: {await xlsRes.Content.ReadAsStringAsync()}");
        }

        return new ExportSnapshot(await csvRes.Content.ReadAsStringAsync(), await xlsRes.Content.ReadAsStringAsync());
    }

    private sealed record ExportSnapshot(string Csv, string Xls);

    /// <summary>
    /// 建一個團隊、專案、看板、清單與 **3 張卡片**，其中 1 張**帶未來截止日、已完成且準時**，
    /// 並記 **1.5 小時**工時。
    ///
    /// **為什麼數字必須是分數**：三個數值欄在整數時兩種文化的寫法完全相同（`1` 在 de-DE
    /// 也是 `1`）⇒ 用整數當 fixture，壞掉的實作照樣全綠。1/3 與 1.5 才逼得出小數點。
    /// 準時率 1/1 是**刻意留著、而不是有判別力的那一格**：CSV 那一側 `P1` 一定印一位小數
    /// ⇒ `100,0 %`、帶著逗號；XLS 那一側是 `{onTimeRate}` ⇒ 印 `1`、**兩種文化同形**。
    /// （M2 實測：只還原 XLS 那三處 ⇒ 5 格中**只有 2 格**失敗。）留著它的理由是不讓它
    /// 被誤讀成有判別力——這一欄的判別力在 CSV，不在 XLS。
    ///
    /// **那個截止日是 2026-09-21 補的**，而且它同時是這個 fixture 的形狀約束：準時率的
    /// 分母自該日起是「已交付**且**有截止日」的卡片，所以「1/1 準時」現在**必須**靠一個
    /// 真的截止日成立，不能再靠「沒有截止日 ⇒ 算準時」那個已經移除的後備。
    /// 卡片不指派成員：`owners` 在沒有成員時退回 `CreatedById`（admin），列照樣出得來，
    /// 而這一支要測的是數值格式、不是名冊。
    /// </summary>
    private async Task<(string TeamId, string ProjectId)> SetupTeamWithFractionalNumbersAsync(string token)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", teamId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var projectId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
                JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
                JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        string? firstCardId = null;
        for (var i = 0; i < 3; i++)
        {
            var cardId = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
                    JsonContent.Create(new { title = $"C{i}" })))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
            firstCardId ??= cardId;
        }

        // **截止日在交付之前設**（2026-09-21）：準時率的分母自該日起是「已交付**且**有截止日」
        // 的卡片，少了它這一張不會進分母 ⇒ 準時率變「樣本不足」的空欄位，下面兩條數值斷言
        // （`100.0 %` 與 5 格）當場失去標的。未來日期保證 `CompletedAt <= DueAt`。
        var due = await _client.PutAsync($"/api/cards/{firstCardId}",
            JsonContent.Create(new { dueAt = "2099-01-01T00:00:00Z" }));
        Assert.True(due.IsSuccessStatusCode, await due.Content.ReadAsStringAsync());

        var done = await _client.PutAsync($"/api/cards/{firstCardId}/completion",
            JsonContent.Create(new { isCompleted = true }));
        Assert.True(done.IsSuccessStatusCode, await done.Content.ReadAsStringAsync());

        var effort = await _client.PostAsync($"/api/cards/{firstCardId}/effort",
            JsonContent.Create(new { hours = 1.5, timeZoneId = "UTC" }));
        Assert.True(effort.IsSuccessStatusCode, await effort.Content.ReadAsStringAsync());

        return (teamId, projectId);
    }
}
