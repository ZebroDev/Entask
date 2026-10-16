using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;
using Entask.Infrastructure.Data;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

[Collection("ApiTests")]
public class ExportTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ExportTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task CanExportProjectReportAsCsv()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        
        var r1 = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })); if (!r1.IsSuccessStatusCode) { var b = await r1.Content.ReadAsStringAsync(); throw new Exception(b); } var team = await r1.Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        
        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var res = await _client.GetAsync($"/api/projects/{pId}/report/export");
        if (res.StatusCode != HttpStatusCode.OK) { var body = await res.Content.ReadAsStringAsync(); throw new Exception($"Failed with {res.StatusCode}: {body}"); } Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("text/csv", res.Content.Headers.ContentType?.MediaType);
        
        var csv = await res.Content.ReadAsStringAsync();
        Assert.Contains("CardId,Title,BoardName", csv);
    }
    
    [Fact]
    public async Task CanExportTeamReportAsCsv()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        
        var r1 = await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })); if (!r1.IsSuccessStatusCode) { var b = await r1.Content.ReadAsStringAsync(); throw new Exception(b); } var team = await r1.Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;

        var res = await _client.GetAsync($"/api/teams/{tId}/report/export");
        if (res.StatusCode != HttpStatusCode.OK) { var body = await res.Content.ReadAsStringAsync(); throw new Exception($"Failed with {res.StatusCode}: {body}"); } Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("text/csv", res.Content.Headers.ContentType?.MediaType);
        
        var csv = await res.Content.ReadAsStringAsync();
        Assert.Contains("UserId,Username,DisplayName", csv);
    }

    /// <summary>
    /// 建一個團隊與 3 張「完成、準時、一次通過、各 1 分」的卡片，回傳 (teamId, userId)。
    ///
    /// 3 張而不是 5 張：`reviewed &lt; 5` ⇒ `fpy` 為 null ⇒ 客觀公式只看完成率（1.0 ⇒ S），
    /// 於是評級唯一的分岔來源就是調整項。分數只有主管能填，
    /// admin 有 admin claim ⇒ 放行（`ReviewEndpoints` 的閘門）。
    ///
    /// **這 3 張都沒有截止日**（2026-09-21 起）：準時率因此是 null（樣本不足）而不是 1.0，
    /// 而 `RatingFor` 的 `(onTimeRate is null || …)` 讓它**不列入** S 的條件——評級不變。
    /// 這正是這個 fixture 的形狀：S 的成立**不倚賴**準時率那一格。
    /// </summary>
    private async Task<(string TeamId, Guid UserId)> SetupScoredTeamAsync(string token)
    {
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        var userId = (await _client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("userId").GetGuid();

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        for (var i = 0; i < 3; i++)
        {
            var cardId = (await (await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = $"C{i}" })))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
            var assign = await _client.PutAsync($"/api/cards/{cardId}/reviews",
                JsonContent.Create(new { reviewerUserIds = new[] { userId } }));
            Assert.True(assign.IsSuccessStatusCode, await assign.Content.ReadAsStringAsync());
            var reviewId = (await assign.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().Single()
                .GetProperty("id").GetString()!;
            var done = await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
            Assert.True(done.IsSuccessStatusCode, await done.Content.ReadAsStringAsync());
            var submit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
                JsonContent.Create(new { status = ReviewStatuses.Approved, score = 1 }));
            Assert.True(submit.IsSuccessStatusCode, await submit.Content.ReadAsStringAsync());
        }

        return (tId, userId);
    }

    /// <summary>
    /// 「隊報裡有一列帶著指定顯示名的成員」的最小可達路徑：建隊（`T`）＋建使用者
    /// （`username`／`displayName`）＋專案（`P1`）＋一張指派給該使用者的卡
    /// （ownership 走 assignee ⇒ 她進榜）。回傳 teamId。
    ///
    /// **專用使用者、不動 admin 的顯示名**——理由與實測見 `TeamXlsExport_KeepsTabLfAndCr`
    /// 的檔頭（改共享帳號的名字會漏進同 class 之後的每一支測試）。**需要專用使用者的那兩支**
    /// xls 測試走這裡（`KeepsTabLfAndCr` 與 `FiltersNonCharacters`）；
    /// `FiltersInvalidXmlControlCharacters` 走的是 `SetupScoredTeamAsync` ＋改 admin 的顯示名。
    /// </summary>
    private async Task<string> SetupTeamWithMemberDisplayNameAsync(string username, string displayName)
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;

        var roles = await (await _client.GetAsync($"/api/teams/{tId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;

        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        Guid memberId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            memberId = db.Users.First(u => u.UserName == username).Id;
        }

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var added = await _client.PostAsync($"/api/projects/{pId}/members",
            JsonContent.Create(new { userId = memberId, roleIds = new[] { roleId } }));
        Assert.True(added.IsSuccessStatusCode, await added.Content.ReadAsStringAsync());

        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "C1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var assign = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { memberId } }));
        Assert.True(assign.IsSuccessStatusCode, await assign.Content.ReadAsStringAsync());

        return tId;
    }

    /// <summary>
    /// **CSV 路徑的評級欄要反映主管評分的調整項**（Task 11 審查的 F7）。
    ///
    /// 為什麼非有這一支不可：上面的 `CanExportTeamReportAsCsv` 只驗 content-type 與表頭前綴，
    /// 而它那個團隊**沒有任何成員**——CSV 那一行 `RatingForMember` 的兩個新引數因此
    /// **沒有任何判別力**，寫死成 `null, 0` 仍然全綠（與 Task 10 的 I2 同型）。
    ///
    /// 資料（`SetupScoredTeamAsync`）：完成率 1.0、準時率樣本不足（無截止日）、
    /// `reviewed = 3 &lt; 5` ⇒ `fpy` 為 null ⇒ 客觀公式給 **S**；樣本 3 筆、平均 1.0 ≤ 2.0
    /// ⇒ 調整項**降一級** ⇒ **A**。突變（寫死 `null, 0`）⇒ 這一欄變回 S ⇒ 這支當場紅。
    /// </summary>
    [Fact]
    public async Task CanExportTeamReportAsCsv_ReflectsScoreAdjustment()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (tId, userId) = await SetupScoredTeamAsync(token);

        var res = await _client.GetAsync($"/api/teams/{tId}/report/export");
        if (res.StatusCode != HttpStatusCode.OK) { var body = await res.Content.ReadAsStringAsync(); throw new Exception($"Failed with {res.StatusCode}: {body}"); }
        var csv = await res.Content.ReadAsStringAsync();

        // 第一個欄位是 userId，評級是第 4 欄（索引 3）。`Username`／`DisplayName` 都不含逗號
        // （seed 的顯示名是「系統管理員」），所以直接切欄不會錯位。
        var line = csv.Split('\n').Single(l => l.StartsWith(userId.ToString()));
        Assert.Equal(RatingCodes.A, line.Split(',')[3]);
    }

    /// <summary>
    /// **沒有樣本的欄位在 CSV 是空欄位——不是 0，也不是 100%**（2026-09-21，使用者回報）。
    ///
    /// 兩列各守一半，**兩列都非有不可**：
    /// * **zero**（一張卡片、一張都沒完成）⇒ 達成率 **`0.0 %`**（分母存在、分子是 0）、
    ///   準時率**空**（沒有「已交付且有截止日」的卡片 ⇒ 樣本不足）、評等 **C**。
    /// * **admin**（零卡片、靠 1.5 小時工時進榜）⇒ 達成率、準時率、評等**三欄全空**。
    ///
    /// 舊制在 admin 那一列印的是 `0.0 %` ＋ `100.0 %` ＋ `C`：準時率那一欄與**同一個人的**
    /// `fpy`（畫面顯示「樣本不足」）當場互相矛盾，而達成率的 0 則把「沒有依據」寫成
    /// 「做得不好」。少了 zero 那一列，「把 0 也當成樣本不足」的過度修正不會有紅燈——
    /// **分母是 0 才是樣本不足，分子是 0 不是**。
    /// </summary>
    [Fact]
    public async Task CanExportTeamReportAsCsv_EmptyCellsWhenNoSamples()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var adminId = (await _client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("userId").GetGuid();

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;

        var roles = await (await _client.GetAsync($"/api/teams/{tId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;

        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "zero", password = "Password1!", displayName = "zero" }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        Guid zeroId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            zeroId = db.Users.First(u => u.UserName == "zero").Id;
        }

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var added = await _client.PostAsync($"/api/projects/{pId}/members",
            JsonContent.Create(new { userId = zeroId, roleIds = new[] { roleId } }));
        Assert.True(added.IsSuccessStatusCode, await added.Content.ReadAsStringAsync());

        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "C1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // 卡片指派給 zero ⇒ admin 手上零張卡（責任歸屬是「有指派就歸指派者」）。
        var assign = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { zeroId } }));
        Assert.True(assign.IsSuccessStatusCode, await assign.Content.ReadAsStringAsync());

        // 工時**記在 admin 名下**（端點把工時歸給呼叫者）⇒ 他因此進榜，但沒有任何卡片依據。
        var effort = await _client.PostAsync($"/api/cards/{cardId}/effort", JsonContent.Create(new { hours = 1.5, timeZoneId = "UTC" }));
        Assert.True(effort.IsSuccessStatusCode, await effort.Content.ReadAsStringAsync());

        var res = await _client.GetAsync($"/api/teams/{tId}/report/export");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var lines = (await res.Content.ReadAsStringAsync())
            .Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToArray();

        var header = lines[0].Split(',');
        Assert.Equal(9, header.Length);
        Assert.Equal(3, lines.Length);   // 表頭 ＋ 兩列

        var zero = lines.Single(l => l.Contains("\"zero\"")).Split(',');
        Assert.Equal("1", zero[5]);      // TotalCards
        Assert.Equal("0", zero[4]);      // CompletedCards
        Assert.Equal("0.0 %", zero[6]);  // CompletionRate：分母是 1 ⇒ **不是**樣本不足
        Assert.Equal("", zero[7]);       // OnTimeRate：沒有已交付且有截止日的卡片
        Assert.Equal(RatingCodes.C, zero[3]);

        var admin = lines.Single(l => l.StartsWith(adminId.ToString())).Split(',');
        Assert.Equal("1.5", admin[8]);   // LoggedHours——他為什麼在榜上
        Assert.Equal("0", admin[5]);     // TotalCards
        Assert.Equal("", admin[6]);      // CompletionRate：零卡片 ⇒ 樣本不足
        Assert.Equal("", admin[7]);      // OnTimeRate
        Assert.Equal("", admin[3]);      // Rating：沒有基準就沒有評等
    }

    /// <summary>
    /// 專案 CSV：標題以 `=` 開頭時必須被前置 `'`（外部報告 C 類第 1 條的紅燈格）。
    /// 突變（拿掉 `CsvField.Escape`）⇒ 這支當場紅。
    /// </summary>
    [Fact]
    public async Task ProjectCsv_EscapesFormulaLeadingTitle()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var created = await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "=1+1" }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());

        var csv = await _client.GetStringAsync($"/api/projects/{pId}/report/export");

        Assert.Contains("\"'=1+1\"", csv);        // ★ 紅燈格：修前是 `,"=1+1",`
        Assert.DoesNotContain(",\"=1+1\"", csv);
    }

    /// <summary>
    /// 團隊 CSV：DisplayName 以 `=` 開頭時同樣被前置 `'`——這是**第二個建構器**的線路證明
    /// （只驗專案那一條的話，團隊那一條漏接 helper 不會有人知道）。
    /// </summary>
    [Fact]
    public async Task TeamCsv_EscapesFormulaLeadingDisplayName()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (tId, _) = await SetupScoredTeamAsync(token);

        var p = await _client.PutAsync("/api/me/profile", JsonContent.Create(new { displayName = "=SUM(A1)" }));
        Assert.True(p.IsSuccessStatusCode, await p.Content.ReadAsStringAsync());

        var csv = await _client.GetStringAsync($"/api/teams/{tId}/report/export");

        Assert.Contains("\"'=SUM(A1)\"", csv);    // ★ 紅燈格：修前是 `,"=SUM(A1)",`
        Assert.DoesNotContain(",\"=SUM(A1)\"", csv);
    }

    /// <summary>
    /// 專案 CSV 的**最後一欄（Priority）是文字欄，不是數值欄**：它是專案範疇「優先級」
    /// select 自訂欄位的值——`ProjectReportQueries` 由 `ValueJson` 取出 `string?`
    /// （`CardRow.Priority` 是 `string?`），而 select 的選項只要求「非空字串」
    /// （`CustomFieldEndpoints.ValidSelectOptions` 只擋 null／空清單／空白項）
    /// ⇒ `=1+1` 是合法選項，也是合法卡片值。修前這一欄**裸寫**（既無引號也無轉義）
    /// ⇒ 這支當場紅在「最後一欄的形狀」上。
    ///
    /// 走 API 建立那個值（而不是 DbContext 直寫）是刻意的：`=1+1` 之所以進得了卡片，
    /// 正是因為驗證只要求值在選項清單內——這一條路徑本身就是可達性的證明。
    /// </summary>
    [Fact]
    public async Task ProjectCsv_EscapesFormulaLeadingPriority()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "C1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // 建專案時種下的「優先級」select 欄位（`ProjectEndpoints`：Options = ["高","中","低"]）。
        var fields = await _client.GetFromJsonAsync<JsonElement>($"/api/projects/{pId}/custom-fields");
        var priorityFieldId = fields.EnumerateArray()
            .Single(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;

        var opt = await _client.PutAsync($"/api/projects/{pId}/custom-fields/{priorityFieldId}",
            JsonContent.Create(new { options = new[] { "=1+1" } }));
        Assert.True(opt.IsSuccessStatusCode, await opt.Content.ReadAsStringAsync());

        var set = await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, string> { [priorityFieldId] = "=1+1" }));
        Assert.True(set.IsSuccessStatusCode, await set.Content.ReadAsStringAsync());

        var csv = await _client.GetStringAsync($"/api/projects/{pId}/report/export");

        // ★ 紅燈格：修前最後一欄是裸的 `,=1+1`（無引號、無轉義）。
        var line = csv.Split('\n').Select(l => l.TrimEnd('\r')).Single(l => l.StartsWith(cardId));
        Assert.EndsWith(",\"'=1+1\"", line);
        Assert.DoesNotContain(",=1+1", csv);
    }

    /// <summary>
    /// 看板名與清單名同樣是文字欄、同樣走 `CsvField.Escape`——**這兩格先前沒有判別力**：
    /// 把該站點的 escape 拿掉，整個測試套件仍然全綠（先前只有 Title 那一格有人看著）。
    /// 兩個開頭字分取 `=` 與 `+`，一次釘住 helper 的兩個字元分支。
    /// </summary>
    [Fact]
    public async Task ProjectCsv_EscapesFormulaLeadingBoardAndListNames()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "=B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "+L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var created = await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "C1" }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());

        var csv = await _client.GetStringAsync($"/api/projects/{pId}/report/export");

        Assert.Contains(",\"'=B1\"", csv);   // ★ 拿掉 BoardName 那一格的 escape ⇒ 這一行紅
        Assert.Contains(",\"'+L1\"", csv);   // ★ 拿掉 ListName 那一格的 escape ⇒ 這一行紅
    }

    /// <summary>
    /// 團隊 CSV 的 Username 格同樣走 `CsvField.Escape`——**這格先前也沒有判別力**。
    ///
    /// 用 `+` 開頭而不是 `=`：Identity 預設的 `AllowedUserNameCharacters`
    /// （`Program.cs` 只調了 Password／Lockout，沒動 User）不含 `=`，帳號會建不起來；
    /// `+` 在允許集合內，而它與 `=` 同屬 helper 的前置字元集合。
    /// </summary>
    [Fact]
    public async Task TeamCsv_EscapesFormulaLeadingUsername()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "T" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var tId = team.GetProperty("id").GetString()!;
        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", tId);
        pReq.Content = JsonContent.Create(new { name = "P1" });
        var pId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var bId = (await (await _client.PostAsync($"/api/projects/{pId}/boards", JsonContent.Create(new { name = "B1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var lId = (await (await _client.PostAsync($"/api/boards/{bId}/lists", JsonContent.Create(new { name = "L1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{lId}/cards", JsonContent.Create(new { title = "C1" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var roles = await (await _client.GetAsync($"/api/teams/{tId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var roleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;

        var created = await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "+eve", password = "Password1!", displayName = "eve" }));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        Guid eveId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            eveId = db.Users.First(u => u.UserName == "+eve").Id;
        }

        var added = await _client.PostAsync($"/api/projects/{pId}/members",
            JsonContent.Create(new { userId = eveId, roleIds = new[] { roleId } }));
        Assert.True(added.IsSuccessStatusCode, await added.Content.ReadAsStringAsync());

        // 指派給 eve ⇒ 她以「ownership 走 assignee」進榜（`CreatedById` 是 admin）。
        var assign = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { eveId } }));
        Assert.True(assign.IsSuccessStatusCode, await assign.Content.ReadAsStringAsync());

        var csv = await _client.GetStringAsync($"/api/teams/{tId}/report/export");

        Assert.Contains(",\"'+eve\",", csv);       // ★ 拿掉 uname 那一格的 escape ⇒ 這一行紅
        Assert.DoesNotContain(",\"+eve\",", csv);
    }

    /// <summary>
    /// 團隊 xls：使用者顯示名含 U+0001 級控制字元時，檔案仍必須是**合法 XML**（Excel 開得起來）。
    /// 修前：`SecurityElement.Escape` 不濾控制字元 ⇒ `XDocument.Parse` 當場拋（RED）；
    /// 修後：控制字元被濾掉、其餘字元保留（**不是整格清空**）。
    /// 外部報告核實判定的第 8 條（`WorkLogExport.E` 早有這個過濾、隊報那一份漏了）。
    /// </summary>
    [Fact]
    public async Task TeamXlsExport_FiltersInvalidXmlControlCharacters()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var (tId, _) = await SetupScoredTeamAsync(token);

        // `\u0001`：JSON 允許、XML 1.0 不合法（`WorkLogExport.E` 的檔頭註解載明同一件事）。
        var p = await _client.PutAsync("/api/me/profile", JsonContent.Create(new { displayName = "壞\u0001字" }));
        Assert.True(p.IsSuccessStatusCode, await p.Content.ReadAsStringAsync());

        var res = await _client.GetAsync($"/api/teams/{tId}/report/export-excel");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var xml = System.Text.Encoding.UTF8.GetString(await res.Content.ReadAsByteArrayAsync());

        // ★ 紅燈格：修前這一行拋 XmlException。
        _ = System.Xml.Linq.XDocument.Parse(xml);

        Assert.DoesNotContain('\u0001', xml);
        Assert.Contains("壞", xml);
        Assert.Contains("字", xml);
    }

    /// <summary>
    /// 濾網的**保留半邊**：tab／LF／CR 是合法 XML 1.0 字元，必須原樣穿過過濾器。
    /// 上一支只釘住「非法字元被濾掉」——一個過度積極的濾網把 tab／換行也吃掉時，它不會有任何紅燈
    /// （顯示名裡的換行靜默消失，而檔案仍然是合法 XML）。兩支合起來才是完整的濾網契約。
    ///
    /// **專用使用者，不動 admin 的顯示名**：DB 重置是 per-class 不是 per-test
    /// （`ApiWebApplicationFactory.ConfigureWebHost` 的 `ConfigureServices` 只在 host 建置時跑一次
    /// ⇒ `_pendingReset` 只被該 class 的第一支測試消費）。改共享帳號的名字會漏進同 class 之後的
    /// 每一支測試——**實測**：帶著 LF 的顯示名讓 CSV 的 `Split('\n')` 多切出一列，
    /// `CanExportTeamReportAsCsv_EmptyCellsWhenNoSamples` 的 `Assert.Equal(3, lines.Length)` 當場紅
    /// （Expected: 3 / Actual: 4）。專用使用者只出現在自己這一隊的報表裡，其他測試看不到它。
    ///
    /// 兩條斷言的**量測面不同，兩條都非有不可**：
    /// * 原始字串（`xml`）：CR 只在這裡驗得到——**XML 解析器會把字面的 CR 正規化成 LF**
    ///   （XML 1.0 §2.11 的行尾正規化）⇒ 過了 `XDocument.Parse` 就分不出「CR 倖存」與
    ///   「CR 被濾掉、LF 從別處來」。
    /// * 解析後的樹（`XDocument.Parse` → 各 `Data` 的 `Value`）：tab／LF 走完整條路徑
    ///   （過濾 → 寫檔 → 解析）之後仍在同一個儲存格裡，CR 則已按規範變成 LF。
    ///
    /// 判別力（突變量測，2026-10-08）：把 `'\t'` 從保留清單拿掉 ⇒ 第一條紅；
    /// 把 `'\n'` 拿掉 ⇒ 第三條紅（其餘照過——三條斷言不是彼此的複製品）。
    /// </summary>
    [Fact]
    public async Task TeamXlsExport_KeepsTabLfAndCr()
    {
        // 顯示名含 tab／LF／CR：走共用的「一列帶指定顯示名的成員」建置器（專用使用者）。
        var tId = await SetupTeamWithMemberDisplayNameAsync("wsprobe", "甲\t乙\n丙\r丁");

        var res = await _client.GetAsync($"/api/teams/{tId}/report/export-excel");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var xml = System.Text.Encoding.UTF8.GetString(await res.Content.ReadAsByteArrayAsync());

        // ★ tab／CR 在原始字串上：CR 過了游標就會被正規化（見檔頭），所以只能在這裡驗。
        Assert.Contains("甲\t乙", xml);
        Assert.Contains("丙\r丁", xml);

        // ★ 解析後的儲存格：tab／LF 原樣穿過解析器，CR 按 XML 規範成為 LF。
        var doc = System.Xml.Linq.XDocument.Parse(xml);
        System.Xml.Linq.XNamespace ns = "urn:schemas-microsoft-com:office:spreadsheet";
        Assert.Contains("甲\t乙\n丙\n丁", doc.Descendants(ns + "Data").Select(d => d.Value));
    }

    /// <summary>
    /// 隊報 xls：顯示名含 **U+FFFF** 時，檔案仍必須是**合法 XML**（Excel 開得起來）。
    /// U+FFFE／U+FFFF 是**非字元**：UTF-8 編得出來、XML 1.0 的 Char production 卻只到 `#xFFFD`
    /// ⇒ 照原樣落地就是非良構的檔，`SecurityElement.Escape` 也救不回來。
    ///
    /// 修前：濾網是 `c &gt;= ' ' || tab/LF/CR` ⇒ 這兩個碼點 >= `' '` 而被放行
    /// ⇒ 下面那行 `XDocument.Parse` 當場拋 `XmlException`（RED）。
    ///
    /// 可達性**實查，不是推論**：`UserEndpoints` 對 `DisplayName` 只驗非 null／非空白／長度，
    /// 沒有任何字元類別檢查，而 `System.Text.Json` 接受 `￿` 這種轉義 ⇒ 一個非字元就讓
    /// **同區間的所有讀者**拿到一份拒開的檔（與上面 U+0001 那支同一個 blast radius）。
    ///
    /// ★ 落單代理項**不在**這一類：`Encoding.UTF8` 的替換後備會把它寫成 U+FFFD（合法字元）
    /// ⇒ 要濾的只有 `{U+FFFE, U+FFFF}` 這兩個碼點。
    /// </summary>
    [Fact]
    public async Task TeamXlsExport_FiltersNonCharacters()
    {
        var tId = await SetupTeamWithMemberDisplayNameAsync("uFFFFprobe", "壞￿字");

        var res = await _client.GetAsync($"/api/teams/{tId}/report/export-excel");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var xml = System.Text.Encoding.UTF8.GetString(await res.Content.ReadAsByteArrayAsync());

        // ★ 紅燈格：修前這一行拋 XmlException。
        _ = System.Xml.Linq.XDocument.Parse(xml);

        Assert.DoesNotContain("￿", xml);
        // 濾掉的是**那個碼點**，不是整個儲存格（否則「壞」與「字」會一起消失）。
        Assert.Contains("壞字", xml);
    }
}






