using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

/// <summary>
/// `/api/notifications` 的對外契約（設計 §4.3）。
///
/// 三件事一起釘：
/// ① `payload` 是**物件**而不是字串——DB 裡存的是 jsonb 文字，端點要先具體化再解；
/// ② `createdAt` 是 **ISO 8601 UTC**，取代舊的 `time`（無時區標記的 `yyyy-MM-dd HH:mm:ss`，
///    前端直接印出，於是全世界看到同一個 UTC 時鐘）；
/// ③ **舊列**（payload 為 null）仍回散文——Fly 上的既有資料會走到這條路徑。
/// </summary>
[Collection("ApiTests")]
public class NotificationContractTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public NotificationContractTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<Guid> AdminIdAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        // 帳號來自 factory 的 `Seed:AdminUsername`（`admin-test`），不是 appsettings 的 `admin`
        var username = _factory.SeedCredentials().Username;
        return await db.Users.Where(u => u.UserName == username).Select(u => u.Id).FirstAsync();
    }

    private async Task<JsonElement> GetMineAsync()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return await _client.GetFromJsonAsync<JsonElement>("/api/notifications");
    }

    /// <summary>
    /// 清掉 admin 既有的通知。
    ///
    /// **為什麼需要**：`WithDbReset()` 只在 web host 建立時生效一次，而 `IClassFixture` 讓
    /// 整個類別共用同一個 host——先跑過的測試留下的列還在 DB 裡，直接 `.Single()` 會拿到
    /// 兩列以上（`Sequence contains more than one element`）。這是測試基建的性質
    /// （per-class 而非 per-test 重置），不是 REST 契約的一部分。
    /// </summary>
    private static Task ClearMineAsync(EntaskDbContext db, Guid userId) =>
        db.Notifications.Where(n => n.UserId == userId).ExecuteDeleteAsync();

    [Fact]
    public async Task 新列回_kind_與_payload_物件_且沒有_time()
    {
        var adminId = await AdminIdAsync();
        var notifId = Guid.NewGuid();
        const string link = "/projects/8a1e/boards/2f4c?card=9c7d";
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            await ClearMineAsync(db, adminId);
            db.Notifications.Add(new Notification
            {
                Id = notifId,
                UserId = adminId,
                Type = NotificationTypes.Comment,
                Kind = NotificationKinds.CommentCreated,
                Payload = """{"actor":"小包","card":"登入頁異常"}""",
                Link = link,
            });
            await db.SaveChangesAsync();
        }

        var row = (await GetMineAsync()).EnumerateArray().Single();

        Assert.Equal("comment_created", row.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Object, row.GetProperty("payload").ValueKind);
        Assert.Equal("小包", row.GetProperty("payload").GetProperty("actor").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("title").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("message").ValueKind);
        // 另外四個頂層欄位也要有東西讀它們——少了這四行，回應整條掉 id 或 type 也是綠燈
        Assert.Equal(notifId.ToString(), row.GetProperty("id").GetString());
        Assert.Equal(NotificationTypes.Comment, row.GetProperty("type").GetString());
        Assert.False(row.GetProperty("read").GetBoolean());
        Assert.Equal(link, row.GetProperty("link").GetString());
        // time 已移除。少了這一行時，持有舊 bundle 的分頁會拿到空字串而不是紅燈
        // （設計 §4.5 的降級窗口），所以由契約鎖負責。
        Assert.False(row.TryGetProperty("time", out _));
    }

    [Fact]
    public async Task createdAt_是_ISO_8601_UTC()
    {
        var adminId = await AdminIdAsync();
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            await ClearMineAsync(db, adminId);
            db.Notifications.Add(new Notification { UserId = adminId, Type = NotificationTypes.System });
            await db.SaveChangesAsync();
        }

        var createdAt = (await GetMineAsync()).EnumerateArray().Single().GetProperty("createdAt").GetString()!;

        Assert.EndsWith("Z", createdAt);
        Assert.True(DateTimeOffset.TryParse(createdAt, out var parsed));
        Assert.Equal(TimeSpan.Zero, parsed.Offset);
    }

    [Fact]
    public async Task 舊列_payload_為_null_時仍回散文()
    {
        var adminId = await AdminIdAsync();
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            await ClearMineAsync(db, adminId);
            db.Notifications.Add(new Notification
            {
                UserId = adminId,
                Type = NotificationTypes.Review,
                Title = "審查通過",
                Message = "卡片「登入頁異常」審查已由 小包 提交，狀態：approved",
            });
            await db.SaveChangesAsync();
        }

        var row = (await GetMineAsync()).EnumerateArray().Single();

        Assert.Equal(JsonValueKind.Null, row.GetProperty("kind").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("payload").ValueKind);
        Assert.Equal("審查通過", row.GetProperty("title").GetString());
        Assert.Contains("狀態：approved", row.GetProperty("message").GetString()!);
    }

    // 設計 §7 的「每個碼至少一處 body 斷言」：16 個碼裡唯一沒有站點斷言的那一個。
    // 查詢帶 `n.UserId == userId`（`NotificationEndpoints.cs` 的 `MarkAsRead`），所以
    // 「別人的通知」與「不存在的通知」走同一條 404——這一支釘的是那一條路徑的 wire 形狀。
    [Fact]
    public async Task MarkUnknownNotificationRead_Returns404WithCode()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var response = await _client.PutAsync($"/api/notifications/{Guid.NewGuid()}/read", null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(ErrorCodes.NotificationNotFound, await ErrorBody.CodeOfAsync(response));
    }
}
