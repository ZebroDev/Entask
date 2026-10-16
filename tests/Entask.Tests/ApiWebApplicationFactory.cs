using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Entask.Tests;

public class ApiWebApplicationFactory : WebApplicationFactory<Program>
{
    private bool _pendingReset;

    public void WithDbReset() => _pendingReset = true;

    // 設為 true 時不注入 Jwt:Issuer / Jwt:Audience，讓 Program.cs 的正規化走
    // JwtOptions 的屬性預設值。用途：涵蓋「環境完全沒有設定這兩個鍵」這條路徑——
    // 其他測試永遠明確設定它們，否則走不到（見 JwtDefaultLiteralTests）。
    //
    // ★ 2026-09-25：**這件事在修正前是假的**——`Program.cs` 當時是頂層 eager 讀，而這個
    //   晚到的 null 遮蔽它看不到，於是「走屬性預設值」實際上是「走 appsettings.Development.json
    //   的值」。兩者同值（entask／entask-web）⇒ 沒有任何斷言分得開。今天是真的走預設值了
    //   （正規化只讀已綁定的選項；這一格以探針當場量過——顯式 null 對 `Configure<T>` 的綁定
    //   同樣有效，2026-09-25 複閱），而釘住「晚到來源必須生效」的是 `JwtConfigSourceTests`。
    public bool OmitJwtIssuerAudience { get; set; }

    // 上面那兩個鍵注入的值。**預設刻意與 `JwtOptions` 的屬性預設值相同**，其他類別的既有
    // 行為因此不變；`JwtConfigSourceTests` 會改成可辨識的值，用來分辨「值從哪個來源來」。
    // 同值時這一格在值層面不可觀測——那正是修正前那個盲區活了這麼久的原因。
    public string JwtIssuerOverride { get; set; } = "entask";
    public string JwtAudienceOverride { get; set; } = "entask-web";

    // 列舉面限流（2026-09-24）。**只有 `RateLimitTests` 設定它**：那一類要把限額壓到 3，
    // 否則「第 N+1 次逾額」得先送 60 次請求才觀測得到。
    // 形狀與時機都與 `OmitJwtIssuerAudience` 同型（同一個字典、同一個來源）——
    // **必須在第一支 `CreateClient()` 之前設**：host 只建置一次，之後改屬性沒有作用
    // （`RateLimitTests` 在自己的建構子裡設，那個時機是對的）。
    // 不設定時 `RateLimit` 整節不存在 ⇒ `Program.cs` 走屬性初始化裡的預設值。
    public int? RateLimitPermitLimit { get; set; }
    public int? RateLimitSegmentsPerWindow { get; set; }

    // 頭像落地目錄的覆寫（2026-09-28）。**只有 `AvatarStoragePathTests` 設定它**：那一類要把
    // 頭像寫進暫存目錄，才能在不污染 repo 工作樹的前提下驗證 `Storage:AvatarsPath` 這條路。
    // 形狀與時機都同 `RateLimitPermitLimit`——**必須在第一支 `CreateClient()` 之前設**。
    public string? AvatarsPathOverride { get; set; }

    // 測試 peer 的 IP（2026-10-12）。**只有 `ForwardedHeadersTests` 設定它。**
    // 不設 ⇒ TestServer 的 peer 是 null ⇒ forwarded 標頭被 fail-closed 忽略。
    public IPAddress? RemoteIpAddressOverride { get; set; }

    // 執行環境的覆寫（2026-10-12）。`WebApplicationFactory` 強制 Development，而
    // `UseHsts()` 只在非 Development 掛 ⇒ 要驗 HSTS 就得有一顆非 Development 的 host。
    // **機制是這條 factory 自己的 `ConfigureWebHost`**：它讀到這個屬性就直接呼叫
    // `builder.UseEnvironment(EnvironmentOverride)`（見下面 `ConfigureWebHost`）——值是「**建 host 的
    // 那一刻**」讀的。★ 因此呼叫端**必須在第一支 `CreateClient()` 之前設**（時機同
    // `RateLimitPermitLimit`）；要**另一顆** host（例如非 Development，`SecurityHeaderTests`
    // 那一格）就在 `WithWebHostBuilder` 疊出來的 derived builder 上再 `UseEnvironment` 一次
    // ——建那顆 host 時父的 `ConfigureWebHost` 也會再跑一遍，所以父層的屬性在那時才被定住。
    public string? EnvironmentOverride { get; set; }

    // 任意設定的覆寫（2026-10-12）。`ForwardedHeadersTests` 用它套 fly profile。
    // ★ 呼叫端**每次都要自己清空**：它在「建 host 的那一刻」被整份讀走，
    //   留著上一支測試的值就是跨測試污染。
    public Dictionary<string, string?> ConfigOverrides { get; } = new();

    // 日誌捕獲。存在的理由：日誌是唯一沒有其他觀測窗口的東西——其他測試都只看得到
    // HTTP 回應，所以「某個分支有沒有留下痕跡」不捕獲就無法斷言。
    //
    // **它是唯讀的實例，不是可設定的屬性**：`IClassFixture` 讓同一個測試類別的所有測試
    // 共用這一條 factory，而 host 只在**第一次** `CreateClient()` 時建置一次
    // （`ILoggerProvider` 建置後就不再被收）。若讓每個測試在建構子裡塞一個新的 provider，
    // 只有跑第一支的那個會生效，而斷言會對著一個永遠空白的物件——失敗方向還是靜默的
    // （「沒有任何警告」恆真）。同一個實例就沒有這個問題。
    //
    // 代價：每一條 factory 都多一個 provider，但它 `IsEnabled` 只收 `Warning` 以上
    // （見 `CapturingLoggerProvider`），所以量是零頭。★ 但**它擋不住應用程式自己的篩選規則**
    // （`LoggerFactory` 先按 `appsettings.json` 的 `Logging:LogLevel` 過濾）——完整說明、
    // 以及為什麼刻意不在測試 host 覆寫那些規則，都寫在 `CapturingLoggerProvider` 的摘要。
    public CapturingLoggerProvider LogCapture { get; } = new();

    // SignalR 廣播的替身（見 `RecordingHubContext`）。**與 LogCapture 同型、同一個理由**：
    // `IClassFixture` 讓同一個測試類別共用這一條 factory，而 host 只在第一次 `CreateClient()`
    // 時建置一次 ⇒ 每個測試各塞一個新的替身，只有跑第一支的那個會生效，而斷言會對著一個
    // 永遠空白的物件（失敗方向是靜默的：「沒有廣播」恆真）。
    //
    // 記錄會跨測試累積 ⇒ **每支廣播測試開頭呼叫 `Hub.Clear()`**。
    public RecordingHubContext Hub { get; } = new();

    public (string Username, string Password) SeedCredentials()
    {
        var config = Services.GetRequiredService<IConfiguration>();
        return (config["Seed:AdminUsername"]!, config["Seed:AdminPassword"]!);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        if (EnvironmentOverride is not null)
        {
            builder.UseEnvironment(EnvironmentOverride);
        }

        builder.ConfigureAppConfiguration((_, config) =>
        {
            var settings = new Dictionary<string, string?>
            {
                ["ConnectionStrings:Default"] = TestDb.Connection,
                ["Seed:AdminUsername"] = "admin-test",
                ["Seed:AdminPassword"] = "TestPass123!",
                ["Jwt:Secret"] = "test-only-secret-0123456789abcdef0123456789abcdef",
            };
            if (RateLimitPermitLimit is int permitLimit)
                settings["RateLimit:PermitLimit"] = permitLimit.ToString();
            if (RateLimitSegmentsPerWindow is int segments)
                settings["RateLimit:SegmentsPerWindow"] = segments.ToString();
            if (!string.IsNullOrWhiteSpace(AvatarsPathOverride))
                settings["Storage:AvatarsPath"] = AvatarsPathOverride;
            if (!OmitJwtIssuerAudience)
            {
                settings["Jwt:Issuer"] = JwtIssuerOverride;
                settings["Jwt:Audience"] = JwtAudienceOverride;
            }
            else
            {
                // appsettings.Development.json 也提供這兩個鍵，故必須以「較後加入的來源給 null」
                // 遮蔽掉（ConfigurationRoot 會把 null 視為有效的空值並停止往下找）。
                settings["Jwt:Issuer"] = null;
                settings["Jwt:Audience"] = null;
            }
            foreach (var (key, value) in ConfigOverrides)
            {
                settings[key] = value;
            }
            config.AddInMemoryCollection(settings);
        });

        builder.ConfigureServices(services =>
        {
            // 預設的 `LoggerFactory` 會把 DI 裡每一個 `ILoggerProvider` 都收進去，
            // 所以不必動 `builder.Logging`（那條路要在 `ConfigureWebHost` 之前，這裡拿不到）。
            services.AddSingleton<ILoggerProvider>(LogCapture);

            if (RemoteIpAddressOverride is not null)
            {
                services.AddSingleton<IStartupFilter>(new RemoteIpStartupFilter(RemoteIpAddressOverride));
            }

            // 廣播替身。**必須先 RemoveAll**：`AddSignalR()` 已經註冊過真的 `IHubContext<>`，
            // 直接 AddSingleton 會變成兩個註冊、由最後一個勝出（語意隨註冊順序而變），
            // 而且一旦寫成 `TryAddSingleton` 就會**靜默沿用真的 hub**——廣播照樣發生，
            // 替身卻永遠是空的，測試於是恆綠。移除後才註冊，就沒有這一格。
            services.RemoveAll<IHubContext<Entask.Api.Hubs.CollaborationHub>>();
            services.AddSingleton<IHubContext<Entask.Api.Hubs.CollaborationHub>>(Hub);

            // 同步阻塞完成 DB 重置，避免與 server 啟動產生競賽（不得用 async lambda）
            if (_pendingReset)
            {
                TestDb.ResetAsync(services.BuildServiceProvider()).GetAwaiter().GetResult();
                _pendingReset = false;
            }
        });
    }
}
