using System.Net;
using Microsoft.AspNetCore.Hosting;

namespace Entask.Tests;

// 基線安全標頭（2026-10-10）的**行為**鎖。被鎖的是 `Program.cs` 管線最前面那一段
// （`X-Content-Type-Options`／`Referrer-Policy`／`X-Frame-Options`／
// `Content-Security-Policy` 四個回應標頭）。
//
// ★ **HSTS 不在這一檔的射程內，這是實查過的限制、不是省略**：`UseHsts()` 只在 **HTTPS**
//   回應上加 `Strict-Transport-Security`，而 `WebApplicationFactory` 跑的是記憶體內的
//   HTTP 管線（沒有 TLS）⇒ 它在本檔恆不觸發。HSTS 的驗收靠 `UseHsts` 的既有語意（框架實作）
//   ＋ 部署觀測，不靠這裡的斷言。★ 2026-10-12 起 `ForwardedHeadersTests` 用 forwarded
//   proto 標頭在測試 host 就驗得到它（那條路徑不在本檔——本檔不帶 forwarded 標頭）。
//
// ★ 判別力（2026-10-10 當場做過這次突變）：拿掉 `Program.cs` 那一顆標頭中介層 ⇒ 三支斷言
//   全部紅（`GetValues` 對不存在的標頭拋 `InvalidOperationException`）；還原後再跑一次綠。
//
// ★ 標的取 `/api/health`：它掛明示的 `.AllowAnonymous()`，是 T6 加入的三處 healthcheck
//   （`Dockerfile.fly`／compose 的 app／`fly.toml`）實際打的那一條，而且不需要 seed 資料
//   以外的任何東西。**刻意不取靜態檔路徑**：`wwwroot` 被 gitignore（本機有、CI 沒有），
//   拿它當標的會讓這一檔在 CI 上恆紅或恆綠——那不是判別力，是環境相依。
public class SecurityHeaderTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public SecurityHeaderTests(ApiWebApplicationFactory factory)
    {
        // App 啟動會跑遷移 ＋ AdminSeed（需 Identity 資料表），故每個測試 class 的 host
        // 都要先重置 DB（`HealthTests` 同一個形狀）。
        factory.WithDbReset();
        _factory = factory;
    }

    [Fact]
    public async Task HealthResponse_CarriesBaselineSecurityHeaders()
    {
        var res = await _factory.CreateClient().GetAsync("/api/health");
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("no-referrer", res.Headers.GetValues("Referrer-Policy").Single());
        Assert.Equal("DENY", res.Headers.GetValues("X-Frame-Options").Single());
    }

    // CSP（2026-10-12）。字面值在測試端逐字重複一份是刻意的：它是**契約**，
    // 不是實作的鏡像——改了政策就會紅，改的人必須來說明為什麼。
    private const string CspPolicy =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
        + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    [Fact]
    public async Task HealthResponse_CarriesCsp()
    {
        var res = await _factory.CreateClient().GetAsync("/api/health");
        Assert.Equal(CspPolicy, res.Headers.GetValues("Content-Security-Policy").Single());
    }

    // Swagger 路徑是唯一豁免（Swagger UI 自帶 inline script）。**這一格量到的形狀是 401**
    // （2026-10-12 實測）：`UseAuthorization`（`Program.cs:377`）跑在 `UseSwaggerUI`
    // （`:443`）之前，而帶點的最後一段被 SPA fallback 的 `nonfile` 排除 ⇒ 沒有候選端點
    // ⇒ fallback policy 挑戰它（同 `FallbackPolicyTests.Anonymous_OnUnroutedPath_IsChallenged`
    // 的形狀）。豁免是**路徑述詞**、與狀態碼無關：401 的回應照樣經過那一顆中介層
    // （三個基線標頭在 401 上也在，已實測；這一格把 `X-Content-Type-Options` 一起鎖住）
    // ⇒ 少了豁免，CSP 就會跟著出現在這一格。
    // ★ 這一格同時是「Swagger 落在 fallback 授權之後」的第一個**實測**（2026-10-10 那批
    //   只記成推論）；若日後有人把它移到授權之前（dev 的 SwaggerUI 匿名可達），這一格
    //   會紅——那時把狀態碼期望改成 200 並在 history 記一筆，不要只改期望值。
    [Fact]
    public async Task SwaggerPath_IsExemptFromCsp()
    {
        var res = await _factory.CreateClient().GetAsync("/swagger/index.html");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.False(res.Headers.Contains("Content-Security-Policy"));
    }

    // 豁免**只在 Development**（2026-10-12 複審裁定）：非 Development 時 Swagger 沒掛載，
    // 但那兩個不帶點的形狀（`/swagger`、`/swagger/`）會落到 SPA fallback ⇒ 少了這一格，
    // 正式站會用**沒有 CSP** 的殼回應一個公開可達的 URL。
    // ★ 用 `WithWebHostBuilder` 疊出來（**不動**共用 fixture 的 `EnvironmentOverride`——
    //   那會在 host 已建好之後才設，變成順序相依的假測試）；子層的 `UseEnvironment` 勝過
    //   父層。
    // ★ **這一顆 derived host 會跑一次 DB reset**（2026-10-12 複審實查；原本這裡寫的是
    //   反話「不必、也不該再跑一次」）：derived host 是**一棵新的 host**，`WithWebHostBuilder`
    //   會在那顆 builder 上**再執行一次** `ApiWebApplicationFactory.ConfigureWebHost`
    //   （`ApiWebApplicationFactory.cs`，含 `if (_pendingReset)` 那一段 reset）；本類別建構子
    //   每一支測試都設 `WithDbReset()`，而建這顆 host 之前沒有別的 host 建置消費它 ⇒
    //   這裡照樣 `EnsureDeletedAsync` ＋ `MigrateAsync`——那正是已知 transient
    //   （`42501 permission denied to terminate process`）的站點。
    //   為什麼這樣仍然可以接受：環境在**建 host 的那一刻**定型、之後改不動，而這一格要驗的
    //   就是「非 Development 的 host」⇒ 只能走 derived host 這條路；代價是一次冪等的重置
    //   （同一條連線、同一個測試 DB），換到的是「Swagger 豁免只在 Development」這條契約。
    //   若這一格真的紅在 reset，先孤立重跑（判準見 `AGENTS.md`〈已知 transient〉），
    //   不要動測試基建。
    // ★ 刻意**只斷言標頭、不斷言狀態碼**：本機有 `wwwroot/index.html` ⇒ 200（殼）；
    //   乾淨 clone／CI 沒有那個檔（`Program.cs:418` 的閘）⇒ 401。兩種都必須帶 CSP。
    [Fact]
    public async Task NonDevelopment_SwaggerPath_StillCarriesCsp()
    {
        var prod = _factory.WithWebHostBuilder(b => b.UseEnvironment("Production"));
        var res = await prod.CreateClient().GetAsync("/swagger");
        Assert.Equal(CspPolicy, res.Headers.GetValues("Content-Security-Policy").Single());
    }
}
