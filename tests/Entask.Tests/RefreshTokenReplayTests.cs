using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Identity;
using Entask.Identity.Models;

namespace Entask.Tests;

/// <summary>
/// Refresh token 的重放偵測（OAuth 2.0 Security BCP）。
///
/// 本檔整體同時釘住兩件事：**該撤銷的有撤銷**、以及**不該撤銷的沒有被撤銷**。
/// 單一支只斷言其中一邊（`ReplayOfRotatedToken_…` 與 `RevokedAndExpiredToken_…` 只有前者）
/// ——新增測試時兩邊都要想到。只斷言前者的測試對「過度撤銷」是全盲的，而那正是這個機制
/// 最容易寫壞的方向：token 值本身就是秘密，任何人送一串隨機字串都會走到失敗分支；
/// 在那裡撤銷就成了一個「不必先竊得任何東西」的全體登出開關（DoS）。
/// </summary>
public class RefreshTokenReplayTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public RefreshTokenReplayTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    // 一次登入 = 一個獨立的 session（DB 裡多一列 refresh token）。
    // 本檔的多數測試都要「兩個互不相干的 session」才分得出
    // 「只撤銷被重放的那一條鏈」與「撤銷該使用者的全部 session」。
    private async Task<string> LoginAsync()
    {
        var seed = _factory.SeedCredentials();
        var response = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("refreshToken").GetString()!;
    }

    private async Task<HttpStatusCode> RefreshStatusAsync(string refreshToken) =>
        (await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken }))).StatusCode;

    /// <summary>正常輪替一次，回傳新的 refresh token（同時斷言這一步是成功的）。</summary>
    private async Task<string> RotateAsync(string refreshToken)
    {
        var response = await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("refreshToken").GetString()!;
    }

    // 儲存格式是 SHA256 的 hex（`JwtTokenService.Hash`）。這裡重寫一份是刻意的：
    // 它讓「DB 裡存的是雜湊而不是 token 本身」這件事有一個可執行的敘述，
    // 而且查不到列時 `FirstAsync` 會當場拋，不會靜靜地測一個空集合。
    private static string HashOf(string refreshToken) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(refreshToken)));

    /// <summary>
    /// 直接改 DB 的欄位，用來造出「自然過期」與「已撤銷」這兩個用 HTTP 到不了的中間狀態。
    /// </summary>
    private async Task MutateTokenAsync(string refreshToken, DateTime? expiresAt, DateTime? revokedAt, string? revokedReason = null)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.RefreshTokens.FirstAsync(t => t.TokenHash == HashOf(refreshToken));
        if (expiresAt is not null) row.ExpiresAt = expiresAt.Value;
        if (revokedAt is not null) row.RevokedAt = revokedAt.Value;
        if (revokedReason is not null) row.RevokedReason = revokedReason;
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// 刪掉使用者。與 <see cref="MutateTokenAsync"/> 同一個理由：全庫**沒有**刪使用者的端點
    /// （`AuthEndpoints` 只有 login／refresh／logout／me／users 的讀與建），
    /// 這個中間狀態只有直接改 DB 才到得了。
    ///
    /// **前提（實查）**：`RefreshTokens` 對 `AspNetUsers` **沒有 FK**——
    /// `EntaskDbContext` 沒有為 `RefreshToken` 設定關聯、
    /// `EntaskDbContextModelSnapshot.cs` 的那個 entity 區塊只有 `HasKey("Id")` 與
    /// `ToTable("RefreshTokens")`、而 `20260814081435_RefreshTokens.cs` 的 `Up` 只 CreateTable
    /// （全檔零個 `ForeignKey`）⇒ 刪掉使用者**不會**連帶刪掉 token 列。
    /// 那正是這一支測得到 `LoadAndIssueAsync` 的 `user is null` 的前提。
    /// （Identity 自己的 AspNetUserRoles／AspNetUserClaims 走 cascade，與本支無關。）
    /// </summary>
    private async Task DeleteUserAsync(Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var user = await db.Users.FirstAsync(u => u.Id == userId);
        db.Users.Remove(user);
        await db.SaveChangesAsync();
    }

    // 造一個**只屬於這支測試**的使用者（Identity 只給它 password hash，不給任何 claim）。
    // 前例：`AdminClaimMigrationTests.CreateUserAsync`（同一個形狀、同一組 using）。
    //
    // **為什麼 L-4 不能用共用的 seed admin**（實查，2026-09-23）：`WithDbReset()` 只對每條
    // factory 生效**一次**——旗標在 `ApiWebApplicationFactory.cs:74-78` 的
    // `ConfigureServices` 裡被消費，而那個回呼只在 **host 首次建置**時跑
    // （同檔 `:24` 的註解：「host 只在第一次 `CreateClient()` 時建置一次」）。
    // 這個 class 的每一支測試因此**共用同一份 DB 與同一個 admin**，而 L-4 需要「使用者已經不在」
    // 這個中間狀態 ⇒ 它若刪掉大家的人，排在它之後的測試會全部在 `LoginAsync()` 紅
    // （**實測：12 支裡 10 支**，`login` 回 401、body 裡沒有 `refreshToken`）。
    // 用自己造的人就沒有這個問題——**不需要還原，也就沒有「還原範圍」要維護**。
    //
    // 同一個成因（per-class 的共用狀態）在 `NotificationContractTests.ClearMineAsync` 也出現過，
    // 但**兩者的處置不同型**：那一支是在每支測試**之前**清掉**自己造的**列（冪等、不需還原），
    // 這裡是根本不碰共用的狀態。本檔上一輪「先快照共用的 admin、斷言完再寫回去」的形狀已移除
    // ——review 的 F1：那個形狀讓「還原範圍要跟著 fixture 長」變成沒有守衛的不變量。
    // ★ **它不是全庫唯一的還原形狀**（`SystemIdentifierTests.cs:65` 的
    //   `WithSystemRolesRestoredAsync` 也是快照 → 執行 → 還原，包在 try/finally 裡）
    //   ——本檔移除它的理由是上一行那個，不是「本庫沒人這樣寫」。
    private async Task<(string Username, string Password)> CreateThrowawayUserAsync()
    {
        const string username = "l4-victim";
        const string password = "Migrate1!"; // 與 `AdminClaimMigrationTests` 同一個值（Identity 的密碼原則擋得住就別改）
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var created = await users.CreateAsync(
            new ApplicationUser { UserName = username, DisplayName = username }, password);
        Assert.True(created.Succeeded, string.Join("; ", created.Errors.Select(e => e.Description)));
        return (username, password);
    }

    /// <summary>與 <see cref="LoginAsync"/> 同一個端點，差別只在帳密由呼叫端給。</summary>
    private async Task<string> LoginAsAsync(string username, string password)
    {
        var response = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password }));
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("refreshToken").GetString()!;
    }

    [Fact]
    public async Task Rotation_LeavesOtherSessionsAlone()
    {
        var first = await LoginAsync();
        var otherSession = await LoginAsync();

        var second = await RotateAsync(first);

        // 新的可用
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(second));
        // **另一個 session 完全不受影響**——正常輪替不是重放，不該有任何全體撤銷
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(otherSession));

        // ★ 這裡**刻意不去斷言「first 已經失效」**：有了寬限窗之後，「拿舊 token 去換」
        //   在輪替後 N 秒內本來就會拿到 200（下一支正是這件事），要驗「失效」得先把撤銷
        //   時刻推到窗外——那正是 Replay… 那支的形狀，在那裡它是重放的**前提**
        //   而不是併存的斷言。（本支初版寫成斷言 401，那時還沒有窗，實測紅在第二條。）
        //   連帶事實：`AuthLoginTests.Refresh_ReturnsNewTokens_And_OldRefreshTokenBecomesInvalid`
        //   的那個「再換一次 → 401」現在也必須先推到窗外；它的意圖與斷言不變。
    }

    [Fact]
    public async Task ReplayOfRotatedToken_RevokesEverySessionOfThatUser()
    {
        var first = await LoginAsync();
        var otherSession = await LoginAsync(); // 另一條鏈，與 first 無關
        var second = await RotateAsync(first); // 輪替後，first 已被標成撤銷

        // 寬限窗（D1）：剛被輪替掉的 token 在 N 秒內是**良性競態**、不判重放。
        // 這一支要驗的是「窗外的重放」⇒ 把撤銷時刻推到窗外（`expiresAt: null` 保持不動）。
        await MutateTokenAsync(first, expiresAt: null, revokedAt: DateTime.UtcNow.AddSeconds(-10));

        // 重放：拿已經被換掉的 first 再換一次
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(first));

        // 不只那一條鏈——該使用者**所有**現行 session 一起失效，
        // 因為已經分不出哪一份是原主、哪一份是副本
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(second));
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(otherSession));

        // ⑤-b（fix round 1）：重放處置**動了哪些列**是資料層的事實，HTTP 斷言看不到它。
        // 三值分野（D6）的價值就在這裡——被連帶撤銷的兄弟 session 要說得出「我為什麼被撤銷」；
        // 少了這一格，未來的稽核讀取介面（`docs/STATE.md` ⑤-b）只查得到一堆沒有原因的撤銷列，
        // 而那個退化**不會有任何紅燈**（原因留 null 與 `replay_detected` 目前走同一條處置）。
        Assert.Equal(RevokedReasons.ReplayDetected, await RevokedReasonOfAsync(second));
        Assert.Equal(RevokedReasons.ReplayDetected, await RevokedReasonOfAsync(otherSession));
        // 被重放的那一列原本是 `replaced`，而且**已經撤銷** ⇒ `RevokeAllActiveAsync` 的述詞
        // （`RevokedAt == null`）不該碰到它：原因必須原樣留著，否則「這條是被輪替掉的」那項
        // 事實會被重放處置吃掉，下一個讀那一欄的人就分不出它是誰撤銷的了。
        Assert.Equal(RevokedReasons.Replaced, await RevokedReasonOfAsync(first));
    }

    // 多分頁競態（docs/STATE.md ②）：分頁 B 在 A 完成輪替之後才把舊 token 送出去。
    // 寬限窗把它當成良性競態——發一組新的，而不是把該使用者的所有 session 撤銷。
    [Fact]
    public async Task RecentlyReplacedToken_IsToleratedByTheGraceWindow()
    {
        var replaced = await LoginAsync();
        var otherSession = await LoginAsync();
        var rotated = await RotateAsync(replaced); // replaced 被標成 replaced（RevokedAt = 剛剛）
        _factory.LogCapture.Clear();

        var response = await _client.PostAsync("/api/auth/refresh", JsonContent.Create(new { refreshToken = replaced }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        var graceToken = json.GetProperty("refreshToken").GetString()!;
        Assert.NotEqual(replaced, graceToken);
        // 寬限窗發出的那一組**真的能用**（而且 A 分頁手上的 rotated 仍然有效）
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(graceToken));
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(rotated));
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(otherSession));
        // 良性競態不得留下「重放」的痕跡（⑤-a 的契約：警告只給真重放）
        Assert.DoesNotContain(_factory.LogCapture.Entries, e => e.Category == typeof(JwtTokenService).FullName);
    }

    // L-4：窗內、`replaced`、而**使用者已經不在**（`LoadAndIssueAsync` 的 `user is null`）。
    // 這條路目前是 fail-closed（回 null ⇒ 401）且不撤銷任何東西——正確，但沒有測試看著它。
    //
    // 使用者是**這一支自己造的**（見 `CreateThrowawayUserAsync`）——不是共用的 seed admin，
    // 所以它被刪掉不影響同類別的其他測試，也不需要還原。
    [Fact]
    public async Task ReplacedInWindow_WithDeletedUser_IsRejectedWithoutRevokingOthers()
    {
        var (username, password) = await CreateThrowawayUserAsync();
        var replaced = await LoginAsAsync(username, password);
        var otherSession = await LoginAsAsync(username, password);
        var userId = await UserIdOfAsync(replaced);
        await RotateAsync(replaced); // ⇒ 窗內

        await DeleteUserAsync(userId);

        // 前提：刪使用者沒有帶走 token 列（否則下面的斷言會以「查不到列」的形式紅，
        // 那個紅燈讀起來像是別的問題）。同時確認那一列仍帶著輪替留下的原因。
        Assert.Equal(RevokedReasons.Replaced, await RevokedReasonOfAsync(replaced));

        _factory.LogCapture.Clear();
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(replaced));

        // ★ 這一支的**反向那一半只能在資料層斷言**：使用者沒了，其他 session 的 refresh 也
        //   一樣回 401（`LoadAndIssueAsync` 對它們同樣找不到人）⇒ **狀態碼分不出**
        //   「寬限分支回 null」與「重放分支撤銷完再回 null」。分得出的是**那一列的狀態**。
        Assert.Null(await RevokedReasonOfAsync(otherSession));
        // 而且不留「重放」的痕跡（⑤-a 的契約：警告只給真重放）
        Assert.DoesNotContain(_factory.LogCapture.Entries,
            e => e.Category == typeof(JwtTokenService).FullName);
    }

    // docs/STATE.md ③：登出與重放本來同源。加了 RevokedReason 之後，登出造成的撤銷
    // **不該**掃掉該使用者的其他 session（真實踩法：登出那一刻在途中的 refresh）。
    [Fact]
    public async Task LogoutRevokedToken_IsRejected_WithoutRevokingOtherSessions()
    {
        var loggedOut = await LoginAsync();
        var otherSession = await LoginAsync();
        await _client.PostAsync("/api/auth/logout", JsonContent.Create(new { refreshToken = loggedOut }));
        _factory.LogCapture.Clear();

        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(loggedOut));

        // 其他 session 不受影響——這正是 ③ 要修掉的那個傷害
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(otherSession));
        Assert.DoesNotContain(_factory.LogCapture.Entries, e => e.Category == typeof(JwtTokenService).FullName);
    }

    [Fact]
    public async Task ForgedToken_IsRejected_WithoutRevokingAnySession()
    {
        var live = await LoginAsync();

        // 128 個 hex 字元：與真 token 同一個形狀，但 DB 裡沒有這一列
        var forged = Convert.ToHexString(RandomNumberGenerator.GetBytes(64));
        Assert.NotEqual(live, forged);

        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(forged));

        // 「查不到」不觸發全體撤銷——否則任何人都能用隨機字串登出所有使用者
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(live));
    }

    [Fact]
    public async Task ExpiredToken_IsRejected_WithoutRevokingOtherSessions()
    {
        var expired = await LoginAsync();
        var live = await LoginAsync();

        await MutateTokenAsync(expired, expiresAt: DateTime.UtcNow.AddMinutes(-1), revokedAt: null);

        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(expired));

        // 「自然過期」同樣不觸發全體撤銷（與 forged 那支是同一個 DoS 理由）
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(live));
    }

    // 這一支釘的是規格的**字面讀法**：判定重放的條件是「已撤銷」，而檢查順序上
    // 「已撤銷」先於「已過期」⇒ 一個既被撤銷、又已經過期的 token 仍然走重放路徑。
    // 另一種讀法是讓「已過期」先成立（已過期的 token 誰都換不到東西，因此不觸發全體撤銷）。
    // 兩者在這裡刻意選了前者（規格明寫的條件），要改就改這一支 ＋ RefreshAsync 的順序。
    [Fact]
    public async Task RevokedAndExpiredToken_StillCountsAsReplay()
    {
        var replayed = await LoginAsync();
        var live = await LoginAsync();

        await MutateTokenAsync(replayed,
            expiresAt: DateTime.UtcNow.AddMinutes(-1),
            revokedAt: DateTime.UtcNow.AddMinutes(-2));

        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(replayed));
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(live));
    }

    // 寬限窗的**過期邊界**（`docs/STATE.md` 的 L-3）：窗的合取項裡
    // `ExpiresAt >= UtcNow` 這一項最難看見——它只在「token 在自己的到期前 5 秒內被輪替」
    // 那條縫上改變行為（約 5s / 14d ≈ 4e-6 每次輪替），而那條縫實務上撞不到。
    // （14 天＝`JwtOptions.RefreshTokenDays` 的預設值，`appsettings.Development.json:14`
    //   也寫 14 ⇒ 測試與 dev 都是這個值。**不要**把它當 30 天。）
    // 少了這一支，拿掉那個合取項是**隱形突變**：全部測試照綠。
    //
    // 這一支把「已過期」那一維單獨推過去（撤銷時刻**留在窗內**），於是它與
    // `ReplayOfRotatedToken_…`（撤銷時刻在窗外）互補，兩者合起來才把窗的兩個邊界都釘住。
    //
    // 沒有寬限 ⇒ 落到重放分支：與 `RevokedAndExpiredToken_StillCountsAsReplay` 走同一條路，
    // 差別只在那一支的撤銷原因是 null（fail-safe）、這一支是 `replaced`（原本夠資格進窗）。
    // 「重放要留痕」那一半的守門員仍是 `DetectsReplay_LeavesATraceInTheLog`，這裡不重複。
    [Fact]
    public async Task ReplacedButExpiredToken_GetsNoGraceWindow()
    {
        var replaced = await LoginAsync();
        var otherSession = await LoginAsync();
        await RotateAsync(replaced); // ⇒ RevokedReason = replaced、RevokedAt = 剛剛（窗內）
        // 只推「已過期」這一維：revokedAt 傳 null ＝ 不改 ⇒ 仍是輪替當下那個時刻。
        await MutateTokenAsync(replaced, expiresAt: DateTime.UtcNow.AddMinutes(-1), revokedAt: null);

        // 到期那一項不成立 ⇒ 不給寬限。（拿掉 `ExpiresAt >= UtcNow` 這一項時，這裡會拿到 200。）
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(replaced));

        // 落到重放分支的連帶效果：該使用者的其他 session 一起被撤銷，原因蓋的是重放。
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(otherSession));
        Assert.Equal(RevokedReasons.ReplayDetected, await RevokedReasonOfAsync(otherSession));
        // 被送進來的那一列**原本就已撤銷** ⇒ `RevokeAllActiveAsync` 的述詞不該碰它：原因必須
        // 原樣留著（與 `ReplayOfRotatedToken_…` 同一條資料層斷言）。★ 但**判別力不在這一支**：
        // 本支那一列同時也被推成過期，而述詞是三項合取（`UserId` ＋ `RevokedAt == null` ＋
        // `ExpiresAt > now`）⇒ 只拿掉 `RevokedAt == null` 這一項**不會**讓這一支紅
        // （那一列仍被 `ExpiresAt > now` 排除在外）。真正守住那一項的是鄰居
        // `ReplayOfRotatedToken_RevokesEverySessionOfThatUser`（那裡傳 `expiresAt: null`，
        // 只有 `RevokedAt == null` 在保護它）。這裡是雙重保護，留著。
        Assert.Equal(RevokedReasons.Replaced, await RevokedReasonOfAsync(replaced));
    }

    // D4：既有列（RevokedReason 為 null）＝原因不明 ⇒ fail-safe，不給寬限。
    [Fact]
    public async Task RevokedWithoutReason_IsStillTreatedAsReplay()
    {
        var replayed = await LoginAsync();
        var live = await LoginAsync();
        await MutateTokenAsync(replayed, expiresAt: null, revokedAt: DateTime.UtcNow.AddSeconds(-1), revokedReason: null);

        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(replayed));
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(live));
    }

    /// <summary>該 token 在 DB 裡屬於哪個使用者——用來把日誌那筆的 `{UserId}` 對回來。</summary>
    private async Task<Guid> UserIdOfAsync(string refreshToken)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.RefreshTokens.AsNoTracking().FirstAsync(t => t.TokenHash == HashOf(refreshToken));
        return row.UserId;
    }

    /// <summary>
    /// 該 token 那一列**為什麼**被撤銷——直接讀 DB。這件事沒有任何 HTTP 回應看得見，
    /// 而它正是三值分野要留下的憑據（`docs/STATE.md` 的 ③／⑤-b）。
    /// </summary>
    private async Task<string?> RevokedReasonOfAsync(string refreshToken)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var row = await db.RefreshTokens.AsNoTracking().FirstAsync(t => t.TokenHash == HashOf(refreshToken));
        return row.RevokedReason;
    }

    // ⑤-a（2026-09-23，`docs/STATE.md`）：重放偵測必須**留下痕跡**。
    // 它落地時，唯一的觀測窗口是「該使用者的所有 session 同時失效」——而登出
    // （`RevokeAsync`）與多分頁競態走的是同一條路，事後**分不出**是哪一種。
    // （同日稍晚：撤銷已在 `JwtTokenService.RefreshAsync` 依撤銷原因分流——登出與競態，
    //  以及後續補上的停用（2026-10-07）與密碼變更（2026-10-08），都到不了那個 `LogWarning`
    //  ⇒ 現在走到這裡的就是真重放，痕跡的判讀窗口是乾淨的。）
    //
    // 這一支是那個 `LogWarning` 的**唯一**守門員：其他測試都只看得到 HTTP 回應。
    // 突變實測：拿掉那一行 ⇒ 恰好這一支紅。
    [Fact]
    public async Task DetectsReplay_LeavesATraceInTheLog()
    {
        var replayed = await LoginAsync();
        await RotateAsync(replayed); // 輪替 ⇒ replayed 被標成已撤銷
        // 寬限窗（D1）：同上一支——要驗的是**窗外**的重放留痕，先把撤銷時刻推出去。
        await MutateTokenAsync(replayed, expiresAt: null, revokedAt: DateTime.UtcNow.AddSeconds(-10));
        var userId = await UserIdOfAsync(replayed);

        // 同一個類別共用一條 factory ⇒ 前面幾支觸發的重放還在捕獲裡，先清乾淨才問得準
        _factory.LogCapture.Clear();

        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(replayed));

        // 條件收在**這一支的使用者**上，不是「本類別的所有警告」：日後 `JwtTokenService`
        // 任何地方多一行 `LogWarning`（例如 `IssueTokensAsync`——本檔每一次 `LoginAsync()` 都
        // 會走到它），收在類別層級的 `Single` 會為了一個無關的理由變紅，而那個紅燈讀起來
        // 像是「重放偵測壞了」。收在 UserId 上，這一支紅的時候就是它要說的那件事。
        //
        // 用 Single 而不是 FirstOrDefault——**欄位不見時要當場紅**（0 筆 ⇒ Single 失敗），
        // 不是拿到 null 再比對失敗。斷言**結構化的欄位**而不是訊息的文字：文案會改，
        // 欄位名 `{UserId}` 才是契約。
        var matches = _factory.LogCapture.Entries
            .Where(e => e.Category == typeof(JwtTokenService).FullName)
            .Where(e => e.State.Any(kv => kv.Key == "UserId" && kv.Value is Guid id && id == userId))
            .ToList();
        var entry = Assert.Single(matches);

        Assert.Equal(LogLevel.Warning, entry.Level);
    }

    // 反向對照（與上面那一支成對）：**沒有觸發重放的路徑不得留下痕跡**。
    // 少了這一支，「不小心把 LogWarning 挪到 `stored is null` 那個分支」不會有任何紅燈
    // ——而那一支是任何人送隨機字串都會走到的路（DoS 面），在那裡記警告等於讓未經驗證的
    // 呼叫端決定日誌量。
    //
    // 範圍講清楚：捕獲只收 `Warning` 以上 ⇒ 這一支管的是**警告**。把痕跡降級成
    // `Information` 會落在它的視野外，而那是刻意的——這個機制的契約是「重放要被看見」，
    // 不是「每一個失敗分支都要寫流水帳」。
    [Fact]
    public async Task ForgedToken_LeavesNoTraceInTheLog()
    {
        var live = await LoginAsync();
        _factory.LogCapture.Clear();

        var forged = Convert.ToHexString(RandomNumberGenerator.GetBytes(64));
        Assert.Equal(HttpStatusCode.Unauthorized, await RefreshStatusAsync(forged));

        Assert.DoesNotContain(_factory.LogCapture.Entries,
            e => e.Category == typeof(JwtTokenService).FullName);

        // 連帶確認這一支沒有走進重放分支（否則它會把 live 也撤銷掉）
        Assert.Equal(HttpStatusCode.OK, await RefreshStatusAsync(live));
    }
}
