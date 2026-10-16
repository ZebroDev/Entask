using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

/// <summary>
/// 四個通知寫入點的契約鎖（設計 §4.4）：每個站點都要寫入 `Kind` 與 `Payload`。
///
/// **為何要釘「Title / Message 為 null」**：只補了 Kind 而忘了移除散文時，前端仍走 payload
/// 路徑（kind 認得），散文只是靜靜留在 DB 裡——直到某天有人以為它是回退來源而重新依賴它。
/// 這一條是設計 §4.2 的「新的列不再寫入散文」。
///
/// 這一支**讀 DB 不讀 REST**——REST 契約是另一支測試（`NotificationContractTests`）的事。
/// 分開的理由是症狀不同：這裡是「寫進去的東西對不對」，那裡是「讀出來的形狀對不對」。
/// **唯一的例外**是最後一支（`Push_的頂層欄位與_REST_的列一致`）——契約的兩端只能互相對照，
/// 所以那一支同時讀 DB 與 REST。
/// </summary>
[Collection("ApiTests")]
public class NotificationPayloadTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public NotificationPayloadTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private record Fixture(string CardId, Guid BobId, Guid AdminId, string AdminName);

    /// <summary>
    /// admin 建團隊／專案／看板／列表／卡片，再建一個 bob 並以「工程組長」加入專案。
    ///
    /// **bob 必須是專案成員**：`RequireProjectPermission` 對非 admin 是 fail-closed 的
    /// （解析不到專案或沒有該權限一律 403），而審查結果那兩支要由 bob 送審（`card.review`）。
    ///
    /// **角色自 Task 9 起是「工程組長」而不是「測試工程師」**：`審查通過通知` 那一支由 bob
    /// **帶分數**送審，而 `card.rate`（設計 §13.5，D8）只給主管角色——測試工程師提交分數
    /// 會 400，通知根本不會產生。本檔其他支與角色無關（見各支的斷言：收件者、payload 欄位、
    /// 通知列數），**沒有一支斷言 bob 缺少某個權限**。
    ///
    /// **bob 不加入任何卡片**——`card_assigned` 與 `comment_created` 靠「新增卡片成員」
    /// 這個動作觸發通知，先加進去就沒有東西可觸發了。
    /// </summary>
    private async Task<Fixture> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var teamId = (await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "通知團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var pReq = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        pReq.Headers.Add("X-Team-Id", teamId);
        pReq.Content = JsonContent.Create(new { name = "通知專案" });
        var projectId = (await (await _client.SendAsync(pReq)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "通知板" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var listId = (await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "待辦" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var cardId = (await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "登入頁異常" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "bob", password = "Password1!", displayName = "小包" }));

        Guid bobId, adminId;
        string adminName;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            bobId = db.Users.First(u => u.UserName == "bob").Id;
            var admin = db.Users.First(u => u.UserName == _factory.SeedCredentials().Username);
            adminId = admin.Id;
            // payload 的 actor 是 `DisplayName ?? UserName`（後端寫入點就是這樣組的）
            adminName = admin.DisplayName ?? admin.UserName!;
        }

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var leadRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程組長").GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = bobId, roleIds = new[] { leadRoleId } }))).StatusCode);

        return new Fixture(cardId, bobId, adminId, adminName);
    }

    private async Task<string> BobTokenAsync() =>
        (await (await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "bob", password = "Password1!" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

    /// <summary>該使用者最近一列通知（本測試每個情境都只產生一列）。</summary>
    private async Task<Entask.Core.Entities.Notification> LatestAsync(Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return await db.Notifications.AsNoTracking()
            .Where(n => n.UserId == userId).OrderByDescending(n => n.CreatedAt).FirstAsync();
    }

    /// <summary>
    /// 該使用者的**所有**通知。`LatestAsync` 對空集合會直接拋例外，所以「一列都沒有」
    /// 這種斷言需要另一個入口（`Assert.Empty` 拿不到 `FirstAsync` 的結果）。
    /// </summary>
    private async Task<List<Entask.Core.Entities.Notification>> AllAsync(Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return await db.Notifications.AsNoTracking().Where(n => n.UserId == userId).ToListAsync();
    }

    /// <summary>所有寫入點共用的不變量：有 kind、有 payload、沒有散文。</summary>
    private static JsonElement AssertPayload(Entask.Core.Entities.Notification n, string expectedType, string expectedKind)
    {
        Assert.Equal(expectedType, n.Type);
        Assert.Equal(expectedKind, n.Kind);
        Assert.Null(n.Title);
        Assert.Null(n.Message);
        Assert.False(string.IsNullOrWhiteSpace(n.Payload));
        return JsonDocument.Parse(n.Payload!).RootElement;
    }

    [Fact]
    public async Task 留言通知_寫入_comment_created_與_actor_card()
    {
        var f = await SetupAsync();
        // bob 先成為卡片成員，才會進「收件者」名單（留言的收件者是卡片成員 ＋ 建立者）
        await _client.PutAsync($"/api/cards/{f.CardId}/members", JsonContent.Create(new { userIds = new[] { f.BobId } }));

        var post = new HttpRequestMessage(HttpMethod.Post, $"/api/cards/{f.CardId}/comments");
        post.Content = JsonContent.Create(new { text = "重現步驟如附件" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(post)).StatusCode);

        var payload = AssertPayload(await LatestAsync(f.BobId),
            NotificationTypes.Comment, NotificationKinds.CommentCreated);
        Assert.Equal(f.AdminName, payload.GetProperty("actor").GetString());
        Assert.Equal("登入頁異常", payload.GetProperty("card").GetString());
    }

    [Fact]
    public async Task 指派通知_寫入_card_assigned_與_card()
    {
        var f = await SetupAsync();

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{f.CardId}/members",
            JsonContent.Create(new { userIds = new[] { f.BobId } }))).StatusCode);

        var payload = AssertPayload(await LatestAsync(f.BobId),
            NotificationTypes.Assigned, NotificationKinds.CardAssigned);
        Assert.Equal("登入頁異常", payload.GetProperty("card").GetString());
        Assert.False(payload.TryGetProperty("actor", out _));
    }

    [Fact]
    public async Task 審查請求通知_寫入_review_requested_與_card()
    {
        var f = await SetupAsync();

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{f.CardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { f.BobId } }))).StatusCode);

        var payload = AssertPayload(await LatestAsync(f.BobId),
            NotificationTypes.Review, NotificationKinds.ReviewRequested);
        Assert.Equal("登入頁異常", payload.GetProperty("card").GetString());
    }

    [Fact]
    public async Task 審查通過通知_寫入_review_approved_與_score()
    {
        var f = await SetupAsync();
        await _client.PutAsync($"/api/cards/{f.CardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { f.BobId } }));

        var reviews = await (await _client.GetAsync($"/api/cards/{f.CardId}/reviews"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = reviews.EnumerateArray().First().GetProperty("id").GetString()!;

        var put = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{f.CardId}/reviews/{reviewId}");
        put.Headers.Authorization = new("Bearer", await BobTokenAsync());
        put.Content = JsonContent.Create(new { status = ReviewStatuses.Approved, score = 5 });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(put)).StatusCode);

        var payload = AssertPayload(await LatestAsync(f.AdminId),
            NotificationTypes.Review, NotificationKinds.ReviewApproved);
        Assert.Equal("小包", payload.GetProperty("actor").GetString());
        Assert.Equal(5, payload.GetProperty("score").GetInt32());
    }

    [Fact]
    public async Task 審查退回通知_寫入_review_rejected_且沒有評分時_payload_不含_score()
    {
        var f = await SetupAsync();
        await _client.PutAsync($"/api/cards/{f.CardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { f.BobId } }));

        var reviews = await (await _client.GetAsync($"/api/cards/{f.CardId}/reviews"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = reviews.EnumerateArray().First().GetProperty("id").GetString()!;

        var put = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{f.CardId}/reviews/{reviewId}");
        put.Headers.Authorization = new("Bearer", await BobTokenAsync());
        // 退回必須附意見（本階段的驗證），缺了會在驗證階段先回 400；本支要驗的是
        // 「沒有評分時 payload 不含 score」，所以只補上意見、評分仍留空。
        put.Content = JsonContent.Create(new { status = ReviewStatuses.Rejected, comment = "退回" });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(put)).StatusCode);

        var payload = AssertPayload(await LatestAsync(f.AdminId),
            NotificationTypes.Review, NotificationKinds.ReviewRejected);
        // 設計 §4.4：「有值才放」。null 進去的話前端要分辨「沒有評分」與「評分是 null」，
        // 而後者不存在。
        Assert.False(payload.TryGetProperty("score", out _));
    }

    /// <summary>
    /// **`pending` 是「還沒審」而不是一種結果，既不可提交也不該發通知。**
    ///
    /// 這支的前身驗的是「`pending` 提交成功、但不發通知」——P-C Followups `aea4df5` 修的
    /// 缺陷：通知的 kind 由兩路三元式決定（approved／其餘一律 rejected），送出待審會讓
    /// 卡片建立者收到一則標題為「審查被退回」的通知，一句關於治理動作的假陳述。
    ///
    /// **本階段把 `pending` 從「動作」降為「狀態」（設計 D4）之後，它連提交都進不來**：
    /// 端點開頭的 `Submittable` 驗證就回 400，`req.Status != ReviewStatuses.Pending` 那個
    /// 守衛隨之成為不可達的防禦（設計 §6.1 第 5 點，保留不刪）。前半段因此改驗
    /// 「400 **且**不發通知」——被擋下的請求不該留下任何痕跡。
    ///
    /// **反向對照是必要的**：同一條審查接著改成 approved 一定要產生通知，否則「整個通知
    /// 區塊拿掉」也會讓這支綠燈——那會讓所有人都不再收到審查結果。
    ///
    /// **斷言比的是「增加了幾列」而不是「一列都沒有」**：`WithDbReset()` 只在 host 建立
    /// 時生效一次（`IClassFixture` 讓整個類別共用同一個 host），admin 是每一支測試共用的
    /// 同一個人，`審查退回通知` 那支留下的列還在 DB 裡——直接 `Assert.Empty` 會拿到它。
    /// </summary>
    [Fact]
    public async Task 審查送出為_pending_回400不發通知_改成_approved_才發()
    {
        var f = await SetupAsync();
        await _client.PutAsync($"/api/cards/{f.CardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { f.BobId } }));

        var reviews = await (await _client.GetAsync($"/api/cards/{f.CardId}/reviews"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = reviews.EnumerateArray().First().GetProperty("id").GetString()!;
        var bobToken = await BobTokenAsync();
        // 指派審查者的通知收件者是 bob，這條基線因此只會裝著前面幾支測試留下來的列
        var before = (await AllAsync(f.AdminId)).Count;

        var pending = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{f.CardId}/reviews/{reviewId}");
        pending.Headers.Authorization = new("Bearer", bobToken);
        pending.Content = JsonContent.Create(new { status = ReviewStatuses.Pending });
        var pendingRes = await _client.SendAsync(pending);
        Assert.Equal(HttpStatusCode.BadRequest, pendingRes.StatusCode);
        // 斷言碼而不只是狀態碼：這一支的前提是「`pending` 被 Submittable 擋下」，
        // 若 400 來自別的驗證，這支會在不該綠的時候綠。
        Assert.Equal(ErrorCodes.ReviewStatusNotSubmittable,
            (await pendingRes.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        Assert.Equal(before, (await AllAsync(f.AdminId)).Count);

        var approve = new HttpRequestMessage(HttpMethod.Put, $"/api/cards/{f.CardId}/reviews/{reviewId}");
        approve.Headers.Authorization = new("Bearer", bobToken);
        approve.Content = JsonContent.Create(new { status = ReviewStatuses.Approved });
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(approve)).StatusCode);

        Assert.Equal(before + 1, (await AllAsync(f.AdminId)).Count);
        var payload = AssertPayload(await LatestAsync(f.AdminId),
            NotificationTypes.Review, NotificationKinds.ReviewApproved);
        Assert.Equal("小包", payload.GetProperty("actor").GetString());
    }

    /// <summary>
    /// `NotificationPayloads.Push` 的頂層欄位集必須與 REST 的列逐鍵相同（設計 §4.3）：
    /// REST 與 SignalR 是**同一個契約的兩端**，只能互相對照。
    ///
    /// **為何用反射**：`NotificationPayloads` 是 internal，設計文件裁定測試看不到它
    /// 也不需要看到（「測試只用常數與 HTTP」）。反射是唯一不必放寬生產程式碼可見性
    /// 就能列舉那份物件的辦法。
    ///
    /// **這一支的紅燈條件**：端點若再手寫第二份匿名物件而形狀漂移，這裡會逐鍵列出差異。
    /// 今天 REST 的列就是 `Push` 的輸出，所以它同時是「端點沒有手寫第二份」的契約鎖。
    /// </summary>
    [Fact]
    public async Task Push_的頂層欄位與_REST_的列一致()
    {
        var f = await SetupAsync();
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsync($"/api/cards/{f.CardId}/members",
            JsonContent.Create(new { userIds = new[] { f.BobId } }))).StatusCode);

        var dbRow = await LatestAsync(f.BobId);

        var get = new HttpRequestMessage(HttpMethod.Get, "/api/notifications");
        get.Headers.Authorization = new("Bearer", await BobTokenAsync());
        var restRow = (await (await _client.SendAsync(get)).Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().First();
        // 兩邊必須是同一列（`LatestAsync` 與端點都是 CreatedAt 遞減），否則比到不同列也看不出來
        Assert.Equal(dbRow.Id.ToString(), restRow.GetProperty("id").GetString());

        var pushed = typeof(Entask.Api.Endpoints.NotificationEndpoints).Assembly
            .GetType("Entask.Api.Endpoints.NotificationPayloads")!
            .GetMethod("Push")!.Invoke(null, new object[] { dbRow })!;

        var restKeys = restRow.EnumerateObject().Select(p => p.Name)
            .OrderBy(k => k, StringComparer.Ordinal).ToArray();
        var pushedKeys = JsonSerializer.SerializeToElement(pushed).EnumerateObject()
            .Select(p => p.Name).OrderBy(k => k, StringComparer.Ordinal).ToArray();

        // 明示 IEnumerable 多載——逐鍵比較，順序已由上面排序固定
        Assert.Equal<string>(restKeys, pushedKeys);
    }
}
