namespace Entask.Api.Endpoints;

/// <summary>
/// CSV 欄位的轉義＋**公式注入防護**（OWASP CSV Injection，2026-10-08，外部報告 C 類第 1 條）。
/// 以 `=` `+` `-` `@` `\t` `\r` 開頭的欄位在 Excel／Sheets 開啟時會被當成公式求值——
/// 前置一個 `'` 讓它變成文字。**只套在文字欄**；數值欄不經這裡（負數不能被改）。
/// 代價：那些文字欄在 Excel 會多一個可見的 `'`——這是這個防護的標準取捨，不是缺陷。
/// 呼叫端：`ReportEndpoints` 與 `TeamReportEndpoints` 的 CSV 建構器（在此之前兩者各自
/// 手寫 `Replace("\"", "\"\"")`）。**public 是為了可測**（先例 `UserEndpoints.ResolveAvatarsRoot`）。
/// </summary>
public static class CsvField
{
    public static string Escape(string? value)
    {
        var v = value ?? "";
        if (v.Length > 0 && v[0] is '=' or '+' or '-' or '@' or '\t' or '\r')
            v = "'" + v;
        return v.Replace("\"", "\"\"");
    }
}
