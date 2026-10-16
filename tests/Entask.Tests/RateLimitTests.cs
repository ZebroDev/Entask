using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Api.Options;
using Entask.Core;

namespace Entask.Tests;

/// <summary>
/// 兩個推導值的算術（<see cref="RateLimitOptions.TokensPerPeriod"/> 與
/// <see cref="RateLimitOptions.ReplenishmentPeriod"/>）。**不需要 host、不需要 DB**——
/// 它們是純函式，而契約測試只看得到「429 有沒有出現、`Retry-After` 是幾秒」，
/// 看不到這兩個值在各種設定組合下對不對（合約測試只跑一組設定）。
///
/// 這裡釘住的不變量是**有效速率不得高於設定速率**——它是一個安全性質，不是排版偏好。
/// 突變（下取整改上取整、`EffectiveSegments` 的上界拿掉、週期算成整窗）都會在這裡紅。
/// </summary>
public class RateLimitOptionsTests
{
    [Fact]
    public void Defaults_SplitTheWindowIntoExactPeriods()
    {
        var options = new RateLimitOptions();

        Assert.Equal(10, options.TokensPerPeriod);
        Assert.Equal(TimeSpan.FromSeconds(10), options.ReplenishmentPeriod);
    }

    [Fact]
    public void NonDivisible_FloorsTheTokens_SoTheRateNeverExceedsTheLimit()
    {
        var options = new RateLimitOptions { PermitLimit = 10, WindowSeconds = 60, SegmentsPerWindow = 3 };

        Assert.Equal(3, options.TokensPerPeriod);                          // 10 / 3，下取整
        Assert.Equal(TimeSpan.FromSeconds(20), options.ReplenishmentPeriod); // ⇒ 9 個／分 < 10
    }

    [Fact]
    public void SegmentsExceedingPermit_AreClamped_NotRaisedToAtLeastOneToken()
    {
        // 這一格是 `EffectiveSegments` 的上界存在的理由：不夾住就是「每 10 秒 1 個」
        // ＝每分鐘 6 個（設定值的 3 倍）。夾住之後是每 30 秒 1 個＝每分鐘 2 個。
        var options = new RateLimitOptions { PermitLimit = 2, WindowSeconds = 60, SegmentsPerWindow = 6 };

        Assert.Equal(1, options.TokensPerPeriod);
        Assert.Equal(TimeSpan.FromSeconds(30), options.ReplenishmentPeriod);
    }

    [Fact]
    public void UnnormalizedSegments_DoNotThrow()
    {
        // `Program.cs` 會先把非正的值換成預設值；這個屬性仍然要在那之前讀得出來
        // （請求路徑上的東西不該因為一個還沒正規化的設定而拋）。
        var options = new RateLimitOptions { SegmentsPerWindow = 0 };

        Assert.Equal(60, options.TokensPerPeriod);
        Assert.Equal(TimeSpan.FromSeconds(60), options.ReplenishmentPeriod);
    }
}

/// <summary>
/// 列舉面限流的契約（2026-09-24）。政策與數字都在 `Options/RateLimitPolicy`（後端）；
/// 這一類只驗**行為**：逾額是什麼形狀、誰跟誰共用一個桶、以及限流相對於授權的**順序**。
///
/// **自己的 `IClassFixture` ⇒ 自己的 host ⇒ 自己的限流狀態**，而且限額在這一類被壓到 3
/// （`ApiWebApplicationFactory.RateLimitPermitLimit`）——60 次／分的預設值在測試裡
/// 要送 61 次請求才觀測得到逾額。**這個覆寫不會外溢**：xUnit 的 `IClassFixture` 是
/// **每個類別各一個實例**，其他類別的 host 走的是預設值。
///
/// ★ **桶活在 host 裡，而 host 在整個類別之間共用** ⇒ 同一類別的測試**會互相排空對方的桶**。
/// 這一類的每一支都用 `FreshClientAsync` 造一個**全新的帳號**（⇒ 全新的分區），
/// 所以測試之間沒有順序依賴——**這是刻意的設計，不是樣板**：`WithinLimit_…` 那一支若沿用
/// 同一個帳號，另一個測試先跑就會讓它紅在「第 1 次就 429」。
/// </summary>
public class RateLimitTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public RateLimitTests(ApiWebApplicationFactory factory)
    {
        // 這三行必須在 `CreateClient()` **之前**：host 只建置一次，組態與 DB 重置都在那一次生效。
        factory.RateLimitPermitLimit = 3;
        factory.RateLimitSegmentsPerWindow = 3;
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    /// <summary>
    /// 造一個**全新的帳號**，回傳帶著它的 token 的 client。兩件事同時成立：
    ///
    /// ① **全新的分區**——分區鍵是使用者 id（`RateLimitPolicy.PartitionKey`）
    ///    ⇒ 這是一個新的桶，測試之間不會互相排空。
    /// ② **預設 `isAdmin = true`**——兩個受政策保護的端點都掛著權限閘門，而 admin 直接放行。
    ///    非 admin 的新帳號會被擋下（閘門在限流器**之後**，桶是新鮮的所以限流器一定放行）
    ///    ⇒ 那樣就分不出「限流放行」與「權限擋下」，這一類的斷言會全部失去判別力。
    ///    **`isAdmin: false` 只有 `OverLimit_OutranksForbidden…` 那一支在用**——它要的正是
    ///    那個擋下來的狀態碼，拿它當「桶還滿」的對照組。
    ///    ★ **那個狀態碼是 `X-Team-Id` 決定的，不是「非 admin」決定的**（2026-09-24 全量才
    ///    發現）：**沒有 header ⇒ 400**、**有 header 但沒權限 ⇒ 403**。第一版少了 header，
    ///    前提斷言拿到 400 ⇒ 紅。**要 403 就自己帶一個不屬於任何團隊的 Guid。**
    /// </summary>
    private async Task<HttpClient> FreshClientAsync(string username, bool isAdmin = true)
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        var admin = _factory.CreateClient();
        admin.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var created = await admin.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = username,
            isAdmin,
        }));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    private static Task<HttpResponseMessage> SearchAsync(HttpClient client)
        => client.GetAsync("/api/auth/users/search?q=abc");

    private async Task ExhaustAsync(HttpClient client)
    {
        // 名額是 3（建構子覆寫的）。送 4 次＝不管先前狀態如何，桶一定空了。
        for (var i = 0; i < 4; i++) await SearchAsync(client);
    }

    [Fact]
    public async Task WithinLimit_Succeeds_ThenExceeding_Returns429WithContractBody()
    {
        var client = await FreshClientAsync("ratelimit-contract");

        // ① 限額內全數放行。**3 次**是覆寫後的名額：桶**一開始是滿的**（token bucket 的
        //    `TokenLimit`；滑動窗時代同構，補充週期只決定額度什麼時候回來）
        //    ⇒ 對一個全新的分區「前 3 次成功」是可斷言的。
        for (var i = 0; i < 3; i++)
        {
            var ok = await SearchAsync(client);
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        }

        // ② 第 4 次逾額。
        var rejected = await SearchAsync(client);
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);

        // body **恰好**是 `{code, message}`——不是「有這兩個欄位」而是「只有這兩個」：
        // 逐位元比對整份 JSON（含屬性順序）。多一個欄位就代表有人把例外資訊、追蹤碼或
        // 重試秒數餵進了 body，而那正是 500 那一族擋掉的形狀。
        var raw = await rejected.Content.ReadAsStringAsync();
        var code = ErrorCodes.RequestTooManyRequests;
        Assert.Equal($"{{\"code\":\"{code}\",\"message\":\"{ErrorMessages.For(code)}\"}}", raw);

        // `Retry-After`（2026-09-24 裁定 D6）。**值是補充週期，不是整窗**：本類別把名額壓到
        // 3、段數 3、窗寬走預設 60 ⇒ 每 20 秒還 1 個，而第 4 次請求的缺口是 1 個 ⇒ 一個週期
        // ⇒ **20 秒**。這一格同時釘住三件事，缺一不可：
        //   ① header 真的送出來了——滑動窗的租約**不帶** `MetadataName.RetryAfter`（實測），
        //      換演算法之前的這一版會在這裡拿到 null。**演算法就是為了這一格換的。**
        //   ② 值是**週期**——寫成整窗（60）或 0 都會紅。
        //   ③ 無條件進位：0 秒等於叫呼叫端立刻重試，是這顆 header 的反面。
        Assert.NotNull(rejected.Headers.RetryAfter);
        Assert.Equal(TimeSpan.FromSeconds(20), rejected.Headers.RetryAfter!.Delta);
    }

    [Fact]
    public async Task ExhaustedBucket_DoesNotAffectAnotherUser()
    {
        var exhausted = await FreshClientAsync("ratelimit-iso-a");
        var other = await FreshClientAsync("ratelimit-iso-b");

        await ExhaustAsync(exhausted);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SearchAsync(exhausted)).StatusCode);

        // ③ 另一個使用者不受影響。**這一格才是「分區」的判別點**：分區鍵若退化成常數
        //    （所有人共用一個桶），這一支會拿到 429——而其他每一支都照樣綠。
        Assert.Equal(HttpStatusCode.OK, (await SearchAsync(other)).StatusCode);
    }

    [Fact]
    public async Task UsersEndpoint_IsNotRateLimited()
    {
        var client = await FreshClientAsync("ratelimit-reverse");

        await ExhaustAsync(client);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SearchAsync(client)).StatusCode);

        // ④ **反向對照**：同一個使用者、同一個（已排空的）桶，但 `/users` 沒有掛政策
        //    ⇒ 必須照綠。政策是**端點級**的、不是全域的——少了這一格，把
        //    `UseRateLimiter` 掛成全域名額（或把政策設成 fallback policy）不會有測試變紅，
        //    而 `/users` 正是那個「回應固定、不因輸入而變化」所以刻意不限流的端點。
        var users = await client.GetAsync("/api/auth/users");
        Assert.Equal(HttpStatusCode.OK, users.StatusCode);
    }

    [Fact]
    public async Task Unauthenticated_IsRejected401_BeforeRateLimiting()
    {
        // ⑤ **順序**：`UseAuthorization` 排在 `UseRateLimiter` 之前 ⇒ 未帶憑證的請求在
        // 授權中介層就被挑戰成 401，**根本到不了限流器**。
        //
        // 量**五次**（名額是 3）是這一支的判別力所在：匿名請求全部落在同一個回退桶
        // （`RateLimitPolicy.PartitionKey` 的 `anonymous`）⇒ 順序若顛倒，第 4 次起會變成 429，
        // 而**只送一次的話兩種順序都會回 401**（新鮮的桶讓第一次一定過得了限流器）。
        var anonymous = _factory.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            var res = await anonymous.GetAsync("/api/auth/users/search?q=abc");
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }

        // 401 的 body 來自認證挑戰（`ApiResults.WriteUnauthorizedAsync`）——不是空 body：
        // 空的 401 是 2026-09-20 那批修掉的形狀，這裡順手釘住它在這一條路徑上也成立。
        var body = await (await anonymous.GetAsync("/api/auth/users/search?q=abc"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(ErrorCodes.AuthUnauthenticated, body.GetProperty("code").GetString());
    }

    /// <summary>
    /// ⑥ **順序的另一半：逾額排在權限之前**——同一個請求裡限流器先跑，所以一個**沒有權限**
    /// 的呼叫端只要桶空了就會拿到 **429，而不是 403**。
    ///
    /// **為什麼要釘**：計畫 §3.3 把它寫成「不構成新的存在性 oracle（端點清單不是秘密），
    /// 但**要由測試釘住**，不讓它靜默翻面」——而原本的 T7⑤ 只釘了 401 那一半
    /// （2026-09-24 複閱的 L-1）。少了這一支，「把權限閘門搬到限流器之前」不會有任何紅燈，
    /// 而那個改動會**靜默改變每一個逾額請求的狀態碼**。
    ///
    /// 判別力來自**兩個狀態碼在同一個帳號上的先後對比**：桶還滿 ⇒ 403（權限擋下）、
    /// 桶空了 ⇒ 429。少了前面那一格，「429」也可能是因為這個帳號本來就有權限而毫無意義。
    /// </summary>
    [Fact]
    public async Task OverLimit_OutranksForbidden_UnauthorizedCallerGets429AfterBucketEmpties()
    {
        var client = await FreshClientAsync("ratelimit-order-perm", isAdmin: false);
        // ★ 非 admin **一定要自己帶 `X-Team-Id`**，否則拿到的不是 403 而是 **400**：
        // `RequirePermissionExtensions` 的守衛在 header 缺席／不可解析時
        // `StatusCode = 400` ＋ `WriteAsync("缺少 X-Team-Id header")`，**比權限判定更早**。
        // 帶一個**不屬於任何團隊**的 Guid ⇒ `PermissionChecker.HasPermissionAsync` 查無成員列
        // ⇒ 空集合 ⇒ 403。（`PermissionChecker` 是當場開檔讀的，不是推論。）
        // **這一格是 2026-09-24 全量才發現的**：本支第一版沒有這一行，前提斷言拿到的是 400。
        client.DefaultRequestHeaders.Add("X-Team-Id", Guid.NewGuid().ToString());

        // 前提：這個帳號沒有 `team.member.manage`。**這一格同時是前提的斷言**——
        // 它若紅了，代表新帳號其實拿得到權限，那這一支後半就失去判別力（見摘要）。
        Assert.Equal(HttpStatusCode.Forbidden, (await SearchAsync(client)).StatusCode);

        await ExhaustAsync(client);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SearchAsync(client)).StatusCode);
    }
}
