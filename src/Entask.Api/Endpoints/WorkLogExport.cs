using System.Globalization;
using System.Text;
using Entask.Api.Dtos;
using Entask.Core;

namespace Entask.Api.Endpoints;

/// <summary>
/// 工作日誌的 SpreadsheetML (.xls) 產生器。
/// 沿用 P8 TeamReportEndpoints 的 Styles 寫法（Microsoft JhengHei、色塊表頭）。
/// 所有字串經 <see cref="SpreadsheetMl.Escape"/>（XML 轉義＋濾除 XML 1.0 非法字元，單一實作）；
/// 所有數值以 InvariantCulture 輸出（避免地區設定產生逗號小數點）。
/// </summary>
internal static class WorkLogExport
{
    private const string Font = "Microsoft JhengHei";

    /// <summary>
    /// XML 文字轉義＋濾除 XML 1.0 非法字元——**委派 `SpreadsheetMl.Escape`（單一實作）**。
    /// 當初的理由（含控制字元的備註會讓整份檔在 Excel 拒開、受影響的是同區間的所有讀者）
    /// 已移入該檔的檔頭註解。
    /// </summary>
    private static string E(string? s) => SpreadsheetMl.Escape(s);

    private static string N(decimal v) => v.ToString(CultureInfo.InvariantCulture);

    public static byte[] Build(WorkLogReportResponse report, ExportLabels labels)
    {
        var sb = new StringBuilder();
        sb.AppendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        sb.AppendLine("<?mso-application progid=\"Excel.Sheet\"?>");
        sb.AppendLine("<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\"");
        sb.AppendLine(" xmlns:o=\"urn:schemas-microsoft-com:office:office\"");
        sb.AppendLine(" xmlns:x=\"urn:schemas-microsoft-com:office:excel\"");
        sb.AppendLine(" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">");
        sb.AppendLine("<Styles>");
        sb.AppendLine($" <Style ss:ID=\"Header\"><Font ss:Bold=\"1\" ss:Color=\"#FFFFFF\" ss:Size=\"11\" ss:FontName=\"{Font}\"/><Interior ss:Color=\"#4F46E5\" ss:Pattern=\"Solid\"/><Alignment ss:Horizontal=\"Center\" ss:Vertical=\"Center\"/></Style>");
        sb.AppendLine($" <Style ss:ID=\"DataCell\"><Font ss:FontName=\"{Font}\" ss:Size=\"10\"/><Alignment ss:Vertical=\"Center\"/></Style>");
        sb.AppendLine($" <Style ss:ID=\"NumberCell\"><Font ss:FontName=\"{Font}\" ss:Size=\"10\"/><Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/></Style>");
        sb.AppendLine("</Styles>");

        AppendDetailSheet(sb, report, labels);
        AppendSummarySheet(sb, report, labels);

        sb.AppendLine("</Workbook>");
        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static void AppendHeaderRow(StringBuilder sb, params string[] headers)
    {
        sb.AppendLine("<Row ss:Height=\"24\">");
        foreach (var h in headers)
            sb.AppendLine($"<Cell ss:StyleID=\"Header\"><Data ss:Type=\"String\">{E(h)}</Data></Cell>");
        sb.AppendLine("</Row>");
    }

    private static void AppendStringCell(StringBuilder sb, string? value) =>
        sb.AppendLine($"<Cell ss:StyleID=\"DataCell\"><Data ss:Type=\"String\">{E(value)}</Data></Cell>");

    private static void AppendNumberCell(StringBuilder sb, decimal value) =>
        sb.AppendLine($"<Cell ss:StyleID=\"NumberCell\"><Data ss:Type=\"Number\">{N(value)}</Data></Cell>");

    private static void AppendDetailSheet(StringBuilder sb, WorkLogReportResponse report, ExportLabels labels)
    {
        sb.AppendLine($"<Worksheet ss:Name=\"{E(labels[ExportKeys.WorklogSheetDetail])}\"><Table ss:DefaultRowHeight=\"20\">");
        AppendHeaderRow(sb,
            labels[ExportKeys.WorklogDetailDate], labels[ExportKeys.WorklogMember],
            labels[ExportKeys.WorklogDetailTeam], labels[ExportKeys.WorklogDetailProject],
            labels[ExportKeys.WorklogDetailBoard], labels[ExportKeys.WorklogDetailList],
            labels[ExportKeys.WorklogDetailCard], labels[ExportKeys.WorklogDetailHours],
            labels[ExportKeys.WorklogDetailNote], labels[ExportKeys.WorklogDetailLoggedAt]);
        foreach (var m in report.Members)
        foreach (var d in m.Days)
        foreach (var e in d.Entries)
        {
            sb.AppendLine("<Row>");
            AppendStringCell(sb, d.Date);
            AppendStringCell(sb, m.DisplayName);
            AppendStringCell(sb, e.TeamName);
            AppendStringCell(sb, e.ProjectName);
            AppendStringCell(sb, e.BoardName);
            AppendStringCell(sb, e.ListName);
            AppendStringCell(sb, e.CardTitle);
            AppendNumberCell(sb, e.Hours);
            AppendStringCell(sb, e.Note);
            // 填報時間欄印**凍結的牆鐘**（`LoggedAtLocal`）：補登時它仍是填報當下，
            // 不是補登的那一天——那條分岔記在 2026-10-08 的歷史檔（D1）。
            AppendStringCell(sb, e.LoggedAtLocal.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture));
            sb.AppendLine("</Row>");
        }
        sb.AppendLine("</Table></Worksheet>");
    }

    private static void AppendSummarySheet(StringBuilder sb, WorkLogReportResponse report, ExportLabels labels)
    {
        sb.AppendLine($"<Worksheet ss:Name=\"{E(labels[ExportKeys.WorklogSheetSummary])}\"><Table ss:DefaultRowHeight=\"20\">");
        AppendHeaderRow(sb,
            labels[ExportKeys.WorklogMember],
            labels[ExportKeys.WorklogSummaryTotalHours], labels[ExportKeys.WorklogSummaryEntries],
            labels[ExportKeys.WorklogSummaryCards], labels[ExportKeys.WorklogSummaryActiveDays],
            labels[ExportKeys.WorklogSummaryReportedWorkdays], labels[ExportKeys.WorklogSummaryMissingWorkdays],
            labels[ExportKeys.WorklogSummaryCompletedCards]);
        foreach (var m in report.Members)
        {
            sb.AppendLine("<Row>");
            AppendStringCell(sb, m.DisplayName);
            AppendNumberCell(sb, m.TotalHours);
            AppendNumberCell(sb, m.EntryCount);
            AppendNumberCell(sb, m.CardCount);
            AppendNumberCell(sb, m.ActiveDays);
            AppendNumberCell(sb, m.ReportedWorkdays);
            AppendNumberCell(sb, m.MissingWorkdays);
            AppendNumberCell(sb, m.CompletedCards);
            sb.AppendLine("</Row>");
        }
        sb.AppendLine("</Table></Worksheet>");
    }
}
