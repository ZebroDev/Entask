using System.Text;

namespace Entask.Board.Positioning;

// 併發約定（2026-09-12）：
// Position 欄位沒有唯一索引，因此兩個並行操作可能算出相同的排序字串——
//   * 拖曳移動：用戶端以 between/after 自行計算後送出，伺服器僅原樣儲存，
//     無法偵測亦無法重算。
//   * 新增（board/list/card/label/checklist/custom-field/mindmap node）：
//     伺服器讀取 After(last) 後計算，屬 read-compute-write，並行新增會得到相同值。
// 兩者都不會拋例外（無唯一索引 → 沒有 23505、沒有 DbUpdateConcurrencyException），
// 故重試迴圈在此幫不上忙。實際後果是同分兩列在 PostgreSQL 的相對順序不保證穩定，
// 重新載入後可能前後跳動（前端 comparator 同分回 0，穩定排序會沿用伺服器給的次序）。
// 對策：所有依 Position 排序的查詢一律補 ThenBy(Id) 作為決定性次序鍵。
// 若要根絕重複（而非僅消除不穩定），需改為伺服器端配發 Position 並加唯一索引——
// 但用戶端拖曳路徑將因此改為需處理 409 重試，屬產品決策，不在技術債範圍內。
public static class FractionalPosition
{
    private const string Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    public static string After(string? last) => Between(last, null);

    public static string Between(string? lower, string? upper)
    {
        lower ??= "";
        upper ??= "";
        var sb = new StringBuilder();
        var i = 0;
        while (true)
        {
            var lowerDigit = i < lower.Length ? Digits.IndexOf(lower[i]) : 0;
            var upperDigit = i < upper.Length ? Digits.IndexOf(upper[i]) : Digits.Length - 1;
            if (lowerDigit == upperDigit)
            {
                sb.Append(Digits[lowerDigit]);
                i++;
                continue;
            }
            if (upperDigit - lowerDigit >= 2)
            {
                sb.Append(Digits[lowerDigit + (upperDigit - lowerDigit) / 2]);
                return sb.ToString();
            }
            sb.Append(Digits[lowerDigit]);
            lower = lower.Length > i + 1 ? lower[(i + 1)..] : "";
            upper = "";
            i = 0;
        }
    }
}
