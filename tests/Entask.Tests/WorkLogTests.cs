using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Entask.Performance;

namespace Entask.Tests;

public class WorkLogTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public WorkLogTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task LoginAsync(string username, string password)
    {
        var login = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    // 測試 fixture（**凍結的本地日**：`LocalDate`／`LoggedAtLocal` 由寫入端在寫入當下算好，
    // 讀取端零時區數學——2026-10-08 批次的 Q1／R5）：
    //   erin：c1「評估A系統需求」3h　LocalDate 09-09（三）、牆鐘 09-09 10:00（備註含 U+0001）
    //          c2「客戶需求訪談」2h　LocalDate 09-12（六）、牆鐘 09-12 11:00（週末加班）
    //   dave：c1 4h　LocalDate 09-10（四）、牆鐘 09-10 07:30
    //          ——**跨界樣本**：瞬時是 2026-09-09T23:30Z（UTC 日 09-09），凍結日是 09-10。
    //          舊讀取端（瞬時＋查詢帶的 tzOffsetMinutes）在 tz=0 會歸 09-09、tz=480 才歸 09-10
    //          ⇒ 同一筆工時的「日」隨讀者漂移；現在沒有 tz 參數，分桶只能來自凍結的 LocalDate。
    //   admin：c3（封存卡）5h → 一律排除
    // 查詢區間：本地日 2026-09-07（一）～ 2026-09-14（一）（`to` 排他）
    //   → Workdays = 09-07,09-08,09-09,09-10,09-11 共 5 天
    // 成員列（HTTP 建立）的 JoinedLocalDate 於 SetupAsync 尾部一律改寫成窗**前**的 2026-08-01
    // ——「窗內有紀錄」的前提是這些人在窗開始前就在了；不改寫的話，到職日夾擠會把預期工作日夾成 0。
    private static readonly DateOnly From = new(2026, 9, 7);
    private static readonly DateOnly ToExclusive = new(2026, 9, 14);

    /// <summary>查詢字串與斷言共用的本地日線格式（`yyyy-MM-dd`，與端點契約同一把尺）。</summary>
    private static string Day(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // 「窗中途到職」測試共用的 Join 值：**凍結日＝09-09**。
    // 同時把 `JoinedAt` 寫成瞬時 2026-09-08T20:00Z（UTC 日 09-08）——舊制（讀 `JoinedAt` 的 UTC 日）
    // 會夾在 09-08 ⇒ 預期工作日變 4（不是 3），這一格才有判別力。
    private static readonly DateTime MidWindowJoinUtc = new(2026, 9, 8, 20, 0, 0, DateTimeKind.Utc);
    private static readonly DateOnly MidWindowJoinLocalDate = new(2026, 9, 9);

    private async Task<(string ProjectId, string TeamId, string Card1, string Card2, Guid ErinId, Guid DaveId)>
        SetupAsync()
    {
        await LoginAsync("admin-test", "TestPass123!");
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = $"日誌團隊{Guid.NewGuid():N}" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "日誌專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "日誌板" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "待辦" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var card1Id = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "評估A系統需求" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var card2Id = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "客戶需求訪談" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var card3Id = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "封存卡" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/cards/{card3Id}", JsonContent.Create(new { isArchived = true }));

        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "艾琳" }));
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "dave", password = "Password1!", displayName = "戴夫" }));

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineer = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "erin", roleIds = new[] { engineer } }));
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "dave", roleIds = new[] { engineer } }));

        // 團隊端點走 RequirePermission，必須帶 X-Team-Id header（與前端 axios 攔截器行為一致）
        _client.DefaultRequestHeaders.Remove("X-Team-Id");
        _client.DefaultRequestHeaders.Add("X-Team-Id", teamId);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        // 類別 fixture 的 WithDbReset 只在首次建立 host 時生效（ApiWebApplicationFactory.ConfigureWebHost
        // 僅執行一次），同一類別的多個測試因此共用同一份 DB；erin/dave 是固定的使用者名稱，
        // 會在各次 setup 間累積工時。清空工時日誌，讓每個測試的 Me 範疇聚合只看到本次 fixture 的紀錄。
        await db.EffortLogs.ExecuteDeleteAsync();
        var erinId = db.Users.First(u => u.UserName == "erin").Id;
        var daveId = db.Users.First(u => u.UserName == "dave").Id;
        var adminId = db.Users.First(u => u.UserName == "admin-test").Id;
        db.EffortLogs.AddRange(
            // U+0001 是 XML 1.0 不合法、但 PostgreSQL text／JSON 允許的控制字元：
            // 匯出的 E() 必須濾掉它，否則整份 .xls 會讓 Excel 拒開（Export_ReturnsSpreadsheetMl 的 Parse 即釘子）。
            // 不可改用 U+0000——Postgres 的 text 拒收 NUL，會直接在 SaveChangesAsync 爆掉。
            // 牆鐘一律 `Kind=Unspecified`（欄位是 timestamp without time zone；帶 Utc 的 Kind 進 Npgsql 會 500）。
            new EffortLog { CardId = Guid.Parse(card1Id), UserId = erinId, Hours = 3m, Note = "含控制字元\u0001備註",
                LoggedAt = new DateTime(2026, 9, 9, 2, 0, 0, DateTimeKind.Utc),
                LocalDate = new DateOnly(2026, 9, 9), LoggedAtLocal = new DateTime(2026, 9, 9, 10, 0, 0) },
            new EffortLog { CardId = Guid.Parse(card2Id), UserId = erinId, Hours = 2m,
                LoggedAt = new DateTime(2026, 9, 12, 3, 0, 0, DateTimeKind.Utc),
                LocalDate = new DateOnly(2026, 9, 12), LoggedAtLocal = new DateTime(2026, 9, 12, 11, 0, 0) },
            // 跨界樣本（見檔頭）：瞬時在 UTC 日 09-09，凍結日在 09-10。
            new EffortLog { CardId = Guid.Parse(card1Id), UserId = daveId, Hours = 4m, Note = "訪談前置",
                LoggedAt = new DateTime(2026, 9, 9, 23, 30, 0, DateTimeKind.Utc),
                LocalDate = new DateOnly(2026, 9, 10), LoggedAtLocal = new DateTime(2026, 9, 10, 7, 30, 0) },
            new EffortLog { CardId = Guid.Parse(card3Id), UserId = adminId, Hours = 5m,
                LoggedAt = new DateTime(2026, 9, 9, 1, 0, 0, DateTimeKind.Utc),
                LocalDate = new DateOnly(2026, 9, 9), LoggedAtLocal = new DateTime(2026, 9, 9, 9, 0, 0) });
        // 完成時間直接寫在實體上，不走 PUT /api/cards/{id}/completion——該端點固定寫 DateTime.UtcNow，
        // 會讓 CompletedCards 的窗口斷言隨時間失效。card1 窗內完成、card2 窗外完成（判別用）。
        db.Cards.First(c => c.Id == Guid.Parse(card1Id)).CompletedAt = new DateTime(2026, 9, 10, 0, 0, 0, DateTimeKind.Utc);
        db.Cards.First(c => c.Id == Guid.Parse(card2Id)).CompletedAt = new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc);

        // 成員列由 HTTP 建立 ⇒ JoinedLocalDate 恆為「now」（遠在 fixture 窗之後），而窗內的工時紀錄
        // 在語意上屬於「窗開始前就存在」的成員——這是 fixture 的處境、不是真實情境的形狀。
        // 把本團隊／本專案的成員列 JoinedLocalDate 直接改寫成窗前的 2026-08-01，讓 fixture
        // 反映該處境（先例：ProjectPermissionTests 直接寫 db.ProjectMembers 的既有縫）。
        // 不改寫的話，ComposeAsync 的到職日夾擠會把每個成員的預期工作日夾成 0，整段窗的斷言
        // 就變成在斷言「大家都還沒到職」——那是夾擠壞掉、不是夾擠生效。
        // （`JoinedAt` 不動：讀取端已不看它，讓它留在「now」＝任何誤讀它的實作都會被這些斷言抓到。）
        var preWindow = new DateOnly(2026, 8, 1);
        foreach (var m in db.TeamMembers.Where(m => m.TeamId == Guid.Parse(teamId)))
            m.JoinedLocalDate = preWindow;
        foreach (var m in db.ProjectMembers.Where(m => m.ProjectId == Guid.Parse(projectId)))
            m.JoinedLocalDate = preWindow;

        await db.SaveChangesAsync();

        return (projectId, teamId, card1Id, card2Id, erinId, daveId);
    }

    /// <summary>
    /// 於指定團隊下建立專案＋看板＋列表＋一張卡片，回傳 (projectId, cardId)。
    /// 供測試自建第二個專案／他隊專案，避免更動共用 fixture 的算式而波及既有斷言。
    /// 呼叫端須先移除 client 層的 X-Team-Id，否則會與此處的 request 層標頭併成兩個值。
    /// </summary>
    private async Task<(string ProjectId, string CardId)> CreateProjectWithCardAsync(string teamId, string name)
    {
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "板" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "待辦" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = $"{name}卡" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        return (projectId, cardId);
    }

    // 區間是必填的本地日（`to` 排他）；沒有 tzOffsetMinutes——那個參數已不存在，
    // 查詢字串裡留著它只會被忽略（擋不住的假綠來源，故一律不寫）。
    private async Task<JsonElement> GetWorkLogAsync(string url) =>
        await (await _client.GetAsync($"{url}?from={Day(From)}&to={Day(ToExclusive)}"))
            .Content.ReadFromJsonAsync<JsonElement>();

    private static string WindowQuery => $"from={Day(From)}&to={Day(ToExclusive)}";

    [Fact]
    public async Task MeScope_ReturnsOnlyCallerAndGroupsByLocalDate()
    {
        var (_, _, _, _, erinId, _) = await SetupAsync();
        await LoginAsync("erin", "Password1!");
        var report = await GetWorkLogAsync("/api/me/worklog");

        var members = report.GetProperty("members").EnumerateArray().ToList();
        Assert.Single(members);
        // 回應的區間是**本地日字串回聲**（`yyyy-MM-dd`）；瞬時與時區參數已從契約移除——
        // 少了這幾行，舊欄位悄悄長回來不會有人知道。**缺席的釘子要對稱**：舊 DTO 帶的是
        // `FromUtc` 與 `ToUtc` **兩個**瞬時（`WorkLogReportResponse` 的舊簽章），
        // 只釘 from 那一半的話，`toUtc` 長回來是靜默的。
        Assert.Equal("2026-09-07", report.GetProperty("fromDate").GetString());
        Assert.Equal("2026-09-14", report.GetProperty("toDate").GetString());
        Assert.False(report.TryGetProperty("tzOffsetMinutes", out _), "回應不該再有 tzOffsetMinutes");
        Assert.False(report.TryGetProperty("fromUtc", out _), "回應不該再有 fromUtc");
        Assert.False(report.TryGetProperty("toUtc", out _), "回應不該再有 toUtc");
        var erin = members[0];
        Assert.Equal(erinId.ToString(), erin.GetProperty("userId").GetString());
        Assert.Equal(5m, erin.GetProperty("totalHours").GetDecimal());
        Assert.Equal(2, erin.GetProperty("entryCount").GetInt32());
        Assert.Equal(2, erin.GetProperty("cardCount").GetInt32());
        Assert.Equal(2, erin.GetProperty("activeDays").GetInt32());
        Assert.Equal(1, erin.GetProperty("reportedWorkdays").GetInt32());   // 09-09 是工作日；09-12 是週六
        Assert.Equal(4, erin.GetProperty("missingWorkdays").GetInt32());    // 5 - 1

        var days = erin.GetProperty("days").EnumerateArray().ToList();
        Assert.Equal("2026-09-09", days[0].GetProperty("date").GetString());
        Assert.Equal("2026-09-12", days[1].GetProperty("date").GetString());
        Assert.Equal(3m, days[0].GetProperty("entries")[0].GetProperty("hours").GetDecimal());

        var workdays = report.GetProperty("workdays").EnumerateArray().Select(x => x.GetString()).ToList();
        Assert.Equal(5, workdays.Count);
        Assert.Contains("2026-09-09", workdays);
        Assert.DoesNotContain("2026-09-12", workdays);
        Assert.Equal(5, report.GetProperty("summary").GetProperty("workdayCount").GetInt32());
    }

    /// <summary>
    /// 到職前的日子不算漏報（2026-10-08 批次 A，`state/33` 的 `JoinedAt` 半）。
    /// 成員在窗**中途**到職 ⇒ 預期工作日＝窗內且 &gt;= 到職當天；到職**當天算在內**。
    /// 突變：拿掉夾擠 ⇒ `expectedWorkdays` 由 3 變回整段窗的 5（實測），這一支紅。
    /// </summary>
    [Fact]
    public async Task TeamScope_MemberJoiningMidWindow_DoesNotCountDaysBeforeJoinAsMissing()
    {
        var (_, teamId, _, _, erinId, daveId) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");

        // dave 的凍結到職日 09-09（三）：窗（09-07～09-11）的中途，且他在 09-09 沒有紀錄
        // （唯一一筆工時的凍結日 09-10 落 09-10）⇒ 到職**當天**必須仍算「該填而未填」。
        // 同時把 `JoinedAt` 寫成瞬時 2026-09-08T20:00Z（UTC 日 09-08）：改讀瞬時、不讀凍結欄的
        // 實作會夾在 09-08 ⇒ 預期工作日變 4（不是 3），這一格才有判別力。
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var rows = db.TeamMembers.Where(m => m.TeamId == Guid.Parse(teamId) && m.UserId == daveId).ToList();
            Assert.NotEmpty(rows);   // 夾擠的資料來源是成員列；這裡空掉的話整支測不到夾擠
            foreach (var row in rows)
            {
                row.JoinedAt = MidWindowJoinUtc;
                row.JoinedLocalDate = MidWindowJoinLocalDate;
            }
            await db.SaveChangesAsync();
        }

        var report = await GetWorkLogAsync($"/api/teams/{teamId}/worklog");
        var members = report.GetProperty("members").EnumerateArray().ToList();
        var dave = members.Single(m => m.GetProperty("userId").GetString() == daveId.ToString());

        // dave：整段窗 5 個工作日，到職日 09-09 ⇒ 預期 09-09／09-10／09-11 共 3 天；已回報 09-10
        Assert.Equal(3, dave.GetProperty("expectedWorkdays").GetInt32());
        Assert.Equal(1, dave.GetProperty("reportedWorkdays").GetInt32());
        var missing = dave.GetProperty("missingDays").EnumerateArray().Select(x => x.GetString()!).ToList();
        Assert.Equal(new[] { "2026-09-09", "2026-09-11" }, missing);
        // 到職前的 09-08 不是他的預期工作日；到職當天 09-09 是（`>=` 而非 `>`，少了它會是 2 天）
        Assert.DoesNotContain("2026-09-08", missing);
        Assert.Contains("2026-09-09", missing);
        // MissingWorkdays 與 MissingDays 是同一集合的兩個出口
        Assert.Equal(dave.GetProperty("missingWorkdays").GetInt32(), missing.Count);
        Assert.Equal(dave.GetProperty("expectedWorkdays").GetInt32(),
            missing.Count + dave.GetProperty("reportedWorkdays").GetInt32());

        // 對照：erin 在窗**前**就到職（SetupAsync 把 JoinedLocalDate 寫回 2026-08-01）⇒ 整段窗不變。
        // 少了這一半，把「夾擠」誤寫成「全員歸零」也會綠。
        var erin = members.Single(m => m.GetProperty("userId").GetString() == erinId.ToString());
        Assert.Equal(5, erin.GetProperty("expectedWorkdays").GetInt32());
        Assert.Equal(4, erin.GetProperty("missingWorkdays").GetInt32());
        Assert.Equal(4, erin.GetProperty("missingDays").GetArrayLength());
    }

    /// <summary>
    /// Project 範疇的同一條夾擠（`GetScopeMemberJoinDatesAsync` 的 Project 分支）。
    /// dave 直接寫入專案成員列、Join 日寫在窗中途 ⇒ 他的預期工作日被夾；
    /// erin 不是專案成員（只是靠窗內工時紀錄入列）⇒ **不夾**——「無成員列不夾」是規則、不是遺漏。
    /// 突變：Project 分支改回空字典 ⇒ dave 的 `expectedWorkdays` 變回整段窗的 5，這一支紅。
    /// </summary>
    [Fact]
    public async Task ProjectScope_MemberJoiningMidWindow_IsClampedWhileLogOnlyMemberIsNot()
    {
        var (projectId, _, _, _, erinId, daveId) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            // 角色沿用建立者（admin-test）那一列的角色——本測試只在乎 Join 日。
            var roleId = db.ProjectMembers.First(m => m.ProjectId == Guid.Parse(projectId)).RoleId;
            db.ProjectMembers.Add(new ProjectMember
            {
                Id = Guid.NewGuid(), ProjectId = Guid.Parse(projectId), UserId = daveId, RoleId = roleId,
                // 凍結到職日 09-09；`JoinedAt` 留在 UTC 日 09-08 ⇒ 讀錯欄位的實作夾在 09-08
                //（預期 4 不是 3），與 Team 範疇那一支同一套判別力。
                JoinedAt = MidWindowJoinUtc, JoinedLocalDate = MidWindowJoinLocalDate,
            });
            await db.SaveChangesAsync();
        }

        var report = await GetWorkLogAsync($"/api/projects/{projectId}/worklog");
        var members = report.GetProperty("members").EnumerateArray().ToList();

        var dave = members.Single(m => m.GetProperty("userId").GetString() == daveId.ToString());
        Assert.Equal(3, dave.GetProperty("expectedWorkdays").GetInt32());
        Assert.Equal(new[] { "2026-09-09", "2026-09-11" },
            dave.GetProperty("missingDays").EnumerateArray().Select(x => x.GetString()!).ToList());

        var erin = members.Single(m => m.GetProperty("userId").GetString() == erinId.ToString());
        Assert.Equal(5, erin.GetProperty("expectedWorkdays").GetInt32());
        Assert.Equal(4, erin.GetProperty("missingDays").GetArrayLength());
    }

    /// <summary>
    /// 同一人多列時的到職日＝**Min(JoinedLocalDate)**，不是 Max／最後一列：成員表的鍵含 RoleId
    /// （`EntaskDbContext.cs:51`／`:62` 的 `(…Id, UserId, RoleId)` 唯一鍵 ⇒ 差集指派會為每個角色
    /// 各留一列）⇒ 同一個人可以有多列、各列 Join 日不同。
    /// dave 兩列：凍結日在窗**前**的 2026-08-01 與窗**中途**的 09-09。
    /// 突變：`Min`→`Max` ⇒ 預期工作日由 5（取窗前那列）變 3（取中途那列），這一支紅；
    /// 改讀 `JoinedAt`（瞬時）再取 UTC 日 ⇒ 4（窗前那列的瞬時刻意寫在最晚），同樣紅。
    /// </summary>
    [Fact]
    public async Task ProjectScope_TwoMembershipRows_UsesEarliestJoinDate()
    {
        var (projectId, teamId, _, _, _, daveId) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");

        // 兩個**不同**角色：唯一鍵含 RoleId，同角色兩列會被 DB 擋下（那是測試自己的錯，不是產品行為）。
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerRoleId = Guid.Parse(roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!);
        var managerRoleId = Guid.Parse(roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理").GetProperty("id").GetString()!);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var projectGuid = Guid.Parse(projectId);
            // 兩列的凍結日刻意相反於瞬時：凍結日在窗**前**的那一列，瞬時反而晚（09-09T10:00Z）
            // ⇒ 取 Min 的「欄位選錯」（改讀 `JoinedAt` 再取 UTC 日）同樣會紅，不只 Min→Max。
            db.ProjectMembers.AddRange(
                new ProjectMember
                {
                    Id = Guid.NewGuid(), ProjectId = projectGuid, UserId = daveId,
                    RoleId = engineerRoleId, JoinedAt = MidWindowJoinUtc,
                    JoinedLocalDate = MidWindowJoinLocalDate,
                },
                new ProjectMember
                {
                    Id = Guid.NewGuid(), ProjectId = projectGuid, UserId = daveId,
                    RoleId = managerRoleId, JoinedAt = new DateTime(2026, 9, 9, 10, 0, 0, DateTimeKind.Utc),
                    JoinedLocalDate = new DateOnly(2026, 8, 1),
                });
            await db.SaveChangesAsync();
            // 兩列都要真的在：只剩一列時 Min＝Max，這一支就分不出聚合方式了（會變成假綠）
            Assert.Equal(2, db.ProjectMembers.Count(m => m.ProjectId == projectGuid && m.UserId == daveId));
        }

        var report = await GetWorkLogAsync($"/api/projects/{projectId}/worklog");
        var dave = report.GetProperty("members").EnumerateArray()
            .Single(m => m.GetProperty("userId").GetString() == daveId.ToString());

        // 最早那列在窗**前**（2026-08-01）⇒ 不夾：預期＝整段窗 5 天、漏報＝他沒回報的 4 天（已回報 09-10）。
        // `Max` 會取到 09-09 那一列 ⇒ 3／2，兩個斷言都會紅。
        Assert.Equal(5, dave.GetProperty("expectedWorkdays").GetInt32());
        Assert.Equal(4, dave.GetProperty("missingDays").GetArrayLength());
    }

    /// <summary>
    /// 匯出「彙總」表的「未回報工作日」欄吃的是**夾擠後**的值——JSON 與 xls 是同一份
    /// `MissingWorkdays` 的兩個出口，前端對話框（Task 4）與匯出檔必須同意。
    /// 突變：該格改印 `ExpectedWorkdays`（或改回未夾擠的算式）⇒ dave 的格子由 2 變 3（或 4），這一支紅。
    /// </summary>
    [Fact]
    public async Task Export_TeamScope_MissingColumnCarriesClampedValue()
    {
        var (_, teamId, _, _, _, daveId) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var rows = db.TeamMembers.Where(m => m.TeamId == Guid.Parse(teamId) && m.UserId == daveId).ToList();
            Assert.NotEmpty(rows);
            foreach (var row in rows)
            {
                row.JoinedAt = MidWindowJoinUtc;
                row.JoinedLocalDate = MidWindowJoinLocalDate;   // 09-09 到職 ⇒ 預期 3、已回報 1、漏報 2
            }
            await db.SaveChangesAsync();
        }

        var resp = await _client.GetAsync($"/api/teams/{teamId}/worklog/export?{WindowQuery}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var doc = XDocument.Parse(System.Text.Encoding.UTF8.GetString(await resp.Content.ReadAsByteArrayAsync()));
        XNamespace ns = "urn:schemas-microsoft-com:office:spreadsheet";
        // 只在「彙總」表找 dave 那一列——明細表的第一格是日期，不會誤中；`Single` 則擋下多列。
        var summary = doc.Descendants(ns + "Worksheet").Single(w => (string?)w.Attribute(ns + "Name") == "彙總");
        var daveRow = summary.Descendants(ns + "Row")
            .Single(r => (string?)r.Elements(ns + "Cell").First().Element(ns + "Data") == "戴夫");
        var cells = daveRow.Elements(ns + "Cell").Select(c => c.Element(ns + "Data")!.Value).ToList();
        Assert.Equal("1", cells[5]);   // 已回報工作日：09-10
        Assert.Equal("2", cells[6]);   // 未回報工作日：09-09／09-11（到職前的 09-07／09-08 不在內）
    }

    [Fact]
    public async Task EntryCarriesFullContext()
    {
        var (_, _, card1Id, _, _, _) = await SetupAsync();
        await LoginAsync("dave", "Password1!");
        var report = await GetWorkLogAsync("/api/me/worklog");
        var entry = report.GetProperty("members")[0].GetProperty("days")[0].GetProperty("entries")[0];

        Assert.Equal(card1Id, entry.GetProperty("cardId").GetString());
        // 回應不再有 UTC 瞬時：`loggedAt` → `loggedAtLocal`（凍結牆鐘，`Kind=Unspecified`
        // ⇒ 序列化不帶 Z 後綴）。dave 那一筆的牆鐘是 2026-09-10 07:30。
        Assert.False(entry.TryGetProperty("loggedAt", out _), "回應不該再有 loggedAt");
        Assert.Equal("2026-09-10T07:30:00", entry.GetProperty("loggedAtLocal").GetString());
        Assert.Equal("評估A系統需求", entry.GetProperty("cardTitle").GetString());
        Assert.Equal("訪談前置", entry.GetProperty("note").GetString());
        Assert.Equal("日誌專案", entry.GetProperty("projectName").GetString());
        Assert.Equal("日誌板", entry.GetProperty("boardName").GetString());
        Assert.Equal("待辦", entry.GetProperty("listName").GetString());
        Assert.StartsWith("日誌團隊", entry.GetProperty("teamName").GetString());
    }

    /// <summary>
    /// 跨界樣本（「日」不再隨讀者漂移）：dave 的瞬時是 2026-09-09T23:30Z（UTC 日 09-09），
    /// 凍結日是 09-10。舊讀取端把日算成「瞬時＋查詢帶的 tzOffsetMinutes」——tz=480 歸 09-10、
    /// tz=0 歸 09-09，同一個人同一筆工時的「日」隨**讀報告的人**而變（舊版本檔的
    /// `TimeZoneOffset_ShiftsLocalDayBucket` 釘住的正是那個漂移，該支已隨參數一併退場）。
    /// 現在沒有 tz 參數，分桶只能來自凍結的 `LocalDate` ⇒ 唯一的答案是 09-10。
    /// 突變：`GroupBy(r => r.LocalDate)` 改回 `DateOnly.FromDateTime(r.LoggedAt)`（＋任何 offset）
    /// ⇒ 這支紅——要綠就只能猜中那個 offset，而「猜」正是本批要消滅的東西。
    /// </summary>
    [Fact]
    public async Task CrossBoundarySample_BucketsByFrozenLocalDate_NotByUtcInstant()
    {
        await SetupAsync();
        await LoginAsync("dave", "Password1!");

        var report = await GetWorkLogAsync("/api/me/worklog");
        var members = report.GetProperty("members").EnumerateArray().ToList();
        Assert.Single(members);
        var days = members[0].GetProperty("days").EnumerateArray().ToList();
        Assert.Single(days);   // 不落 UTC 日 09-09 的桶，也不多長一桶
        Assert.Equal("2026-09-10", days[0].GetProperty("date").GetString());
        Assert.Equal(1, days[0].GetProperty("entryCount").GetInt32());
        Assert.Equal(4m, days[0].GetProperty("totalHours").GetDecimal());
    }

    [Fact]
    public async Task ProjectScope_ExcludesArchivedCardsAndCoversWholeProject()
    {
        var (projectId, _, _, _, erinId, daveId) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var report = await GetWorkLogAsync($"/api/projects/{projectId}/worklog");

        var members = report.GetProperty("members").EnumerateArray().ToList();
        Assert.Equal(5m, members.Single(m => m.GetProperty("userId").GetString() == erinId.ToString()).GetProperty("totalHours").GetDecimal());
        Assert.Equal(4m, members.Single(m => m.GetProperty("userId").GetString() == daveId.ToString()).GetProperty("totalHours").GetDecimal());
        // admin 的 5h 在封存卡上 → 被排除；但建立者自動成為專案成員（ProjectEndpoints.cs:85），
        // 因此會被補齊為零工時成員。erin/dave 不是 ProjectMember，是靠工時紀錄納入。
        var zeroHourMembers = members.Where(m => m.GetProperty("totalHours").GetDecimal() == 0m).ToList();
        Assert.Single(zeroHourMembers);
        Assert.Empty(zeroHourMembers[0].GetProperty("days").EnumerateArray());
        Assert.Equal(9m, report.GetProperty("summary").GetProperty("totalHours").GetDecimal());
        Assert.Equal(2, report.GetProperty("summary").GetProperty("cardCount").GetInt32());
    }

    [Fact]
    public async Task TeamScope_IncludesAllProjectsOfTeam()
    {
        var (projectId, teamId, _, _, erinId, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");

        // 「團隊範疇」的定義性條件：同團隊的第二個專案要納入、他隊專案要排除。
        // 兩者皆於本測試自建，不動共用 fixture 的算式，以免波及本檔其他依賴既有數字的斷言。
        _client.DefaultRequestHeaders.Remove("X-Team-Id");
        var (secondProjectId, secondCardId) = await CreateProjectWithCardAsync(teamId, "日誌專案二");
        var otherTeamId = (await (await _client.PostAsync("/api/teams",
            JsonContent.Create(new { name = $"他隊{Guid.NewGuid():N}" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var (otherProjectId, otherCardId) = await CreateProjectWithCardAsync(otherTeamId, "他隊專案");
        _client.DefaultRequestHeaders.Add("X-Team-Id", teamId);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            db.EffortLogs.AddRange(
                new EffortLog { CardId = Guid.Parse(secondCardId), UserId = erinId, Hours = 2m,
                    LoggedAt = new DateTime(2026, 9, 10, 2, 0, 0, DateTimeKind.Utc),
                    LocalDate = new DateOnly(2026, 9, 10), LoggedAtLocal = new DateTime(2026, 9, 10, 10, 0, 0) },
                new EffortLog { CardId = Guid.Parse(otherCardId), UserId = erinId, Hours = 7m,
                    LoggedAt = new DateTime(2026, 9, 10, 3, 0, 0, DateTimeKind.Utc),
                    LocalDate = new DateOnly(2026, 9, 10), LoggedAtLocal = new DateTime(2026, 9, 10, 11, 0, 0) });
            await db.SaveChangesAsync();
        }

        var report = await GetWorkLogAsync($"/api/teams/{teamId}/worklog");

        var members = report.GetProperty("members").EnumerateArray().ToList();
        Assert.Contains(members, m => m.GetProperty("userId").GetString() == erinId.ToString());
        // 9h（fixture 專案）＋ 2h（同團隊第二個專案）＝ 11h；他隊專案的 7h 不得計入
        Assert.Equal(11m, report.GetProperty("summary").GetProperty("totalHours").GetDecimal());

        var erin = members.Single(m => m.GetProperty("userId").GetString() == erinId.ToString());
        var erinProjects = erin.GetProperty("projects").EnumerateArray().ToList();
        // (a) 同團隊的兩個專案都滾入
        Assert.Equal(7m, erin.GetProperty("totalHours").GetDecimal());
        Assert.Contains(erinProjects, p => p.GetProperty("projectId").GetString() == projectId);
        Assert.Contains(erinProjects, p => p.GetProperty("projectId").GetString() == secondProjectId);
        // (b) 他隊專案不得出現（若範圍條件誤以專案 id 比對團隊 id，此處會整批落空或反向納入）
        Assert.DoesNotContain(members.SelectMany(m => m.GetProperty("projects").EnumerateArray()),
            p => p.GetProperty("projectId").GetString() == otherProjectId);
    }

    [Fact]
    public async Task ProjectScope_ProjectBreakdownIsPerMember()
    {
        var (projectId, _, _, _, erinId, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var report = await GetWorkLogAsync($"/api/projects/{projectId}/worklog");
        var erin = report.GetProperty("members").EnumerateArray()
            .Single(m => m.GetProperty("userId").GetString() == erinId.ToString());
        var slice = erin.GetProperty("projects").EnumerateArray().Single();
        Assert.Equal("日誌專案", slice.GetProperty("projectName").GetString());
        Assert.Equal(5m, slice.GetProperty("hours").GetDecimal());
        Assert.Equal(2, slice.GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task CompletedCards_CountsOnlyCompletionsInsideWindow()
    {
        var (projectId, _, _, _, erinId, daveId) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var report = await GetWorkLogAsync($"/api/projects/{projectId}/worklog");

        var members = report.GetProperty("members").EnumerateArray().ToList();
        // card1 於窗內完成且 erin/dave 都有對它記工時 → 各 1 張；
        // card2 於窗外完成 → 不計，即使 erin 對它有工時。
        // 註：CompletedCards 的窗界是 **UTC 日界**（`Card.CompletedAt` 是瞬時、沒有本地日可凍結；
        // 實作端在原地留了「已知近似」的註解）。這裡兩個瞬時都離界線很遠 ⇒ 這一支對
        // 「UTC 日界 vs 本地日界」是全盲的，不構成那一格的判別力（那一格沒有測試看著，誠實記在報告）。
        Assert.Equal(1, members.Single(m => m.GetProperty("userId").GetString() == erinId.ToString())
            .GetProperty("completedCards").GetInt32());
        Assert.Equal(1, members.Single(m => m.GetProperty("userId").GetString() == daveId.ToString())
            .GetProperty("completedCards").GetInt32());
    }

    [Fact]
    public async Task FromNotBeforeTo_Returns400()
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var resp = await _client.GetAsync(
            $"/api/projects/{projectId}/worklog?from={Day(ToExclusive)}&to={Day(From)}");
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(resp));
    }

    /// <summary>`to == from` 同樣是「from 須早於 to」——`to` 是排他界，等於 `from` 的窗是空的。</summary>
    [Fact]
    public async Task ToEqualsFrom_Returns400()
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var resp = await _client.GetAsync(
            $"/api/projects/{projectId}/worklog?from={Day(From)}&to={Day(From)}");
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(resp));
    }

    /// <summary>`from`／`to` 是**必填**的本地日（D5）：缺任何一半 ⇒ 400 `request.invalid`。
    /// 舊制在缺參數時用 viewer 時區算「預設今天」——時區參數拿掉之後那個預設無法誠實定義
    /// ⇒ 三個缺法（只缺 from／只缺 to／兩個都缺）都必須是 400，不是 500、更不是隱性預設。
    /// 訊息是逐字契約（`request.invalid` 是宣告過的粗粒度碼，這一條字面值就是它的定義）。</summary>
    [Theory]
    [InlineData(null, "2026-09-14")]
    [InlineData("2026-09-07", null)]
    [InlineData(null, null)]
    public async Task MissingFromOrTo_Returns400(string? from, string? to)
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var parts = new List<string>();
        if (from is not null) parts.Add($"from={from}");
        if (to is not null) parts.Add($"to={to}");
        var resp = await _client.GetAsync($"/api/projects/{projectId}/worklog?{string.Join("&", parts)}");

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.RequestInvalid, body.GetProperty("code").GetString());
        Assert.Equal("from 與 to 為必填（本地日期 yyyy-MM-dd）", body.GetProperty("message").GetString());
    }

    /// <summary>
    /// **舊契約的輸入格式被收緊後的拒絕路徑**：舊版（&lt; 2026-10-08）的 `from`／`to` 是 ISO 瞬時
    /// （`from=2026-09-06T16:00:00Z`），而這正是**升級期間的舊前端仍在送**的值；新版要求 `yyyy-MM-dd`。
    /// 這一支把那個輸入餵進去，釘住它**不會**被靜默接受（接受＝少一天或整段窗位移，而且是無聲的）。
    /// ★ 實測（2026-10-09，本支第一次執行）：400，body `request.invalid`「請求格式錯誤」——
    /// 這條路徑**不經** `Results.*` 也不是上面那條「必填」的出口，而是模型繫結在 `DateOnly?` 上
    /// 解析失敗丟 `BadHttpRequestException` 後由 `Program.cs` 的全域處理器產出（`:243-254`）。
    /// 舊契約對同一個輸入是 **200**（把它當瞬時、截去時間）⇒ 「換了契約、舊輸入照樣被吃」這種
    /// 沉默位移，在這裡當場紅。
    /// </summary>
    [Theory]
    [InlineData("2026-09-06T16:00:00Z", "2026-09-14")]   // 舊前端的 from；to 用新格式
    [InlineData("2026-09-07", "2026-09-13T16:00:00Z")]   // 舊前端的 to；from 用新格式
    public async Task IsoInstantRange_Returns400(string from, string to)
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var resp = await _client.GetAsync($"/api/projects/{projectId}/worklog?from={from}&to={to}");

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.RequestInvalid, body.GetProperty("code").GetString());
        Assert.Equal("請求格式錯誤", body.GetProperty("message").GetString());
    }

    /// <summary>邊界：`to - from` 恰為 `MaxRangeDays` 天 ⇒ 放行（200）；多 1 天 ⇒ `query.rangeTooLong`。
    /// 少了「恰為上限」那一半，把 `>` 寫成 `>=` 不會有紅燈（兩半合起來才是完整的界線契約）。</summary>
    [Fact]
    public async Task RangeOver366Days_Returns400()
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var from = new DateOnly(2026, 1, 1);

        var atLimit = await _client.GetAsync(
            $"/api/projects/{projectId}/worklog?from={Day(from)}&to={Day(from.AddDays(WorkLogQueries.MaxRangeDays))}");
        Assert.Equal(HttpStatusCode.OK, atLimit.StatusCode);

        var resp = await _client.GetAsync(
            $"/api/projects/{projectId}/worklog?from={Day(from)}&to={Day(from.AddDays(WorkLogQueries.MaxRangeDays + 1))}");
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.QueryRangeTooLong, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task AdminCallingMissingProject_Returns404()
    {
        await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");   // admin claim 直接放行，才會進到 handler
        var resp = await _client.GetAsync(
            $"/api/projects/{Guid.NewGuid()}/worklog?{WindowQuery}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task NonAdminCallingMissingProject_Returns403()
    {
        await SetupAsync();
        await LoginAsync("erin", "Password1!");           // 授權層先擋，永遠到不了 handler 的 404
        var resp = await _client.GetAsync(
            $"/api/projects/{Guid.NewGuid()}/worklog?{WindowQuery}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task ProjectWorkLog_WithoutReportView_Returns403()
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("dave", "Password1!");           // 工程師無 report.view
        var resp = await _client.GetAsync(
            $"/api/projects/{projectId}/worklog?{WindowQuery}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Anonymous_Returns401()
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        _client.DefaultRequestHeaders.Authorization = null;
        var resp = await _client.GetAsync($"/api/projects/{projectId}/worklog");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task TeamWorkLog_WithoutTeamHeader_Returns400()
    {
        var (_, teamId, _, _, _, _) = await SetupAsync();
        await LoginAsync("erin", "Password1!");            // 非 admin 才會走到 header 檢查
        _client.DefaultRequestHeaders.Remove("X-Team-Id");
        var resp = await _client.GetAsync($"/api/teams/{teamId}/worklog?{WindowQuery}");
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // 註：X-Team-Id 與 route teamId 的一致性檢查在 RequirePermissionAttribute 內，
    // 且 admin claim 會完全跳過該檢查。該中介層已由 TeamReportTests／TeamTests 涵蓋，
    // 本檔不重複測試共用授權邏輯。

    // `NoRangeGiven_DefaultsToLocalToday` 已退場：舊制的「預設今天」由 viewer 時區算出，
    // 時區參數拿掉之後那個預設無法誠實定義 ⇒ 缺參數一律 400（`MissingFromOrTo_Returns400`）。

    [Fact]
    public async Task Export_ReturnsSpreadsheetMl()
    {
        await SetupAsync();
        await LoginAsync("erin", "Password1!");
        var resp = await _client.GetAsync($"/api/me/worklog/export?{WindowQuery}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal("application/vnd.ms-excel", resp.Content.Headers.ContentType!.MediaType);
        var text = System.Text.Encoding.UTF8.GetString(await resp.Content.ReadAsByteArrayAsync());
        Assert.Contains("mso-application", text);
        Assert.Contains("評估A系統需求", text);
        Assert.Contains("明細", text);
        Assert.Contains("彙總", text);

        // spec §8 唯一驗收條件是「匯出檔可以用 Excel 開啟」——任何破壞 XML 的畸形輸出、
        // 欄位順序錯置或工作表數量錯誤都必須在此擋下，故實際解析整份文件而非只比對子字串。
        var doc = XDocument.Parse(text);   // 格式錯誤即丟 XmlException → 測試失敗
        XNamespace ns = "urn:schemas-microsoft-com:office:spreadsheet";
        var sheets = doc.Descendants(ns + "Worksheet").ToList();
        Assert.Equal(2, sheets.Count);
        Assert.Equal(new[] { "明細", "彙總" }, sheets.Select(s => s.Attribute(ns + "Name")!.Value).ToList());

        // 明細表頭 10 欄：順序即欄位語意，錯置會讓 Excel 的欄位對應全盤位移
        var detailHeader = sheets[0].Descendants(ns + "Row").First()
            .Elements(ns + "Cell").Select(c => c.Element(ns + "Data")!.Value).ToList();
        Assert.Equal(new[] { "日期", "成員", "團隊", "專案", "看板", "列表", "卡片", "時數", "備註", "回報時間" }, detailHeader);

        // 「回報時間」欄是**凍結的牆鐘**逐字（`LoggedAtLocal`，不再用 viewer 時區換算）：
        // 最後一欄 yyyy-MM-dd HH:mm。erin 的兩筆是 09-09 10:00 與 09-12 11:00。
        var loggedAtCells = sheets[0].Descendants(ns + "Row").Skip(1)
            .Select(r => r.Elements(ns + "Cell").Last().Element(ns + "Data")!.Value).ToList();
        Assert.Contains("2026-09-09 10:00", loggedAtCells);
        Assert.Contains("2026-09-12 11:00", loggedAtCells);
        // 逐字相等（不是「包含」）：少了它，`+tz` 這類殘留換算只要仍落在同一分鐘就不會被發現。
        Assert.All(loggedAtCells, cell => Assert.Matches(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", cell));

        // erin（SetupAsync 的 fixture）有一筆備註含 U+0001。此處正面表達「控制字元被濾除、其餘內容保留」；
        // 上方的 Parse 則是機制面的釘子——E() 的過濾一旦拿掉，U+0001 進入 XML 使 Parse 丟 XmlException。
        Assert.Contains("含控制字元備註", text);

        // dave 的跨界樣本（瞬時 09-09T23:30Z、凍結牆鐘 09-10 07:30）在**專案**範疇的匯出裡：
        // erin 看不到他（me 範疇），而這一格是「牆鐘是資料、不是推導」最強的釘子——以瞬時＋
        // offset 反推的實作必須**同時**猜中 erin 的兩格與 dave 的這一格（09-09／09-12／09-10
        // 三個不同的凍結值），沒有單一 offset 做得到。
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("admin-test", "TestPass123!");
        var projectExport = await _client.GetAsync($"/api/projects/{projectId}/worklog/export?{WindowQuery}");
        Assert.Equal(HttpStatusCode.OK, projectExport.StatusCode);
        var projectDoc = XDocument.Parse(System.Text.Encoding.UTF8.GetString(await projectExport.Content.ReadAsByteArrayAsync()));
        var daveLoggedAtCells = projectDoc.Descendants(ns + "Worksheet")
            .Single(w => (string?)w.Attribute(ns + "Name") == "明細")
            .Descendants(ns + "Row").Skip(1)
            .Where(r => r.Elements(ns + "Cell").ElementAt(1).Element(ns + "Data")!.Value == "戴夫")
            .Select(r => r.Elements(ns + "Cell").Last().Element(ns + "Data")!.Value).ToList();
        Assert.Equal(new[] { "2026-09-10 07:30" }, daveLoggedAtCells);
    }

    // 非西曆主機文化（泰曆）下，DateOnly.ToString 的年份會變佛曆年（2026 → 2569）。
    // ComposeAsync 的日分組 date 欄與 workdays 清單、ExportAsync 的檔名插值都必須走 InvariantCulture。
    // 泰曆一律「顯式」指定，不依賴 th-TH 的預設曆——後者隨 ICU 版本而異，不 deterministic。
    [Fact]
    public async Task NonGregorianHostCulture_StillEmitsGregorianDates()
    {
        await SetupAsync();
        await LoginAsync("erin", "Password1!");

        var original = CultureInfo.CurrentCulture;
        var originalDefault = CultureInfo.DefaultThreadCurrentCulture;
        // 基準必須是一般文化：InvariantCulture.Clone() 的 DateTimeFormat 會拒收非 GregorianCalendar
        // （ArgumentOutOfRangeException「Not a valid calendar for the given culture」）。
        // 取 th-TH 後「顯式」掛上泰曆——不依賴 th-TH 的預設曆（後者隨 ICU 版本而異）。
        var thai = (CultureInfo)CultureInfo.GetCultureInfo("th-TH").Clone();
        thai.DateTimeFormat.Calendar = new ThaiBuddhistCalendar();
        CultureInfo.CurrentCulture = thai;
        // TestServer 的請求處理不繼承呼叫端的 ExecutionContext（AsyncLocal 不流動），單設 CurrentCulture
        // 進不了 handler，釘子會假綠。行程級覆寫於此安全：本組件已全域關閉測試平行化（AssemblyInfo.cs）。
        CultureInfo.DefaultThreadCurrentCulture = thai;
        try
        {
            var report = await GetWorkLogAsync("/api/me/worklog");
            var days = report.GetProperty("members")[0].GetProperty("days").EnumerateArray().ToList();
            Assert.Equal("2026-09-09", days[0].GetProperty("date").GetString());
            Assert.Equal("2026-09-12", days[1].GetProperty("date").GetString());

            var workdays = report.GetProperty("workdays").EnumerateArray().Select(x => x.GetString()).ToList();
            Assert.Equal(5, workdays.Count);
            Assert.Contains("2026-09-09", workdays);

            // 檔名插值同樣吃 CurrentCulture：少了 InvariantCulture 會是 worklog-me-25690907.xls
            // （`from` 是 DateOnly 2026-09-07 ⇒ 檔名日期直接就是它，不再經過任何 offset）。
            var export = await _client.GetAsync($"/api/me/worklog/export?{WindowQuery}");
            Assert.Equal(HttpStatusCode.OK, export.StatusCode);
            Assert.Contains("worklog-me-20260907.xls", export.Content.Headers.ContentDisposition!.FileName);
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
            CultureInfo.DefaultThreadCurrentCulture = originalDefault;
        }
    }

    [Fact]
    public async Task Export_ProjectScope_RequiresReportView()
    {
        var (projectId, _, _, _, _, _) = await SetupAsync();
        await LoginAsync("dave", "Password1!");
        var resp = await _client.GetAsync($"/api/projects/{projectId}/worklog/export?{WindowQuery}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    /// <summary>
    /// **跨 DST 的同一天**（Santiago 2026-09-06 的春季切換：00:00 直接跳到 01:00，UTC−4 → −3）。
    /// 兩筆瞬時相隔 1 小時（02:50Z／03:50Z，都在切換前 04:00Z 之前 ⇒ 當下的 offset 都是 −4），
    /// 凍結日同為 09-05（六）——必須落在**同一個桶**。
    /// 判別力的來源是「瞬時＋單一 offset」的推導不是穩定函式：拿切換後才會觀測到的 −3 反推，
    /// 這兩筆會落在 09-05 23:50 與 09-06 00:50 ⇒ **兩桶**；UTC 日反推（兩筆都在 09-06）也是
    /// 另一桶。凍結日不分歧 ⇒ 兩筆只可能同桶。
    /// 同一個窗裡再加入一筆**補登**樣本（凍結工作日 09-03、填報牆鐘 09-05 23:55）：`LocalDate`
    /// 與「牆鐘的日期」分岔，是 T2／D1 補登語意的讀取端釘子——少了它，改寫成
    /// `GroupBy(DateOnly.FromDateTime(r.LoggedAtLocal))`（另一種「從時間欄反推」）在整個檔案裡
    /// 沒有任何紅燈。窗刻意收在 09-01～09-06（排他）：把 SetupAsync 的 dave 紀錄（凍結日 09-10）
    /// 排除在窗外，桶數與時數才只有這一組。
    /// </summary>
    [Fact]
    public async Task DstSwitchDay_TwoInstantsOneHourApart_ShareOneFrozenDayBucket()
    {
        var (_, _, card1Id, _, _, daveId) = await SetupAsync();

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            db.EffortLogs.AddRange(
                // 補登：工作日 09-03，填報當下是 09-05 23:55（瞬時 03:55Z，切換前 ⇒ 仍是 −4）。
                new EffortLog { CardId = Guid.Parse(card1Id), UserId = daveId, Hours = 1.5m,
                    LoggedAt = new DateTime(2026, 9, 6, 3, 55, 0, DateTimeKind.Utc),
                    LocalDate = new DateOnly(2026, 9, 3), LoggedAtLocal = new DateTime(2026, 9, 5, 23, 55, 0) },
                new EffortLog { CardId = Guid.Parse(card1Id), UserId = daveId, Hours = 1m,
                    LoggedAt = new DateTime(2026, 9, 6, 2, 50, 0, DateTimeKind.Utc),
                    LocalDate = new DateOnly(2026, 9, 5), LoggedAtLocal = new DateTime(2026, 9, 5, 22, 50, 0) },
                new EffortLog { CardId = Guid.Parse(card1Id), UserId = daveId, Hours = 2m,
                    LoggedAt = new DateTime(2026, 9, 6, 3, 50, 0, DateTimeKind.Utc),
                    LocalDate = new DateOnly(2026, 9, 5), LoggedAtLocal = new DateTime(2026, 9, 5, 23, 50, 0) });
            await db.SaveChangesAsync();
        }

        await LoginAsync("dave", "Password1!");
        var report = await (await _client.GetAsync("/api/me/worklog?from=2026-09-01&to=2026-09-06"))
            .Content.ReadFromJsonAsync<JsonElement>();

        var days = report.GetProperty("members")[0].GetProperty("days").EnumerateArray().ToList();
        Assert.Equal(2, days.Count);   // 桶數由凍結日決定：09-03 與 09-05

        // 補登那一桶的鍵是**工作日** 09-03，不是牆鐘的 09-05（牆鐘日期分桶的實作會讓它消失）。
        Assert.Equal("2026-09-03", days[0].GetProperty("date").GetString());
        Assert.Equal(1, days[0].GetProperty("entryCount").GetInt32());
        Assert.Equal("2026-09-05T23:55:00",
            days[0].GetProperty("entries")[0].GetProperty("loggedAtLocal").GetString());

        // DST 那兩筆同在 09-05：拆成兩桶（09-05／09-06）或以 UTC 日分桶的實作在這裡就紅。
        Assert.Equal("2026-09-05", days[1].GetProperty("date").GetString());
        Assert.Equal(2, days[1].GetProperty("entryCount").GetInt32());
        Assert.Equal(3m, days[1].GetProperty("totalHours").GetDecimal());
        // 桶內次序沿 `ThenBy(LoggedAt)`（瞬時升冪，兩筆相差一小時）＝牆鐘升冪。
        var entries = days[1].GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal(new[] { "2026-09-05T22:50:00", "2026-09-05T23:50:00" },
            entries.Select(e => e.GetProperty("loggedAtLocal").GetString()).ToList());
    }
}
