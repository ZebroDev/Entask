using System.Security;
using System.Text;

namespace Entask.Api.Endpoints;

/// <summary>
/// SpreadsheetML（Excel XML）文字格的轉義：濾除 XML 1.0 非法字元
/// （U+0000–U+0008、U+000B、U+000C、U+000E–U+001F，以及**非字元** U+FFFE／U+FFFF——XML 1.0 的
/// Char production 只到 `#xFFFD`；tab／LF／CR 合法、保留）**再** `SecurityElement.Escape`
/// （後者只處理 `&amp;` `&lt;` `&gt;` `"` `'`）。
/// 單一實作：`WorkLogExport` 與 `TeamReportEndpoints` 共用——2026-10-08 之前只有 `WorkLogExport`
/// 那**一份**有濾除，而 `TeamReportEndpoints` 的兩格只做 XML 轉義：一筆含此類字元的顯示名
/// （例如貼上的控制碼、或 `￿` 這種非字元）會讓整份檔案在 Excel 拒開，受影響的是同區間
/// 的所有讀者。**public 是為了可測**（先例 `UserEndpoints.ResolveAvatarsRoot`）。
///
/// ★ 落單代理項**不必**濾：`Encoding.UTF8`（靜態實例）的編碼器後備是替換後備 ⇒ 它會把不成對的
/// 代理項寫成 U+FFFD（合法字元）。要濾的非法 BMP 碼點就是上面那些，沒有第三類。
/// </summary>
public static class SpreadsheetMl
{
    public static string Escape(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder(s.Length);
        foreach (var c in s)
            if ((c >= ' ' && c is not ('￾' or '￿')) || c is '\t' or '\n' or '\r') sb.Append(c);
        return SecurityElement.Escape(sb.ToString()) ?? "";
    }
}
