namespace Entask.Api.Options;

/// <summary>
/// 列舉面限流的設定（section <c>RateLimit</c>）。**預設值只在屬性初始化定義一次**
/// （照 <see cref="Entask.Identity.Options.JwtOptions"/> 的先例）。
///
/// ★ **它刻意不註冊進 DI**（沒有 <c>builder.Services.Configure&lt;RateLimitOptions&gt;(...)</c>）：
/// <c>AddRateLimiter</c> 的 configure 回呼在**啟動時**就跑，而
/// <c>AddRateLimiter(Action&lt;RateLimiterOptions&gt;)</c> 沒有帶 <c>IServiceProvider</c> 的多載
/// ——在回呼裡自建容器是**另一個**容器。所以值在 <c>Program.cs</c> 當場讀定、做完非法值
/// 回退之後直接餵給政策。**註冊一個沒有消費者的 options 是有害的**：下一個人會以為
/// 「改 DI 裡的值有效」，而那個旋鈕沒有任何效果。
///
/// 今天**兩個**端點共用同一個政策：<c>GET /api/auth/users/search</c> 與
/// <c>GET /api/projects/{projectId}/search</c>——兩者都是「輸入驅動的批次讀取」＝列舉面。
/// <c>GET /api/users</c> 刻意**不在**裡面：它的回應是固定的團隊名冊、不隨輸入變化，
/// 重複取用不會多得到資訊，限它只有誤傷的風險（2026-09-24 裁定 D1）。
/// </summary>
public class RateLimitOptions
{
    public const string Section = "RateLimit";

    /// <summary>每個分區（＝每個使用者）在窗內允許的請求數。</summary>
    public int PermitLimit { get; set; } = 60;

    /// <summary>窗寬（秒）。</summary>
    public int WindowSeconds { get; set; } = 60;

    /// <summary>
    /// 窗切成幾個**補充週期**（＝限流器每 <see cref="WindowSeconds"/> /
    /// <see cref="SegmentsPerWindow"/> 秒還一次額度）。60 秒窗、6 段 ⇒ 每 10 秒還 10 個，
    /// 而不是整整 60 秒後一次歸零。
    /// </summary>
    public int SegmentsPerWindow { get; set; } = 6;

    /// <summary>
    /// 實際使用的段數：夾在 <c>[1, max(1, PermitLimit)]</c>。**上界是為了守住「有效速率
    /// 不得高於設定的速率」**——`PermitLimit` 2、`SegmentsPerWindow` 6 時，不夾住就會變成
    /// 「每 10 秒還 1 個」＝每分鐘 6 個，是設定值的 3 倍，而且沒有任何地方會出聲。
    /// 夾住之後是每 30 秒 1 個＝每分鐘 2 個，恰好等於設定值。
    /// （下界 1 是為了讓尚未正規化的 0／負值仍然讀得出來——`Program.cs` 會先把它換成預設值。）
    /// </summary>
    private int EffectiveSegments => Math.Clamp(SegmentsPerWindow, 1, Math.Max(1, PermitLimit));

    /// <summary>
    /// 每個補充週期還幾個名額。**由 <see cref="PermitLimit"/> ÷
    /// <see cref="EffectiveSegments"/> 推導，不另外設定**——兩個旋鈕各設一次就是兩個事實。
    ///
    /// **整數除法、下取整**：不能整除時（例：PermitLimit 10、Segments 3 ⇒ 3 個／20 秒
    /// ＝ 每分鐘 9 個）有效速率會**略低於** <c>PermitLimit</c>——方向是刻意的（寧可少給，
    /// 不可多給）。預設組合（60 ÷ 6）整除 ⇒ 有效速率就是每分鐘 60。**要精確就挑能整除的
    /// 組合**；這裡刻意不做「自動調整段數」那類補償，那只會讓設定值與實際值更難對上。
    /// 守門員是 `RateLimitOptionsTests`（純算術，不需要 host）。
    /// </summary>
    public int TokensPerPeriod => Math.Max(1, PermitLimit / EffectiveSegments);

    /// <summary>補充週期的長度（見 <see cref="TokensPerPeriod"/>）。</summary>
    public TimeSpan ReplenishmentPeriod =>
        TimeSpan.FromSeconds((double)WindowSeconds / EffectiveSegments);
}
