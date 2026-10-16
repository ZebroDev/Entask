using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Performance;

namespace Entask.Api.Endpoints;

public static class ReportEndpoints
{
    public static IEndpointRouteBuilder MapReports(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/projects/{projectId:guid}/report", async (Guid projectId, DateTime? from, DateTime? to,
            EntaskDbContext db) =>
        {
            if (from is not null && to is not null && from >= to)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
            if (from is not null && to is not null && (to.Value - from.Value).TotalDays > WorkLogQueries.MaxRangeDays)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.QueryRangeTooLong,
                    message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                    @params = new { max = WorkLogQueries.MaxRangeDays }
                });
            var projectExists = await db.Projects.AnyAsync(p => p.Id == projectId);
            if (!projectExists) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            // 窗框語意（含上界排他與 Kind 正規化）只在 `ReportWindow` 這一處，同 `TeamReportEndpoints`。
            // naive（無時區標記）的 `from`／`to` 繫結出 `Kind=Unspecified`，直接進查詢會被 Npgsql
            // 擋下（`LoggedAt` 是 `timestamp with time zone`）⇒ 500；正規化之後才進得了。
            var window = ReportWindow.Create(from, to);
            var hourRows = await ProjectReportQueries.GetMemberHourRowsAsync(db, projectId, window);
            // **剩餘工時刻意吃全期**（裁定 5，2026-09-22 使用者定案）：它是專案的**存量**
            // 指標（現在還欠多少），不是區間流量。餵它 `window` 會讓預估側（本來就不吃窗框）
            // 與已記側各說各話——跨年時剩餘會**越做越多**，甚至變成負數。
            // 不變量：這裡是 `ReportWindow.All` 的唯一呼叫端，前端那張卡也據此標明「全期」。
            // 守門員是 `ReportTests.Remaining_IgnoresWindow`（含對照組）。
            var remainingRows = await ProjectReportQueries.GetMemberRemainingRowsAsync(
                db, projectId, ReportWindow.All);
            var (reviewRows, averageScore) = await ProjectReportQueries.GetReviewStatsAsync(db, projectId);
            var cardRows = await ProjectReportQueries.GetCardRowsAsync(db, projectId, window);
            var availableYears = await ProjectReportQueries.GetAvailableYearsAsync(db, new[] { projectId });

            var userIds = hourRows.Select(r => r.UserId)
                .Concat(remainingRows.Select(r => r.UserId))
                .Concat(cardRows.SelectMany(r => r.AssigneeUserIds)).Distinct().ToList();
            var users = await ActivityEndpoints.GetUsersAsync(db, userIds);   // 兩步查 User（Core 不引用 Identity）

            var memberHours = hourRows.OrderByDescending(r => r.Hours)
                .Select(r => new MemberHoursRow(r.UserId, users.GetValueOrDefault(r.UserId)?.UserName ?? "",
                    users.GetValueOrDefault(r.UserId)?.DisplayName ?? "", r.Hours, r.CardCount)).ToList();
            var memberRemaining = remainingRows.OrderByDescending(r => r.EstimatedHours - r.LoggedHours)
                .Select(r => new MemberRemainingRow(r.UserId, users.GetValueOrDefault(r.UserId)?.UserName ?? "",
                    users.GetValueOrDefault(r.UserId)?.DisplayName ?? "", r.EstimatedHours, r.LoggedHours,
                    r.EstimatedHours - r.LoggedHours)).ToList();
            var stats = new ReviewStats(
                reviewRows.FirstOrDefault(r => r.Status == ReviewStatuses.Pending)?.Count ?? 0,
                reviewRows.FirstOrDefault(r => r.Status == ReviewStatuses.Approved)?.Count ?? 0,
                reviewRows.FirstOrDefault(r => r.Status == ReviewStatuses.Rejected)?.Count ?? 0,
                averageScore);
            var cards = cardRows.Select(c => new CardReportRow(c.Id, c.Title, c.BoardId, c.BoardName, c.ListId,
                c.ListName, c.AssigneeUserIds, c.EstimatedHours, c.LoggedHours, c.RemainingHours,
                c.ReviewStatus, c.Priority)).ToList();
            return Results.Ok(new ProjectReportResponse(memberHours, memberRemaining, stats, cards, availableYears));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ReportView);

        app.MapGet("/api/projects/{projectId:guid}/report/export", async (Guid projectId, DateTime? from, DateTime? to, EntaskDbContext db) =>
        {
            // 與上面那條 JSON 路由同一道 guard（`docs/STATE.md` 的殘餘：匯出路徑原本沒有這道，
            // 顛倒窗框會靜默回一張只有 BOM 的 CSV）。字面值逐字同上——`request.invalid` 是
            // `check:message-values` 唯一宣告的粗粒度碼，兩處用同一個字面值對該閘門是零變化。
            if (from is not null && to is not null && from >= to)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
            if (from is not null && to is not null && (to.Value - from.Value).TotalDays > WorkLogQueries.MaxRangeDays)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.QueryRangeTooLong,
                    message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                    @params = new { max = WorkLogQueries.MaxRangeDays }
                });
            var projectExists = await db.Projects.AnyAsync(p => p.Id == projectId);
            if (!projectExists) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);
            
            // 與上面那條路由同一個窗框（`GetCardRowsAsync` 是三對工時窗裡唯一兩條路由都用到的一對）。
            var cardRows = await ProjectReportQueries.GetCardRowsAsync(db, projectId, ReportWindow.Create(from, to));
            
            var sb = new System.Text.StringBuilder();
            sb.AppendLine("CardId,Title,BoardName,ListName,EstimatedHours,LoggedHours,RemainingHours,Priority");
            foreach(var c in cardRows)
            {
                // 機器格式：欄位以逗號分隔 ⇒ **三個工時欄**一律 InvariantCulture（否則逗號小數點的主機
                // 文化——de-DE 這族——會多出逗號、欄位全盤位移；同型註解見 TeamReportEndpoints 的 CSV）。
                // **文字欄**（Title／BoardName／ListName／Priority）一律走 `CsvField.Escape`：公式注入
                // 防護＋引號加倍（外部報告 C 類第 1 條）。最後一欄**不是數值欄**——它是專案「優先級」
                // select 自訂欄位的值（`ProjectReportQueries` 由 `ValueJson` 取 `string?`；`CardRow.Priority`
                // 就是 `string?`），而選項只被要求「非空字串」（`CustomFieldEndpoints.ValidSelectOptions`）
                // ⇒ 與其他文字欄同一種寫法（含引號：選項含逗號時才不會撐破欄數，同 TeamReportEndpoints）。
                sb.AppendLine(string.Create(CultureInfo.InvariantCulture,
                    $"{c.Id},\"{CsvField.Escape(c.Title)}\",\"{CsvField.Escape(c.BoardName)}\",\"{CsvField.Escape(c.ListName)}\",{c.EstimatedHours},{c.LoggedHours},{c.RemainingHours},\"{CsvField.Escape(c.Priority)}\""));
            }
            
            var bytes = System.Text.Encoding.UTF8.GetBytes(sb.ToString());
            var bom = new byte[] { 0xEF, 0xBB, 0xBF };
            var result = new byte[bom.Length + bytes.Length];
            Buffer.BlockCopy(bom, 0, result, 0, bom.Length);
            Buffer.BlockCopy(bytes, 0, result, bom.Length, bytes.Length);
            
            return Results.File(result, "text/csv", $"project-{projectId}-export.csv");
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ReportView);

        return app;
    }
}
