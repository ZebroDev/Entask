using System.Globalization;

namespace Entask.Api.Endpoints;

/// <summary>
/// 分頁 cursor：`(CreatedAt, Id)` 複合鍵的不透明序列化，形狀是 `{CreatedAt:O}|{Id:D}`。
/// 稽核端點與活動牆**共用同一份**（設計 §4.2／D3）——兩邊的排序都是
/// `.OrderByDescending(CreatedAt).ThenByDescending(Id)`，cursor 也就必須是同一把鍵。
///
/// 為什麼是複合鍵而不是只有時間戳：只帶時間戳的 cursor 會在「同一 `CreatedAt` 有多列」時
/// 把它們整批跳過（活動牆原本就是那個形狀：`state/45`／設計 §1.1）。
///
/// 為什麼是不透明字串（而不是兩個 query 參數）：進出各一值，前端 `getNextPageParam`
/// 直接回傳它、`pageParam` 的型別是 `string | null`；內部編碼日後要改也不必動客戶端。
/// 壞字串一律拒絕（`TryParse` 回 false ⇒ 端點回 400），
/// **不猜、也不靜默退回第一頁**——那會回一份看起來正常、其實不是使用者要的資料。
///
/// `Kind` 必須是 `Utc`：`RoundtripKind` 對不帶 `Z` 的字串給 `Unspecified`，而 Npgsql
/// **拒收**寫進 `timestamp with time zone` 的 Unspecified 值
/// （`src/Entask.Infrastructure/Data/EntaskDbContext.cs:99-101` 有同型記載）
/// ⇒ 那是必須當場拒絕、不能放行的形狀。
/// </summary>
internal readonly record struct TimestampIdCursor(DateTime CreatedAt, Guid Id)
{
    public override string ToString() => $"{CreatedAt:O}|{Id:D}";

    public static bool TryParse(string? s, out TimestampIdCursor cursor)
    {
        cursor = default;
        if (string.IsNullOrEmpty(s)) return false;
        var parts = s.Split('|');
        if (parts.Length != 2) return false;
        if (!DateTime.TryParse(parts[0], CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out var createdAt)) return false;
        if (createdAt.Kind != DateTimeKind.Utc) return false;
        if (!Guid.TryParse(parts[1], out var id)) return false;
        cursor = new TimestampIdCursor(createdAt, id);
        return true;
    }

    /// <summary>
    /// 三態：`raw` 是 null ⇒ **第一頁**（回 true、`key` 為 null）；合法 ⇒ true；
    /// 不合法 ⇒ false（呼叫端回 400）。
    /// </summary>
    public static bool TryRead(string? raw, out TimestampIdCursor? key)
    {
        key = null;
        if (raw is null) return true;
        if (!TryParse(raw, out var parsed)) return false;
        key = parsed;
        return true;
    }
}
