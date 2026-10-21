using Entask.Performance;
using static Entask.Tests.ReportDrilldownTestTime;

namespace Entask.Tests;

/// <summary>
/// due date 變更的**純函式**契約（2026-10-20 報表可解釋性，Task 3）。
///
/// 2026-10-21 自 `ReportDrilldownTests.cs` 拆出（那個檔會撞上 800 行上限）。拆出來的
/// 判準是「不需要 `WebApplicationFactory`」：這幾支只看輸入與輸出，不碰 DB、也不靠
/// planner 選了哪顆 index。整合測試（含同一條排序契約的 wiring 證據）留在原檔。
/// </summary>
public class ReportDrilldownDueChangeTests
{
    /// <summary>
    /// legacy detail（Task 3 之前寫入的 `due_change` 沒有欄位，例如 `{"hours":1}`）：
    /// 兩欄都是 null、`ChangedAt` 保留，**不拋例外**——舊資料在庫裡就是這個形狀，
    /// 它不得讓整份 drill-down 500。
    /// </summary>
    [Fact]
    public void ParseDueChangeEntry_ToleratesLegacyDetail()
    {
        var changedAt = Utc(2026, 9, 10);
        var entry = ReportDrilldownQueries.ParseDueChangeEntry(changedAt, "{\"hours\":1}");

        Assert.Equal(changedAt, entry.ChangedAt);
        Assert.Null(entry.From);
        Assert.Null(entry.To);
    }

    /// <summary>
    /// detail 根本不是物件（null／空字串／不是 JSON／JSON 陣列）：整筆回 null 欄位，不拋例外。
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("null")]
    public void ParseDueChangeEntry_ReturnsNulls_ForNonObjectDetail(string? detail)
    {
        var entry = ReportDrilldownQueries.ParseDueChangeEntry(Utc(2026, 9, 10), detail);

        Assert.Equal(Utc(2026, 9, 10), entry.ChangedAt);
        Assert.Null(entry.From);
        Assert.Null(entry.To);
    }

    /// <summary>
    /// 容錯是**逐欄位獨立**：任一欄壞掉只讓那一欄變 null，另一欄與 `ChangedAt` 照留。
    /// 最後一列是正對照（兩欄都合法 ⇒ 兩欄都讀得到），確保上面的 null 不是「什麼都回 null」。
    /// </summary>
    [Theory]
    [InlineData("{\"from\":5,\"to\":\"2026-09-20T00:00:00Z\"}", null)]                 // 非字串
    [InlineData("{\"from\":\"nope\",\"to\":\"2026-09-20T00:00:00Z\"}", null)]          // 非日期
    [InlineData("{\"from\":null,\"to\":\"2026-09-20T00:00:00Z\"}", null)]              // 顯式 null 同缺欄位
    [InlineData("{\"to\":\"2026-09-20T00:00:00Z\"}", null)]                            // 缺 from
    [InlineData("{\"from\":\"2026-09-01T00:00:00Z\",\"to\":\"2026-09-20T00:00:00Z\"}",
        "2026-09-01T00:00:00Z")]                                                       // 正對照
    public void ParseDueChangeEntry_ReadsFieldsIndependently(string detail, string? expectedFrom)
    {
        var entry = ReportDrilldownQueries.ParseDueChangeEntry(Utc(2026, 9, 10), detail);

        Assert.Equal(Utc(2026, 9, 10), entry.ChangedAt);
        Assert.Equal(expectedFrom is null ? null : Utc(2026, 9, 1), entry.From);
        Assert.Equal(Utc(2026, 9, 20), entry.To);
    }

    /// <summary>
    /// 分組／排序／解析是純函式：輸入**逆序**（後發生的變更排在前面）時，輸出仍依
    /// `ChangedAt` 遞增。這條是**契約紅燈**——不看資料庫，因此不受 planner 是否選中
    /// `(CardId, CreatedAt, Id)` index 影響（選中時列序本來就是 `CreatedAt` 遞增）。
    /// </summary>
    [Fact]
    public void GroupDueChanges_SortsByChangedAt_EvenWhenInputIsDescending()
    {
        var cardId = Guid.NewGuid();
        var later = new DueChangeActivity(cardId, Utc(2026, 9, 10), Guid.NewGuid(),
            "{\"from\":\"2026-08-01T00:00:00Z\",\"to\":\"2026-09-20T00:00:00Z\"}");
        var earlier = new DueChangeActivity(cardId, Utc(2026, 9, 5), Guid.NewGuid(),
            "{\"from\":\"2026-09-20T00:00:00Z\",\"to\":\"2026-10-01T00:00:00Z\"}");

        var entries = ReportDrilldownQueries.GroupDueChanges(new[] { later, earlier })[cardId];

        Assert.Equal(new[] { Utc(2026, 9, 5), Utc(2026, 9, 10) },
            entries.Select(e => e.ChangedAt).ToArray());
    }

    /// <summary>
    /// 同一張卡、`ChangedAt` 完全相同時，以 `Id` 遞增打破平手。
    /// 期望順序用與實作相同的比較語意（`Guid.CompareTo`）決定——不假設字串序。
    /// </summary>
    [Fact]
    public void GroupDueChanges_BreaksChangedAtTiesByIdAscending()
    {
        var cardId = Guid.NewGuid();
        var changedAt = Utc(2026, 9, 10);
        var smallerId = Guid.Parse("0f0e0d0c-0b0a-4908-8706-050403020100");
        var largerId = Guid.Parse("0f0e0d0c-0b0a-4908-8706-050403020101");
        Assert.True(smallerId.CompareTo(largerId) < 0, "前提：smallerId 依 Guid.CompareTo 較小");

        // 輸入刻意把較大的 Id 放前面；兩筆的 from／to 不同，才能認出誰排在哪。
        var larger = new DueChangeActivity(cardId, changedAt, largerId,
            "{\"from\":\"2026-09-01T00:00:00Z\",\"to\":\"2026-09-20T00:00:00Z\"}");
        var smaller = new DueChangeActivity(cardId, changedAt, smallerId,
            "{\"from\":\"2026-08-01T00:00:00Z\",\"to\":\"2026-09-01T00:00:00Z\"}");

        var entries = ReportDrilldownQueries.GroupDueChanges(new[] { larger, smaller })[cardId];

        Assert.Equal(2, entries.Count);
        Assert.Equal(Utc(2026, 9, 1), entries[0].To);    // 較小的 Id 先
        Assert.Equal(Utc(2026, 9, 20), entries[1].To);
    }
}

/// <summary>
/// 兩個 drill-down 測試檔共用的時間建構子（`Utc(2026, 9, 10)`）。**只留一份**：日期
/// 建構抄兩份時，`DateTimeKind` 會有一個先漂移，而 `DateTime` 的相等比對只會讓某些斷言
/// 莫名其妙差 8 小時。兩邊都以 `using static` 匯入，呼叫端維持 `Utc(...)` 的形狀。
/// </summary>
internal static class ReportDrilldownTestTime
{
    internal static DateTime Utc(int year, int month, int day) =>
        new(year, month, day, 0, 0, 0, DateTimeKind.Utc);
}
