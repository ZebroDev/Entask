using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Entask.Api.Options;

/// <summary>
/// <c>enumeration</c> 政策的**唯一定義點**：政策名、分區鍵、限流器選項都在這裡。
///
/// 為什麼要有這個類別：政策名會被**三個**地方引用（<c>Program.cs</c> 的
/// <c>AddPolicy</c>，以及兩個端點的 <c>.RequireRateLimiting(...)</c>）。寫成三份字面值時，
/// 打錯一個字不會有任何編譯錯誤——**ASP.NET Core 在執行期才拋
/// 「No policy with name '…' was found」**，而那是請求路徑上的 500。常數把那個錯
/// 移回編譯期。同一個理由讓分區鍵也只寫一份：分區是限流的**語意**本身
/// （「每個人各有一個桶」），兩個端點各寫一份等於兩個不同的事實。
/// </summary>
public static class RateLimitPolicy
{
    /// <summary>
    /// 政策名。**改這個值等於同時改三個引用點**（見類別摘要），不需要動別的地方。
    /// </summary>
    public const string Name = "enumeration";

    /// <summary>取不到使用者身分時的分區桶（見 <see cref="PartitionKey"/>）。</summary>
    private const string AnonymousBucket = "anonymous";

    /// <summary>
    /// 分區鍵＝**使用者 id**（<c>BoardEndpoints.CurrentUserId</c> 的正典 claim：先
    /// <see cref="ClaimTypes.NameIdentifier"/>、再退回 <c>sub</c>）。
    ///
    /// **這個方法不可以拋例外、也不可以回 null**：它在請求路徑上，對**每一個**受政策保護的
    /// 請求都會跑，而且是在中介層裡被呼叫的——丟出來的例外會變成 500，等於「限流器把服務
    /// 打掛」；回 null 則會讓每一次請求各自拿到一個新桶，那正好是限流的反面。
    /// 所以取不到時回退一個**常數桶**。
    ///
    /// 正常路徑取不到：政策只掛在 <c>RequireAuthorization()</c> 的端點上，而授權中介層排在
    /// 限流器**之前** ⇒ 未帶憑證的請求在那裡就被挑戰成 401，根本到不了這裡。
    /// 那個回退值是為了「下一個人把政策掛到匿名端點上」而留的，不是死碼。
    /// </summary>
    public static string PartitionKey(HttpContext context) =>
        context.User.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? context.User.FindFirstValue(JwtRegisteredClaimNames.Sub)
        ?? AnonymousBucket;

    /// <summary>
    /// 建立這個請求所屬分區的限流器。回傳的是 <see cref="RateLimitPartition{TKey}"/>——
    /// 那是 <c>RateLimiterOptions.AddPolicy</c> 要的形狀（政策是「請求 → 分區」的函式，
    /// 不是「一個限流器」：同一個政策的所有分區共用這一份定義，各自持有自己的計數）。
    /// **值全部來自 <see cref="RateLimitOptions"/>，這裡不寫任何數字**——數字只有一個出處
    /// （屬性初始化），測試要壓低限額時改的是設定，而不是在這裡再抄一份。
    ///
    /// ★ **為什麼是 token bucket 而不是滑動窗**（2026-09-24 實測後改的，原本裁定是滑動窗）：
    /// `SlidingWindowRateLimiter` 的租約**永遠不帶** <c>MetadataName.RetryAfter</c>——成敗兩者
    /// 都以 `null` 建構（`SlidingWindowLease(true, null)`／`(false, null)`，見 runtime 原始碼），
    /// 所以 `Program.cs` 那段「有 metadata 就送 `Retry-After`」的分支在滑動窗下是**死碼**，
    /// 而 D6 要的就是那顆 header。`TokenBucketRateLimiter` 的失敗租約帶
    /// `ReplenishmentPeriod × replenishPeriods`（原始碼 `CreateFailedTokenLease`）⇒ header 有值。
    /// 平滑度兩者同構：一次給滿 <see cref="RateLimitOptions.PermitLimit"/>，之後每個補充週期
    /// 還 <see cref="RateLimitOptions.TokensPerPeriod"/> 個（預設 60／6 ⇒ 每 10 秒還 10 個）。
    ///
    /// ★ **代價是每個分區各有一個 timer，而分區只進不出**：`AutoReplenishment` 讓每個被建立
    /// 過的桶各帶一個計時器，而 `RateLimitPartition` 的分區快取**沒有淘汰**。
    /// 措辭要精確——「有請求才有」對**建立**成立（不為沒出現過的使用者預先建桶），
    /// 對**釋放**不成立：一個桶一旦被建起來就留著，連那個使用者再也不會回來也一樣。
    /// 今天的鍵空間是封閉的（已認證的 user id ＋ 一個 <see cref="PartitionKey"/> 的回退值）
    /// ⇒ 有界、可忽略；**分區鍵哪天換成 IP／路徑之類的開放鍵，同一段程式碼就是無界記憶體**。
    /// </summary>
    public static RateLimitPartition<string> CreateLimiter(HttpContext context, RateLimitOptions options) =>
        RateLimitPartition.GetTokenBucketLimiter(
            PartitionKey(context),
            _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = options.PermitLimit,
                TokensPerPeriod = options.TokensPerPeriod,
                ReplenishmentPeriod = options.ReplenishmentPeriod,
                // **0 是刻意的**：排隊會把請求扣在閘門前直到有名額，呼叫端看到的是一個
                // 「很慢但成功」的請求——前端 300ms debounce 的意義同時消失，而且呼叫端
                // 無從得知自己被限流。要退讓就當場說（429 ＋ `Retry-After`）。
                QueueLimit = 0,
            });
}
