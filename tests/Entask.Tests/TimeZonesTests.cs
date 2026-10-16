using Entask.Core;

namespace Entask.Tests;

// 寫入端的時區換算單一入口（Q1／R5，2026-10-08 裁定）。
public class TimeZonesTests
{
    [Theory]
    [InlineData("Asia/Taipei")]
    [InlineData("UTC")]
    [InlineData("Pacific/Kiritimati")]   // UTC+14，無 DST
    [InlineData("America/Santiago")]     // 有 DST：IANA ID 必須被 ICU 對映，不是 offset
    public void TryResolve_KnownIanaIds_Succeeds(string id)
    {
        Assert.True(TimeZones.TryResolve(id, out var tz));
        Assert.NotNull(tz);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("+08:00")]               // offset 不是 ID（R5 ②：建議帶 IANA ID 而非 offset）
    [InlineData("Not/AZone")]
    public void TryResolve_MissingOrUnknown_ReturnsFalse(string? id) =>
        Assert.False(TimeZones.TryResolve(id, out _));

    [Fact]
    public void TryResolveOptional_AbsentOrBlank_IsUtc_UnknownIsRejected()
    {
        Assert.True(TimeZones.TryResolveOptional(null, out var a));
        Assert.Equal(TimeZoneInfo.Utc, a);
        Assert.True(TimeZones.TryResolveOptional("   ", out var b));
        Assert.Equal(TimeZoneInfo.Utc, b);
        Assert.False(TimeZones.TryResolveOptional("Not/AZone", out _));
    }

    // 判別力：+14 與 -11 相差 25 小時 ⇒ 兩者的本地日**必然**不同；
    // 且任一時刻至少有一個與 UTC 日不同 ⇒ 「直接取 UTC 日」的實作一定會被其中一條抓到。
    [Fact]
    public void LocalToday_UsesTheGivenTimeZone_NotUtc()
    {
        var utcNow = new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);
        Assert.True(TimeZones.TryResolve("Pacific/Kiritimati", out var east));
        Assert.True(TimeZones.TryResolve("Pacific/Midway", out var west));
        Assert.Equal(new DateOnly(2026, 9, 8), TimeZones.LocalToday(utcNow, east));
        Assert.Equal(new DateOnly(2026, 9, 7), TimeZones.LocalToday(utcNow, west));
        Assert.NotEqual(TimeZones.LocalToday(utcNow, east), TimeZones.LocalToday(utcNow, west));
    }

    [Fact]
    public void LocalWallClock_IsUnspecifiedWallClock_InTheGivenTimeZone()
    {
        var utcNow = new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);
        Assert.True(TimeZones.TryResolve("Asia/Taipei", out var tpe));
        var wall = TimeZones.LocalWallClock(utcNow, tpe);
        Assert.Equal(new DateTime(2026, 9, 7, 20, 0, 0), wall);
        // Kind 必須是 Unspecified——Npgsql 的 timestamp without time zone 拒收 Utc（會 500）
        Assert.Equal(DateTimeKind.Unspecified, wall.Kind);
    }
}
