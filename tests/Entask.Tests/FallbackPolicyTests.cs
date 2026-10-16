using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

// `FallbackPolicy`（2026-10-10）的**行為**鎖。被鎖的是 `Program.cs` 的
// `AddAuthorization(options => options.FallbackPolicy = ...RequireAuthenticatedUser())`：
// 授權的預設由「沒宣告就是沒要求」翻成「沒宣告就是需登入」（fail-closed）。
//
// 這一檔只斷言 HTTP 看得見的東西（狀態碼、Content-Type、body 的 `code`），**不看**
// `AuthorizationOptions.FallbackPolicy` 的 metadata——「政策有設」與「政策真的生效」是兩件事，
// 而後者才是要守的。
//
// ★ **判別力邊界（實測 2026-10-10，別把這一檔讀得比實際更強）**：
//   改動前，`EndpointAuthorizationGuardTests.EveryRouteEndpoint_DeclaresItsAuthenticationIntent`
//   是**綠的** ⇒ 端點圖上**每一條**端點都已經有 `RequireAuthorization()` 或 `AllowAnonymous()`
//   ⇒ **有 `RequireAuthorization()` 的那些**在加 fallback 之前就已經是 401（`GET /api/projects`
//   匿名拿到的是 `auth.unauthenticated`，不是 200——既有測試 `AuthErrorBodyTests` 早就釘著它）；
//   而**掛 `AllowAnonymous()` 的那幾條一直是匿名可用的**（改動前後都一樣，②就是它的鎖）。
//   因此①②③三支是**回歸鎖**（fallback 不得把它們弄壞），不是「改動前會紅」的那一種；
//   這一檔裡**改動前會紅的那一支是④**：路由不認得的路徑。
public class FallbackPolicyTests : IClassFixture<ApiWebApplicationFactory>
{
    // 401 的**唯一產生點**是 `ApiResults`（`Program.cs` 的 `OnChallenge` 走
    // `WriteUnauthorizedAsync`）。碼的字面值照 `AuthErrorBodyTests` 的既有慣例寫成常數、
    // **不從 `ErrorCodes` 取**——那樣才抓得到「那個常數被改掉」。
    private const string UnauthenticatedCode = "auth.unauthenticated";

    private readonly ApiWebApplicationFactory _factory;

    public FallbackPolicyTests(ApiWebApplicationFactory factory)
    {
        // ③ 要真的登入成功，而登入讀的是 seed 出來的帳號 ⇒ 這一類要一份有 Identity 資料表的庫
        // （`HealthTests`／`PermissionCatalogTests` 同一個形狀）。
        factory.WithDbReset();
        _factory = factory;
    }

    // ① 代表性端點：匿名 ⇒ 401（不是 200、也不是 handler 自己的回應）。
    //
    // `GET /api/projects` 取自 `Declared` 的「查詢內以成員資格收斂」那一類——它的授權本來就來自
    // `RequireAuthorization()`（`authorizeData` 非空 ⇒ `CombineAsync` 組合得出政策 ⇒ **fallback
    // 根本不會被用到**）。所以這一支守的不是「fallback 生效」，而是**加了 fallback 之後那條路徑
    // 的回應一個位元都沒變**：同一個產生點（認證挑戰 → `OnChallenge`）、同樣的四項。
    //
    // ★ 這一支在改動前就是綠的（原因見檔頭）——**不要**把它當成「fallback 生效」的證據；
    //    它守的是「fallback 沒有把既有端點的回應形狀改掉」。
    [Fact]
    public async Task Anonymous_OnRepresentativeEndpoint_IsRejected()
    {
        var client = _factory.CreateClient();
        var res = await client.GetAsync("/api/projects");
        await AssertChallengeAsync(res);
    }

    // ② 明示匿名（`.AllowAnonymous()`）的端點不受影響：`AuthorizationMiddleware` 在
    //    「端點有沒有 `IAllowAnonymous`」那一格就 return 了，fallback 到不了那裡。
    //    健康探針是最便宜的那一條，而它是**本批 T6 加入的那三處 healthcheck 的標的**
    //    （`docs/superpowers/plans/2026-10-10-entask-pre-release-hardening.md` 的 T6 Step 5／6：
    //    `Dockerfile.fly` 的 `HEALTHCHECK`／compose 的 app／`fly.toml` 的 `[[http_service.checks]]`）
    //    ——**在那之前**（2026-10-10 實查）沒有任何部署探針打它：`fly.toml` 無
    //    `[[http_service.checks]]`、`Dockerfile.fly` 無 `HEALTHCHECK`。它若被收成 401，
    //    那些 healthcheck 會把容器判死——fail-closed 最典型的誤傷。
    [Fact]
    public async Task Anonymous_OnHealth_StaysOk()
    {
        var client = _factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/health")).StatusCode);
    }

    // ② 的另一半：登入本身必須保持匿名。它掛著明示的 `.AllowAnonymous()`，而這是**唯一的**
    //    取得憑證的入口——它若被 fallback 收掉，所有人（包括第一個使用者）都進不來。
    [Fact]
    public async Task Anonymous_CanStillLogIn()
    {
        var client = _factory.CreateClient();
        var seed = _factory.SeedCredentials();
        var res = await client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    // ④ **這一支才是改動前會紅的那一支**：路由不認得的路徑（沒有端點可匹配）⇒ 一律挑戰。
    //
    //    沒有 fallback policy 時，「沒有端點」等於「授權中介層沒有任何要求」⇒ 404（請求一路走到
    //    管線尾端）。有 fallback policy 時，`AuthorizationPolicy.CombineAsync` 對空的
    //    `authorizeData` 回 null ⇒ 落到 `options.FallbackPolicy` ⇒ 401。
    //    **它與「端點存在但忘了宣告」走的是同一格**（兩者的 `authorizeData` 都是空的），
    //    差別只在後者今天在端點圖上不存在——`EveryRouteEndpoint_DeclaresItsAuthenticationIntent`
    //    是綠的，也就是說每一條端點都宣告過了（見檔頭）。
    //
    //    **路徑一定要帶點**（`.json`），而且這一點是實測逼出來的、不是推理：SPA fallback 的
    //    pattern 是 `GET,HEAD /{*path:nonfile}`（端點圖實測值），而 `nonfile` 只排除「最後一段
    //    帶點」的路徑——**路徑本身仍然是一條候選**。所以
    //      POST /api/fallback-policy-probe      ⇒ **改動前 405**（候選命中路徑、方法不合；實測。
    //                                               改動後是 401——`Program.cs` 那一格的註解）
    //      GET  /api/fallback-policy-probe      ⇒ **本機** SPA fallback 命中 ⇒ `.AllowAnonymous()`
    //                                               ⇒ 這一支會變成在測②（200 的 HTML）；這一條
    //                                               只在 `wwwroot/index.html` 存在時成立（那個
    //                                               目錄被 gitignore，同 guard test 的盲區④）
    //    兩種都不是「沒有端點」。帶點的路徑才是真的沒有候選（`nonfile` 當場排除它）。
    [Fact]
    public async Task Anonymous_OnUnroutedPath_IsChallenged()
    {
        var client = _factory.CreateClient();
        var res = await client.GetAsync("/api/fallback-policy-probe.json");
        await AssertChallengeAsync(res);
    }

    // 401 家族一律是這個形狀（沿 `AuthErrorBodyTests.AssertUnauthorizedAsync` 的兩條理由）：
    // 只斷言狀態碼的話，「有 body」與「空 body」兩種實作都綠；只斷言 body 的話，
    // 「403 帶同一個碼」也會綠。四項一起才是「同一個產生點」的證據。
    private static async Task AssertChallengeAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/json; charset=utf-8", response.Content.Headers.ContentType?.ToString());

        var raw = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        Assert.Equal(UnauthenticatedCode, doc.RootElement.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(doc.RootElement.GetProperty("message").GetString()));
    }
}
