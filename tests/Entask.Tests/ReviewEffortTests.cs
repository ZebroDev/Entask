using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class ReviewEffortTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ReviewEffortTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string CardId, string TeamId, string EngineerRoleId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "審查測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerId = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "審查測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "審查板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var card = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "審查卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (card.GetProperty("id").GetString()!, teamId, engineerId);
    }

    [Fact]
    public async Task Reviews_AssignSubmitOwnOnly_Works()
    {
        var (cardId, teamId, _) = await SetupAsync();
        // ivan 用「工程組長」而不是 SetupAsync 查到的「工程師」：本支要他**帶分數**提交，
        // 而 card.rate（Task 9，設計 §13.5）只給主管角色——工程師提交分數會 400。
        // 其餘三支拿 engineerRoleId 做的是工時與非法分數，與 card.rate 無關，故 SetupAsync 不動。
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var leadRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程組長").GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "ivan", password = "Password1!", displayName = "伊凡" }));
        Guid ivanId;
        using (var scope = _factory.Services.CreateScope())
            ivanId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "ivan").Id;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "ivan", roleIds = new[] { leadRoleId } }));
        // ivan 還必須是**專案成員**：審查者必須是該卡片所屬專案的成員（2026-09-19 不變量）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{FindProjectId(cardId)}/members",
            JsonContent.Create(new { userId = ivanId, roleIds = new[] { leadRoleId } }))).StatusCode);

        // 指派審查者（admin，card.assign）
        var assigned = await (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { ivanId } }))).Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = assigned.EnumerateArray().First().GetProperty("id").GetString()!;
        Assert.Equal("pending", assigned.EnumerateArray().First().GetProperty("status").GetString());

        // ivan 登入並提交自己的審查
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "ivan", password = "Password1!" }));
        var ivanToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var submit = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{reviewId}");
        submit.Headers.Authorization = new("Bearer", ivanToken);
        submit.Content = JsonContent.Create(new { status = "approved", score = 5, comment = "通過" });
        var submitted = await (await _client.SendAsync(submit)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("approved", submitted.GetProperty("status").GetString());
        Assert.Equal(5, submitted.GetProperty("score").GetInt32());

        // 活動串：指派 → review_added、提交 → review_submitted
        var feed = await (await _client.GetAsync($"/api/cards/{cardId}/activity")).Content.ReadFromJsonAsync<JsonElement>();
        var types = feed.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("type").GetString()).ToList();
        Assert.Contains("review_added", types);
        Assert.Contains("review_submitted", types);

        // admin（非該列本人）→ 403
        // 這裡送 `approved` 而不是 `rejected`：本支要驗的是「不是自己的審查列」這道閘門，
        // 而不是狀態的值。`rejected` 現在要求填意見，缺了它會在**驗證**階段先回 400，
        // 403 就走不到了。
        //
        // 這支端點是**驗證先於存在性查詢**：四道 400 在 ReviewEndpoints.cs:106-114，
        // 存在性查詢在 :116。list PUT 同序（ListEndpoints.cs:33-38 先於 :39）。
        // **不要**照舊版寫成「與 list/card PUT 的既有順序一致」——card PUT 是
        // **存在性優先**（CardEndpoints.cs:64-65 的 NotFound() 在任何驗證之前），
        // 三個端點是三種順序。（2026-09-17 收尾批次更正，逐條實查。）
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var hack = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{reviewId}");
        hack.Headers.Authorization = new("Bearer", adminToken);
        hack.Content = JsonContent.Create(new { status = "approved" });
        var hackResp = await _client.SendAsync(hack);
        Assert.Equal(HttpStatusCode.Forbidden, hackResp.StatusCode);
        // body 帶 code：admin 沒有豁免這道閘門（`review.ReviewerUserId != userId` 是身分比對，
        // 不是權限碼），所以這一條真的走得到 handler 的 403，而不是篩選器的。
        Assert.Equal("review.notReviewer",
            (await hackResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Reviews_InvalidScore_Returns400()
    {
        var (cardId, teamId, engineerRoleId) = await SetupAsync();
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "judy", password = "Password1!", displayName = "茱蒂" }));
        Guid judyId;
        using (var scope = _factory.Services.CreateScope())
            judyId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "judy").Id;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "judy", roleIds = new[] { engineerRoleId } }));
        // 同 ivan：審查者必須是專案成員（2026-09-19 不變量）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{FindProjectId(cardId)}/members",
            JsonContent.Create(new { userId = judyId, roleIds = new[] { engineerRoleId } }))).StatusCode);
        var assigned = await (await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { judyId } }))).Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = assigned.EnumerateArray().First().GetProperty("id").GetString()!;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "judy", password = "Password1!" }));
        var judyToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var submit = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{cardId}/reviews/{reviewId}");
        submit.Headers.Authorization = new("Bearer", judyToken);
        submit.Content = JsonContent.Create(new { status = "approved", score = 99 });
        var invalid = await _client.SendAsync(submit);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        // 這個端點上有兩個 400：開頭的「評分範圍」與後面的「沒有 card.rate」（Task 9）。
        // 只斷言狀態碼的話，兩者互換位置也照樣綠——judy 是「工程師」（無 card.rate），
        // 所以這一支必須紅在「範圍」而不是「權限」，錯誤碼才分得出是哪一條路徑。
        Assert.Equal(ErrorCodes.ReviewRatingInvalid,
            (await invalid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Effort_LogOwnOnly_SummaryComputed_Works()
    {
        var (cardId, teamId, engineerRoleId) = await SetupAsync();
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "kate", password = "Password1!", displayName = "凱特" }));
        Guid kateId;
        using (var scope = _factory.Services.CreateScope())
            kateId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "kate").Id;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "kate", roleIds = new[] { engineerRoleId } }));
        await _client.PostAsync($"/api/projects/{FindProjectId(cardId)}/members",
            JsonContent.Create(new { userId = kateId, roleIds = new[] { engineerRoleId } }));

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "kate", password = "Password1!" }));
        var kateToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        var log = new HttpRequestMessage(HttpMethod.Post, $"/api/cards/{cardId}/effort");
        log.Headers.Authorization = new("Bearer", kateToken);
        log.Content = JsonContent.Create(new { hours = 2.5m, note = "寫 API", timeZoneId = "UTC" });
        var logged = await (await _client.SendAsync(log)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2.5m, logged.GetProperty("hours").GetDecimal());
        Assert.Equal("kate", logged.GetProperty("username").GetString());

        var listReq = new HttpRequestMessage(HttpMethod.Get, $"/api/cards/{cardId}/effort");
        listReq.Headers.Authorization = new("Bearer", kateToken);
        var effort = await (await _client.SendAsync(listReq)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2.5m, effort.GetProperty("totalHours").GetDecimal());

        // 活動串：effort_logged 記 hours
        var feed = await (await _client.GetAsync($"/api/cards/{cardId}/activity")).Content.ReadFromJsonAsync<JsonElement>();
        var loggedAct = OfType(feed, "effort_logged").First();
        Assert.Equal(2.5m, ParseDetail(loggedAct).GetProperty("hours").GetDecimal());
    }

    [Fact]
    public async Task Effort_NonPositiveHours_Returns400()
    {
        var (cardId, teamId, engineerRoleId) = await SetupAsync();
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "leo", password = "Password1!", displayName = "里歐" }));
        Guid leoId;
        using (var scope = _factory.Services.CreateScope())
            leoId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>().Users.First(u => u.UserName == "leo").Id;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "leo", roleIds = new[] { engineerRoleId } }));
        await _client.PostAsync($"/api/projects/{FindProjectId(cardId)}/members",
            JsonContent.Create(new { userId = leoId, roleIds = new[] { engineerRoleId } }));
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "leo", password = "Password1!" }));
        var leoToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/cards/{cardId}/effort");
        req.Headers.Authorization = new("Bearer", leoToken);
        // 帶一個有效的時區：這一支要紅在「時數非正」，時區必須先過關，
        // 否則驗證順序若被調換，這裡會以 request.timeZoneInvalid 假綠。
        req.Content = JsonContent.Create(new { hours = 0, timeZoneId = "UTC" });
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.SendAsync(req)).StatusCode);
    }

    // ── 工時寫入契約（2026-10-08，Q1／R5）：凍結本地日、補登與兩個新錯誤碼 ────────────────
    //
    // 「本地日」一律由**測試端自己**用 `TimeZoneInfo` 算（不呼叫 `TimeZones`——這四支測的是
    // 端點；helper 自己的判別力在 `TimeZonesTests`）。Kiritimati 是 UTC+14：每天有一段時間
    // 它的本地日領先 UTC 日 ⇒「直接取 UTC 日」的實作在那段時間會與這裡的預期分開。
    private const string WriterTz = "Pacific/Kiritimati";

    private static DateOnly LocalTodayOf(string ianaId, DateTime utcNow) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(utcNow, TimeZoneInfo.FindSystemTimeZoneById(ianaId)));

    /// <summary>回應的 `localDate` 逐字釘住線格式 `yyyy-MM-dd`（欄位契約的一部分）。</summary>
    private static DateOnly LocalDateOf(JsonElement body) =>
        DateOnly.ParseExact(body.GetProperty("localDate").GetString()!, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    [Fact]
    public async Task Effort_FreezesAuthorLocalDay_AndFilingWallClock()
    {
        var (cardId, _, _) = await SetupAsync();

        var before = LocalTodayOf(WriterTz, DateTime.UtcNow);
        var resp = await _client.PostAsync($"/api/cards/{cardId}/effort",
            JsonContent.Create(new { hours = 2, timeZoneId = WriterTz }));
        var after = LocalTodayOf(WriterTz, DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var bodyLocalDate = LocalDateOf(body);
        // before／after 的聯集只吸收「本地午夜正好跨過這次請求」的窗口；兩值相等時它就退化為
        // 逐字相等。窗口外，正確的實作與其中恰好一個相等。
        Assert.Contains(bodyLocalDate, new[] { before, after });
        // 回應不再有 UTC 瞬時（`loggedAt` 欄位已移除）——顯示的是工作日
        Assert.False(body.TryGetProperty("loggedAt", out _), "回應不該再有 loggedAt");

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var log = db.EffortLogs.First(e => e.Id == Guid.Parse(body.GetProperty("id").GetString()!));
        Assert.Equal(bodyLocalDate, log.LocalDate);
        // 沒補登 ⇒ 填報牆鐘與工作日同一天（都在作者時區）
        Assert.Equal(bodyLocalDate, DateOnly.FromDateTime(log.LoggedAtLocal));
        Assert.Equal(DateTimeKind.Unspecified, log.LoggedAtLocal.Kind);
        // 瞬時欄位仍在、仍是 UTC（讀取端的過渡期靠它）
        Assert.Equal(DateTimeKind.Utc, log.LoggedAt.Kind);
    }

    [Fact]
    public async Task Effort_Backfill_KeepsFilingWallClockInTheNow()
    {
        var (cardId, _, _) = await SetupAsync();

        var before = LocalTodayOf(WriterTz, DateTime.UtcNow);
        var backfill = before.AddDays(-3);
        var resp = await _client.PostAsync($"/api/cards/{cardId}/effort",
            JsonContent.Create(new { hours = 1, timeZoneId = WriterTz, localDate = backfill.ToString("yyyy-MM-dd") }));
        var after = LocalTodayOf(WriterTz, DateTime.UtcNow);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        // 補登的那一天是逐字回聲（不受午夜窗口影響）
        Assert.Equal(backfill, LocalDateOf(body));

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var log = db.EffortLogs.First(e => e.Id == Guid.Parse(body.GetProperty("id").GetString()!));
        Assert.Equal(backfill, log.LocalDate);
        // 填報牆鐘仍是「今天」——補登不改寫填報當下
        var filingDay = DateOnly.FromDateTime(log.LoggedAtLocal);
        Assert.Contains(filingDay, new[] { before, after });
        Assert.NotEqual(backfill, filingDay);
    }

    [Fact]
    public async Task Effort_FutureLocalDate_Returns400()
    {
        var (cardId, _, _) = await SetupAsync();

        // +2 而不是 +1：本地午夜若正好在「測試端計算」與「伺服器判定」之間跨過，+1 會退化成
        // 「不是未來」（400 變 200）。這一支只釘 400 這條路徑；「UTC 日 vs 本地日」的判別力
        // 在下面那一支（時鐘窗口無關）。
        var today = LocalTodayOf(WriterTz, DateTime.UtcNow);
        var resp = await _client.PostAsync($"/api/cards/{cardId}/effort",
            JsonContent.Create(new { hours = 1, timeZoneId = WriterTz, localDate = today.AddDays(2).ToString("yyyy-MM-dd") }));

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.EffortLocalDateInFuture, await ErrorBody.CodeOfAsync(resp));
    }

    /// <summary>
    /// 時鐘窗口無關的判別：「未來日」的判準是**作者的本地日**，不是 UTC 日。
    /// 選一個「現在」本地日必定與 UTC 日不同的時區，兩個分支各離換日點至少一小時餘裕
    /// （所以它每一天都分得開），且兩個分支的期待值相反——用 UTC 日比較的實作必紅在
    /// 其中一邊：
    ///   Kiritimati（UTC+14，無 DST）在 UTC 10:00 換日 ⇒ UTC 10:00–23:59 其本地日＝UTC 日 + 1
    ///   Midway（UTC-11，無 DST）在 UTC 11:00 換日 ⇒ UTC 00:00–09:59 其本地日＝UTC 日 − 1
    /// </summary>
    [Fact]
    public async Task Effort_FutureCheck_UsesTheAuthorLocalDay_NotTheUtcDay()
    {
        var (cardId, _, _) = await SetupAsync();

        var utcToday = DateOnly.FromDateTime(DateTime.UtcNow);
        var behind = DateTime.UtcNow.Hour < 10;
        var tzId = behind ? "Pacific/Midway" : "Pacific/Kiritimati";
        var localToday = LocalTodayOf(tzId, DateTime.UtcNow);
        // 這一行是「這個窗口真的分得開」的證據——兩個日期相等就代表選錯窗口了
        Assert.NotEqual(utcToday, localToday);

        if (behind)
        {
            // 落後時區：本地日 + 1 == UTC 日 ⇒ 正確的實作回 400；用 UTC 日比較的實作回 200。
            Assert.Equal(utcToday, localToday.AddDays(1));
            var resp = await _client.PostAsync($"/api/cards/{cardId}/effort",
                JsonContent.Create(new { hours = 1, timeZoneId = tzId, localDate = localToday.AddDays(1).ToString("yyyy-MM-dd") }));
            Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
            Assert.Equal(ErrorCodes.EffortLocalDateInFuture, await ErrorBody.CodeOfAsync(resp));
        }
        else
        {
            // 領先時區：本地日 == UTC 日 + 1 ⇒「今天」必須被接受（200）；用 UTC 日比較的實作會 400。
            Assert.Equal(utcToday.AddDays(1), localToday);
            var resp = await _client.PostAsync($"/api/cards/{cardId}/effort",
                JsonContent.Create(new { hours = 1, timeZoneId = tzId, localDate = localToday.ToString("yyyy-MM-dd") }));
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            Assert.Equal(localToday, LocalDateOf(await resp.Content.ReadFromJsonAsync<JsonElement>()));
        }
    }

    [Fact]
    public async Task Effort_MissingOrUnknownTimeZone_Returns400()
    {
        var (cardId, _, _) = await SetupAsync();

        var missing = await _client.PostAsync($"/api/cards/{cardId}/effort",
            JsonContent.Create(new { hours = 1, timeZoneId = (string?)null }));
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(missing));

        var unknown = await _client.PostAsync($"/api/cards/{cardId}/effort",
            JsonContent.Create(new { hours = 1, timeZoneId = "Not/AZone" }));
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.Equal(ErrorCodes.TimeZoneInvalid, await ErrorBody.CodeOfAsync(unknown));
    }

    private static IEnumerable<JsonElement> OfType(JsonElement activity, string type) =>
        activity.GetProperty("items").EnumerateArray().Where(a => a.GetProperty("type").GetString() == type);

    private static JsonElement ParseDetail(JsonElement item)
    {
        using var doc = JsonDocument.Parse(item.GetProperty("detail").GetString()!);
        return doc.RootElement.Clone();
    }

    private string FindProjectId(string cardId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return db.Cards.Where(c => c.Id == Guid.Parse(cardId)).Select(c => c.List.Board.ProjectId).First().ToString();
    }
}
