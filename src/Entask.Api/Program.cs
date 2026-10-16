using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Entask.Api;                     // T1 實查回報：Program.cs 是 top-level statements（global
                                      // namespace）⇒ 沒有這個 using，`ForwardedHeadersConfiguration`
                                      // 是 CS0103。
using Entask.Api.Authorization;
using Entask.Api.Endpoints;
using Entask.Api.Options;
using Entask.Board.Copying;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Identity.Options;
using Entask.Infrastructure.Activity;
using Entask.Infrastructure.Audit;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Data.Seed;
using Entask.Infrastructure.Identity;
using Entask.Infrastructure.Permissions;
using Entask.Infrastructure.Storage;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // JSON 端點全域 1MiB 即足；附件上傳端點以 per-endpoint IRequestSizeLimitMetadata 豁免
    // （135_266_304 = 20MB app 上限 + multipart boundary overhead，FormOptions.MultipartBodyLengthLimit 預設 128MB）
    options.Limits.MaxRequestBodySize = 1_048_576;
});

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddDbContext<EntaskDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddIdentityCore<ApplicationUser>(options =>
{
    options.Password.RequiredLength = 8;
    options.Lockout.MaxFailedAccessAttempts = 5;
    options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
})
.AddRoles<IdentityRole<Guid>>()
.AddEntityFrameworkStores<EntaskDbContext>();

builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection(JwtOptions.Section));
builder.Services.AddScoped<JwtTokenService>();

// 預設值只在 JwtOptions 的屬性初始化定義一次。這裡做「空字串視同未設定」的正規化，
// 而且**只讀已綁定的選項、不讀 `builder.Configuration`**。
//
// ★ 為什麼不讀 `builder.Configuration`（2026-09-25 實測）：這一格原本是頂層的 eager 讀，
//   而頂層讀到的內容**在 `Build()` 之前並不完整**——`WebApplicationFactory` 注入的來源是
//   那個時候才掛上去的（同一個盲區的實例與量測見下面 `AddRateLimiter` 那一則）。
//   代價是**晚到的來源對這一格永久隱形**：config 說 probe-injected、實際生效的卻是早到來源
//   的值，而且沒有紅燈——兩個值恰好相同時連測試都分不開（見 JwtDefaultLiteralTests 的說明）。
//   `PostConfigure` 跑在選項第一次被解析時（請求路徑上、`Build()` 之後），讀到的是最終綁定值。
//
// 空字串視同未設定：Fly secrets 設成空值時，若兩端規則不同一樣會壞。
builder.Services.PostConfigure<JwtOptions>(o =>
{
    var jwtDefaults = new JwtOptions();
    if (string.IsNullOrWhiteSpace(o.Issuer)) o.Issuer = jwtDefaults.Issuer;
    if (string.IsNullOrWhiteSpace(o.Audience)) o.Audience = jwtDefaults.Audience;
});

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // 保留 JWT 原始 claim 名稱（sub/unique_name），供 /me 以 JwtRegisteredClaimNames 讀取
        options.MapInboundClaims = false;
        // ★ **驗證參數不要在這一格設**（舊版就寫在這裡，所以這是最自然的位置）：那份
        //   `TokenValidationParameters` 由下面那個帶 DI 的 `Configure` **整顆指派**，而它排在
        //   這個回呼**之後** ⇒ 在這裡寫 `options.TokenValidationParameters.…` 會被**靜默覆蓋**，
        //   沒有紅燈、只有「我設的值沒生效」。要加欄位請去那裡加。
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                var path = context.HttpContext.Request.Path;
                if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hubs"))
                {
                    context.Token = accessToken;
                }
                return Task.CompletedTask;
            },
            // 認證挑戰（沒帶憑證／憑證驗不過）。框架預設只送狀態碼與 `WWW-Authenticate`、
            // **沒有 body**，於是前端唯一的錯誤出口（`apiErrorMessage`）在這一格只能退回
            // 呼叫端自己那句泛用譯文。這裡補上與其他 401 同一個產生點的 body。
            //
            // `HandleResponse()` 會**同時**跳過狀態碼與 `WWW-Authenticate` 標頭（框架的順序是
            // 「先跑 Challenge 事件、`Handled` 就 return」）⇒ 兩者都得自己補。少補一個就是
            // 一個沒有測試會發現的協定退化——那兩個值改動前是框架給的，看起來「本來就有」。
            OnChallenge = async context =>
            {
                context.HandleResponse();

                // 重建框架原本會寫的那個標頭。`Error` 在 `Events.Challenge` 被叫到**之前**
                // 就已由框架填好（`IncludeErrorDetails` 為真且確有 `AuthenticateFailure` 時），
                // 所以這裡是**複製它的判定**，不是重新推導：沒帶憑證 ⇒ 裸 `Bearer`
                // （RFC 6750 §3 不得附 error 碼）；憑證有問題 ⇒ 附 `error="invalid_token"`。
                //
                // **只送 `error` 碼，框架另外填好的 `ErrorDescription`／`ErrorUri` 刻意不轉發**
                // （使用者 2026-09-22 裁定，技術債清單的最後一條）。理由是它們把**失敗分類**
                // 送給**未經驗證**的呼叫端——當場量到的三個值：憑證過期 ⇒
                // `The token expired at '09/21/2026 22:58:04'`（連過期時刻都送上）、金鑰不對 ⇒
                // `The signature key was not found`、audience 不對 ⇒ `The audience '(null)' is invalid`。
                // 「金鑰找不到」與「簽章不對」在攻擊者眼裡是兩種訊號（前者是在探 `kid`／金鑰輪替），
                // 而客戶端不缺這句人話：想判斷過期的自己解 token 的 `exp` 就有。RFC 6750 §3 只要求
                // `error` 碼。**不要改成 `IncludeErrorDetails = false` 來達到同一件事**——那個旗標
                // 是 `Error` 與描述**一起**填的，關掉會連 `invalid_token` 都沒了。
                // 守門員：`AuthErrorBodyTests.Challenge_EveryReachableFailureReason_SendsOnlyErrorCode`。
                var scheme = JwtBearerDefaults.AuthenticationScheme;
                context.Response.Headers.WWWAuthenticate = string.IsNullOrEmpty(context.Error)
                    ? scheme
                    : $"{scheme} error=\"{context.Error}\"";

                await ApiResults.WriteUnauthorizedAsync(context.HttpContext, ErrorCodes.AuthUnauthenticated);
            }
        };
    });

// 驗證端與簽發端同源：`JwtTokenService` 建構子注入的是 `IOptions<JwtOptions>`，這裡也用
// 同一個——**兩個端點吃的是同一個選項實例**（含上面那一段正規化），不再有第二份字面值，
// 也沒有第二個讀設定的時機。兩邊只改一邊的後果是「簽得出 token、但每個請求都 401」。
//
// ★ 為什麼不寫在 `AddJwtBearer(options => …)` 裡（2026-09-25）：那個回呼拿不到 DI，
//   要取 `JwtOptions` 就只能從 `builder.Configuration` 讀或自建容器（那是**另一個**容器）。
//   `Configure<TDep>` 由容器注入相依，且**選項在 `Build()` 之後才解析** ⇒ 讀到的是最終值。
//   金鑰也一併從同一份選項取（原本是 `builder.Configuration["Jwt:Secret"]!`）：兩端同源，
//   「簽章金鑰不一致」在這個形狀下是**寫不出來**的，而不是靠記得改兩邊。
builder.Services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
    .Configure<IOptions<JwtOptions>>((options, jwtOptions) =>
    {
        var jwt = jwtOptions.Value;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwt.Issuer,
            ValidAudience = jwt.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Secret)),
        };
    });
// 授權的預設＝需登入（2026-10-10）。`RequireAuthorization()`／`RequireProjectPermission()` 都是
// **opt-in**：少了它們、也沒有 `.AllowAnonymous()` 的端點，在**執行期**是**匿名**的——稽核測試
// 會事後亮紅（`EndpointAuthorizationGuardTests` 的兩個方向問的都是「有沒有宣告」，不是
// 「宣告得對不對」），但那一格紅在 CI 上，不在部署中的請求上。這一行把預設翻成 fail-closed。
//
// ★ 這一格改了什麼，用**類別**記（不列舉——列舉會腐爛；實例只是實例）：
//   · **既存端點的行為不變**：每一條端點都已經宣告了自己的認證意圖
//     （`EveryRouteEndpoint_DeclaresItsAuthenticationIntent` 綠）⇒ 它們不是走
//     `RequireAuthorization()` 那一格、就是更早在 `IAllowAnonymous` 那一格就 return。匿名
//     `GET /api/projects` 在改動前就是 401；**帶憑證**的請求在改動後實測也還是它原本的回應
//     （`PATCH /api/projects` ＋ admin token ⇒ 405）。
//   · 變的是**匿名、而且那一格沒有任何授權政策（`authorizeData` 空）**那一類請求：它從
//     「沒有任何政策」變成「落到這個 fallback」⇒ 401。當場量到的兩個實例是「未路由：
//     404 ⇒ 401」與「路徑命中但方法不合：405 ⇒ 401」——**兩個實例，不是清單**。
//   它的價值在下一個忘了宣告的端點上——那種端點在稽核測試亮紅之前先被管線收成 401。
// ★ 各端點自己的 `RequireAuthorization()` 因此變成多餘的，但**不要拿掉**：那是不依賴這一行
//   的明示（拿掉會讓「這個端點要不要認證」重新變成端點圖上看不出來的東西，也讓
//   `EveryRouteEndpoint_DeclaresItsAuthenticationIntent` 失去標的）。
// ★ 刻意匿名的端點一律有明示的 `.AllowAnonymous()`——`AuthorizationMiddleware` 在那一格就
//   return，fallback 到不了它（SPA fallback 也有，見管線尾段）。
builder.Services.AddAuthorization(options =>
{
    options.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .Build();
});

// 列舉面限流（2026-09-24）。政策、分區鍵與限流器選項的定義全在 `RateLimitPolicy`／
// `RateLimitOptions`，這裡只做「讀設定、非法值回退、掛上去」。
//
// 設定走 `builder.Configuration` 而不是註冊一個 `IOptions<RateLimitOptions>`：`AddRateLimiter`
// 的 configure 回呼沒有帶 `IServiceProvider` 的多載，在回呼裡自建容器是**另一個**容器。
// 正規化照 `JwtOptions` 的先例：預設值只在選項類別的屬性初始化定義一次。
// **讀的那一行刻意留在回呼裡面**——那不是排版，理由見下面那一則註解（實測出來的）。
//
// **非法值回退，而不是當場拋**：非正的值會被限流器的選項驗證拒絕，而 token bucket 的分區是
// **有請求才建立**的（`RateLimitPolicy.CreateLimiter`）⇒ 那個失敗落在**請求路徑上**，
// 不是啟動時。★ 這一句原本寫的是「`SlidingWindowRateLimiterOptions` 在**啟動時**拋」——
// 那是滑動窗時代的說法（D4r 換演算法之後就不成立了），而**新的失敗位置是推論、未實測**。
// 回退成預設值的代價是「限額不是你想要的那個數」，那個代價小得多、而且在 429 上看得見。
builder.Services.AddRateLimiter(options =>
{
    // ★ **設定在這裡讀，不在 `AddRateLimiter` 之前讀**（2026-09-24 實測）。
    //
    // 這個回呼跑在 `builder.Build()` **之後**（`UseRateLimiter()` 解析
    // `IOptions<RateLimiterOptions>` 時），而 `builder.Configuration` 的內容在
    // `Build()` **之前還不完整**——`WebApplicationFactory` 注入的來源是那個時候才掛上去的。
    //
    // 實測（`RateLimitTests` 把名額覆寫成 3，量「第一次逾額落在第幾次」）：
    //   讀在 `AddRateLimiter` **之前**（eager）：`raw=[null]` ⇒ 綁到預設 60 ⇒ 第 **61** 次才逾額
    //   讀在**回呼裡**：                        `raw=[3]`    ⇒ 綁到 3   ⇒ 第 **4** 次逾額
    // 症狀是**限流器照常運作、數字卻不是你設的那個**：沒有紅燈、沒有錯誤訊息、429 也真的
    // 會出現，只有「第幾次」不對——所以它只有靠當場量才看得見（探針已於診斷後刪除）。
    // ⇒ **在本檔頂層 eager 讀 `builder.Configuration` 的地方都有同一個盲區**；
    //    新增設定時，要嘛讀在延後執行的回呼裡，要嘛走 `builder.Services.Configure<T>(section)`
    //    （`JwtOptions` 與 `EntaskDbContext` 就是後者——它們的讀取都發生在 `Build()` 之後）。
    var rateLimitDefaults = new RateLimitOptions();
    var rateLimit = new RateLimitOptions();
    builder.Configuration.GetSection(RateLimitOptions.Section).Bind(rateLimit);
    if (rateLimit.PermitLimit < 1) rateLimit.PermitLimit = rateLimitDefaults.PermitLimit;
    if (rateLimit.WindowSeconds < 1) rateLimit.WindowSeconds = rateLimitDefaults.WindowSeconds;
    if (rateLimit.SegmentsPerWindow < 1) rateLimit.SegmentsPerWindow = rateLimitDefaults.SegmentsPerWindow;

    // **刻意不設 `options.RejectionStatusCode`**：那條路只寫狀態碼、**body 是空的**，
    // 而前端唯一的錯誤出口（`apiErrorMessage`）在沒有 body 時只能退回呼叫端自己那句泛用
    // 譯文——正是 401 那批修掉的形狀（見下面 JwtBearer 的 OnChallenge）。逾額一律走產生點，
    // 與 404／401／500 同一個契約：`{code, message}`。
    options.OnRejected = async (context, token) =>
    {
        // `Retry-After`：秒數取自租約的 metadata（token bucket 給的是「補足這次的缺口還要幾個
        // 補充週期」）。**無條件進位**——`Retry-After: 0` 等於叫呼叫端立刻重試，那是這顆
        // header 的反面。★ 這一段**只在 token bucket 下才會執行**：滑動窗的租約永遠不帶
        // `MetadataName.RetryAfter`（實測），那一版是死碼——演算法就是為了這顆 header 換的，
        // 理由寫在 `RateLimitPolicy.CreateLimiter` 的摘要裡。
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            context.HttpContext.Response.Headers.RetryAfter =
                ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString();
        await ApiResults.WriteTooManyRequestsAsync(context.HttpContext);
    };

    options.AddPolicy(RateLimitPolicy.Name,
        context => RateLimitPolicy.CreateLimiter(context, rateLimit));
});

// 轉送標頭（2026-10-12）：綁定在延後執行的回呼裡（`builder.Configuration` 在 `Build()`
// 之前不完整——與限流那一則同一個實測，docs/invariants/05）。套用點在下面 `app` 的管線最前面。
builder.Services.Configure<ForwardedHeadersOptions>(options =>
    ForwardedHeadersConfiguration.Apply(options, builder.Configuration));

builder.Services.AddSignalR();
builder.Services.AddSingleton<Microsoft.AspNetCore.SignalR.IUserIdProvider, Entask.Api.Hubs.CustomUserIdProvider>();

builder.Services.AddMemoryCache();
builder.Services.AddScoped<IPermissionChecker, PermissionChecker>();
builder.Services.AddScoped<IProjectScopeResolver, ProjectScopeResolver>();
builder.Services.AddScoped<IAuditService, AuditService>();
builder.Services.AddScoped<IActivityService, ActivityService>();
builder.Services.AddScoped<IBoardCopyService, BoardCopyService>();
builder.Services.AddScoped<IAttachmentStore, AttachmentStore>();

var app = builder.Build();

// 遷移與種子必須先於 AdminSeed（fresh DB 無資料表時後者會失敗）
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
    await db.Database.MigrateAsync();
    await PermissionSeed.SeedAsync(db);
    await RoleSeed.SeedAsync(db);
    // 必須在 AdminSeed 之前：AdminSeed 只對「不存在」的帳號建立 claim，
    // 既有帳號的舊 claim 型別靠這裡補上（見 AdminClaimSeed 的說明）
    await AdminClaimSeed.MigrateAsync(db);
}

await AdminSeed.InitializeAsync(app.Services, builder.Configuration);

// 轉送標頭是管線的第一顆（2026-10-12）：`Request.IsHttps`（HSTS 的觸發條件）與
// `Connection.RemoteIpAddress` 都在這裡定型。標頭名與信任面見 `ForwardedHeadersConfiguration`
// 與 spec §3.1；`X-Forwarded-*` 在 fly 上可被公網偽造（2026-10-12 實測）。
// `app.Logger` 的 category 是**進入組件名**（`Entask.Api`），不是 `Microsoft.AspNetCore.*`
// ⇒ 不受 `appsettings.json` 的 `"Microsoft.AspNetCore": "Warning"` 影響（2026-10-12 探針實測）。
app.UseForwardedHeaders();
app.Logger.LogInformation("Forwarded headers: {ForwardedHeaders}",
    ForwardedHeadersConfiguration.Describe(
        app.Services.GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value));

app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (BadHttpRequestException ex)
    {
        context.Response.StatusCode = ex.StatusCode;
        // 這裡走的是 `WriteAsJsonAsync`、不經 `Results.*`，所以閘門二的形狀掃描看不到它
        // （它掃的是 `Results.X("字面值")`）。仍照統一契約回 `{ code, message }`——
        // 舊的 `{ error = "…" }` 是前端 `serverMessage` 認不得的第五種形狀，等於沒有訊息。
        var tooLarge = ex.StatusCode == StatusCodes.Status413PayloadTooLarge;
        await context.Response.WriteAsJsonAsync(new
        {
            code = tooLarge ? ErrorCodes.RequestBodyTooLarge : ErrorCodes.RequestInvalid,
            message = tooLarge ? "請求的資料量過大或格式錯誤" : "請求格式錯誤",
        });
    }
    // 未處理的例外（2026-09-21）。**順序不能顛倒**：`BadHttpRequestException` 也繼承自
    // `Exception`，它必須先配對，否則 413／400 會被這一條吃掉。
    //
    // body 一律是固定的通用措辭（`server.internalError`）：型別、Message、InnerException、
    // stack 與任何追蹤識別碼**都不進 body**。例外本身只走下面那行日誌——那是 500 唯一
    // 可查的線索（設計 §4.4；security 規則：錯誤訊息不洩漏敏感資料）。
    // 而且 `ApiResults.WriteInternalErrorAsync` 刻意**不收 code 參數**，所以「把 ex 餵進
    // body」在這裡是**寫不出來**的，不是靠記得不要寫。
    //
    // 兩個 when 條件是「這個回應還來得及改」的判準：已經開始寫就改不了（再寫會拋
    // `InvalidOperationException`，把原始例外蓋掉）；客戶端已中止就沒有人在等這個 body。
    // 兩者都**不再攔**、讓例外照原本的路往上拋——與加這一條之前的行為相同。
    catch (Exception ex) when (!context.Response.HasStarted
                               && !context.RequestAborted.IsCancellationRequested)
    {
        app.Logger.LogError(ex, "未處理的例外：{Method} {Path}", context.Request.Method, context.Request.Path);
        await ApiResults.WriteInternalErrorAsync(context);
    }
});

var staticFileOptions = new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        if (ctx.File.Name == "index.html" || ctx.File.Name == "manifest.json")
        {
            ctx.Context.Response.Headers.Append("Cache-Control", "no-cache, no-store, must-revalidate");
            ctx.Context.Response.Headers.Append("Pragma", "no-cache");
            ctx.Context.Response.Headers.Append("Expires", "0");
        }
        else if (ctx.Context.Request.Path.StartsWithSegments("/assets"))
        {
            ctx.Context.Response.Headers.Append("Cache-Control", "public, max-age=31536000, immutable");
        }
    }
};

// 基線安全標頭（2026-10-10）。放在管線最前面是刻意的：靜態檔若先短路就帶不到。
// CSP 於 2026-10-12 上線（見下面中介層；`/swagger` 是唯一豁免——Swagger UI 自帶 inline
// script，且它只在 Development 掛載）。
// ★ `UseHsts()` 只在 HTTPS 回應上加標頭，而 `WebApplicationFactory` 走的是沒有 TLS 的
//   記憶體管線 ⇒ 測試裡要看見它，只能靠 **forwarded proto 標頭**（`ForwardedHeadersTests`
//   就是這樣驗的，2026-10-12；它五格裡兩格走 `Fly-Forwarded-Proto`、其餘走
//   `X-Forwarded-Proto`，所以這裡**不指名**任何一個）。它在 fly 拓撲下**會**生效了
//   （2026-10-12）：`app.UseForwardedHeaders()` 讀的 proto 標頭名由設定決定
//   （fly profile ＝ `Fly-Forwarded-Proto`）⇒ `Request.IsHttps` 為 true。
//   標頭名與信任面的實測與裁定（含「`X-Forwarded-*` 在 fly 上可被公網偽造」）見
//   docs/superpowers/specs/2026-10-12-entask-container-hardening-followups-design.md §2/§3.1。
// CSP（2026-10-12）。`/swagger` 是唯一豁免，且**只在 Development 給**（Swagger UI 自帶
// inline script，而它只在 Development 掛載 ⇒ 非 Development 時那兩個不帶點的 URL 形狀
// 落到 SPA fallback，不該因此失去 CSP）。`script-src 'self'` 是這顆標頭的主要價值
// （建置產物零 inline script，2026-10-12 實查）；`style-src` 留 'unsafe-inline' 是因為
// sonner 與截圖探針都會在執行期注入 <style>。逐 directive 的依據：spec §3.2。
const string csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
    + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["Referrer-Policy"] = "no-referrer";
    headers["X-Frame-Options"] = "DENY";
    if (!(app.Environment.IsDevelopment() && context.Request.Path.StartsWithSegments("/swagger")))
    {
        headers["Content-Security-Policy"] = csp;
    }
    await next();
});

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

app.UseDefaultFiles();
app.UseStaticFiles(staticFileOptions);

app.UseAuthentication();
app.UseAuthorization();

// 限流器排在授權**之後**（順序是語意，不是排版）：未帶憑證的請求在上一行就被挑戰成 401，
// 到不了這裡 ⇒ 「該不該給憑證」不會變成「先過限流才知道」的問題。
// 反過來放的代價是：逾額的**匿名**請求會拿到 429，而 429 是「你太快」——對一個根本沒被
// 允許呼叫的請求說「你太快」是錯的。`RateLimitTests` 的第⑤格釘住這個順序，
// 因為它**翻面的時候不會有任何東西變紅**（兩者都是 4xx，呼叫端看起來都像失敗）。
app.UseRateLimiter();

app.MapHealth();
app.MapAuth();
app.MapUserEndpoints();
app.MapAdminUserEndpoints();
app.MapPermissions();
app.MapTeams();
app.MapTeamRoles();
app.MapAuditLogs();
app.MapBoards();
app.MapLists();
app.MapLabels();
app.MapCards();
app.MapActivity();
app.MapChecklists();
app.MapProjects();
app.MapAttachments();
app.MapCustomFields();
app.MapReviews();
app.MapEffort();
app.MapCopy();
app.MapMindMaps();
app.MapReports();
app.MapWorkLogs();
app.MapWorkCalendar();
app.MapTeamReports();
app.MapProjectCards();
app.MapSearch();
app.MapUserWork();
app.MapNotifications();
app.MapHub<Entask.Api.Hubs.CollaborationHub>("/hubs/collaboration");

var webRoot = app.Environment.WebRootPath ?? Path.Combine(AppContext.BaseDirectory, "wwwroot");
if (File.Exists(Path.Combine(webRoot, "index.html")))
{
    // `.AllowAnonymous()` 在這裡是**必要的**，不是可選的裝飾（2026-10-10 起）：上面設了
    // fallback policy（預設需登入），而這個端點沒有任何 `RequireAuthorization()` ⇒ 少了這一行
    // 它會被那個 fallback 收掉（`AuthorizationMiddleware` 只放行帶 `IAllowAnonymous` 的端點），
    // 前端整站變成 401——只有登入頁還活著。
    // 它同時是**明示**：它是一個**端點圖上看得到的 `RouteEndpoint`**
    // （`GET,HEAD /{*path:nonfile}`），而 `EndpointAuthorizationGuardTests` 要求每個端點都
    // 宣告自己的認證意圖——少了這一行，那一支在**部署映像**裡會紅。
    // 注意它只在 `wwwroot/index.html` 存在時才被 map（`Dockerfile.fly` 會把 `web/dist`
    // 複製進去；那個目錄被 gitignore ⇒ 乾淨 clone／CI 看不到這條端點）。
    app.MapFallbackToFile("index.html", new StaticFileOptions
    {
        OnPrepareResponse = ctx =>
        {
            ctx.Context.Response.Headers.Append("Cache-Control", "no-cache, no-store, must-revalidate");
            ctx.Context.Response.Headers.Append("Pragma", "no-cache");
            ctx.Context.Response.Headers.Append("Expires", "0");
        }
    }).AllowAnonymous();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.Run();

public partial class Program { }
