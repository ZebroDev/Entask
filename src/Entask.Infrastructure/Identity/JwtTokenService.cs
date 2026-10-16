using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Identity.Options;
using Entask.Infrastructure.Data;

namespace Entask.Infrastructure.Identity;

public class JwtTokenService
{
    private readonly JwtOptions _options;
    private readonly EntaskDbContext _db;
    private readonly ILogger<JwtTokenService> _logger;

    public JwtTokenService(IOptions<JwtOptions> options, EntaskDbContext db, ILogger<JwtTokenService> logger)
    {
        _options = options.Value;
        _db = db;
        _logger = logger;
    }

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private string CreateAccessToken(ApplicationUser user, bool isAdmin)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.UniqueName, user.UserName ?? ""),
            new("displayName", user.DisplayName),
        };
        if (isAdmin) claims.Add(new Claim(AdminClaim.Type, AdminClaim.Value));

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Secret));
        var token = new JwtSecurityToken(
            issuer: _options.Issuer,
            audience: _options.Audience,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(_options.AccessTokenMinutes),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string CreateRefreshTokenValue() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(64));

    public async Task<(string AccessToken, string RefreshToken)> IssueTokensAsync(
        ApplicationUser user, string? ip, bool isAdmin)
    {
        var refreshValue = CreateRefreshTokenValue();
        _db.RefreshTokens.Add(new RefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = Hash(refreshValue),
            ExpiresAt = DateTime.UtcNow.AddDays(_options.RefreshTokenDays),
            CreatedByIp = ip,
            CreatedAt = DateTime.UtcNow,
        });
        await _db.SaveChangesAsync();

        return (CreateAccessToken(user, isAdmin), refreshValue);
    }

    public async Task<(string AccessToken, string RefreshToken)?> RefreshAsync(string refreshToken, string? ip)
    {
        var hash = Hash(refreshToken);
        var stored = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash);

        // 三種失敗刻意分開寫，因為它們的**處置不同**（原本是一條 `||` 串起來的）。
        //
        // ① 查不到 ⇒ 只回 null，**不觸發全體撤銷**。token 值本身就是秘密，任何人送一串
        //    隨機字串都會走到這裡；如果在這裡撤銷，等於開了一個「不必先竊得任何東西」
        //    的全體登出開關（DoS）。
        if (stored is null) return null;

        // ② 已撤銷的 token 又被送來。**處置依「當初為什麼撤銷」分成五種**（2026-09-23；第四種 2026-10-07；第五種 2026-10-08）：
        //    ① 輪替（`replaced`）：正常客戶端手上不會留著它 ⇒ 還會拿它來換的只有
        //       「當初就沒換到的那一份」——最常見的成因是**多分頁競態**（兩個分頁共用
        //       localStorage 的同一份 token，去重用的 `refreshing` 卻是 per-page 的）。
        //       輪替後 N 秒內視為良性競態：發一組新的（不回同一組——DB 只存雜湊）。
        //       **代價（刻意接受，三條都要一起讀）**：
        //       (a) 窗內被竊的 token 也換得到，且窗內不限次數（不記 `GraceUsedAt`）。
        //       (b) **窗不是只有競態才會開**：`Replaced` 是「輪替」蓋的章，而**攻擊者
        //           自己第一次用那顆偷來的 live token 就是一次輪替** ⇒ 他**自己**開窗，
        //           全程不必有任何競態。不要把上面那句反推成「沒有競態就沒有窗」。
        //       (c) **登出殺不掉窗內那顆**：`RevokeAsync` 只對 `RevokedAt is null` 的列
        //           生效 ⇒ t0 被 `Replaced` 的 token，即使 t0+2s 登出，仍可換到 t0+5s。
        //    ② 登出（`logout`）：token 已死，回 null 即可——**不撤銷其他 session**
        //       （登出那一刻在途中的 refresh 不該讓手機一起被登出）。
        //       **代價（刻意接受）**：這一支**不記警告**，所以「受害者已登出、token 卻
        //       還被用」這個**強盜用訊號**在改動後不再留下痕跡。這是**丟掉**訊號、不是
        //       漏掉——在途中的 refresh 與攻擊者的使用在 t+0 長得一樣，伺服器端分不開。
        //    ③ 停用（`deactivated`，2026-10-07 新增）：與登出同類——token 已死，回 null 即可，
        //       **不撤銷其他 session**。少了這一格它會落進 ⑤，把「復原之後重新登入的新 session」
        //       當成重放連坐撤銷（見 ⑤ 的理由），而真正的持有者早在停用那一刻就被登出了
        //       ——那是**假重放**。**代價（刻意接受）**：與登出同構，這一支同樣不記警告。
        //       出處：final review I-1。判準是 `docs/invariants/07-refresh-tokens.md`
        //       （分流的輸入是「原因」——新的撤銷路徑若沒有對應的臂，就會靜默落進 fail-safe）。
        //    ④ 密碼變更（`password_changed`，2026-10-08 新增）：與登出同類——token 已死，回 null 即可，
        //       **不撤銷其他 session**。少了這一格它會落進 ⑤，把「改密碼之後重新登入的新
        //       session」當成重放連坐撤銷——那是**假重放**。**代價（刻意接受）**：與登出同構，
        //       這一支同樣不記警告。出處：外部報告 C 類第 2 條（2026-10-07 核實）。
        //       **兩個來源共用它**：使用者改自己的密碼（`PUT /api/me/password`）與管理員重設
        //       （`POST /api/admin/users/{userId:guid}/reset-password`，2026-10-08 納入）。刻意不為後者
        //       另開原因——兩者的分流行為逐位元相同，而新原因沒有對應的臂時會**靜默落進 ⑤**
        //       （理由全文見 `RevokedReasons.PasswordChanged` 的註解）。
        //    ⑤ 重放處置留下的（`replay_detected`）／原因不明（null，既有列）／**未被分流的理由**：
        //       維持最安全的處置，撤銷該使用者所有現行 session。`Logout`（②）與 `Deactivated`（③）
        //       ／`PasswordChanged`（④）在自己的臂就返回；`Replaced`（①）**只有未過期且在寬限窗內**
        //       才走窗——**窗外與已過期的 `replaced` 落到這裡是刻意的**（那正是輪替重放偵測本身，見
        //       `docs/invariants/07-refresh-tokens.md`）。
        if (stored.RevokedAt is not null)
        {
            if (stored.RevokedReason == RevokedReasons.Replaced &&
                stored.ExpiresAt >= DateTime.UtcNow && // 已過期的不給寬限（維持「過期就換不到東西」的既有裁定）
                stored.RevokedAt >= DateTime.UtcNow.AddSeconds(-_options.RefreshGraceSeconds))
            {
                return await LoadAndIssueAsync(stored.UserId, ip);
            }

            if (stored.RevokedReason == RevokedReasons.Logout) return null;

            // 停用是 logout 同類（③ 的長註解）：停用時撤銷的是**當時**那一批 session；
            // 復原之後使用者重新登入建立的是**新** session，不該被一台舊筆電手上的死
            // token 連坐掃掉。
            if (stored.RevokedReason == RevokedReasons.Deactivated) return null;

            // 密碼變更是 logout 同類（見上方 ④ 的長註解）：改密碼（使用者自己改或管理員重設）
            // 時撤銷的是**當時**那一批 session；之後用新密碼重新登入建立的是**新** session，
            // 不該被舊裝置手上的死 token 連坐掃掉。
            if (stored.RevokedReason == RevokedReasons.PasswordChanged) return null;

            // ⑤-a（2026-09-23）：**留痕**。在這一行之前，重放被偵測到的唯一外顯症狀是
            // 「該使用者的所有 session 同時失效」。留痕的判讀窗口此後是乾淨的：登出（②）／
            // 停用（③）／**密碼變更（④）**與良性競態（①）都已從這條路分流出去 ⇒ 走到這裡的
            // 就是真重放（或原因不明的既有列，fail-safe 同真重放）。
            //
            // **只記使用者與事實，不記 token**——任何片段都不行，token 值本身就是秘密
            // （`Hash()` 的存在就是為了讓 DB 裡不存它）。結構化欄位名 `{UserId}` 是契約：
            // 守門員 `RefreshTokenReplayTests.DetectsReplay_LeavesATraceInTheLog` 斷言的是
            // 這個欄位，不是訊息的文字。
            _logger.LogWarning(
                "Refresh token 重放偵測：使用者 {UserId} 的已撤銷 token 被再次使用，已撤銷其名下所有現行 session。",
                stored.UserId);
            await RevokeAllActiveAsync(stored.UserId, RevokedReasons.ReplayDetected);
            return null;
        }

        // ③ 自然過期 ⇒ 只回 null，同樣不觸發全體撤銷（同 ① 的 DoS 理由）。
        //    注意順序：**已撤銷且已過期**的 token 走的是 ②（規格寫的是「已撤銷」即為重放）
        //    ——這在舊 token 上是可達的，見 RefreshTokenReplayTests 的對應案例。
        if (stored.ExpiresAt < DateTime.UtcNow) return null;

        stored.RevokedAt = DateTime.UtcNow; // rotation：舊 token 立即失效
        stored.RevokedReason = RevokedReasons.Replaced;
        await _db.SaveChangesAsync();

        return await LoadAndIssueAsync(stored.UserId, ip);
    }

    /// <summary>載入使用者（含 admin claim 判斷）並簽發一組新的 token；使用者不存在時回 null。</summary>
    private async Task<(string AccessToken, string RefreshToken)?> LoadAndIssueAsync(Guid userId, string? ip)
    {
        var user = await _db.Users.FindAsync(userId);
        // 停用與刪除都在這裡被擋掉（設計 §4.4）。回 null ⇒ 端點回 `auth.sessionInvalid`，
        // **不揭露**是哪一種——`RefreshAsync` 本來就對「查不到／已撤銷／已過期」一視同仁，
        // 一個碼是它唯一誠實的解析度（`/refresh` 端點的既有註解）。
        if (user is null || user.DeletedAt is not null || user.DeactivatedAt is not null) return null;
        var claims = await _db.UserClaims.Where(c => c.UserId == userId).ToListAsync();
        var isAdmin = claims.Any(c => c.ClaimType == AdminClaim.Type && c.ClaimValue == AdminClaim.Value);
        return await IssueTokensAsync(user, ip, isAdmin);
    }

    /// <summary>
    /// 撤銷該使用者的**全部有效** session。**四個**呼叫端：
    /// ① 偵測到 refresh token 重放（`RevokeAllActiveAsync(userId, RevokedReasons.ReplayDetected)`，
    ///    本檔內）；
    /// ② 管理員停用帳號（`RevokeAllActiveAsync(userId, RevokedReasons.Deactivated)`，2026-10-07）。
    ///    復原**不**撤銷（撤銷是永久的，見 `reactivate` 的註解）；
    /// ③ 使用者變更自己的密碼（`RevokeAllActiveAsync(userId, RevokedReasons.PasswordChanged)`，
    ///    2026-10-08；站點在 `UserEndpoints.cs` 的 `PUT /api/me/password`）；
    /// ④ **管理員重設使用者的密碼**（同一個 `PasswordChanged`，2026-10-08 稍晚；
    ///    站點在 `AdminUserEndpoints.cs` 的 `POST /api/admin/users/{userId:guid}/reset-password`）。
    ///    ③ 與 ④ 共用同一個原因碼是刻意的——理由見 `RevokedReasons.PasswordChanged` 的註解。
    /// ★ **這份清單是索引，沒有機器守門員**（`RevokedReasonsTests` 只守 `RevokedReasons.All`
    /// 的集合，不守呼叫端）：新增或刪除呼叫端時**要回來改這裡**。
    ///
    /// **`reason` 是參數而不是寫死**：撤銷原因是**資料層的憑據**，而不變量是
    /// 「每一次新的撤銷都說得出為什麼」（`docs/invariants/07-refresh-tokens.md`）。
    /// 寫死的話，第二個呼叫端會靜默蓋上 `replay_detected`——錯誤的原因不會有任何紅燈。
    ///
    /// 停用**不享寬限窗**：窗只認 `Replaced`，而停用不是競態。
    ///
    /// rotation 的前提是「舊 token 只有一份、而且已經被換掉了」；一旦那份再次出現，
    /// 就無法分辨持有者是原主還是副本 ⇒ 兩邊一起登出，由使用者重新登入取得唯一的一份。
    /// 已過期的不必撤銷（它本來就換不到東西），故述詞含 `ExpiresAt > now`。
    /// 「原因為 null」保留給欄位存在之前就已撤銷的既有列（未知原因）⇒ 蓋章這件事**不是由
    /// 行為守住的**：守門員是 `RefreshTokenReplayTests.ReplayOfRotatedToken_RevokesEverySessionOfThatUser`
    /// 的 DB 層斷言（少了蓋章、只留 `RevokedAt`，沒有任何 HTTP 斷言會變紅）。
    /// </summary>
    public async Task RevokeAllActiveAsync(Guid userId, string reason)
    {
        var now = DateTime.UtcNow;
        var active = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedAt == null && t.ExpiresAt > now)
            .ToListAsync();
        if (active.Count == 0) return;

        foreach (var token in active) { token.RevokedAt = now; token.RevokedReason = reason; }
        await _db.SaveChangesAsync();
    }

    /// <summary>
    /// 使用者主動登出（`POST /api/auth/logout`）：只撤銷這一條。
    /// 蓋上 `RevokedReasons.Logout` 是關鍵——否則它與 rotation 留下的痕跡逐欄相同，
    /// 下次被送來時會走重放分支、把該使用者**其他** session 一起撤銷（`docs/STATE.md` ③）。
    /// </summary>
    public async Task RevokeAsync(string refreshToken)
    {
        var stored = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == Hash(refreshToken));
        if (stored is not null && stored.RevokedAt is null)
        {
            stored.RevokedAt = DateTime.UtcNow;
            stored.RevokedReason = RevokedReasons.Logout;
            await _db.SaveChangesAsync();
        }
    }
}
