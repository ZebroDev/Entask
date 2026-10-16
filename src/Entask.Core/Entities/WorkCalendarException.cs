namespace Entask.Core.Entities;

/// <summary>
/// 工作日的逐日期例外（日曆掛在 team，裁定 R1）：`Holiday`＝這天不上班（即使是週一至週五）、
/// `Workday`＝這天要上班（即使是週六日，如中國的補班）。
/// **不能做成單向的假日表**——中國的調休同時產生兩種例外（評估〈三〉）。
/// 同一天被不同團隊標成兩者時 `Holiday` 勝（裁定 R4，實作在 `WorkCalendar.MergeExceptions`）。
/// </summary>
public class WorkCalendarException
{
    public Guid Id { get; set; }
    public Guid TeamId { get; set; }
    public Team Team { get; set; } = null!;
    /// <summary>**當地日**，不是 UTC 日——例外是「這個團隊的這一天」。</summary>
    public DateOnly Date { get; set; }
    public WorkCalendarKind Kind { get; set; }
    /// <summary>例：國慶日、補 10/10 連假。選填（≤100 字元由端點守）。</summary>
    public string? Name { get; set; }
    public Guid CreatedById { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>顯式指定數值：這一欄會落地成 int，改動等於改資料。</summary>
public enum WorkCalendarKind { Holiday = 0, Workday = 1 }
