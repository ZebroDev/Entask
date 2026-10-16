using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Identity.Options;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Entask.Tests;

// 涵蓋「環境完全未設定 Jwt:Issuer / Jwt:Audience」這條路徑的端到端登入。
//
// 為何需要：其他測試用的 ApiWebApplicationFactory 永遠明確設定這兩個鍵，這條路徑從未被走到。
// 歷史脈絡：這兩個預設值原本是兩份獨立的字面值（JwtOptions 的屬性初始化 vs Program.cs 的
// ?? fallback），只改一邊就會「登入簽得出 token、但後續每個請求都 401」，而 CI 抓不到。
// 現已收斂為單一來源（見 Program.cs 的 Configure<IOptions<JwtOptions>>），故本測試的定位是
// 契約鎖——守住「未設定 issuer 的環境必須能登入」，而不是重現某個特定缺陷。
//
// ★ **分辨力的邊界（2026-09-25 實測，不要把這一檔讀成「來源已經守住了」）**：
//   `appsettings.Development.json` 給的兩個值與 `JwtOptions` 的屬性預設值**一字不差**
//   （entask／entask-web）⇒ 在這裡「值從哪個來源來」是**量不出來的**：上面的前提斷言
//   在修正前後都成立（修正前 eager 讀拿到的是 appsettings 的值、不是預設值，而兩者同值）。
//   **釘住來源的是 `JwtConfigSourceTests`**（注入可辨識的值）。
//   本檔守住的是另一半、同樣重要的一件：**這條路徑（完全未設定）要能走完登入與授權**。
public class JwtDefaultLiteralTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public JwtDefaultLiteralTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.OmitJwtIssuerAudience = true;
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Login_ThenAuthorizedRequest_Succeeds_WithDefaultIssuerAndAudience()
    {
        // 前提斷言：**最終組態裡這兩個鍵必須是空的**。
        // ★ 它守的**不是**「appsettings 有沒有提供」——`ApiWebApplicationFactory` 的 Omit 分支
        //   是以**顯式 null 遮蔽**較早的來源，而那個遮蔽對 `Configure<T>` 的綁定同樣有效
        //   （2026-09-25 複閱時以探針當場量到）⇒ appsettings 哪天補回這兩個鍵，這裡照樣是 null、
        //   這一條照樣綠。（本檔原本寫「會在此變紅」，那句是錯的。）
        var config = _factory.Services.GetRequiredService<IConfiguration>();
        Assert.Null(config["Jwt:Issuer"]);
        Assert.Null(config["Jwt:Audience"]);

        // 實際生效的設定（不是 raw config）：
        // 第一組**錨在 `JwtOptions` 的屬性預設值**（不是兩邊互相對比）——這樣「正規化被拿掉、
        // 值變成 null」當場就紅（互相對比時 `Assert.Equal(null, null)` 會過）。
        // 第二組要求兩端同值：簽發端與驗證端若分岔，下面那個請求會是 401，
        // 但那種失敗看不出是哪一邊走鐘。
        var effective = _factory.Services.GetRequiredService<IOptions<JwtOptions>>().Value;
        var bearer = _factory.Services.GetRequiredService<IOptionsMonitor<JwtBearerOptions>>()
            .Get(JwtBearerDefaults.AuthenticationScheme);
        var defaults = new JwtOptions();
        Assert.Equal(defaults.Issuer, effective.Issuer);
        Assert.Equal(defaults.Audience, effective.Audience);
        Assert.Equal(effective.Issuer, bearer.TokenValidationParameters.ValidIssuer);
        Assert.Equal(effective.Audience, bearer.TokenValidationParameters.ValidAudience);

        var seed = _factory.SeedCredentials();
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/projects");
        request.Headers.Authorization = new("Bearer", token);

        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(request)).StatusCode);
    }
}
