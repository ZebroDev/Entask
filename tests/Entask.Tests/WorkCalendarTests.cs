using Entask.Core.Entities;
using Entask.Performance;

namespace Entask.Tests;

public class WorkCalendarTests
{
    [Theory]
    [InlineData(2026, 9, 7, true)]    // 週一
    [InlineData(2026, 9, 11, true)]   // 週五
    [InlineData(2026, 9, 12, false)]  // 週六
    [InlineData(2026, 9, 13, false)]  // 週日
    public void IsWorkday_WeekdaysOnly(int y, int m, int d, bool expected) =>
        Assert.Equal(expected, WorkCalendar.IsWorkday(new DateOnly(y, m, d)));

    [Fact]
    public void WorkdaysBetween_ExcludesWeekendAndIsExclusiveOfEnd()
    {
        // 2026-09-07（一）～ 2026-09-14（一，排他）→ 5 個工作日
        var days = WorkCalendar.WorkdaysBetween(new DateOnly(2026, 9, 7), new DateOnly(2026, 9, 14));
        Assert.Equal(5, days.Count);
        Assert.Equal(new DateOnly(2026, 9, 7), days[0]);
        Assert.Equal(new DateOnly(2026, 9, 11), days[^1]);
    }

    [Fact]
    public void WorkdaysBetween_SingleDay_WhenEndIsNextDay()
    {
        var days = WorkCalendar.WorkdaysBetween(new DateOnly(2026, 9, 10), new DateOnly(2026, 9, 11));
        Assert.Single(days);
        Assert.Equal(new DateOnly(2026, 9, 10), days[0]);
    }

    [Fact]
    public void WorkdaysBetween_EmptyWhenRangeIsWeekendOnly()
    {
        // 週六 → 週日（排他）
        var days = WorkCalendar.WorkdaysBetween(new DateOnly(2026, 9, 12), new DateOnly(2026, 9, 13));
        Assert.Empty(days);
    }

    [Fact]
    public void IsWorkday_HolidayException_TurnsWeekdayOff()
    {
        var exceptions = new Dictionary<DateOnly, WorkCalendarKind>
        {
            [new DateOnly(2026, 10, 5)] = WorkCalendarKind.Holiday,   // 週一
        };
        Assert.False(WorkCalendar.IsWorkday(new DateOnly(2026, 10, 5), exceptions));
        Assert.True(WorkCalendar.IsWorkday(new DateOnly(2026, 10, 6), exceptions));   // 週二不受影響
    }

    [Fact]
    public void IsWorkday_WorkdayException_TurnsSaturdayOn()
    {
        var exceptions = new Dictionary<DateOnly, WorkCalendarKind>
        {
            [new DateOnly(2026, 10, 10)] = WorkCalendarKind.Workday,   // 週六，中國補班
        };
        Assert.True(WorkCalendar.IsWorkday(new DateOnly(2026, 10, 10), exceptions));
        // 週六的 Holiday 是 no-op（週末本來就不是工作日）
        Assert.False(WorkCalendar.IsWorkday(new DateOnly(2026, 10, 10),
            new Dictionary<DateOnly, WorkCalendarKind> { [new DateOnly(2026, 10, 10)] = WorkCalendarKind.Holiday }));
    }

    [Fact]
    public void WorkdaysBetween_AppliesExceptions()
    {
        var exceptions = new Dictionary<DateOnly, WorkCalendarKind>
        {
            [new DateOnly(2026, 9, 9)] = WorkCalendarKind.Holiday,    // 三
            [new DateOnly(2026, 9, 12)] = WorkCalendarKind.Workday,   // 六
        };
        var days = WorkCalendar.WorkdaysBetween(new DateOnly(2026, 9, 7), new DateOnly(2026, 9, 14), exceptions);
        Assert.Equal(5, days.Count);
        Assert.DoesNotContain(new DateOnly(2026, 9, 9), days);
        Assert.Contains(new DateOnly(2026, 9, 12), days);
    }

    [Fact]
    public void WorkdaysBetween_ExceptionsOutsideRange_AreInert()
    {
        var exceptions = new Dictionary<DateOnly, WorkCalendarKind>
        {
            [new DateOnly(2026, 10, 5)] = WorkCalendarKind.Holiday,
            [new DateOnly(2026, 10, 11)] = WorkCalendarKind.Workday,
        };
        var days = WorkCalendar.WorkdaysBetween(new DateOnly(2026, 9, 7), new DateOnly(2026, 9, 14), exceptions);
        Assert.Equal(5, days.Count);
    }

    [Fact]
    public void WorkdaysBetween_EmptyExceptions_MatchesWeekdaysOnly()
    {
        var from = new DateOnly(2026, 9, 7);
        var to = new DateOnly(2026, 9, 14);
        Assert.Equal(WorkCalendar.WorkdaysBetween(from, to),
            WorkCalendar.WorkdaysBetween(from, to, new Dictionary<DateOnly, WorkCalendarKind>()));
    }

    [Fact]
    public void MergeExceptions_HolidayWinsOverWorkday_RegardlessOfOrder()
    {
        var d = new DateOnly(2026, 10, 5);
        var holiday = Row(d, WorkCalendarKind.Holiday);
        var workday = Row(d, WorkCalendarKind.Workday);

        // R4 是契約：兩個方向都必須得到 Holiday
        Assert.Equal(WorkCalendarKind.Holiday, WorkCalendar.MergeExceptions([holiday, workday])[d]);
        Assert.Equal(WorkCalendarKind.Holiday, WorkCalendar.MergeExceptions([workday, holiday])[d]);
        Assert.Equal(WorkCalendarKind.Workday, WorkCalendar.MergeExceptions([Row(d, WorkCalendarKind.Workday)])[d]);
    }

    private static WorkCalendarException Row(DateOnly date, WorkCalendarKind kind) =>
        new() { Id = Guid.NewGuid(), TeamId = Guid.NewGuid(), Date = date, Kind = kind };
}
