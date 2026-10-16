using Entask.Api.Endpoints;

namespace Entask.Tests;

/// <summary>
/// CSV 公式注入防護（外部報告 C 類第 1 條，2026-10-08）。`=` `+` `-` `@` 開頭的欄位
/// 在 Excel 開啟時會被當成公式求值；Tab／CR 同族（OWASP CSV Injection）。
/// </summary>
public class CsvFieldTests
{
    [Theory]
    [InlineData("=1+1", "'=1+1")]
    [InlineData("+A1", "'+A1")]
    [InlineData("-2+3", "'-2+3")]
    [InlineData("@SUM(A1)", "'@SUM(A1)")]
    [InlineData("\t=1+1", "'\t=1+1")]
    [InlineData("\r=1+1", "'\r=1+1")]
    // 反向對照（這半才是判別力的來源）：危險字元不在開頭、或根本沒有 ⇒ 一個字都不改。
    [InlineData("a=b", "a=b")]
    [InlineData("1+1", "1+1")]
    [InlineData("正常文字", "正常文字")]
    // 既有引號加倍保留，且與前綴同時成立。
    [InlineData("\"quoted\"", "\"\"quoted\"\"")]
    [InlineData("=\"x\"", "'=\"\"x\"\"")]
    // 已加前綴的不二次加。
    [InlineData("'=1+1", "'=1+1")]
    public void Escape_NeutralizesFormulaLeadingCharacters(string input, string expected) =>
        Assert.Equal(expected, CsvField.Escape(input));

    [Fact]
    public void Escape_NullBecomesEmpty() => Assert.Equal("", CsvField.Escape(null));

    [Fact]
    public void Escape_EmptyStaysEmpty() => Assert.Equal("", CsvField.Escape(""));
}
