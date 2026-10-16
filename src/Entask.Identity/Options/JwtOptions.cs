namespace Entask.Identity.Options;

public class JwtOptions
{
    public const string Section = "Jwt";
    public string Secret { get; set; } = "";
    // 預設值只在這裡定義。`Program.cs` 的正規化（PostConfigure<JwtOptions>）以
    // `new JwtOptions()` 讀它，而簽發端（JwtTokenService）與驗證端（JwtBearerOptions 的
    // TokenValidationParameters）吃的是**同一個** `IOptions<JwtOptions>` ⇒ 兩者必然一致。
    // 改這裡的值即同時改變兩端——不要（也不需要）在 ValidIssuer 之類的地方另寫字面值。
    public string Issuer { get; set; } = "entask";
    public string Audience { get; set; } = "entask-web";
    public int AccessTokenMinutes { get; set; } = 30;
    public int RefreshTokenDays { get; set; } = 14;

    // 寬限窗（秒）：只給 `RevokedReasons.Replaced`。多分頁競態的窗寬 ≈ 一次輪替往返，
    // 開發時 DB 跨網段（不在本機）⇒ 數十至數百毫秒。設 0 即關閉（恢復「一被輪替就判重放」）。
    public int RefreshGraceSeconds { get; set; } = 5;
}
