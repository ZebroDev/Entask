namespace Entask.Core;

/// <summary>
/// 伺服器端資源檔的標籤識別碼（.xls 匯出檔 ＋ 複製產生的名稱）。
/// 文案在 `src/Entask.Api/Resources/export.&lt;locale&gt;.json`。
///
/// 與 <see cref="ErrorCodes"/>、<see cref="PermissionCodes"/> 同一類：後端產生、會送到
/// 使用者眼前的文字，識別碼留在程式碼、文案留在資源檔。
///
/// **值就是資源檔的 key**（扁平點分鍵）。前綴是**消費端**：`team.*` 是團隊年度績效報表
/// （`TeamReportEndpoints` 的 `export-excel`）、`worklog.*` 是三個工作日誌匯出
/// （`WorkLogExport`）、`rating.suffix` 是評等儲存格的「{{rating}} 級」、
/// `copy.name` 是複製卡片／看板／專案的預設名稱（`CopyEndpoints`，**不是匯出**）。
///
/// **命名債**：檔名 `export.*.json` 與本類別的名字都還留著「匯出」二字，但內容已不只服務
/// 匯出。改名要動 `Entask.Api.csproj` 的 EmbeddedResource glob、`ExportLabels.Available` 的
/// regex 與 `check-locale-parity.mjs` 的路徑——尚未做。
///
/// 守門員是 `web/scripts/check-locale-parity.mjs` 的**檢查 11**（常數集 ↔ zh-TW 資源檔的
/// key 集相等），以及**檢查 10**（各語系 key 集合相等、無空值、佔位名一致）。
/// </summary>
public static class ExportKeys
{
    // 團隊年度績效報表
    public const string TeamSheet = "team.sheet";
    public const string TeamMemberUsername = "team.member.username";
    public const string TeamMemberName = "team.member.name";
    public const string TeamMemberRating = "team.member.rating";
    public const string TeamMemberCompleted = "team.member.completed";
    public const string TeamMemberTotal = "team.member.total";
    public const string TeamMemberRateCompletion = "team.member.rate.completion";
    public const string TeamMemberRateOnTime = "team.member.rate.onTime";
    public const string TeamMemberHours = "team.member.hours";
    public const string RatingSuffix = "rating.suffix";

    // 工作日誌（三個 scope 共用一份）
    public const string WorklogSheetDetail = "worklog.sheet.detail";
    public const string WorklogSheetSummary = "worklog.sheet.summary";
    public const string WorklogDetailDate = "worklog.detail.date";
    public const string WorklogMember = "worklog.member";
    public const string WorklogDetailTeam = "worklog.detail.team";
    public const string WorklogDetailProject = "worklog.detail.project";
    public const string WorklogDetailBoard = "worklog.detail.board";
    public const string WorklogDetailList = "worklog.detail.list";
    public const string WorklogDetailCard = "worklog.detail.card";
    public const string WorklogDetailHours = "worklog.detail.hours";
    public const string WorklogDetailNote = "worklog.detail.note";
    public const string WorklogDetailLoggedAt = "worklog.detail.loggedAt";
    public const string WorklogSummaryTotalHours = "worklog.summary.totalHours";
    public const string WorklogSummaryEntries = "worklog.summary.entries";
    public const string WorklogSummaryCards = "worklog.summary.cards";
    public const string WorklogSummaryActiveDays = "worklog.summary.activeDays";
    public const string WorklogSummaryReportedWorkdays = "worklog.summary.reportedWorkdays";
    public const string WorklogSummaryMissingWorkdays = "worklog.summary.missingWorkdays";
    public const string WorklogSummaryCompletedCards = "worklog.summary.completedCards";

    /// <summary>
    /// 複製後的預設名稱（卡片／看板／專案共用）。值是**樣板**而不是後綴——`{{name}}` 是原標題，
    /// 前綴式的語系（如 es 的 `Copia de {{name}}`）才成立。見 `BoardCopyService.CopiedName`。
    /// </summary>
    public const string CopyName = "copy.name";
}
