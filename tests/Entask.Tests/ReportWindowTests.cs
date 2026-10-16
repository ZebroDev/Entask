using System.Linq.Expressions;
using Entask.Core.Entities;
using Entask.Performance;
using Xunit;

namespace Entask.Tests;

public class ReportWindowTests
{
    private static readonly DateTime Jan1 = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime NextJan1 = new(2027, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    // 分母述詞的格點：窗的前一刻／窗前界／窗內最後一刻／排他上界。
    private static readonly DateTime[] CreatedGrid =
        { Jan1.AddTicks(-1), Jan1, NextJan1.AddTicks(-1), NextJan1 };

    private static readonly DateTime?[] CompletedGrid =
        { null, Jan1.AddTicks(-1), Jan1, NextJan1.AddTicks(-1), NextJan1 };

    [Fact]
    public void All_IsTheLimitOfAnyWindow()
    {
        // 全期＝「沒有任何一張卡被窗框排除」。這是 §3 的極限性質，
        // 也是 Task 2 的 R1 回歸鎖能成立的理由。
        var w = ReportWindow.Create(null, null);
        Assert.True(w.IsAll);
        Assert.True(w.IsDeliveredInWindow(Jan1));
        Assert.True(w.IsDeliveredInWindow(null) == false);   // 沒交付就是沒交付
    }

    [Fact]
    public void DeliveredInWindow_UsesExclusiveUpperBound()
    {
        var w = ReportWindow.Create(Jan1, NextJan1);
        Assert.False(w.IsDeliveredInWindow(Jan1.AddTicks(-1)));  // 窗外（前一年最後一刻）
        Assert.True(w.IsDeliveredInWindow(Jan1));                // 恰為 from ⇒ 含
        Assert.True(w.IsDeliveredInWindow(NextJan1.AddTicks(-1)));
        Assert.False(w.IsDeliveredInWindow(NextJan1));           // 恰為 to ⇒ 不含（排他）
    }

    [Fact]
    public void From_NormalizesUnspecifiedKindToUtc()
    {
        // 裁定範例的 naive 字串（無時區標記）解析出 Kind=Unspecified；
        // 不正規化的話 Npgsql 對 timestamptz 會拒收。
        var naive = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
        var w = ReportWindow.Create(naive, null);
        Assert.Equal(DateTimeKind.Utc, w.From!.Value.Kind);
        Assert.Equal(naive.Ticks, w.From!.Value.Ticks);
    }

    [Fact]
    public void DenominatorClause_AgreesWithIsDeliveredInWindow_AcrossWholeGrid()
    {
        // review finding #1：`DenominatorClause` 的兩個析取項與 `IsDeliveredInWindow`
        // 是同一條規則的不同形式（expression 樹無法呼叫一般方法，只能各自手寫）。
        // 這裡把 expression 編譯到記憶體裡跑、逐格比對兩者——這是那一條規則的守門員。
        //
        // 第一個析取項的對照用 `IsDeliveredInWindow(c.CreatedAt)`：`Card.CreatedAt` 不可為
        // null，該呼叫因此正好退化為「建卡日在不在窗內」的同一條界線規則，不必在測試裡
        // 再寫第三份。界線本身由 `DeliveredInWindow_UsesExclusiveUpperBound` 以絕對值釘住，
        // 所以這個對照不是自我證成。
        var w = ReportWindow.Create(Jan1, NextJan1);
        var clause = w.DenominatorClause().Compile();

        foreach (var created in CreatedGrid)
            foreach (var completed in CompletedGrid)
            {
                var card = new Card { CreatedAt = created, CompletedAt = completed };
                var expected = w.IsDeliveredInWindow(card.CreatedAt) || w.IsDeliveredInWindow(completed);
                Assert.Equal(expected, clause(card));
            }
    }

    [Fact]
    public void DenominatorClause_ExplicitExpectations_AtEveryBoundary()
    {
        // 上面那支是逐格對照；這支把期望值直接寫死，免得兩份實作一起漂移時對照恆真。
        var w = ReportWindow.Create(Jan1, NextJan1);
        var clause = w.DenominatorClause().Compile();
        static Card At(DateTime created, DateTime? completed) =>
            new() { CreatedAt = created, CompletedAt = completed };

        // 建卡日在窗內 ⇒ 進分母，與交付日無關（達成率取「乙」）。
        Assert.True(clause(At(Jan1, null)));
        Assert.True(clause(At(NextJan1.AddTicks(-1), null)));
        Assert.True(clause(At(Jan1, Jan1.AddTicks(-1))));            // 交付日在窗外也一樣進
        // 建卡日在窗外 ⇒ 只有交付日在窗內才進分母。
        Assert.False(clause(At(Jan1.AddTicks(-1), null)));
        Assert.False(clause(At(Jan1.AddTicks(-1), Jan1.AddTicks(-1))));
        Assert.False(clause(At(NextJan1, null)));                    // 建卡恰在排他上界
        Assert.False(clause(At(NextJan1, NextJan1)));                // 兩個日期都恰在上界 ⇒ 都不含
        Assert.True(clause(At(NextJan1, Jan1)));                     // 建卡在窗外、交付在窗內 ⇒ 進
        Assert.True(clause(At(NextJan1, NextJan1.AddTicks(-1))));
    }

    [Fact]
    public void DenominatorClause_AllPeriod_AdmitsEveryCard()
    {
        // 設計 §3 的極限性質在 expression 這一側的形式：全期時沒有任何一張卡被分母排除。
        var w = ReportWindow.All;
        var clause = w.DenominatorClause().Compile();

        // 刻意取遠在任一年之外的日期：全期時它們與窗內無異。
        var farBefore = new DateTime(1999, 6, 1, 0, 0, 0, DateTimeKind.Utc);
        var farAfter = new DateTime(2030, 6, 1, 0, 0, 0, DateTimeKind.Utc);

        foreach (var created in new[] { farBefore, Jan1, farAfter })
            foreach (var completed in CompletedGrid)
            {
                var card = new Card { CreatedAt = created, CompletedAt = completed };
                Assert.True(clause(card));
                Assert.Equal(
                    w.IsDeliveredInWindow(card.CreatedAt) || w.IsDeliveredInWindow(completed),
                    clause(card));
            }

        // 對照：同一組建卡日一旦加窗就會被排除 ⇒ 上面的「一律為真」不是恆真斷言。
        var windowed = ReportWindow.Create(Jan1, NextJan1).DenominatorClause().Compile();
        Assert.False(windowed(new Card { CreatedAt = farBefore, CompletedAt = null }));
        Assert.False(windowed(new Card { CreatedAt = farAfter, CompletedAt = null }));
    }
}
