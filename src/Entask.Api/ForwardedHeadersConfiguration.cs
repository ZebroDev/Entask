using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;

namespace Entask.Api;

// 轉送標頭（2026-10-12）。為什麼 fly 用 `Fly-*` 的標頭名、為什麼信任面是「清空清單」：
// docs/superpowers/specs/2026-10-12-entask-container-hardening-followups-design.md §2 F4／F5
// 與 §3.1（含「X-Forwarded-* 在 fly 上可被公網偽造」的 2026-10-12 實測）。
public static class ForwardedHeadersConfiguration
{
    public const string Section = "ForwardedHeaders";

    public static void Apply(ForwardedHeadersOptions options, IConfiguration configuration)
    {
        var section = configuration.GetSection(Section);

        if (!(section.GetValue<bool?>("Enabled") ?? true))
        {
            options.ForwardedHeaders = ForwardedHeaders.None;
            return;
        }

        // 只收 For 與 Proto（最小面）：XForwardedHost／XForwardedPrefix 不在本批。
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

        if (section["ForHeaderName"] is { Length: > 0 } forHeader)
        {
            options.ForwardedForHeaderName = forHeader;
        }
        if (section["ProtoHeaderName"] is { Length: > 0 } protoHeader)
        {
            options.ForwardedProtoHeaderName = protoHeader;
        }

        if (section.GetValue<bool?>("TrustAllProxies") ?? false)
        {
            // 清空兩個清單＝跳過「已知 proxy」驗證＝信任全部（官方 breaking-change 文件
            // 明文的行為）。fly 的 proxy 位址不是穩定集合，釘一組會漂的位址，失效形狀是
            // 靜默回到「標頭被忽略、HSTS 不見」。
            options.KnownProxies.Clear();
            options.KnownIPNetworks.Clear();
        }

        // 兩種寫法都收：索引／陣列（`ForwardedHeaders__KnownProxies__0=10.1.2.3`、appsettings
        // 的 JSON 陣列）走 `Get<string[]>()`；**純量**（`ForwardedHeaders__KnownProxies=10.1.2.3`
        // 或 appsettings 的 `"KnownProxies": "10.1.2.3"`——同一個設定路徑）**不會**被它綁到，
        // 因為它只讀子鍵。少了下面那一支，純量會靜默變成 no-op，而啟動日誌與「完全沒設定」
        // 一字不差（2026-10-12 複審量到的失效模式：觀察窗看不到這個錯誤）。
        var knownProxies = section.GetSection("KnownProxies");
        string[]? configured = knownProxies.Get<string[]>();
        if (configured is null && knownProxies.Value is { Length: > 0 } scalar)
        {
            configured = [scalar];
        }
        foreach (var raw in configured ?? [])
        {
            if (!IPAddress.TryParse(raw, out var ip))
            {
                throw new InvalidOperationException(
                    $"{Section}:KnownProxies 有不合法的一個位址：{raw}");
            }
            options.KnownProxies.Add(ip);
        }
    }

    // 啟動日誌（管線建好後呼叫，傳的是已套用的選項）。它讓「設定沒生效」在
    // `fly logs` 裡看得見——今天只能靠回應標頭反推。
    public static string Describe(ForwardedHeadersOptions options)
    {
        if (options.ForwardedHeaders == ForwardedHeaders.None)
        {
            return "disabled";
        }
        var trust = options.KnownProxies.Count == 0 && options.KnownIPNetworks.Count == 0
            ? "all"
            : $"known({options.KnownProxies.Count} proxies, {options.KnownIPNetworks.Count} networks)";
        return $"For={options.ForwardedForHeaderName} Proto={options.ForwardedProtoHeaderName} Trust={trust}";
    }
}
