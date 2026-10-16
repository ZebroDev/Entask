namespace Entask.Core;

/// <summary>refresh token 的撤銷原因。只有 `Replaced` 享有寬限窗
/// （見 `JwtTokenService.RefreshAsync` 與 `docs/STATE.md` 的 ②）。
/// **新增任何撤銷路徑時必須蓋原因**——判準是「分流的輸入是原因，不是時間」，
/// 漏蓋會靜默落進 fail-safe 或靜默取得寬限，兩種都不會有紅燈
/// （`docs/invariants/07-refresh-tokens.md`）。守門員是 `RevokedReasonsTests`。</summary>
public static class RevokedReasons
{
    public const string Logout = "logout";
    public const string Replaced = "replaced";
    public const string ReplayDetected = "replay_detected";

    /// <summary>管理員停用帳號時撤銷該使用者的全部有效 session（2026-10-07）。
    /// **不享寬限窗**（窗只認 `Replaced`）——停用不是競態，沒有理由容忍。</summary>
    public const string Deactivated = "deactivated";

    /// <summary>密碼變更時撤銷該使用者的全部有效 session（2026-10-08，外部報告 C 類第 2 條；
    /// 同日稍後納入管理員重設——`POST /api/admin/users/{userId:guid}/reset-password`）。
    /// **不享寬限窗**（窗只認 `Replaced`）——改密碼不是競態。
    ///
    /// **為什麼不為管理員重設另開一個原因**：兩者的分流行為逐位元相同（都是 logout 同類
    /// ——token 已死、回 null、不連坐撤銷其他 session），而 `JwtTokenService.RefreshAsync`
    /// 的分流判準是「分流的輸入是原因」。新原因沒有對應的臂時會**靜默落進 fail-safe**
    /// （撤銷該使用者所有現行 session ＋ 記一筆假重放的警告），買到的只有診斷顆粒度，
    /// 而「誰做的」本來就記在 `AuditLog`。守門員是
    /// `AdminPasswordResetTests.Reset_StampsPasswordChangedReason`。</summary>
    public const string PasswordChanged = "password_changed";

    public static readonly string[] All = [Logout, Replaced, ReplayDetected, Deactivated, PasswordChanged];
}
