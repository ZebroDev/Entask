using Entask.Board.Positioning;

namespace Entask.Tests;

public class FractionalPositionTests
{
    [Fact]
    public void Between_NullAndValue_ReturnsPositionBeforeValue()
    {
        var p = FractionalPosition.Between(null, "a");
        Assert.True(string.CompareOrdinal(p, "a") < 0);
    }

    [Fact]
    public void Between_TwoValues_ReturnsStrictlyBetween()
    {
        var p = FractionalPosition.Between("a", "c");
        Assert.True(string.CompareOrdinal("a", p) < 0);
        Assert.True(string.CompareOrdinal(p, "c") < 0);
    }

    [Fact]
    public void Between_AdjacentValues_StillStrictlyBetween()
    {
        var p = FractionalPosition.Between("a", "b");
        Assert.True(string.CompareOrdinal("a", p) < 0);
        Assert.True(string.CompareOrdinal(p, "b") < 0);
    }

    [Fact]
    public void After_ReturnsPositionGreaterThanLast()
    {
        var p = FractionalPosition.After("z");
        Assert.True(string.CompareOrdinal("z", p) < 0);
    }
}
