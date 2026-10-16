using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Identity.Options;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Entask.Tests;

// 設定**來源**的迴歸鎖（2026-09-25）。
//
// 守的是「晚到的來源必須生效」這條不變量——它過去不成立，而且**四道防線一道都不會響**：
// `Program.cs` 的 issuer／audience 當時是頂層 eager 讀，而 `builder.Configuration` 在
// `Build()` 之前並不完整（`ApiWebApplicationFactory` 注入的來源正是那個時候才掛上去的）
// ⇒ 那一格永遠看不到它，晚到的值被靜默丟掉。
//
// ★ **為什麼非有這一支不可**（而不是靠 `JwtDefaultLiteralTests`）：`appsettings.Development.json`
//   提供的兩個值與 `JwtOptions` 的屬性預設值**一字不差**（entask／entask-web）⇒「值讀到哪一個」
//   在值層面完全不可觀測，任何等值斷言在修正前後都是綠的。唯一有判別力的形狀是
//   **注入一個與預設值不同的可辨識值**（本檔），再斷言它有沒有到達兩個端點。
//   負向對照：把 `Program.cs` 的正規化改回頂層 eager 讀，本檔第一支的兩個 `Assert.Equal`
//   當場變紅（值停在 entask／entask-web）。
//
// 兩個端點都要斷言、且**都與對方對齊**（不是各自與常數比）：它們在修正前是兩個不同的讀取
// 時機（`PostConfigure` vs eager 區域變數），任一邊走鐘的後果都是「簽得出 token、但每個請求
// 都 401」——那種症狀沒有紅燈指名成因，這裡的等值斷言有。
public class JwtConfigSourceTests : IClassFixture<ApiWebApplicationFactory>
{
    private const string Issuer = "late-source-issuer";
    private const string Audience = "late-source-audience";

    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public JwtConfigSourceTests(ApiWebApplicationFactory factory)
    {
        // 值必須在 `CreateClient()` **之前**設定：host 只建置一次，之後改屬性沒有作用
        // （與 `OmitJwtIssuerAudience` 同一個時機限制）。
        factory.JwtIssuerOverride = Issuer;
        factory.JwtAudienceOverride = Audience;
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public void LateInjectedValues_ReachBothTheSigningAndTheValidationSide()
    {
        var jwt = _factory.Services.GetRequiredService<IOptions<JwtOptions>>().Value;
        Assert.Equal(Issuer, jwt.Issuer);
        Assert.Equal(Audience, jwt.Audience);

        var bearer = _factory.Services
            .GetRequiredService<IOptionsMonitor<JwtBearerOptions>>()
            .Get(JwtBearerDefaults.AuthenticationScheme);
        Assert.Equal(jwt.Issuer, bearer.TokenValidationParameters.ValidIssuer);
        Assert.Equal(jwt.Audience, bearer.TokenValidationParameters.ValidAudience);
    }

    [Fact]
    public async Task LateInjectedValues_SignAndValidateRealTokens()
    {
        // 上一支證明「讀到了」，這一支證明那份設定在**活的管線**上真的被用到——包含
        // 簽發端寫進 token 的 `iss`／`aud`（值層面唯一看得到簽發端的地方）。
        var seed = _factory.SeedCredentials();
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        var parsed = new JwtSecurityTokenHandler().ReadJwtToken(token);
        Assert.Equal(Issuer, parsed.Issuer);
        Assert.Equal(Audience, parsed.Audiences.Single());

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/projects");
        request.Headers.Authorization = new("Bearer", token);

        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(request)).StatusCode);
    }
}
