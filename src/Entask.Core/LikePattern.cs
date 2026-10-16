namespace Entask.Core;

/// <summary>
/// LIKE pattern 的**唯一建造點**（2026-09-24）。使用者輸入要當成「字面子字串」比對時，
/// 一律經由這裡組 pattern——**不要在站點自己寫 `$"%{...}%"`**。
///
/// 為什麼需要這個類別：逃逸有兩個獨立的出錯方式，而它們都只在**特定輸入**下顯形
/// （`%`／`_` 當萬用字元、`\` 順序顛倒），一般輸入下行為完全正常。
/// 同一段規則抄成兩份時，第二份的漏寫不會有任何徵兆——兩站的測試各守各的，
/// 而**漏掉逃逸的那一站，它的既有測試仍然是綠的**（2026-09-24 的實例：
/// <c>SearchEndpoints</c> 少了逃逸的那段期間，`SearchTests` 的既有斷言**沒有一支碰到
/// `%`／`_`** ⇒ 全部照綠；那批是突變 M2 才把它變成紅燈的）。
/// **不要在這裡寫當下的支數**——它會腐爛，而過期的數字讀起來像一份實查。
///
/// **兩個要點**（2026-09-24 由 <c>AuthEndpoints</c> 的註解搬過來，逐字保留其判準）：
///
/// ① **`EscapeCharacter` 要明確傳給 `ILike`**（<c>EF.Functions.ILike(x, pattern, LikePattern.EscapeCharacter)</c>）
/// ——那是為了不吃伺服器預設值：PostgreSQL 的 LIKE 預設 escape 字元**本來就是** `\`
/// ⇒ 那一個引數今天不是「逃逸生效的原因」，而是把那個預設值寫成契約的一部分
/// （換實例、或預設值哪天改了，那一段仍然成立）。**但 `Escape` 與它是一組的**：
/// 只傳 escape 字元而沒有 <see cref="Escape"/> 過的輸入，`%` 仍然是萬用字元。
/// ② **`\` 必須先逃逸**。順序反過來（先逃逸 `%` 再逃逸 `\`）的話，補上去的反斜線會被
/// 自己再逃逸一次（`%` → `\%` → `\\%`）⇒ 那個 `\` 讀成**字面的反斜線**、`%` 退回
/// **萬用字元**，比對語意就變了（實測：`%%%` 在那個順序下**仍然**比對不到任何人，
/// 所以「看起來是對的」）。
///
/// 守門員是**兩個呼叫端各自的測試**（同型但不同站，兩邊都要有）：
/// <c>UserSearchTests</c> 的 B-5（有沒有逃逸）與 B-5b（**順序**）之於
/// <c>GET /api/auth/users/search</c>；<c>SearchTests</c> 的逃逸那兩格之於
/// <c>GET /api/projects/{projectId}/search</c>。B-5 對順序**全盲**——順序顛倒時
/// 它的兩格照樣全綠（`Assert.Empty` 因為錯的理由通過）⇒ **兩者守的是不同的性質**。
/// </summary>
public static class LikePattern
{
    /// <summary>要傳給 <c>EF.Functions.ILike</c> 的 escape 字元（見類別摘要 ①）。</summary>
    public const string EscapeCharacter = "\\";

    /// <summary>
    /// 「包含這個字面子字串」的 pattern（前後各一個萬用字元）。
    /// 值是**樣板**、不是比對結果——呼叫端仍要把 <see cref="EscapeCharacter"/> 傳給 `ILike`。
    /// </summary>
    public static string Contains(string value) => $"%{Escape(value)}%";

    /// <summary>
    /// 把 `\`、`%`、`_` 變成字面值。**順序不能換**（見類別摘要 ②）。
    /// </summary>
    public static string Escape(string value) =>
        value
            .Replace("\\", "\\\\")
            .Replace("%", "\\%")
            .Replace("_", "\\_");
}
