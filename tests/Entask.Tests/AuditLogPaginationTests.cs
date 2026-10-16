using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

// 稽核讀取面的分頁契約（state/41）。
//
// ★ 為什麼種資料要**直接走 DbContext**、不經 IAuditService：`AuditService.AddAsync` 的
//   `CreatedAt` 是 `DateTime.UtcNow`（`src/Entask.Infrastructure/Audit/AuditService.cs:25`）
//   ⇒ 造不出「同一時間戳有多列」這個形狀，而那正是本檔要驗的東西（排序的第二個鍵、
//   以及 cursor 的 `Id` 那一半）。走真實端點更不可能控制時間戳。
//   ⇒ 這是**唯一**能造出該形狀的辦法，不是偷懶。
//
// ★ 量測（2026-10-11，不是推導）：`?cursor=`（空的）被框架綁成**空字串**、不是 null
//   ⇒ `TryParse` 回 false ⇒ **400**（探針實測 status=400、body 長度 0）。所以空字串
//   收在 `MalformedCursor_Returns400` 的 `[InlineData("")]` 裡；它與「不帶 cursor」
//   **在框架綁定上可區分**（後者是 null ⇒ 200 第一頁）。
public class AuditLogPaginationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AuditLogPaginationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    /// <summary>造一個團隊（走真實端點，順帶寫下一列 `team.created`），回傳它的 id。</summary>
    private async Task<string> CreateTeamAsync(string name)
    {
        _client.DefaultRequestHeaders.Authorization =
            new("Bearer", await TestAuth.GetAdminTokenAsync(_factory, _client));
        var json = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name })))
            .Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("id").GetString()!;
    }

    /// <summary>直接以 DbContext 種 <paramref name="count"/> 列稽核，全部共用 <paramref name="createdAt"/>。</summary>
    private async Task SeedLogsAsync(string teamId, int count, DateTime createdAt)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.AuditLogs.AddRange(Enumerable.Range(0, count).Select(_ => new AuditLog
        {
            Id = Guid.NewGuid(),
            UserId = null,
            TeamId = Guid.Parse(teamId),
            Action = "test.seeded",
            EntityType = "test",
            EntityId = Guid.NewGuid(),
            EntityTitle = null,
            Detail = null,
            CreatedAt = createdAt,
        }));
        await db.SaveChangesAsync();
    }

    private static string? NextCursor(JsonElement page) =>
        page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null
            ? null
            : page.GetProperty("nextCursor").GetString();

    private async Task<JsonElement> GetPageAsync(string url, string teamId, string? cursor)
    {
        var full = cursor is null ? url : $"{url}&cursor={Uri.EscapeDataString(cursor)}";
        using var req = new HttpRequestMessage(HttpMethod.Get, full);
        req.Headers.Add("X-Team-Id", teamId);
        var res = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>翻到最後一頁，回傳所有列。有圈數上限——壞掉的 cursor 若原地打轉，這裡要大聲紅。</summary>
    private async Task<List<JsonElement>> WalkAsync(string url, string teamId)
    {
        var all = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 10; guard++)
        {
            var page = await GetPageAsync(url, teamId, cursor);
            all.AddRange(page.GetProperty("items").EnumerateArray());
            cursor = NextCursor(page);
            if (cursor is null) return all;
        }
        Assert.Fail("翻頁超過 10 次還沒到底——cursor 沒有前進（可能原地打轉）");
        return all;
    }

    [Fact]
    public async Task SameTimestampAcrossPageBoundary_NoRowIsSkippedOrDuplicated()
    {
        var teamId = await CreateTeamAsync("分頁同戳部");

        // 205 列、全部共用同一個 CreatedAt ⇒ 排序**完全**由 `Id` 決定
        // ⇒ cursor 的 `Id` 那一半是承重的（拿掉它這一支必紅，見 Task 2 的 M1）。
        await SeedLogsAsync(teamId, 205, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var rows = await WalkAsync($"/api/audit-logs?teamId={teamId}", teamId);

        var ids = rows.Select(r => r.GetProperty("id").GetString()!).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());                                   // 無重複
        Assert.Equal(205, rows.Count(r => r.GetProperty("action").GetString() == "test.seeded")); // 無遺漏
    }

    [Fact]
    public async Task CursorFromAnotherTeam_CannotWidenTheScope()
    {
        // cursor 只是排序鍵，不是範圍。跨團隊的鍵必須讓結果仍是**自己團隊**的列。
        var teamA = await CreateTeamAsync("分頁範圍部 A");
        var teamB = await CreateTeamAsync("分頁範圍部 B");

        // A 要**超過一頁**才會有 cursor（151 列 + 端點自己寫的 1 列 team.created = 152）。
        // 兩隊的時間戳刻意分開：B 的全部比 A 的鍵更舊 ⇒ 範圍一旦被 cursor 繞過，
        // A 的同戳其餘列就會跟著回來（見下方斷言的判別力說明）。
        var aTime = new DateTime(2026, 3, 1, 0, 0, 0, DateTimeKind.Utc);
        var bTime = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        await SeedLogsAsync(teamA, 151, aTime);
        await SeedLogsAsync(teamB, 3, bTime);

        // A 團隊第一頁拿到 100 列，取它的 cursor，拿去問 B 團隊
        var pageA = await GetPageAsync($"/api/audit-logs?teamId={teamA}", teamA, null);
        var cursorFromA = NextCursor(pageA);
        Assert.NotNull(cursorFromA);

        using var req = new HttpRequestMessage(HttpMethod.Get,
            $"/api/audit-logs?teamId={teamB}&cursor={Uri.EscapeDataString(cursorFromA!)}");
        req.Headers.Add("X-Team-Id", teamB);
        var res = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var page = await res.Content.ReadFromJsonAsync<JsonElement>();

        // 回來的每一列都必須是 B 團隊的。回應裡沒有 teamId 欄位
        // （AuditLogDto 刻意不對外揭露 TeamId）⇒ 用 B 自己那個專屬的時間戳當**直接**證據，
        // 不用「列數不超過 3」那種代理斷言——代理斷言在「回空集合」時也會綠。
        // 判別力：拿掉 `Where(l => l.TeamId == teamId)` ⇒ A 同戳其餘的列一起回來
        // ⇒ 兩條斷言都紅（實測數量 56 ≠ 3，且 createdAt 不是 bTime）。
        var items = page.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(3, items.Count);
        Assert.All(items, l => Assert.Equal(bTime, l.GetProperty("createdAt").GetDateTime()));
    }

    [Fact]
    public async Task ExactlyOnePage_NextCursorIsNull()
    {
        var teamId = await CreateTeamAsync("分頁邊界部 A");
        // `CreateTeamAsync` 自己會寫下一列 `team.created`（見
        // `AuditLogTests.TeamCreation_WritesAuditLog`）⇒ 這裡種 99 列，總數剛好 100。
        await SeedLogsAsync(teamId, 99, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var page = await GetPageAsync($"/api/audit-logs?teamId={teamId}", teamId, null);

        Assert.Equal(100, page.GetProperty("items").GetArrayLength());
        Assert.Null(NextCursor(page));
    }

    [Fact]
    public async Task OnePastOnePage_SecondPageHasExactlyOneRow()
    {
        var teamId = await CreateTeamAsync("分頁邊界部 B");
        await SeedLogsAsync(teamId, 100, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var first = await GetPageAsync($"/api/audit-logs?teamId={teamId}", teamId, null);
        Assert.Equal(100, first.GetProperty("items").GetArrayLength());
        var cursor = NextCursor(first);
        Assert.NotNull(cursor);

        var second = await GetPageAsync($"/api/audit-logs?teamId={teamId}", teamId, cursor);

        Assert.Equal(1, second.GetProperty("items").GetArrayLength());
        Assert.Null(NextCursor(second));
        // 兩頁不得有交集（重複的列是分頁最常見的失效形狀）
        var firstIds = first.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("id").GetString()).ToHashSet();
        Assert.DoesNotContain(second.GetProperty("items").EnumerateArray(),
            i => firstIds.Contains(i.GetProperty("id").GetString()));

        // 頁面大小 + 1 的探測：第 101 列只為了回答「還有沒有」，不得出現在任何一頁的 items 裡。
        // 上面兩頁的列數（100 ＋ 1）已經把它排除在外；這裡再正面釘住「每頁都不超過 100」。
        Assert.True(first.GetProperty("items").GetArrayLength() <= 100);
        Assert.True(second.GetProperty("items").GetArrayLength() <= 100);
    }

    /// <summary>
    /// `AuditLog` 的索引**恰為** `(TeamId, CreatedAt, Id)`。
    ///
    /// ★ 這支測的是**模型宣告**、不是資料庫實況——索引真的進 DB 靠的是 migration
    ///   （`Program.cs:253` 的 `MigrateAsync`），而 CI **沒有任何 EF 閘門**
    ///   （實查：`.github/workflows/` 與 `tools/` 對 `dotnet ef` 零命中）。
    ///   別把這一支讀成「索引一定存在」。
    ///
    /// 為什麼是「恰為」而不是「存在一條」：稽核表是寫入最熱的表，任何索引都是要付代價的
    /// 決定 ⇒ 多一條就該有人來說明。寫成 `Assert.Single` 讓那個決定**當場**被看見。
    /// </summary>
    [Fact]
    public void AuditLog_HasExactlyThePaginationIndex()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        var entity = db.Model.FindEntityType(typeof(AuditLog));
        Assert.NotNull(entity);

        var index = Assert.Single(entity!.GetIndexes());
        Assert.Equal(
            new[] { nameof(AuditLog.TeamId), nameof(AuditLog.CreatedAt), nameof(AuditLog.Id) },
            index.Properties.Select(p => p.Name).ToArray());
    }

    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("2026-01-01T00:00:00.0000000Z")]                                        // 只有一段
    [InlineData("2026-01-01T00:00:00.0000000Z|3f2a1b4c-0000-0000-0000-000000000000|x")] // 三段
    [InlineData("not-a-date|3f2a1b4c-0000-0000-0000-000000000000")]                     // 日期不合法
    [InlineData("2026-01-01T00:00:00.0000000Z|not-a-guid")]                             // guid 不合法
    [InlineData("2026-01-01T00:00:00.0000000|3f2a1b4c-0000-0000-0000-000000000000")]    // 沒有 Z
    [InlineData("2026-01-01T00:00:00.0000000+08:00|3f2a1b4c-0000-0000-0000-000000000000")] // 帶位移
    public async Task MalformedCursor_Returns400(string cursor)
    {
        var teamId = await CreateTeamAsync("分頁壞鍵部");

        using var req = new HttpRequestMessage(HttpMethod.Get,
            $"/api/audit-logs?teamId={teamId}&cursor={Uri.EscapeDataString(cursor)}");
        req.Headers.Add("X-Team-Id", teamId);
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        // 空 body 400：與同一條路由上 `?teamId=<壞值>` 今天的行為同構（設計 §4.1）。
        // 這一條是刻意的——新增一個錯誤碼要動 8 個檔，換來的是一條我們自己的 UI 到不了的路徑。
        Assert.Empty(await res.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task RowsWrittenBetweenPages_DoNotDuplicateOrSkipExistingRows()
    {
        var teamId = await CreateTeamAsync("分頁競態部");
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        await SeedLogsAsync(teamId, 150, stamp);

        var first = await GetPageAsync($"/api/audit-logs?teamId={teamId}", teamId, null);
        var cursor = NextCursor(first);
        Assert.NotNull(cursor);
        var firstIds = first.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("id").GetString()!).ToList();

        // 第二頁出發之前，插一列**比較新**的（CreatedAt > stamp ⇒ 排在更前面）
        await SeedLogsAsync(teamId, 1, stamp.AddHours(1));

        // 從第一頁的 cursor **續走**（不是從頭走——`WalkAsync` 是「從頭到尾」的 helper，
        // 這裡要的是「第 2 頁之後」，兩者不可混用）。圈數上限同 `WalkAsync`：
        // 壞掉的 cursor 若原地打轉，這裡要大聲紅，不是把測試掛住。
        var rest = new List<JsonElement>();
        string? c = cursor;
        for (var guard = 0; guard < 10 && c is not null; guard++)
        {
            var page = await GetPageAsync($"/api/audit-logs?teamId={teamId}", teamId, c);
            rest.AddRange(page.GetProperty("items").EnumerateArray());
            c = NextCursor(page);
        }
        Assert.Null(c);
        var restIds = rest.Select(r => r.GetProperty("id").GetString()!).ToList();

        // cursor 是嚴格遞減 ⇒ 新列（比 stamp 新）**不得**出現在後續任何一頁
        Assert.DoesNotContain(rest, r => r.GetProperty("createdAt").GetDateTime() > stamp);
        // 既有的列不重複（第一頁拿過的不該再出現）
        Assert.Empty(firstIds.Intersect(restIds));
        // 也**不遺漏**：走完的全部頁面加起來必須恰好是全部 151 列
        // （150 列種在同一個時間戳＋建團隊時的 1 列 `team.created`）。
        // 少了這一條，「第二頁少回幾列」的退化在上面兩個斷言下**全部是綠的**
        // （複審 I-2：不重複與「不含新列」都成立，缺的正是完整性）。
        Assert.Equal(151, firstIds.Count + restIds.Count);
    }

    [Fact]
    public async Task SystemEndpoint_SupportsCursorAndRejectsMalformed()
    {
        _client.DefaultRequestHeaders.Authorization =
            new("Bearer", await TestAuth.GetAdminTokenAsync(_factory, _client));

        // 系統範圍（TeamId == null）也種 >100 列、共用同一個時間戳
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            db.AuditLogs.AddRange(Enumerable.Range(0, 105).Select(_ => new AuditLog
            {
                Id = Guid.NewGuid(), UserId = null, TeamId = null,
                Action = "test.system", EntityType = "test", EntityId = Guid.NewGuid(),
                EntityTitle = null, Detail = null, CreatedAt = stamp,
            }));
            await db.SaveChangesAsync();
        }

        var all = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 10; guard++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get,
                cursor is null ? "/api/audit-logs/system"
                               : $"/api/audit-logs/system?cursor={Uri.EscapeDataString(cursor)}");
            var res = await _client.SendAsync(req);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var page = await res.Content.ReadFromJsonAsync<JsonElement>();
            all.AddRange(page.GetProperty("items").EnumerateArray());
            cursor = NextCursor(page);
            if (cursor is null) break;
        }

        var ids = all.Select(r => r.GetProperty("id").GetString()!).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());
        Assert.Equal(105, all.Count(r => r.GetProperty("action").GetString() == "test.system"));

        // 壞 token 在這一條路由上同樣是 400（兩條路由共用 TimestampIdCursor.TryRead，但這要**量**，不是推論）
        using var bad = new HttpRequestMessage(HttpMethod.Get, "/api/audit-logs/system?cursor=garbage");
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.SendAsync(bad)).StatusCode);
    }

}
