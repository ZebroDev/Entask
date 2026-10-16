using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

// 活動牆的分頁契約（state/45）。
//
// ★ 為什麼種資料要**直接走 DbContext**、不經端點：`ActivityItem.CreatedAt` 的預設是
//   `DateTime.UtcNow`（`src/Entask.Core/Entities/ActivityItem.cs:12`），寫入端一律吃那個預設
//   ⇒ 造不出「同一時間戳有多列」這個形狀，而那正是本檔要驗的東西（排序的第二個鍵、
//   以及 cursor 的 `Id` 那一半）。走真實端點更不可能控制時間戳。
//
// ★ 建卡本身會寫下一列 `create` 活動（`ActivityCommentTests.Comments_PostListEditOwnOnly_Works`
//   逐字斷言過）⇒ **每一支的期望列數都要把那一列算進去**，否則「恰一頁」之類的邊界會差一。
public class ActivityPaginationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ActivityPaginationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    /// <summary>建一條 Team→Project→Board→List，回傳 list id。</summary>
    private async Task<string> CreateListAsync()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "活動分頁團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", token);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "活動分頁專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "活動分頁板" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "列表" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        return listId;
    }

    /// <summary>在既有列表上建一張卡，回傳卡 id（建卡會自帶一列 `create` 活動）。</summary>
    private async Task<string> CreateCardAsync(string listId)
    {
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "活動分頁卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return card.GetProperty("id").GetString()!;
    }

    /// <summary>直接以 DbContext 種 <paramref name="count"/> 列活動，全部共用 <paramref name="createdAt"/>。</summary>
    private async Task SeedActivityAsync(string cardId, int count, DateTime createdAt, string type = "probe.seeded")
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.ActivityItems.AddRange(Enumerable.Range(0, count).Select(_ => new ActivityItem
        {
            Id = Guid.NewGuid(),
            CardId = Guid.Parse(cardId),
            // UserId 沒有 FK 到 Users（實查：AddBoardCore 只有 FK_ActivityItems_Cards_CardId）
            // ⇒ 隨機值安全；回應裡的 username／displayName 會是空字串，本檔不斷言那兩欄。
            UserId = Guid.NewGuid(),
            Type = type,
            Text = null,
            Detail = null,
            CreatedAt = createdAt,
        }));
        await db.SaveChangesAsync();
    }

    private static string? NextCursor(JsonElement page) =>
        page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null
            ? null
            : page.GetProperty("nextCursor").GetString();

    private async Task<JsonElement> GetPageAsync(string cardId, string query, string? cursor)
    {
        var url = $"/api/cards/{cardId}/activity?{query}";
        if (cursor is not null) url += $"&cursor={Uri.EscapeDataString(cursor)}";
        var res = await _client.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>翻到最後一頁，回傳所有列。有圈數上限——壞掉的 cursor 若原地打轉，這裡要大聲紅。</summary>
    private async Task<List<JsonElement>> WalkAsync(string cardId, string query)
    {
        var all = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 10; guard++)
        {
            var page = await GetPageAsync(cardId, query, cursor);
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
        var cardId = await CreateCardAsync(await CreateListAsync());
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        // 45 列共用同一個 CreatedAt（＋建卡那列 create，共 46）⇒ 排序**完全**由 `Id` 決定
        // ⇒ cursor 的 `Id` 那一半是承重的（拿掉它這一支必紅，見 Task 3 Step 7 的 M1）。
        await SeedActivityAsync(cardId, 45, stamp);
        // 再加 10 列**更舊**的（另一個時間戳）：述詞的兩半各有一顆突變能讓這一支變紅
        // （只留 `CreatedAt <` ⇒ 同戳的 26 列被跳過；只留 `==` 那一半 ⇒ 這 10 列被跳過）。
        // 少了這 10 列，「只留 ==」那顆突變**行為零變化**（等於無效突變，不是判別力不足）。
        await SeedActivityAsync(cardId, 10, stamp.AddHours(-1));

        var rows = await WalkAsync(cardId, "");

        var ids = rows.Select(r => r.GetProperty("id").GetString()!).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());                                     // 無重複
        Assert.Equal(55, rows.Count(r => r.GetProperty("type").GetString() == "probe.seeded")); // 無遺漏（45 ＋ 10）
    }

    [Fact]
    public async Task CursorFromAnotherCard_CannotWidenTheScope()
    {
        // cursor 只是排序鍵，不是範圍。跨卡的鍵必須讓結果仍是**自己這張卡**的列。
        var listId = await CreateListAsync();
        var cardA = await CreateCardAsync(listId);
        var cardB = await CreateCardAsync(listId);

        // A 要**超過一頁**才會有 cursor（25 列 ＋ 建卡那列 create = 26）。
        // 兩張卡的時間戳刻意分開：B 的全部比 A 的鍵更舊 ⇒ 範圍一旦被 cursor 繞過，
        // A 的同戳其餘列就會一起回來（見下方斷言的判別力說明）。
        var aTime = new DateTime(2026, 3, 1, 0, 0, 0, DateTimeKind.Utc);
        var bTime = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        await SeedActivityAsync(cardA, 25, aTime);
        await SeedActivityAsync(cardB, 3, bTime);

        var pageA = await GetPageAsync(cardA, "", null);
        var cursorFromA = NextCursor(pageA);
        Assert.NotNull(cursorFromA);

        // 回來的每一列都必須是 B 卡的（回應帶 `cardId` ⇒ 用直接證據，不用列數代理）。
        // 判別力：拿掉述詞裡的 `a.CardId == cardId` ⇒ A 同戳其餘的 6 列一起回來 ⇒ 兩條都紅。
        var page = await GetPageAsync(cardB, "", cursorFromA);
        var items = page.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(3, items.Count);
        Assert.All(items, i => Assert.Equal(cardB, i.GetProperty("cardId").GetString()));
    }

    [Fact]
    public async Task CursorWithCommentsOnlyFilter_DoesNotLeakOtherTypes()
    {
        var cardId = await CreateCardAsync(await CreateListAsync());
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        // 50 列共用同一個時間戳、兩種型別 ⇒ 篩選與 cursor 必須**同時**生效。
        // （建卡那列 create 不是留言，被 filter 排除。）
        await SeedActivityAsync(cardId, 25, stamp, type: "comment");
        await SeedActivityAsync(cardId, 25, stamp, type: "probe.seeded");

        var rows = await WalkAsync(cardId, "filter=comments_only");

        Assert.Equal(25, rows.Count);
        Assert.All(rows, r => Assert.Equal("comment", r.GetProperty("type").GetString()));
    }

    [Fact]
    public async Task ExactlyOnePage_NextCursorIsNull()
    {
        var cardId = await CreateCardAsync(await CreateListAsync());
        // 建卡自帶一列 create ⇒ 這裡種 19 列，總數剛好 20（＝預設 take）。
        await SeedActivityAsync(cardId, 19, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var page = await GetPageAsync(cardId, "", null);

        Assert.Equal(20, page.GetProperty("items").GetArrayLength());
        Assert.Null(NextCursor(page));
    }

    [Fact]
    public async Task OnePastOnePage_SecondPageHasExactlyOneRow()
    {
        var cardId = await CreateCardAsync(await CreateListAsync());
        await SeedActivityAsync(cardId, 20, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var first = await GetPageAsync(cardId, "", null);
        Assert.Equal(20, first.GetProperty("items").GetArrayLength());
        var cursor = NextCursor(first);
        Assert.NotNull(cursor);

        var second = await GetPageAsync(cardId, "", cursor);

        Assert.Equal(1, second.GetProperty("items").GetArrayLength());
        Assert.Null(NextCursor(second));
        // 兩頁不得有交集（重複的列是分頁最常見的失效形狀）
        var firstIds = first.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("id").GetString()).ToHashSet();
        Assert.DoesNotContain(second.GetProperty("items").EnumerateArray(),
            i => firstIds.Contains(i.GetProperty("id").GetString()));
    }

    [Fact]
    public async Task Limit_IsStillCappedAt100()
    {
        var cardId = await CreateCardAsync(await CreateListAsync());
        await SeedActivityAsync(cardId, 150, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var page = await GetPageAsync(cardId, "limit=1000", null);

        // 既有行為（`ActivityEndpoints.cs:25` 的 `Math.Min(limit, 100)`）在此之前沒有測試盯著。
        Assert.Equal(100, page.GetProperty("items").GetArrayLength());
        Assert.NotNull(NextCursor(page));
    }

    [Fact]
    public async Task RemovedBeforeParameter_IsIgnored_ReturnsFirstPage()
    {
        var cardId = await CreateCardAsync(await CreateListAsync());
        var stamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        await SeedActivityAsync(cardId, 25, stamp);

        // 舊呼叫端帶 `before=<時間戳>`：參數不在簽章上 ⇒ 框架忽略 ⇒ **第一頁**（20 列）。
        // 不是 400（那不是「壞 token」的意思）、也不是套用舊述詞之後的殘頁（那會是 0 列）。
        // 這一條是 D2 的量測（設計 §4.1 標的是「推論（未實測）」）。
        var res = await _client.GetAsync(
            $"/api/cards/{cardId}/activity?before={Uri.EscapeDataString(stamp.ToString("O"))}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var page = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(20, page.GetProperty("items").GetArrayLength());
        Assert.NotNull(NextCursor(page));
    }

    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("2026-01-01T00:00:00.0000000Z")]                                     // 只有一段
    [InlineData("2026-01-01T00:00:00.0000000Z|not-a-guid")]                          // guid 不合法
    [InlineData("2026-01-01T00:00:00.0000000|3f2a1b4c-0000-0000-0000-000000000000")] // 沒有 Z
    public async Task MalformedCursor_Returns400(string cursor)
    {
        var cardId = await CreateCardAsync(await CreateListAsync());

        var res = await _client.GetAsync(
            $"/api/cards/{cardId}/activity?cursor={Uri.EscapeDataString(cursor)}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        // 空 body 400：與稽核端點、以及同一條路由上 `?limit=abc` 的框架綁定失敗同構（設計 §4.1）。
        Assert.Empty(await res.Content.ReadAsByteArrayAsync());
    }

    /// <summary>
    /// `ActivityItem` 的索引**恰為** `(CardId, CreatedAt, Id)`。
    ///
    /// ★ 這支測的是**模型宣告**、不是資料庫實況——索引真的進 DB 靠的是 migration
    ///   （`Program.cs:253` 的 `MigrateAsync`），而 CI **沒有任何 EF 閘門**
    ///   （實查：`.github/workflows/` 與 `tools/` 對 `dotnet ef` 零命中）。
    ///   別把這一支讀成「索引一定存在」。
    ///
    /// 為什麼是「恰為」而不是「存在一條」：活動是寫入很熱的表，索引是每個 insert 都要付的
    /// 成本 ⇒ 多一條就該有人來說明（取代不並存＝設計 D4）。`Assert.Single` 讓那個決定當場被看見。
    /// </summary>
    [Fact]
    public void ActivityItem_HasExactlyThePaginationIndex()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        var entity = db.Model.FindEntityType(typeof(ActivityItem));
        Assert.NotNull(entity);

        var index = Assert.Single(entity!.GetIndexes());
        Assert.Equal(
            new[] { nameof(ActivityItem.CardId), nameof(ActivityItem.CreatedAt), nameof(ActivityItem.Id) },
            index.Properties.Select(p => p.Name).ToArray());
    }
}
