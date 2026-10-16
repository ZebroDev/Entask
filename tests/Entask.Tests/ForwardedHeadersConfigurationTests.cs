using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Entask.Api;

namespace Entask.Tests;

// `ForwardedHeadersConfiguration` 的形狀鎖（2026-10-12）。
// 這些格子全部是**設定 → 選項**的映射：它們不碰管線、不碰 DB。
// 為什麼 `For` 這一側只有形狀鎖、沒有端到端：今天沒有任何控制項消費 client IP
// （限流的分區鍵是使用者 id）⇒ 端到端沒有可觀測面；`Proto` 那一側有（HSTS）⇒ 在
// `ForwardedHeadersTests` 端到端驗。
public class ForwardedHeadersConfigurationTests
{
    private static ForwardedHeadersOptions Apply(params (string Key, string? Value)[] values)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(v => v.Key, v => v.Value))
            .Build();
        var options = new ForwardedHeadersOptions();
        ForwardedHeadersConfiguration.Apply(options, config);
        return options;
    }

    [Fact]
    public void Defaults_KeepFrameworkHeaderNamesAndLoopbackTrust()
    {
        var options = Apply();
        Assert.Equal(
            ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
            options.ForwardedHeaders);
        Assert.Equal("X-Forwarded-For", options.ForwardedForHeaderName);
        Assert.Equal("X-Forwarded-Proto", options.ForwardedProtoHeaderName);
        // 框架預設的 loopback 信任**不被覆蓋**（自架的同機 nginx 因此開箱可用）。
        Assert.Contains(IPAddress.IPv6Loopback, options.KnownProxies);
    }

    [Fact]
    public void FlyProfile_UsesFlyHeaderNamesAndTrustsAllProxies()
    {
        var options = Apply(
            ("ForwardedHeaders:ForHeaderName", "Fly-Client-Ip"),
            ("ForwardedHeaders:ProtoHeaderName", "Fly-Forwarded-Proto"),
            ("ForwardedHeaders:TrustAllProxies", "true"));
        Assert.Equal("Fly-Client-Ip", options.ForwardedForHeaderName);
        Assert.Equal("Fly-Forwarded-Proto", options.ForwardedProtoHeaderName);
        // 兩個清單都空 ⇒ middleware 跳過整套「已知 proxy」驗證（官方明文的信任全部）。
        Assert.Empty(options.KnownProxies);
        Assert.Empty(options.KnownIPNetworks);
    }

    [Fact]
    public void KnownProxies_AreAddedOnTopOfLoopbackDefault()
    {
        // 索引（＝appsettings 的 JSON 陣列）這一種寫法。
        var options = Apply(("ForwardedHeaders:KnownProxies:0", "10.1.2.3"));
        Assert.Contains(IPAddress.Parse("10.1.2.3"), options.KnownProxies);
        Assert.Contains(IPAddress.IPv6Loopback, options.KnownProxies);
        // 觀察窗（`fly logs` 的那一行）要反映它：2 ＝ 框架預設的 loopback ＋ 這一個。
        Assert.Contains("Trust=known(2 proxies", ForwardedHeadersConfiguration.Describe(options));
    }

    [Fact]
    public void KnownProxies_ScalarValue_IsReadAsASingleAddress()
    {
        // 純量寫法：`ForwardedHeaders__KnownProxies=10.1.2.3`（或 appsettings 的
        // `"KnownProxies": "10.1.2.3"`）——兩者都落到同一個設定路徑。
        // ★ 這是 2026-10-12 複審量到的失效模式：`Get<string[]>()` **只讀子鍵** ⇒ 純量回 null
        //   ⇒ 整段變 no-op，而啟動日誌與「完全沒設定」一字不差（觀察窗看不到它）。
        var options = Apply(("ForwardedHeaders:KnownProxies", "10.1.2.3"));
        Assert.Contains(IPAddress.Parse("10.1.2.3"), options.KnownProxies);
        Assert.Contains(IPAddress.IPv6Loopback, options.KnownProxies);
        Assert.Contains("Trust=known(2 proxies", ForwardedHeadersConfiguration.Describe(options));
    }

    [Fact]
    public void InvalidKnownProxy_ThrowsAtStartup()
    {
        // 靜默回退的形狀就是「HSTS 又悄悄不生效」——這一格刻意大聲。
        var ex = Assert.Throws<InvalidOperationException>(
            () => Apply(("ForwardedHeaders:KnownProxies:0", "not-an-ip")));
        Assert.Contains("not-an-ip", ex.Message);
    }

    [Fact]
    public void InvalidScalarKnownProxy_AlsoThrowsAtStartup()
    {
        // 純量那條路徑同樣「不合法就大聲」，不是靜默跳過。
        var ex = Assert.Throws<InvalidOperationException>(
            () => Apply(("ForwardedHeaders:KnownProxies", "not-an-ip")));
        Assert.Contains("not-an-ip", ex.Message);
    }

    [Fact]
    public void Disabled_TurnsTheMiddlewareIntoNoOp()
    {
        var options = Apply(("ForwardedHeaders:Enabled", "false"));
        Assert.Equal(ForwardedHeaders.None, options.ForwardedHeaders);
        Assert.Equal("disabled", ForwardedHeadersConfiguration.Describe(options));
    }

    [Fact]
    public void Describe_NamesTheEffectiveConfiguration()
    {
        var trusted = Apply();
        Assert.Contains("For=X-Forwarded-For", ForwardedHeadersConfiguration.Describe(trusted));
        Assert.Contains("Trust=known(", ForwardedHeadersConfiguration.Describe(trusted));

        var fly = Apply(("ForwardedHeaders:TrustAllProxies", "true"));
        Assert.Contains("Trust=all", ForwardedHeadersConfiguration.Describe(fly));
    }
}
