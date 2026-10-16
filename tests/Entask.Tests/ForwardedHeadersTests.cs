using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Entask.Tests;

// 轉送標頭的端到端鎖（2026-10-12）。五格是 2x2 去掉一格 ＋ fly profile 的兩格：
//   (a) 受信任 peer ＋ X-Forwarded-Proto: https ⇒ HSTS 出現（forwarded proto 真的被消費）
//   (b) 受信任 peer ＋ 不帶標頭              ⇒ 無 HSTS（對照：HSTS 不是無條件出現）
//   (c) 不受信任 peer ＋ X-Forwarded-Proto: https ⇒ 無 HSTS（信任檢查生效）
//   (d) fly profile ＋ 偽造 X-Forwarded-Proto: https ⇒ 無 HSTS（標準標頭名不被看）
//   (e) fly profile ＋ Fly-Forwarded-Proto: https ⇒ HSTS 出現（信任全部 ＋ 標頭名映射）
// (d)/(e) 這一對是防偽的**判別依據**：少了任何一邊，標頭名可以悄悄退回 X-Forwarded-*。
// 每一格都先斷言 200（2026-10-12 修正輪）：HSTS 是**端點跑之前**就掛上去的 ⇒ 少了這一行，
// 404／500 也滿足五格的標頭斷言（「五格全綠」於是不再等於「請求真的走到 app」）。
// 為什麼要 Production 環境：`UseHsts()` 只在非 Development 掛（`Program.cs`）。
// 為什麼 peer 用 `IPAddress.IPv6Loopback`：它是框架 `KnownProxies` 的預設成員（精確命中；
// `127.0.0.1` 得繞一層 `::ffff:127.0.0.1/104` 的網路比對，多一個可失敗的環節）。
// 為什麼請求要指定非 localhost 的 Host：`HstsMiddleware` 對 `ExcludedHosts` 內的宿主不發
// 標頭，而框架預設清單含 `localhost`（**推論、未實查原始碼**——2026-10-12 找 GitHub 原始碼
// 兩條路徑皆 404），TestServer 的預設 base address 正是 `http://localhost`。指定一個普通
// 宿主在「前提成立」與「前提不成立」兩種情形下都安全；不指定則可能讓 (a)(e) 永遠紅。
public class ForwardedHeadersTests : IClassFixture<ApiWebApplicationFactory>
{
    private const string Hsts = "Strict-Transport-Security";
    private static readonly IPAddress Trusted = IPAddress.IPv6Loopback;
    private static readonly IPAddress Untrusted = IPAddress.Parse("203.0.113.7"); // TEST-NET-3

    private static readonly Dictionary<string, string?> FlyProfile = new()
    {
        ["ForwardedHeaders:ForHeaderName"] = "Fly-Client-Ip",
        ["ForwardedHeaders:ProtoHeaderName"] = "Fly-Forwarded-Proto",
        ["ForwardedHeaders:TrustAllProxies"] = "true",
    };

    private readonly ApiWebApplicationFactory _factory;

    public ForwardedHeadersTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
    }

    // 每支測試都要自己的 host（peer 與設定在建 host 的那一刻定型）⇒ 用
    // `WithWebHostBuilder` 疊一個 derived factory（父的 delegate 先跑、子的後跑）。
    private WebApplicationFactory<Program> Host(
        IPAddress peer, IReadOnlyDictionary<string, string?>? extra = null)
    {
        _factory.RemoteIpAddressOverride = peer;
        _factory.EnvironmentOverride = "Production";
        _factory.ConfigOverrides.Clear();
        if (extra is not null)
        {
            foreach (var (key, value) in extra)
            {
                _factory.ConfigOverrides[key] = value;
            }
        }
        return _factory.WithWebHostBuilder(_ => { });
    }

    private static async Task<HttpResponseMessage> HealthAsync(
        WebApplicationFactory<Program> factory, params (string Name, string Value)[] headers)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/health");
        request.Headers.Host = "entask.example"; // 見類別註解（`ExcludedHosts` 含 localhost）
        foreach (var (name, value) in headers)
        {
            request.Headers.Add(name, value);
        }
        return await factory.CreateClient().SendAsync(request);
    }

    [Fact]
    public async Task TrustedPeer_ForwardedProtoHttps_EmitsHsts()
    {
        var res = await HealthAsync(Host(Trusted), ("X-Forwarded-Proto", "https"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.Contains(Hsts));
    }

    [Fact]
    public async Task TrustedPeer_WithoutForwardedHeaders_NoHsts()
    {
        var res = await HealthAsync(Host(Trusted));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.False(res.Headers.Contains(Hsts));
    }

    [Fact]
    public async Task UntrustedPeer_ForwardedProtoHttps_NoHsts()
    {
        var res = await HealthAsync(Host(Untrusted), ("X-Forwarded-Proto", "https"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.False(res.Headers.Contains(Hsts));
    }

    [Fact]
    public async Task FlyProfile_ForgedStandardHeader_NoHsts()
    {
        var res = await HealthAsync(Host(Untrusted, FlyProfile), ("X-Forwarded-Proto", "https"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.False(res.Headers.Contains(Hsts));
    }

    [Fact]
    public async Task FlyProfile_FlyProtoHttps_EmitsHsts()
    {
        var res = await HealthAsync(Host(Untrusted, FlyProfile), ("Fly-Forwarded-Proto", "https"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.Contains(Hsts));
    }
}
