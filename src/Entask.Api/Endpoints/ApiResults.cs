using Entask.Core;

namespace Entask.Api.Endpoints;

/// <summary>
/// **404、401、429 與 500 的唯一產生點**。**不得寫成 <c>Results.NotFound(...)</c>／
/// <c>Results.Unauthorized()</c>／<c>Results.StatusCode(429)</c>／<c>Results.StatusCode(500)</c>**
/// ——閘門 <c>web/scripts/check-error-codes.mjs</c> 的規則 R1／R8／R15–R21 與 429 那一族一律違規
/// （設計 §5 Gate A），包含這個檔案自己，所以這裡走 <c>Results.Json(..., statusCode:)</c>：
/// 與 403 那批的 12 處手寫站點同一個形狀，在 wire 上與 <c>Results.NotFound(value)</c> 逐位元相同。
///
/// 閘門的 R4 釘住「全庫 <c>StatusCodes.Status404NotFound</c> 恰好一處」、R14 釘住
/// 「<c>StatusCodes.Status401Unauthorized</c> 恰好一處」、R15 釘住
/// 「<c>StatusCodes.Status500InternalServerError</c> 恰好一處」，就是下面那三行
/// ——單一產生點沒有白名單檔，靠的是 <c>check:query-filters</c> 那個「恰好一處」的既有慣例。
/// 429 那一族同形（該族規則的編號見閘門檔，別寫死在這裡）。
///
/// **401 與 500 為什麼有兩個入口、卻仍然只有一個產生點**：端點手上是 <c>IResult</c>，而
/// <c>RequireProjectPermission</c> 篩選器、JwtBearer 的 <c>OnChallenge</c> 與 <c>Program.cs</c>
/// 的全域例外中介層手上只有 <c>HttpContext</c>。兩個入口都走下面同一個
/// <c>ExecuteUnauthorizedAsync</c>／<c>ExecuteInternalErrorAsync</c>，
/// 所以「兩個入口」不會變成兩份 wire 形狀（404 只有一個入口，是因為它沒有非 IResult 的呼叫端）。
///
/// **429 只有一個入口，而且刻意不補第二個**：它的唯一呼叫端是限流器的 <c>OnRejected</c>
/// ——那是中介層，手上只有 <c>HttpContext</c>。端點永遠不會自己回 429（逾額在進 handler
/// **之前**就被攔下），所以一個 <c>IResult</c> 版本今天不會有使用者。**沒有使用者的入口
/// 就是沒有測試看著的形狀**：它會在下一次「順手補對稱」時長出來，而長出來的那一刻
/// 沒人驗得到它與這個入口逐位元相同。
///
/// **500 的第二個入口刻意不收 code 參數**（<see cref="WriteInternalErrorAsync"/>）：
/// 它唯一的呼叫端是例外中介層，而那一族**只有一個碼**、訊息固定。簽章上不留位置，
/// 「把例外資訊餵進 body」就變成**寫不出來**，而不是靠紀律不去寫。
/// </summary>
public static class ApiResults
{
    public static IResult NotFound(string code)
        => Results.Json(
            new { code, message = ErrorMessages.For(code) },
            statusCode: StatusCodes.Status404NotFound);

    public static IResult Unauthorized(string code) => new UnauthorizedJsonResult(code);

    /// <summary>
    /// 給沒有 <c>IResult</c> 可回的呼叫端（授權篩選器、<c>OnChallenge</c>）。
    /// 產生的回應與 <see cref="Unauthorized"/> **逐位元相同**。
    /// </summary>
    public static Task WriteUnauthorizedAsync(HttpContext context, string code)
        => ExecuteUnauthorizedAsync(context, code);

    private static Task ExecuteUnauthorizedAsync(HttpContext context, string code)
        => Results.Json(
            new { code, message = ErrorMessages.For(code) },
            statusCode: StatusCodes.Status401Unauthorized).ExecuteAsync(context);

    private sealed class UnauthorizedJsonResult(string code) : IResult
    {
        public Task ExecuteAsync(HttpContext httpContext) => ExecuteUnauthorizedAsync(httpContext, code);
    }

    /// <summary>
    /// 429 的**唯一入口**（見檔頭：這一族刻意不提供 <c>IResult</c> 版本）。
    /// 與 <see cref="InternalError"/> 同一個設計：**簽章上不留 code 的位置**——這一族只有一個碼，
    /// 要求呼叫端傳進來只會多一個「傳錯碼」的可能，而不會多一分彈性。
    /// </summary>
    public static Task WriteTooManyRequestsAsync(HttpContext context)
        => ExecuteTooManyRequestsAsync(context);

    private static Task ExecuteTooManyRequestsAsync(HttpContext context)
        => Results.Json(
            new { code = ErrorCodes.RequestTooManyRequests, message = ErrorMessages.For(ErrorCodes.RequestTooManyRequests) },
            statusCode: StatusCodes.Status429TooManyRequests).ExecuteAsync(context);

    /// <summary>
    /// 500 的端點側入口。**呼叫端只餵 code、不餵訊息**——訊息一律來自
    /// <see cref="ErrorMessages"/>，所以 500 的 body 只可能是那張表上的固定措辭。
    /// </summary>
    public static IResult InternalError(string code) => new InternalErrorJsonResult(code);

    /// <summary>
    /// 給沒有 <c>IResult</c> 可回的呼叫端（<c>Program.cs</c> 的全域例外中介層）。
    /// 產生的回應與 <see cref="InternalError"/> **逐位元相同**。
    /// </summary>
    public static Task WriteInternalErrorAsync(HttpContext context)
        => ExecuteInternalErrorAsync(context, ErrorCodes.ServerInternalError);

    private static Task ExecuteInternalErrorAsync(HttpContext context, string code)
        => Results.Json(
            new { code, message = ErrorMessages.For(code) },
            statusCode: StatusCodes.Status500InternalServerError).ExecuteAsync(context);

    private sealed class InternalErrorJsonResult(string code) : IResult
    {
        public Task ExecuteAsync(HttpContext httpContext) => ExecuteInternalErrorAsync(httpContext, code);
    }
}
