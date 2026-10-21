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

// ---- 團隊報表 drill-down（2026-10-20 報表可解釋性）----
//
// 計數分兩層：`PopulationCount`／`QualifyingCount` 是**全團隊**（含呼叫者無權檢視的
// 專案），因此與團隊報表上的分母／分子逐格相等；`Visible*` 只算呼叫者有 `card.read`
// 的專案；`HiddenCount` 是兩者的差額。`Rows` 只含可讀專案的列，分頁在權限過濾之後套用。
public record ReportDrilldownItemDto(
    Guid CardId, string Title, Guid ProjectId, string ProjectName,
    DateTime? CompletedAt, DateTime? DueAt, bool Qualifies,
    Guid? FirstReviewEntryId, string? FirstReviewStatus, DateTime? FirstReviewAt,
    string? FirstReviewerName,
    Guid? ReviewEntryId, double? Score, DateTime? ReviewCreatedAt, string? ReviewerName,
    IReadOnlyList<DueChangeDto>? DueChanges);

public record DueChangeDto(DateTime ChangedAt, DateTime? From, DateTime? To);

public record ReportDrilldownResponseDto(
    string Metric, string RowKind,
    int PopulationCount, int QualifyingCount,
    int VisiblePopulationCount, int VisibleQualifyingCount,
    int HiddenCount,
    IReadOnlyList<ReportDrilldownItemDto> Rows, int Page, int PageSize);

// ---- 團隊報表 grade 分解（2026-10-20 報表可解釋性，Task 2）----
//
// 由伺服器算好、前端只渲染（設計 §4.4）：所有門檻都由這一組 DTO 帶出去，TS 不得再寫
// 一份。`components` 的 `status` 三態一律相對**該條件自己的規則**（`met`／`failed`／
// `notApplicable`），`reason` 只在 `notApplicable` 時有值。調整項刻意不放進 `components`
// ——它是包在客觀公式外面的獨立一層（`ApplyScoreAdjustment`），形狀也不同。
public record RatingTierDto(string Rating, double Threshold);

public record RatingComponentDto(
    string Key, string Role, double? Value, int SampleSize, string Status,
    string? AchievedTier, string? Reason,
    IReadOnlyList<RatingTierDto>? Tiers, int? SampleThreshold);

public record RatingAdjustmentDto(
    string Status, string? Reason, string? From, string? To,
    double? AverageScore, int ScoreSamples,
    double UpThreshold, double DownThreshold, int SampleThreshold);

public record RatingBreakdownDto(
    string? BaseRating, string? FinalRating,
    IReadOnlyList<RatingComponentDto> Components, RatingAdjustmentDto Adjustment);
