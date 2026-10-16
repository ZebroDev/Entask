namespace Entask.Core;

/// <summary>
/// 年度績效的評級識別碼。與 <see cref="ActivityTypes"/> 同型：機器可讀的識別碼，不是文案。
///
/// 為何需要：這四個值原本是**三處各寫一次的三元式**（`TeamReportEndpoints` 的 JSON、
/// CSV 與 xls 三條輸出路徑），而前端 `TeamReportTab` 的 `default` 分支把認不得的等級
/// 顯示成「C 待加強」——後端新增等級時的症狀是**顯示錯的標籤**，不像活動型別缺 case
/// 那樣會印出識別碼，所以看不出來。守門員是 `web/scripts/check-label-tables.mjs`
/// 的第六張表。
///
/// 值會進入匯出檔（CSV 的 Rating 欄、xls 的儲存格），**不可重新命名**。
/// </summary>
public static class RatingCodes
{
    public const string S = "S";
    public const string A = "A";
    public const string B = "B";
    public const string C = "C";

    /// <summary>
    /// 由高至低。xls 的樣式區塊以這個順序產生——用陣列而不是走 dictionary 的列舉順序，
    /// 後者在 .NET 沒有保證，會讓匯出檔的 diff 不穩定。
    /// </summary>
    public static readonly string[] All = [S, A, B, C];
}
