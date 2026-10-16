namespace Entask.Core;

/// <summary>
/// 寫入端的時區換算**唯一入口**（Q1／R5，2026-10-08 裁定）。
/// 讀取端從 2026-10-08 起零時區數學——凍結值在寫入當下由這裡算好、存進資料。
/// 認不得的 ID **不 fallback**：呼叫端一律 400（`request.timeZoneInvalid`），
/// 猜一個時區等於讓錯誤的日界線靜默生效。
/// </summary>
public static class TimeZones
{
    /// <summary>解析時區 ID——**契約是 IANA**（`Asia/Taipei`）；空白／null／認不得一律 false。
    /// 平台 ID（如 `Taipei Standard Time`）由 Windows 登錄檔子鍵比對接受，IANA 則靠 ICU 對映
    /// （invariant globalization 模式下不保證）——那是餘裕，不是契約。</summary>
    public static bool TryResolve(string? id, out TimeZoneInfo tz)
    {
        tz = TimeZoneInfo.Utc;
        if (string.IsNullOrWhiteSpace(id)) return false;
        try
        {
            tz = TimeZoneInfo.FindSystemTimeZoneById(id);
            return true;
        }
        catch (TimeZoneNotFoundException)
        {
            return false;
        }
        catch (InvalidTimeZoneException)
        {
            return false;
        }
    }

    /// <summary>選填欄位（成員／專案寫入，見 plan D8）：null／空白 ⇒ UTC（文件化的預設，
    /// 與 migration 回填同一語意）；**有值但認不得 ⇒ false**——認不得與沒帶是兩件事。</summary>
    public static bool TryResolveOptional(string? id, out TimeZoneInfo tz)
    {
        if (string.IsNullOrWhiteSpace(id)) { tz = TimeZoneInfo.Utc; return true; }
        return TryResolve(id, out tz);
    }

    /// <summary>作者當下的本地日（凍結候選）。`utcNow` 必須是 `Kind=Utc`
    /// （`ConvertTimeFromUtc` 對 `Local` 會拋 `ArgumentException`）。</summary>
    public static DateOnly LocalToday(DateTime utcNow, TimeZoneInfo tz) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(utcNow, tz));

    /// <summary>作者當下的本地牆鐘（填報時間）。`utcNow` 必須是 `Kind=Utc`
    /// （`ConvertTimeFromUtc` 對 `Local` 會拋 `ArgumentException`）。回傳值 `Kind=Unspecified`
    /// ——對應 `timestamp without time zone`；給 Utc 會被 Npgsql 拒收（見 ReportEndpoints.cs:32 前例）。</summary>
    public static DateTime LocalWallClock(DateTime utcNow, TimeZoneInfo tz) =>
        DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(utcNow, tz), DateTimeKind.Unspecified);
}
