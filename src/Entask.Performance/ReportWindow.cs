using System.Linq.Expressions;
using Entask.Core.Entities;

namespace Entask.Performance;

/// <summary>
/// 報表的時間窗。**窗框語意的唯一出處**——`from`／`to` 這兩個原始參數不得越過它直接進查詢，
/// 否則「該年交付」與「在分母裡」會各自漂移（上一批的 bug 就是同一段公式被抄了三份）。
///
/// 窗 = [from, to)（**排他上界**）。`from`／`to` 皆 null ＝ 全期，此時
/// `CreatedAt ∈ 窗` 恆真 ⇒ 分母＝全部卡片、分子＝已交付 ⇒ **與加窗框之前的行為逐位相同**。
/// 「全期」因此不是一條特例分支，是同一個式子的極限。
/// </summary>
public readonly record struct ReportWindow(DateTime? From, DateTime? To)
{
    /// <summary>全期。與 `Create(null, null)` 等價，留著是為了讓呼叫端讀得出來意圖。</summary>
    public static ReportWindow All => new(null, null);

    /// <summary>
    /// 由查詢參數建立，並把 <see cref="DateTimeKind"/> 正規化。
    ///
    /// **`Unspecified` ⇒ 視為 UTC**（`SpecifyKind`，不是 `ToUniversalTime()`——後者會引入
    /// 機器的本地時區，正是「後端不得隱式判定時間」那條裁定要擋掉的依賴）。
    /// naive 字串（裁定範例的形狀）與帶 `Z` 的字串因此落在同一格。
    /// </summary>
    /// **命名注意**：工廠方法不得叫 `From`——`record struct` 的位置參數已經產生了
    /// 同名屬性 `From`，兩者同名是編譯錯誤。
    public static ReportWindow Create(DateTime? from, DateTime? to) =>
        new(Normalize(from), Normalize(to));

    private static DateTime? Normalize(DateTime? value) =>
        value is null ? null
        : value.Value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc)
            : value.Value.ToUniversalTime();

    public bool IsAll => From is null && To is null;

    /// <summary>
    /// 「這是不是該年的交付」——分子與準時率樣本的依據。
    /// **全期時退化為 `completedAt is not null`**，與加窗框之前的 `CardStats` 逐字同義。
    ///
    /// 注意它與 <see cref="DenominatorClause"/> 的第二個析取項是同一條規則的兩種形式
    /// （expression 樹無法呼叫一般方法，只能各自手寫）。**這兩種形式漂移時，不會有任何既有
    /// 查詢把它炸出來**——分子的卡片清單本身就是分母述詞篩出來的，`completed > total`
    /// 因此依構造不可達，那條不變量斷言也從未存在。守門員是 `ReportWindowTests` 的三支
    /// `DenominatorClause_*`：把 expression 編譯到記憶體裡、逐格比對兩者（不需 DB）。
    /// </summary>
    public bool IsDeliveredInWindow(DateTime? completedAt) =>
        completedAt is not null
        && (From is null || completedAt.Value >= From.Value)
        && (To is null || completedAt.Value < To.Value);

    /// <summary>
    /// 卡片在不在**分母**：建卡日在窗內，或交付日在窗內（達成率取「乙」）。
    ///
    /// 為什麼分母不能也用「交付日」：`CardStats` 的分子分母出自同一份清單，
    /// 而 `RatingFor` 的 A／B／C 三級全由達成率決定 ⇒ 分母若也是交付年，
    /// 達成率恆為 1.0，B／C 變成不可達（設計 §1.3）。
    /// </summary>
    public Expression<Func<Card, bool>> DenominatorClause()
    {
        var from = From;
        var to = To;
        return c =>
            ((from == null || c.CreatedAt >= from) && (to == null || c.CreatedAt < to))
            || (c.CompletedAt != null
                && (from == null || c.CompletedAt >= from)
                && (to == null || c.CompletedAt < to));
    }
}
