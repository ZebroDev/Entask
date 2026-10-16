using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Entask.Core;
using Entask.Infrastructure.Data;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

/// <summary>
/// `GET /api/teams/{teamId}/report/export-excel` 的契約鎖。
///
/// 這條路由原本**沒有任何測試**——補跑後端全量跑綠也蓋不到它，因為沒有測試呼叫它。
/// 而它產出的 xls 有一個 Excel 會**靜默容忍**的失敗模式：`&lt;Cell ss:StyleID="…"&gt;`
/// 指向一個不存在於 `&lt;Styles&gt;` 的樣式時，檔案照樣開得起來，只是那一格沒有顏色，
/// 沒有任何錯誤訊息、沒有任何日誌。
///
/// F3（`9d6b66e`）把四個 `&lt;Style&gt;` 與每一格的 StyleID 收斂到同一張 `RatingStyles`，
/// 讓兩者不可能只壞一邊。本測試釘住的正是那條不變量：**每一格引用的 StyleID 都必須有
/// 定義**，且已評級的格子要真的用到 Rating 樣式（不是靜默落回 DataCell）。
/// </summary>
[Collection("ApiTests")]
public class TeamReportExcelExportTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public TeamReportExcelExportTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // `<Style ss:ID="X"` 是**定義**，`ss:StyleID="X"` 是**引用**——兩個屬性名不同，
    // 所以「引用得到定義」可以用集合相減表達，不必真的解析 XML。
    private static readonly Regex StyleDefinitions = new("<Style ss:ID=\"([^\"]+)\"", RegexOptions.Compiled);
    private static readonly Regex StyleReferences = new("ss:StyleID=\"([^\"]+)\"", RegexOptions.Compiled);

    /// <summary>
    /// 建立團隊 ＋ `firstPass + reworked` 張已完成、**無截止日**的卡片，每張都指派了審查者
    /// （admin 自己）。admin 是這些卡的建立者，所以會出現在報表裡：**達成率 1.0、
    /// 準時率樣本不足**（2026-09-21 起——沒有截止日的卡片不進準時率的分子也不進分母，
    /// 見 `CardStats`）。
    ///
    /// 回傳的 `FirstCardId` 與 `ProjectId` 是給「再加一個零卡片成員」那類測試用的
    /// （`ExcelExport_LeavesEmptyCells_WhenNoSamples` 需要專案 id 補成員、需要卡片 id 記工時）。
    ///
    /// 前 `firstPass` 張**第一筆 entry 就是 approved**；其餘 `reworked` 張走「交付 → 退回
    /// → 重新交付 → 通過」，第一筆 entry 是 rejected ⇒ 只進分母、不進分子。
    /// 預設 (5, 0) ⇒ 一次交付通過率 5/5 = 1.0 → 評級 S（`RatingFor` 的第一個分支）。
    ///
    /// **五張不是隨手挑的**：S 的第三個條件（一次交付通過率）有樣本門檻——分母 <strong>少於
    /// 5 張</strong>時不列入 S 資格（設計 §13.4），所以 4 張卡走的是「條件不列入」那條路
    /// （`fpy` 為 null），只有 5 張才真的走「算出來的值」那條。
    /// </summary>
    /// <param name="scores">
    /// 逐張指定最終那次通過的評分（Task 11 的主管評分）。缺席或不足張數的卡片**不帶分數**
    /// ——預設 null，所以既有的三支測試完全不受影響。有分數時只有 `approved` 那一次帶
    /// （退回帶分數會被端點回 400）。
    /// </param>
    private sealed record ExcelTeam(string TeamId, string ProjectId, string ListId, string FirstCardId, Guid UserId);

    private async Task<ExcelTeam> SetupTeamWithCardsAsync(string token, int firstPass = 5, int reworked = 0,
        int[]? scores = null)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "Excel Team" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var me = await _client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        var userId = me.GetProperty("userId").GetGuid();
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { userIds = new[] { userId } }));

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", teamId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        string? firstCardId = null;
        for (var i = 1; i <= firstPass + reworked; i++)
        {
            // `POST /api/lists/{id}/cards` 直接回 CardResponse，不必再 GET 整個看板挑卡片。
            var cardId = (await (await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = $"C{i}" })))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
            firstCardId ??= cardId;

            // 指派審查者**本身不寫 entry**（設計 §5.3），所以少了下面那次提交的卡片
            // 會進 FPY 的分母而不進分子——這一步與下一步是一組的。
            var rows = await (await _client.PutAsync($"/api/cards/{cardId}/reviews",
                JsonContent.Create(new { reviewerUserIds = new[] { userId } }))).Content.ReadFromJsonAsync<JsonElement>();
            var reviewId = rows.EnumerateArray().Single().GetProperty("id").GetString()!;

            await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));

            if (i > firstPass)
            {
                // 交付 → 退回（清掉 CompletedAt）→ 重新交付 → 通過：第一筆 entry 是 rejected。
                await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
                    JsonContent.Create(new { status = ReviewStatuses.Rejected, comment = "退回重做" }));
                await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
            }

            var score = scores is not null && i <= scores.Length ? scores[i - 1] : (int?)null;
            await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
                JsonContent.Create(new { status = ReviewStatuses.Approved, score }));
        }

        return new ExcelTeam(teamId, pId, lId, firstCardId!, userId);
    }

    private async Task<string> ExportExcelAsync(string teamId)
    {
        var res = await _client.GetAsync($"/api/teams/{teamId}/report/export-excel");
        if (res.StatusCode != HttpStatusCode.OK)
        {
            var body = await res.Content.ReadAsStringAsync();
            throw new Exception($"Failed GET /api/teams/{teamId}/report/export-excel with {res.StatusCode}: {body}");
        }
        Assert.Equal("application/vnd.ms-excel", res.Content.Headers.ContentType?.MediaType);
        return await res.Content.ReadAsStringAsync();
    }

    /// <remarks>
    /// 這條**打不到單一改動的紅燈**：`RatingStyleId` 的 `ContainsKey` 護欄讓未知評級落回
    /// DataCell，所以「新增一個 RatingCodes 而 RatingStyles 沒跟上」不會產生 dangling，
    /// 而是在樣式區塊那一圈直接爆 KeyNotFoundException（500）。它要紅，得同時拆掉那道護欄
    /// ——定位是**契約鎖**，不是回歸重現（同 `TiedPositions_FallBackToDeterministicIdOrdering`）。
    /// </remarks>
    [Fact]
    public async Task ExcelExport_ReferencesNoUndefinedStyle()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var teamId = (await SetupTeamWithCardsAsync(token)).TeamId;

        var xml = await ExportExcelAsync(teamId);

        var defined = StyleDefinitions.Matches(xml).Select(m => m.Groups[1].Value).ToHashSet();
        var referenced = StyleReferences.Matches(xml).Select(m => m.Groups[1].Value).ToHashSet();

        // dangling 的 StyleID 是這一類缺陷唯一的形狀——Excel 不會抱怨，只會默默不上色。
        var dangling = referenced.Except(defined).OrderBy(x => x).ToList();
        Assert.Empty(dangling);

        // 四個評級都要被產生（樣式區塊走 RatingCodes.All，不是走 dictionary 的列舉順序）。
        foreach (var rating in RatingCodes.All)
        {
            Assert.Contains($"Rating{rating}", defined);
        }
    }

    [Fact]
    public async Task ExcelExport_UsesRatingStyleForRatedMember()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var teamId = (await SetupTeamWithCardsAsync(token)).TeamId;

        var xml = await ExportExcelAsync(teamId);

        // 完成率 1.0、準時率樣本不足（這些卡沒有截止日 ⇒ 該條件不列入）、
        // 一次交付通過率 5/5 → S。這一格必須真的掛上 RatingS，
        // 若哪天 RatingStyles 的鍵與 RatingCodes 的值漂移，RatingStyleId 會靜默落回
        // DataCell——畫面（JSON／CSV）完全不變，只有下載下來的 Excel 少一格顏色。
        Assert.Contains("ss:StyleID=\"RatingS\"", xml);
    }

    /// <summary>
    /// **三條輸出路徑釘在一起**：同一組數字在 JSON 路徑拿 A
    /// （`TeamReportTests.Rating_S_FallsToA_WhenFpyBelowThreshold`），xls 路徑也必須拿 A。
    ///
    /// 資料：5 張全部完成（完成率 1.0；`SetupTeamWithCardsAsync` 建的卡都沒有截止日
    /// ⇒ 準時率樣本不足、條件不列入），3 張一次通過、2 張退回後才通過
    /// ⇒ `reviewed = 5`、`fpy = 0.60 &lt; 0.80` ⇒ S 的第三個條件不成立 ⇒ **A**。
    ///
    /// 這一支的判別力來自「A 與 S 在這裡會分岔」：`fpy` 為 null（樣本不足）時條件**不適用**
    /// ⇒ 完成率 1.0 會拿到 **S**。所以把 xls 那條路徑的第三個引數寫死成 `null`
    /// ——或讓它自己去算一個不套門檻的比率——這一支當場變紅。
    /// 上一支（`ExcelExport_UsesRatingStyleForRatedMember`）擋不住那個突變：它的成員兩條路
    /// 都通向 S（`fpy` 真的算出來是 1.0、旁路則是 null），分歧點不在它身上。
    /// </summary>
    [Fact]
    public async Task ExcelExport_RatingMatchesJsonPath_WhenFpyBelowThreshold()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var teamId = (await SetupTeamWithCardsAsync(token, firstPass: 3, reworked: 2)).TeamId;

        var xml = await ExportExcelAsync(teamId);

        // 評級格真的掛上 RatingA（`ss:StyleID` 是**引用**；`<Style ss:ID="RatingA">` 那個
        // **定義**上面那兩支已經驗過、且與引用的屬性名不同，不會誤命中）。
        Assert.Contains("ss:StyleID=\"RatingA\"", xml);
        // 反面：同一份資料若走「樣本不足 ⇒ 條件不適用」會是 S——那正是突變的長相。
        Assert.DoesNotContain("ss:StyleID=\"RatingS\"", xml);
    }

    /// <summary>
    /// **xls 路徑的評級要反映主管評分的調整項**（Task 11 審查的 F7）。
    ///
    /// 資料：3 張全部完成、各以 1 分通過 ⇒ 完成率 1.0（準時率樣本不足 ⇒ 不列入）、
    /// `reviewed = 3 &lt; 5` ⇒ `fpy` 為 null ⇒ 客觀公式給 **S**；
    /// 樣本 3 筆、平均 1.0 ≤ 2.0 ⇒ 調整項**降一級** ⇒ **A**。
    ///
    /// 為什麼非有這一支不可：先前 `:471` 的兩個新引數**沒有任何判別力**——原有的三支測試
    /// 不是沒有分數（`scoreSamples = 0`，調整項不作用），就是兩條路都通向 S。
    /// 把那兩個引數寫死成 `null, 0` 之後全部測試仍然全綠（與 Task 10 的 I2 同型）。
    /// 這一支的評級在兩個方向上都會分岔，所以那個突變當場變紅。
    /// </summary>
    [Fact]
    public async Task ExcelExport_RatingReflectsScoreAdjustment()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var teamId = (await SetupTeamWithCardsAsync(token, firstPass: 3, scores: [1, 1, 1])).TeamId;

        var xml = await ExportExcelAsync(teamId);

        Assert.Contains("ss:StyleID=\"RatingA\"", xml);
        Assert.DoesNotContain("ss:StyleID=\"RatingS\"", xml);
    }

    /// <summary>
    /// **沒有樣本的欄位在 xls 是「空的一格」——不是 0，也不是 100%**（2026-09-21，使用者回報）。
    ///
    /// 這條路徑原本把 `completed > 0 ? … : 1.0` 當後備，於是零交付的成員在 Excel 裡
    /// 是一格貨真價實的 `100%`（`ss:Type="Number"` ＋ `PercentCell` 的 `0.0%` 格式），
    /// 與同一份報表 JSON 路徑上顯示「樣本不足」的 `fpy` 當場互相矛盾。
    ///
    /// 兩個成員各守一半：
    /// * **admin**（5 張完成、全部無截止日）⇒ 達成率 1.0 **有** `<Data>`、
    ///   準時率樣本不足 ⇒ 該格**沒有** `<Data>`。
    /// * **idle**（零卡片、只有 1.5 小時工時 ⇒ 靠工時進榜）⇒ 兩個比率格與**評等格**都沒有內容。
    ///
    /// 逐格數而不是只 `Contains`：`Assert.Contains` 對「壞掉的實作」與「修好的實作」
    /// 可能都成立（舊制那兩格也都是 `PercentCell`），**數空格的個數才分得開**。
    /// 空的評等格另外釘住 `<Data ss:Type="String"></Data>`：少了 `rating is null` 那個三元式，
    /// 這一格會變成一個沒有主詞的「級」（zh-TW）／`Grade `（en）。
    /// </summary>
    [Fact]
    public async Task ExcelExport_LeavesEmptyCells_WhenNoSamples()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var setup = await SetupTeamWithCardsAsync(token);

        // 第二個成員：零卡片。專案成員的身分是必要條件（卡片成員不變量），
        // 而工時**記在他名下**只有一個辦法——用資料庫直寫（工時端點一律歸給呼叫者，
        // 而呼叫者只能是 admin）。他因此進得了榜，卻沒有任何卡片依據。
        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "idle", password = "Password1!", displayName = "idle" }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());

        var roles = await (await _client.GetAsync($"/api/teams/{setup.TeamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;

        Guid idleId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            idleId = db.Users.First(u => u.UserName == "idle").Id;
            var loggedAt = DateTime.UtcNow;
            db.EffortLogs.Add(new Entask.Core.Entities.EffortLog
            {
                CardId = Guid.Parse(setup.FirstCardId),
                UserId = idleId,
                Hours = 1.5m,
                LoggedAt = loggedAt,
                LocalDate = DateOnly.FromDateTime(loggedAt),
                LoggedAtLocal = DateTime.SpecifyKind(loggedAt, DateTimeKind.Unspecified),
            });
            await db.SaveChangesAsync();
        }

        var added = await _client.PostAsync($"/api/projects/{setup.ProjectId}/members",
            JsonContent.Create(new { userId = idleId, roleIds = new[] { roleId } }));
        Assert.True(added.IsSuccessStatusCode, await added.Content.ReadAsStringAsync());

        var xml = await ExportExcelAsync(setup.TeamId);

        // 每一列兩格百分比 ⇒ 兩列共 4 格，其中 **3 格是空的**（admin 的準時率、
        // idle 的達成率與準時率）。舊制是 0 格——這一條就是那個差別的所在。
        var percentCells = Regex.Matches(xml, "<Cell ss:StyleID=\"PercentCell\"(/>|>)").Count;
        var emptyPercentCells = Regex.Matches(xml, "<Cell ss:StyleID=\"PercentCell\"/>").Count;
        Assert.Equal(4, percentCells);
        Assert.Equal(3, emptyPercentCells);

        // 「沒有 `<Data>`」在**全域**上不成立（admin 的達成率那格有），所以不能寫成
        // 一句 `DoesNotContain` ——要說的是「樣本不足的那幾格不是 0」。
        // 舊制在這裡寫的是一個貨真價實的 `0`，Excel 的 `0.0%` 格式把它顯示成 `0.0%`。
        Assert.DoesNotContain("<Cell ss:StyleID=\"PercentCell\"><Data ss:Type=\"Number\">0</Data></Cell>", xml);

        // 評等格：**恰好一格**是空的（idle），且空白格仍套得到樣式（DataCell，
        // 不是 Rating 系列——沒有評等就沒有對應的顏色）。
        var emptyStringCells = Regex.Matches(xml, "<Data ss:Type=\"String\"></Data>").Count;
        Assert.Equal(1, emptyStringCells);
        Assert.Contains("<Cell ss:StyleID=\"DataCell\"><Data ss:Type=\"String\"></Data></Cell>", xml);
    }
}
