namespace Entask.Api.Dtos;

public record ProjectReportResponse(
    List<MemberHoursRow> MemberHours,
    List<MemberRemainingRow> MemberRemaining,
    ReviewStats ReviewStats,
    List<CardReportRow> Cards,
    // 資料涵蓋的年份（由大到小），供前端的年份下拉。**與窗框無關**、**不含今年**
    // （後端不讀時鐘判年份）——兩條性質的理由都在 `ProjectReportQueries.GetAvailableYearsAsync`。
    // 與團隊報表的同名欄位同源（同一個查詢），兩邊的形狀刻意一致。
    List<int> AvailableYears);

public record MemberHoursRow(Guid UserId, string Username, string DisplayName, decimal Hours, int CardCount);
public record MemberRemainingRow(Guid UserId, string Username, string DisplayName, decimal EstimatedHours, decimal LoggedHours, decimal RemainingHours);
public record ReviewStats(int PendingCount, int ApprovedCount, int RejectedCount, double? AverageScore);
public record CardReportRow(Guid Id, string Title, Guid BoardId, string BoardName, Guid ListId, string ListName,
    List<Guid> AssigneeUserIds, decimal? EstimatedHours, decimal LoggedHours, decimal? RemainingHours,
    string? ReviewStatus, string? Priority);
