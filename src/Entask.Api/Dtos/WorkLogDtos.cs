namespace Entask.Api.Dtos;

public record WorkLogReportResponse(
    string Scope, string FromDate, string ToDate,
    List<string> Workdays,              // 期間內工作日（本地日 yyyy-MM-dd，升冪）
    WorkLogSummary Summary,
    List<WorkLogMember> Members);

public record WorkLogSummary(
    decimal TotalHours, int MemberCount, int EntryCount, int CardCount, int WorkdayCount);

public record WorkLogMember(
    Guid UserId, string Username, string DisplayName, string? AvatarUrl,
    decimal TotalHours, int EntryCount, int CardCount,
    int ActiveDays,          // 有紀錄的日子（含週末加班）
    int ReportedWorkdays,    // 其中有紀錄且屬工作日的天數（不夾到職日：報了就算）
    int MissingWorkdays,     // MissingDays 的支數（同一個集合的兩個出口，兩者必然相等）
    int ExpectedWorkdays,    // 該員應填報的工作日數＝窗內工作日 ∩ 到職日起（無成員列／`Me` 範圍＝整段窗）
    string[] MissingDays,    // 應填而未填的本地日（yyyy-MM-dd、升冪；到職前的日子不在內）
    int CompletedCards,      // 本期內完成、且該成員在本期對其有工時紀錄的卡片數
    List<WorkLogProjectSlice> Projects,
    List<WorkLogDay> Days);

public record WorkLogProjectSlice(Guid ProjectId, string ProjectName, decimal Hours, int EntryCount);

public record WorkLogDay(string Date, decimal TotalHours, int EntryCount, List<WorkLogEntry> Entries);

public record WorkLogEntry(
    Guid LogId, DateTime LoggedAtLocal, decimal Hours, string? Note,
    Guid CardId, string CardTitle, DateTime? CardCompletedAt, decimal? CardEstimatedHours,
    string TeamName, Guid ProjectId, string ProjectName,
    Guid BoardId, string BoardName, Guid ListId, string ListName);
