using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Identity;

namespace Entask.Tests;

// 使用者停用與刪除（設計 2026-10-07）。
// 端點在 Task 5 之前不存在 ⇒ 這一階段一律用 DB 直接改欄位來建立狀態。
public class UserDeactivationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public UserDeactivationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Refresh_OnDeactivatedUser_ReturnsSessionInvalid()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "refresh-off",
            password = "Password1!",
            displayName = "停用測試",
        }))).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "refresh-off", password = "Password1!" }));
        var refreshToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        await MutateUserAsync("refresh-off", u => u.DeactivatedAt = DateTime.UtcNow);

        var again = await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken }));
        Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);
        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("auth.sessionInvalid", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Refresh_OnReactivatedUser_StaysDead()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "refresh-back",
            password = "Password1!",
            displayName = "復原測試",
        }));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetString();
        _client.DefaultRequestHeaders.Authorization = null;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "refresh-back", password = "Password1!" }));
        var refreshToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        // 停用 → 復原**走端點**（不是 `MutateUserAsync` 直接改欄位）。撤銷只發生在端點裡：
        // DB 直改會讓這一支在「端點有沒有撤銷」兩種實作下都紅——它就不再是撤銷的守門員，
        // T8 的第 8 顆突變（拿掉端點的撤銷呼叫）也會失去判別力（T3 review 的 F-1）。
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/deactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/reactivate", null)).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // 列還在、欄位回到 null（上面兩次 204），但**撤銷是永久的**：
        // 「復原」只復原帳號，不復原工作階段（設計 §4.5）。
        var again = await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken }));
        Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);

        // ★ 端點傳的**撤銷原因**（T5 review 的 F6）：只釘服務層那一支不夠——端點把
        //   `RevokedReasons.Deactivated` 換成 `Logout`／`ReplayDetected` 時 HTTP 上逐位元
        //   相同、全線綠燈，差別只在一行重放 warning log。這一格釘的是端點的**引數**。
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(refreshToken)));
            var row = await db.RefreshTokens.FirstAsync(t => t.TokenHash == hash);
            Assert.Equal(RevokedReasons.Deactivated, row.RevokedReason);
        }
    }

    // I-1（final review，2026-10-07）：`RevokedReasons.Deactivated` 在 `RefreshAsync` 沒有
    // 自己的臂 ⇒ 落進 fail-safe 的「重放」分支 ⇒ 一台舊筆電手上的死 token 一打 refresh，
    // 就把**復原後重新登入的現行 session** 連坐撤銷，還留下一筆假的重放警告。
    // 設計意圖：`deactivated` 是**登出同類**（token 已死、回 null、不連坐），不是重放同類。
    [Fact]
    public async Task Refresh_TokenOfDeactivatedUser_DoesNotKillNewSessionAfterReactivate()
    {
        const string username = "stale-refresh";
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "舊 token 測試",
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var userId = Guid.Parse((await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("userId").GetString()!);
        _client.DefaultRequestHeaders.Authorization = null;

        // R1：停用前的 session——停用時會被蓋上 `deactivated`。
        var first = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var stale = (await first.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        // 停用 → 復原**都走端點**（撤銷與恢復的語意都在端點裡；理由同
        // `Refresh_OnReactivatedUser_StaysDead`——DB 直改會讓這一支失去判別力）。
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{userId}/deactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{userId}/reactivate", null)).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // R2：復原後重新登入拿到的**現行** session。
        var second = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var live = (await second.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        // 同一個類別共用一條 factory ⇒ 先清乾淨才問得準「這一支有沒有留下痕跡」。
        _factory.LogCapture.Clear();

        // ① 死 token 就是死 token：401，且**不連坐**。
        Assert.Equal(HttpStatusCode.Unauthorized, (await _client.PostAsync(
            "/api/auth/refresh", JsonContent.Create(new { refreshToken = stale }))).StatusCode);

        // ② ★ 紅燈格：新 session 必須還換得到（修前被 ① 的假重放掃掉 ⇒ 401）。
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync(
            "/api/auth/refresh", JsonContent.Create(new { refreshToken = live }))).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        // ③ 連坐撤銷的痕跡：**沒有任何**該使用者的列被蓋成 `replay_detected`。
        //    （`Assert.Empty` 會踩 xUnit2029，用 `AnyAsync` 直接問「有沒有」。）
        Assert.False(await db.RefreshTokens
            .AnyAsync(t => t.UserId == userId && t.RevokedReason == RevokedReasons.ReplayDetected));

        // ④ 也沒有假的重放警告——那一支的註解自己定義「留痕的判讀窗口此後是乾淨的」，
        //    假警告會讓 log 分不出真假。形狀同 `DetectsReplay_LeavesATraceInTheLog`：
        //    釘**結構化欄位** `{UserId}`，不釘訊息的文字。
        Assert.DoesNotContain(_factory.LogCapture.Entries, e =>
            e.Category == typeof(JwtTokenService).FullName
            && e.State.Any(kv => kv.Key == "UserId" && kv.Value is Guid id && id == userId));
    }

    [Fact]
    public async Task Deactivate_Self_IsRejected()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        // `deactivatedAt == null` 的篩選是必要的，兄弟測試也有：同一個類別共用一份 DB，
        // `Deactivate_WithTwoAdmins_Succeeds` 會留下一列**已停用**的 admin，若它排在種子
        // admin 前面，這一支會打到它、拿到冪等的 204（T5 review 的 F5）。
        var adminId = list.EnumerateArray().First(u => u.GetProperty("isAdmin").GetBoolean()
            && u.GetProperty("deactivatedAt").ValueKind == JsonValueKind.Null)
            .GetProperty("userId").GetString();

        var response = await _client.PostAsync($"/api/admin/users/{adminId}/deactivate", null);
        // 400 `request.invalid`，**不是** `!= 204`：這種斷言在端點還不存在時也會綠
        // （實測是 405 MethodNotAllowed——SPA fallback 那條 `GET,HEAD /{*path:nonfile}`
        // 讓這個路徑有匹配、只是方法不在清單裡；不是 brief 推測的 404），
        // 分不出「守衛正確」與「端點整個不在」。
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ★ 正向對照：只測「拒絕」會分不出「守衛正確」與「整支端點壞了」。
    //   兩個 admin，停用**其中一個**必須成功。
    [Fact]
    public async Task Deactivate_WithTwoAdmins_Succeeds()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "admin-two",
            password = "Password1!",
            displayName = "第二個管理員",
            isAdmin = true,
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var secondId = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("userId").GetString();

        var response = await _client.PostAsync($"/api/admin/users/{secondId}/deactivate", null);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        // 現在只剩一個可用的 admin ⇒ 換那個來停用自己（或對方）必須被擋。
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var firstId = list.EnumerateArray().First(u => u.GetProperty("isAdmin").GetBoolean()
            && u.GetProperty("deactivatedAt").ValueKind == JsonValueKind.Null)
            .GetProperty("userId").GetString();
        var again = await _client.PostAsync($"/api/admin/users/{firstId}/deactivate", null);
        // 同一條理由：`!= 204` 在端點不存在時也綠。這一格是「最後一個可用的 admin」——
        // 該情境下 caller 就是那一個，自助檢查先觸發，所以預期也是 400。
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
    }

    // ★ 正向對照：復原之後必須真的能登入。缺了它，「把所有人擋掉」也會全綠。
    [Fact]
    public async Task Reactivate_RestoresLogin()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "back-again",
            password = "Password1!",
            displayName = "回來了",
        }));
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var id = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "back-again")
            .GetProperty("userId").GetString();

        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/deactivate", null)).StatusCode);

        var blocked = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "back-again", password = "Password1!" }));
        Assert.Equal(HttpStatusCode.Unauthorized, blocked.StatusCode);

        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/reactivate", null)).StatusCode);

        var ok = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "back-again", password = "Password1!" }));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    }

    [Fact]
    public async Task Delete_RequiresDeactivatedFirst()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "not-yet-off",
            password = "Password1!",
            displayName = "還沒停用",
        }));
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var id = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "not-yet-off")
            .GetProperty("userId").GetString();

        Assert.Equal(HttpStatusCode.BadRequest, (await _client.DeleteAsync($"/api/admin/users/{id}")).StatusCode);

        await _client.PostAsync($"/api/admin/users/{id}/deactivate", null);
        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync($"/api/admin/users/{id}")).StatusCode);
    }

    // 刪除的兩道防線**一起**拆才打得穿（設計 §6.1 第 3 條）。
    [Fact]
    public async Task Delete_ScrubsCredentialsAndFreesUsername()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "gone-forever",
            password = "Password1!",
            displayName = "陳美惠",
        }));
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var id = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "gone-forever")
            .GetProperty("userId").GetString();

        await _client.PostAsync($"/api/admin/users/{id}/deactivate", null);
        await _client.DeleteAsync($"/api/admin/users/{id}");

        // 顯示名稱留著（D2：歷史還讀得懂），帳號欄位清掉。
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.Users.FirstAsync(u => u.Id == Guid.Parse(id!));
        Assert.Equal("陳美惠", row.DisplayName);
        Assert.Null(row.PasswordHash);
        Assert.NotNull(row.DeletedAt);
        Assert.NotEqual("gone-forever", row.UserName);

        // 用舊密碼登入必須失敗——而且回的是通用碼，不揭露。
        _client.DefaultRequestHeaders.Authorization = null;
        var attempt = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "gone-forever", password = "Password1!" }));
        Assert.Equal(HttpStatusCode.Unauthorized, attempt.StatusCode);

        // 這一行把 spec §10 的「username 會被釋放」寫成斷言而不是意外。
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var recreate = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "gone-forever",
            password = "Password2!",
            displayName = "新來的",
        }));
        Assert.Equal(HttpStatusCode.OK, recreate.StatusCode);
    }

    // I-2（final review，2026-10-07）：三個動作端點都丟掉 `UpdateAsync` 的回傳值 ⇒ 端點照樣
    // 往下走，該做的處置與「狀態是否真的改變」脫鉤。刪除路徑的佔位符**用戶端算得出來**
    // ⇒ 可以用同名使用者先占住它，做出**確定性**的 `DuplicateUserName` 失敗（不需要競態）。
    // ★ 修前實測不是 final review 推測的 204，而是 **500**（Red log：`Expected: BadRequest`／
    //   `Actual: InternalServerError`）。500 的機制是**推論（未實查、未捕捉堆疊）**：使用者的
    //   修改還掛在同一個 scoped `EntaskDbContext` 的變更追蹤裡，後續稽核的 `SaveChangesAsync`
    //   把它一起送去寫 ⇒ 例外從稽核那一行炸出來。已實測的是失敗的來源——`UpdateAsync` 是
    //   回傳失敗、不是拋例外（2026-10-08 探針）。
    [Fact]
    public async Task Delete_WhenUpdateFails_ReturnsErrorWithoutAudit()
    {
        const string username = "delete-fails";
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "刪除失敗測試",
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var id = Guid.Parse((await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("userId").GetString()!);

        // 佔位符**照端點同法**從 id 算出（`AdminUserEndpoints.cs` 的
        // `$"deleted-{user.Id:N}"[..24]`）——先占住那個名字，刪除時的 `UpdateAsync`
        // 就會撞 Identity 的 `NormalizedUserName` 唯一性驗證。
        var placeholder = $"deleted-{id:N}"[..24];
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = placeholder,
            password = "Password1!",
            displayName = "佔位符占用者",
        }))).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/deactivate", null)).StatusCode);

        var response = await _client.DeleteAsync($"/api/admin/users/{id}");

        // ★ 紅燈格：修前是 500（結果被丟掉 ⇒ 稽核的 `SaveChangesAsync` 把註定失敗的修改
        //   一起送去寫）；修後是建帳號端點同一形狀的 400（`AuthEndpoints.cs:232-235`），
        //   不新增錯誤碼或字面值。
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.IdentityDuplicateUserName, body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("message").GetString()));

        // 失敗 ⇒ **狀態不變**（而不是「回報已刪除、欄位全在」）：重新讀 DB 逐欄確認。
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.Users.FirstAsync(u => u.Id == id);
        Assert.Null(row.DeletedAt);
        Assert.NotNull(row.PasswordHash);
        Assert.Equal(username, row.UserName);

        // 也**不能**留下一列 `user.deleted` 稽核——那是「已經發生」的紀錄。
        Assert.False(await db.AuditLogs.AnyAsync(l => l.EntityId == id && l.Action == AuditActions.UserDeleted));
    }

    // 稽核的三個動作各寫一列。這一支是 §6.1 第 12 條——沒有它，三個
    // `audit.AddAsync` 呼叫全部漏掉不會有任何紅燈（`check:labels` 只比對常數集合，
    // 不管有沒有人用它）。
    [Fact]
    public async Task Actions_WriteAuditRows()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "audited",
            password = "Password1!",
            displayName = "被稽核的",
        }));
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var id = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "audited")
            .GetProperty("userId").GetString();

        await _client.PostAsync($"/api/admin/users/{id}/deactivate", null);
        await _client.PostAsync($"/api/admin/users/{id}/reactivate", null);
        await _client.PostAsync($"/api/admin/users/{id}/deactivate", null);
        await _client.DeleteAsync($"/api/admin/users/{id}");

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var actions = await db.AuditLogs
            .Where(l => l.EntityId == Guid.Parse(id!))
            .Select(l => l.Action).ToListAsync();

        Assert.Contains(AuditActions.UserDeactivated, actions);
        Assert.Contains(AuditActions.UserReactivated, actions);
        Assert.Contains(AuditActions.UserDeleted, actions);
    }

    // `/api/auth/me` 是唯一一條**不經** `ResolveCurrentUserAsync` 的「讀自己」路由
    // （Task 4 review 的 Important；設計 §4.3 說窗在「本來就要讀 DB」的站點關掉）。
    // 它的判準是行內的另一份副本 ⇒ 這支測試是那一份副本的守門員——少了它，
    // 「停用／刪除的窗」在這一條路上開著，而所有既有測試都看不到。
    [Theory]
    [InlineData("deactivated")]
    [InlineData("deleted")]
    public async Task Me_OnDeactivatedOrDeletedUser_ReturnsSessionInvalid(string mode)
    {
        // 使用者名稱逐格不同——同一個 Theory 的多格共用同一份 DB（`WithDbReset()` 每條
        // factory 只生效一次），形狀照上面 `me-off-{route}` 的既有裁定。
        var username = $"me-state-{mode}";
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "狀態測試",
        }));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetString();
        _client.DefaultRequestHeaders.Authorization = null;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{id}/deactivate", null)).StatusCode);
        if (mode == "deleted")
            Assert.Equal(HttpStatusCode.NoContent,
                (await _client.DeleteAsync($"/api/admin/users/{id}")).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        // 用**停用前**拿到的 access token——這是 30 分鐘窗內唯一會關掉的站點之一。
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        request.Headers.Authorization = new("Bearer", token);
        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("auth.sessionInvalid", body.GetProperty("code").GetString());
    }

    // 撤銷原因不是診斷欄位，是契約（docs/invariants/07-refresh-tokens.md）：
    // 分流器的輸入是「原因」不是「時間」，所以新增的撤銷路徑必須蓋自己的原因。
    [Fact]
    public async Task Deactivate_StampsItsOwnRevocationReason()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "reason-check",
            password = "Password1!",
            displayName = "原因測試",
        }));
        _client.DefaultRequestHeaders.Authorization = null;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "reason-check", password = "Password1!" }));
        var refreshToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("refreshToken").GetString()!;

        using (var scope = _factory.Services.CreateScope())
        {
            var tokens = scope.ServiceProvider.GetRequiredService<JwtTokenService>();
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var user = await db.Users.FirstAsync(u => u.UserName == "reason-check");
            await tokens.RevokeAllActiveAsync(user.Id, RevokedReasons.Deactivated);
        }

        using var verifyScope = _factory.Services.CreateScope();
        var verifyDb = verifyScope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(refreshToken)));
        var row = await verifyDb.RefreshTokens.FirstAsync(t => t.TokenHash == hash);

        Assert.NotNull(row.RevokedAt);
        Assert.Equal(RevokedReasons.Deactivated, row.RevokedReason);
    }

    [Theory]
    [InlineData("profile")]   // PUT /api/me/profile
    [InlineData("password")]  // PUT /api/me/password
    [InlineData("avatar")]    // PUT /api/me/avatar
    public async Task MeEndpoints_OnDeactivatedUser_ReturnSessionInvalid(string route)
    {
        // 使用者名稱**逐路由不同**（`me-off-{route}`）：`WithDbReset()` 只對每條 factory 生效
        // 一次（`ApiWebApplicationFactory` 的 `ConfigureServices` 只在 host 首次建置時跑），
        // 所以同一個 Theory 的三格**共用同一份 DB**。共用一個名字時，第一格把 `me-off` 停用
        // 之後，第二格的 login 就拿到 401（少了 `accessToken`），紅在**登入**而不是守衛上——
        // 那個紅燈讀起來像是守衛壞了。形狀照 `RefreshTokenReplayTests.CreateThrowawayUserAsync`
        // 的既有裁定：造自己的人就不需要還原。
        var username = $"me-off-{route}";
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "停用測試",
        }));
        _client.DefaultRequestHeaders.Authorization = null;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        await MutateUserAsync(username, u => u.DeactivatedAt = DateTime.UtcNow);

        var request = new HttpRequestMessage(HttpMethod.Put, $"/api/me/{route}");
        request.Headers.Authorization = new("Bearer", token);
        // 內容型別**依路由而異**：`/avatar` 的參數是 `IFormFile`，而它從 multipart 綁定
        // ——JSON body 會在模型繫結就 **415 UnsupportedMediaType**（Task 4 實測；原本寫 400 是推論），
        // **根本走不到 handler 內的那一段守衛**
        // （守衛在 handler 裡，不在模型繫結之前）。形狀照 `AvatarTests.PngContent` 的既有先例。
        // 其餘兩條收 `[FromBody]` 的 record，空 JSON 就夠。
        HttpContent content = route == "avatar" ? PngContent() : JsonContent.Create(new { });
        request.Content = content;
        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("auth.sessionInvalid", body.GetProperty("code").GetString());
    }

    // 與 `AvatarTests.PngContent` 同一個形狀（1x1 透明 PNG、部件名 `file`）——刻意不共用，
    // 因為那一支是 `AvatarTests` 的 private。
    private static MultipartFormDataContent PngContent()
    {
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
        var content = new MultipartFormDataContent();
        var streamContent = new StreamContent(new MemoryStream(png));
        streamContent.Headers.ContentType = new("image/png");
        content.Add(streamContent, "file", "avatar.png");
        return content;
    }

    [Fact]
    public async Task AdminList_IncludesDeactivatedWithStatus()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "listed-off",
            password = "Password1!",
            displayName = "被列出的",
        }));

        var before = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var target = before.EnumerateArray().First(u => u.GetProperty("username").GetString() == "listed-off");
        Assert.Equal(JsonValueKind.Null, target.GetProperty("deactivatedAt").ValueKind);

        await MutateUserAsync("listed-off", u => u.DeactivatedAt = DateTime.UtcNow);

        var after = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var updated = after.EnumerateArray().First(u => u.GetProperty("username").GetString() == "listed-off");
        Assert.NotEqual(JsonValueKind.Null, updated.GetProperty("deactivatedAt").ValueKind);
    }

    [Fact]
    public async Task Offboarding_CountsOpenCardsAndPendingReviews()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        // 這支只驗形狀與 0 的基準——**不**去造卡片：那是既有測試基建的工作，
        // 而在這裡重造一遍會讓這支測試同時驗兩件事。計數的語意由 Task 6 的
        // 名冊測試守著（同一批資料、同一個使用者）。
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var adminId = list.EnumerateArray().First(u => u.GetProperty("isAdmin").GetBoolean())
            .GetProperty("userId").GetString();

        var off = await _client.GetFromJsonAsync<JsonElement>($"/api/admin/users/{adminId}/offboarding");
        Assert.Equal(0, off.GetProperty("openCards").GetInt32());
        Assert.Equal(0, off.GetProperty("pendingReviews").GetInt32());
        Assert.True(off.GetProperty("projectMemberships").GetInt32() >= 0);
        Assert.True(off.GetProperty("teamMemberships").GetInt32() >= 0);
    }

    // 已停用的 admin 帶著**仍然有效的 access token** 打 admin 端點 ⇒ 401 `auth.sessionInvalid`
    // ——這是設計 §4.4 白紙黑字的存在理由（「他可以在被停用之後用舊 token 把自己復原」）。
    // 少了這一支，把 `RequireAdminAsync` 的 `ResolveCurrentUserAsync` 換回單純的
    // `FindByIdAsync`（或任何不看 `DeactivatedAt` 的等價寫法）全線綠燈（T5 review 的 F2）。
    [Fact]
    public async Task DeactivatedAdmin_WithStillValidToken_IsRejected()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "admin-off",
            password = "Password1!",
            displayName = "將被停用的管理員",
            isAdmin = true,
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var secondId = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("userId").GetString();
        _client.DefaultRequestHeaders.Authorization = null;

        // 停用**前**簽發的 access token。撤銷只動 refresh token 列 ⇒ 這顆到過期前都還帶著
        // `entask:admin` claim，閘門必須另外看 DB 的 `DeactivatedAt`。
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "admin-off", password = "Password1!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{secondId}/deactivate", null)).StatusCode);
        _client.DefaultRequestHeaders.Authorization = null;

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/users");
        request.Headers.Authorization = new("Bearer", token);
        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("auth.sessionInvalid", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task AdminEndpoints_RejectNonAdmin()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "plain-user",
            password = "Password1!",
            displayName = "普通人",
        }));
        // 動作端點的目標：閘門在解析目標**之前**，所以目標是誰無關緊要；
        // 用 admin 自己的 id 只是讓「擋在查詢之前」這件事在讀的人眼裡是明確的。
        var adminList = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var adminId = adminList.EnumerateArray().First(u => u.GetProperty("isAdmin").GetBoolean())
            .GetProperty("userId").GetString();
        _client.DefaultRequestHeaders.Authorization = null;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "plain-user", password = "Password1!" }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        // 403 ＋ `permission.denied` ＋ 非空 message——`!= OK` 分不出「閘門正確」
        // 與「端點壞成 500／404」。`permission.denied` 是共用的碼
        // （docs/invariants/04-error-codes-and-messages.md）。
        var response = await _client.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("permission.denied", body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("message").GetString()));

        // 動作端點也要同一道閘門、同一個 body 形狀。少了這一格，三個動作端點的
        // 403 分支只有「編譯得過」守著（P1 的 403 形狀在 Task 5 才有行為測試）。
        // ★ **三個動作全部**（T5 review 的 R16b）：只驗 deactivate 的話，reactivate／delete
        //   的 403 分支（是各自獨立的三份，不是共用 helper）漏掉一道也全綠。
        foreach (var (method, path) in new (HttpMethod, string)[]
                 {
                     (HttpMethod.Post, $"/api/admin/users/{adminId}/deactivate"),
                     (HttpMethod.Post, $"/api/admin/users/{adminId}/reactivate"),
                     (HttpMethod.Delete, $"/api/admin/users/{adminId}"),
                 })
        {
            using var action = new HttpRequestMessage(method, path);
            var actionResponse = await _client.SendAsync(action);
            Assert.Equal(HttpStatusCode.Forbidden, actionResponse.StatusCode);
            var actionBody = await actionResponse.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("permission.denied", actionBody.GetProperty("code").GetString());
            Assert.False(string.IsNullOrEmpty(actionBody.GetProperty("message").GetString()));
        }
    }

    // ★ 成對：池排除、名冊保留。只做一半的話「全部過濾」與「全部保留」各能滿足一邊。
    [Fact]
    public async Task DeactivatedUser_LeavesPoolsButStaysOnRosters()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        // 團隊由下面的 helper 直接寫 DB（形狀照 PermissionDeniedBodyTests 的行內 seed）。
        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "pool-check",
            password = "Password1!",
            displayName = "池測試",
        }));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetString()!;

        var teamId = await SeedTeamWithMemberAsync("pool-check");
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var targetId = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "pool-check")
            .GetProperty("userId").GetString();

        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{targetId}/deactivate", null)).StatusCode);

        // ① 池：不出現
        var pool = await _client.GetFromJsonAsync<JsonElement>("/api/auth/users");
        Assert.DoesNotContain(pool.EnumerateArray(),
            u => u.GetProperty("username").GetString() == "pool-check");

        var search = await _client.GetFromJsonAsync<JsonElement>("/api/auth/users/search?q=pool-che");
        Assert.DoesNotContain(search.EnumerateArray(),
            u => u.GetProperty("username").GetString() == "pool-check");

        // ② 名冊：還在，而且帶著標記
        var team = await _client.GetFromJsonAsync<JsonElement>($"/api/teams/{teamId}");
        var member = team.GetProperty("members").EnumerateArray()
            .First(m => m.GetProperty("userId").GetString() == id);
        Assert.True(member.GetProperty("deactivated").GetBoolean());
    }

    [Fact]
    public async Task ProjectMembers_KeepDeactivatedWithFlag()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var created = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "roster-check",
            password = "Password1!",
            displayName = "名冊測試",
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);

        var (projectId, userId) = await SeedProjectWithMemberAsync("roster-check");
        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var targetId = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "roster-check")
            .GetProperty("userId").GetString();
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{targetId}/deactivate", null)).StatusCode);

        var members = await _client.GetFromJsonAsync<JsonElement>($"/api/projects/{projectId}/members");
        var entry = members.EnumerateArray().First(m => m.GetProperty("userId").GetString() == userId.ToString());
        Assert.True(entry.GetProperty("deactivated").GetBoolean());
    }

    // ★ 成對：新增停用者 ⇒ 400；**保留既有者 ⇒ 成功**。
    //   少了 ①，一個「request 中任何 id 停用即拒」的實作會全綠——而那會讓任何一次
    //   原樣送回整份成員清單的卡片編輯回 400，那張卡片從此改不動。
    [Fact]
    public async Task CardMembers_RejectAddingDeactivated_ButAllowKeeping()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        // 兩個帳號走真端點建立（helper 只收 username、拿不到 client）；斷言 200 是必要的
        // ——少它，建立失敗會以「後面找不到使用者」的形狀出現，指向錯的方向。
        foreach (var name in new[] { "card-a", "card-b" })
        {
            Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
            {
                username = name,
                password = "Password1!",
                displayName = $"卡片成員 {name}",
            }))).StatusCode);
        }

        var (_, _, _, cardId, keepId, dropId) = await SeedCardWithTwoMembersAsync("card-a", "card-b");

        var list = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var targetId = list.EnumerateArray().First(u => u.GetProperty("username").GetString() == "card-b")
            .GetProperty("userId").GetString()!;
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{targetId}/deactivate", null)).StatusCode);

        // ① 原樣送回整份集合（card-a ＋ 已停用的 card-b，他仍在卡片上）⇒ 成功。
        //    這格是判別格：一個「request 中任何 id 停用即拒」的實作必須在這裡紅。
        var keep = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { keepId, dropId } }));
        Assert.Equal(HttpStatusCode.OK, keep.StatusCode);

        // ② 移除已停用成員（只剩 card-a）⇒ 成功（D7「仍移得掉」）。
        var remove = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { keepId } }));
        Assert.Equal(HttpStatusCode.OK, remove.StatusCode);

        // ③ 把停用者加回來（card-a ＋ card-b；② 之後他確實不在集合裡）⇒ 400
        var add = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { keepId, dropId } }));
        Assert.Equal(HttpStatusCode.BadRequest, add.StatusCode);
    }

    // ★ 成對：新增停用者（非成員 ⇒ 這一 PUT 給他第一筆成員列）⇒ 400；
    //   **既有停用成員的角色編輯 ⇒ 成功**。第二格是判別格：一個「request 中被指名的
    //   使用者停用即拒」的實作必須在那裡紅——這條 PUT 是既有成員的角色編輯路徑
    //   （前端唯一消費者是 EditProjectMemberRolesDialog），整個拒絕會連移除一起擋掉，
    //   與 D7「仍移得掉」矛盾。
    [Fact]
    public async Task ProjectMemberPut_RejectsAddingDeactivated_ButAllowsRoleEdit()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        foreach (var name in new[] { "put-owner", "put-off", "put-edit" })
        {
            Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
            {
                username = name,
                password = "Password1!",
                displayName = $"PUT 成員 {name}",
            }))).StatusCode);
        }

        var users = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        string UserIdOf(string username) => users.EnumerateArray()
            .First(u => u.GetProperty("username").GetString() == username)
            .GetProperty("userId").GetString()!;

        // 兩個專案：① 的目標是**非成員**、② 的目標是既有成員。
        var (projectAdd, _) = await SeedProjectWithMemberAsync("put-owner");
        var (projectEdit, editTargetId) = await SeedProjectWithMemberAsync("put-edit");

        // 有效角色取自名冊上實際掛著的那一筆（系統角色；自訂角色要綁團隊成員身分）。
        var membersAdd = await _client.GetFromJsonAsync<JsonElement>($"/api/projects/{projectAdd}/members");
        var roleIdAdd = membersAdd.EnumerateArray().First().GetProperty("roleIds")[0].GetString()!;
        var membersEdit = await _client.GetFromJsonAsync<JsonElement>($"/api/projects/{projectEdit}/members");
        var roleIdEdit = membersEdit.EnumerateArray().First().GetProperty("roleIds")[0].GetString()!;

        foreach (var username in new[] { "put-off", "put-edit" })
            Assert.Equal(HttpStatusCode.NoContent, (await _client.PostAsync(
                $"/api/admin/users/{UserIdOf(username)}/deactivate", null)).StatusCode);

        // ① 停用者不是成員 ⇒ 這一 PUT 會讓他取得第一筆成員列 ⇒ 400
        var add = await _client.PutAsync($"/api/projects/{projectAdd}/members/{UserIdOf("put-off")}",
            JsonContent.Create(new { roleIds = new[] { roleIdAdd } }));
        Assert.Equal(HttpStatusCode.BadRequest, add.StatusCode);

        // ② 既有停用成員原樣送回角色 ⇒ 200（新增差集為空 ⇒ 不擋）
        var edit = await _client.PutAsync($"/api/projects/{projectEdit}/members/{editTargetId}",
            JsonContent.Create(new { roleIds = new[] { roleIdEdit } }));
        Assert.Equal(HttpStatusCode.OK, edit.StatusCode);
    }

    // R22（F-2b）：三道沒有專屬測試的既有守衛。它們守的是「守衛在不在」，預期直綠；
    // 判別力靠 T8 的突變（移除守衛 ⇒ 紅），本輪不跑突變。
    [Fact]
    public async Task TeamMemberAssignment_OnDeactivatedUser_ReturnsBadRequest()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username = "team-assign-off",
            password = "Password1!",
            displayName = "團隊指派停用者",
        }))).StatusCode);

        var teamId = await SeedTeamWithMemberAsync("team-assign-off");
        var team = await _client.GetFromJsonAsync<JsonElement>($"/api/teams/{teamId}");
        var roleId = team.GetProperty("roles")[0].GetProperty("id").GetString()!;

        var users = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var targetId = users.EnumerateArray().First(u => u.GetProperty("username").GetString() == "team-assign-off")
            .GetProperty("userId").GetString()!;
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{targetId}/deactivate", null)).StatusCode);

        // 原樣重送（他本來就是成員、同一組有效角色）——沒有守衛時是 200 的 no-op 差集。
        var assign = await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "team-assign-off", roleIds = new[] { roleId } }));
        Assert.Equal(HttpStatusCode.BadRequest, assign.StatusCode);
    }

    [Fact]
    public async Task ProjectMemberAssignment_OnDeactivatedUser_ReturnsBadRequest()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        foreach (var name in new[] { "proj-assign-owner", "proj-assign-off" })
        {
            Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
            {
                username = name,
                password = "Password1!",
                displayName = $"專案指派 {name}",
            }))).StatusCode);
        }

        var (projectId, _) = await SeedProjectWithMemberAsync("proj-assign-owner");
        var members = await _client.GetFromJsonAsync<JsonElement>($"/api/projects/{projectId}/members");
        var roleId = members.EnumerateArray().First().GetProperty("roleIds")[0].GetString()!;

        var users = await _client.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var targetId = users.EnumerateArray().First(u => u.GetProperty("username").GetString() == "proj-assign-off")
            .GetProperty("userId").GetString()!;
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{targetId}/deactivate", null)).StatusCode);

        // 指派一個已停用的非成員——沒有守衛時會落一筆新成員列並回 200。
        var assign = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = targetId, roleIds = new[] { roleId } }));
        Assert.Equal(HttpStatusCode.BadRequest, assign.StatusCode);
    }

    [Fact]
    public async Task ProjectCards_MarkDeactivatedAssignees()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        foreach (var name in new[] { "flag-keep", "flag-drop" })
        {
            Assert.Equal(HttpStatusCode.OK, (await _client.PostAsync("/api/auth/users", JsonContent.Create(new
            {
                username = name,
                password = "Password1!",
                displayName = $"旗標成員 {name}",
            }))).StatusCode);
        }

        var (projectId, _, _, _, keepId, dropId) = await SeedCardWithTwoMembersAsync("flag-keep", "flag-drop");
        Assert.Equal(HttpStatusCode.NoContent,
            (await _client.PostAsync($"/api/admin/users/{dropId}/deactivate", null)).StatusCode);

        var res = await _client.GetFromJsonAsync<JsonElement>($"/api/projects/{projectId}/cards");
        var assignees = res.GetProperty("items").EnumerateArray().Single().GetProperty("assignees").EnumerateArray().ToList();
        Assert.True(assignees.Single(a => a.GetProperty("userId").GetString() == dropId.ToString())
            .GetProperty("deactivated").GetBoolean());
        // 對照組：同一位指派者清單裡的啟用者必須是 false——不然「一律 true」也會全綠。
        Assert.False(assignees.Single(a => a.GetProperty("userId").GetString() == keepId.ToString())
            .GetProperty("deactivated").GetBoolean());
    }

    private async Task MutateUserAsync(string username, Action<Entask.Identity.Models.ApplicationUser> mutate)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var user = await db.Users.FirstAsync(u => u.UserName == username);
        mutate(user);
        await db.SaveChangesAsync();
    }

    /// <summary>直接寫 DB 建團隊並把使用者加成成員（形狀照 PermissionDeniedBodyTests 的行內 seed）。</summary>
    private async Task<Guid> SeedTeamWithMemberAsync(string username)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var user = await db.Users.FirstAsync(u => u.UserName == username);
        var role = await db.Roles.FirstAsync(r => r.TeamId == null && r.Code != null);
        var teamId = Guid.NewGuid();
        db.Teams.Add(new Entask.Core.Entities.Team
        {
            Id = teamId, Name = "池測試團隊", CreatedById = user.Id,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });
        db.TeamMembers.Add(new Entask.Core.Entities.TeamMember
        {
            Id = Guid.NewGuid(), TeamId = teamId, UserId = user.Id, RoleId = role.Id,
            // JoinedAt 未設 ⇒ default(DateTime)＝0001-01-01；凍結欄位沿用同一個值，語意不變。
            JoinedLocalDate = DateOnly.MinValue,
        });
        await db.SaveChangesAsync();
        return teamId;
    }

    /// <summary>同形，改為團隊 → 專案 → 專案成員；回傳 (projectId, userId)。</summary>
    private async Task<(Guid ProjectId, Guid UserId)> SeedProjectWithMemberAsync(string username)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var user = await db.Users.FirstAsync(u => u.UserName == username);
        var role = await db.Roles.FirstAsync(r => r.TeamId == null && r.Code != null);
        var teamId = Guid.NewGuid();
        db.Teams.Add(new Entask.Core.Entities.Team
        {
            Id = teamId, Name = "名冊測試團隊", CreatedById = user.Id,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });
        var projectId = Guid.NewGuid();
        db.Projects.Add(new Entask.Core.Entities.Project
        {
            Id = projectId, TeamId = teamId, Name = "名冊測試專案", CreatedById = user.Id,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        });
        var joinedAt = DateTime.UtcNow;
        db.ProjectMembers.Add(new Entask.Core.Entities.ProjectMember
        {
            Id = Guid.NewGuid(), ProjectId = projectId, UserId = user.Id, RoleId = role.Id,
            JoinedAt = joinedAt, JoinedLocalDate = DateOnly.FromDateTime(joinedAt),
        });
        await db.SaveChangesAsync();
        return (projectId, user.Id);
    }

    /// <summary>
    /// 直接寫 DB 建「團隊 → 專案 → 看板 → 清單 → 卡片」鏈：卡片上先掛兩個成員，兩人也都是
    /// 專案成員（卡片成員端點的第二道前置驗證要求後者，少了它會先 400 在「只能指派本專案的
    /// 成員」而不會走到差集檢查）。回傳的兩個 userId 依序是「保留」與「新增」的那一個。
    /// **不透過 API 建卡片**——那會讓這支測試同時驗「建立卡片」這個無關的東西。
    /// </summary>
    private async Task<(Guid ProjectId, Guid BoardId, Guid ListId, Guid CardId, Guid KeepUserId, Guid DropUserId)>
        SeedCardWithTwoMembersAsync(string keepUsername, string dropUsername)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var keepUser = await db.Users.FirstAsync(u => u.UserName == keepUsername);
        var dropUser = await db.Users.FirstAsync(u => u.UserName == dropUsername);
        var role = await db.Roles.FirstAsync(r => r.TeamId == null && r.Code != null);
        var now = DateTime.UtcNow;

        var teamId = Guid.NewGuid();
        db.Teams.Add(new Entask.Core.Entities.Team
        {
            Id = teamId, Name = "卡片測試團隊", CreatedById = keepUser.Id, CreatedAt = now, UpdatedAt = now,
        });
        var projectId = Guid.NewGuid();
        db.Projects.Add(new Entask.Core.Entities.Project
        {
            Id = projectId, TeamId = teamId, Name = "卡片測試專案", CreatedById = keepUser.Id,
            CreatedAt = now, UpdatedAt = now,
        });
        var boardId = Guid.NewGuid();
        db.Boards.Add(new Entask.Core.Entities.Board
        {
            Id = boardId, ProjectId = projectId, Name = "卡片測試看板", CreatedById = keepUser.Id,
            CreatedAt = now, UpdatedAt = now,
        });
        var listId = Guid.NewGuid();
        db.Lists.Add(new Entask.Core.Entities.BoardList
        {
            Id = listId, BoardId = boardId, Name = "待辦", CreatedAt = now, UpdatedAt = now,
        });
        var cardId = Guid.NewGuid();
        db.Cards.Add(new Entask.Core.Entities.Card
        {
            Id = cardId, ListId = listId, Title = "成員測試卡", CreatedById = keepUser.Id,
            CreatedAt = now, UpdatedAt = now,
        });
        db.ProjectMembers.AddRange(
            new Entask.Core.Entities.ProjectMember
            {
                Id = Guid.NewGuid(), ProjectId = projectId, UserId = keepUser.Id, RoleId = role.Id,
                JoinedAt = now, JoinedLocalDate = DateOnly.FromDateTime(now),
            },
            new Entask.Core.Entities.ProjectMember
            {
                Id = Guid.NewGuid(), ProjectId = projectId, UserId = dropUser.Id, RoleId = role.Id,
                JoinedAt = now, JoinedLocalDate = DateOnly.FromDateTime(now),
            });
        db.CardMembers.AddRange(
            new Entask.Core.Entities.CardMember { CardId = cardId, UserId = keepUser.Id },
            new Entask.Core.Entities.CardMember { CardId = cardId, UserId = dropUser.Id });
        await db.SaveChangesAsync();
        return (projectId, boardId, listId, cardId, keepUser.Id, dropUser.Id);
    }
}
