using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace Entask.Tests;

/// <summary>一筆被攔下來的日誌。`State` 保留結構化欄位，斷言才不會綁在訊息的文字上。</summary>
public sealed record CapturedLog(
    string Category,
    LogLevel Level,
    string Message,
    IReadOnlyList<KeyValuePair<string, object?>> State);

/// <summary>
/// 測試用的日誌捕獲。存在的理由：**日誌是唯一沒有其他觀測窗口的東西**——
/// 其他測試都只看得到 HTTP 回應，所以「某個分支有沒有留下痕跡」如果不捕獲就無法斷言，
/// 那一行 `LogWarning` 也就沒有守門員（本 repo 對「加了東西卻沒有守門員」的代價
/// 記了很多次）。用法見 `ApiWebApplicationFactory.LogCapture`。
///
/// <para>
/// **只收 `Warning` 以上**：`IsEnabled` 直接回 false 讓低階日誌連格式化都不做，
/// 否則光是 EF Core 的 `Information` 就會灌進大量與斷言無關的條目。
/// </para>
///
/// <para>
/// ★ **它擋不住「應用程式自己的篩選規則」**——`LoggerFactory` 會先按 `appsettings.json` 的
/// `Logging:LogLevel` 過濾，過不了的連 `Log` 都到不了這裡。今天
/// `src/Entask.Api/appsettings.json` 是 `Default: "Information"`（實查）⇒ 警告過得去；
/// 但若有人為了讓測試輸出安靜而把 `Entask.Infrastructure.Identity` 調成 `Error`，
/// 這裡的**正向**守門員會當場變紅——**失敗方向是安全的**（不是靜默），只是紅燈不會自己
/// 說出原因，所以寫在這裡。
/// </para>
///
/// <para>
/// **刻意不去覆寫那些規則**（不在測試 host 補一條 `AddFilter` 把這個類別釘在 `Warning`）：
/// 蓋掉的話，「生產環境的 log 設定把這個警告吃掉」就變成測試看不見的事——而那正是這個
/// 守門員應該反映的東西。測試依賴真實設定是**有意圖的**，不是忘了隔離。
/// </para>
/// </summary>
public sealed class CapturingLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<CapturedLog> _entries = new();

    public IReadOnlyList<CapturedLog> Entries => _entries.ToArray();

    /// <summary>
    /// 清空。同一個測試類別共用一條 factory ⇒ 前一支測試留下的條目還在這裡
    /// （本檔就是這樣：好幾支都會觸發重放），所以「這一支有沒有留下痕跡」要先清乾淨才問得準。
    /// 同類別的測試是循序跑的（xUnit 只在類別之間平行），所以不必考慮競態。
    /// </summary>
    public void Clear() => _entries.Clear();

    public ILogger CreateLogger(string categoryName) => new CapturingLogger(categoryName, _entries);

    // **必須保持空實作。** 這個 provider 是被共用的**同一個實例**（`ApiWebApplicationFactory`
    // 註冊成 singleton，同一條 factory 的所有測試共用它），而 `Clear()` 是測試自己按順序呼叫的
    // ——處置的時機卻不歸測試管。任何人把「清空」或「標記已處置」寫進來，都可能讓某一支測試
    // 在跑到一半時失去證據，而失敗方向是靜默的（`Assert.DoesNotContain` 會變成恆真）。
    public void Dispose() { }

    private sealed class CapturingLogger(
        string category,
        ConcurrentQueue<CapturedLog> sink) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;

            // 結構化的 `state` 是一個 `IEnumerable<KeyValuePair<string, object?>>`，
            // 鍵就是訊息樣板裡的 `{UserId}` 這種佔位名。非結構化的呼叫端
            // （`LogWarning("純字串")`）會走 `FormattedLogValues`，鍵是 `{OriginalFormat}`。
            var fields = state is IEnumerable<KeyValuePair<string, object?>> pairs
                ? pairs.ToList()
                : [];

            sink.Enqueue(new CapturedLog(category, logLevel, formatter(state, exception), fields));
        }
    }
}
