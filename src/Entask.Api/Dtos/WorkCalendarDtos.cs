namespace Entask.Api.Dtos;

/// <summary>日期是 `yyyy-MM-dd` 的**當地日**字串（與 `WorkLogDtos.Workdays` 同一個形狀：
/// 前端只做字串比對與顯示，不解析成 `Date` 再受瀏覽器時區影響）。
/// `Kind` 是 `Holiday`／`Workday` 的字面值——前端標籤表的識別碼。</summary>
public record WorkCalendarExceptionResponse(string Date, string Kind, string? Name);

/// <summary>`Kind` 逐字比對（**不用 `Enum.TryParse`**：它會把 `"1"` 這種數字字串也解析成功，
/// 寫進 DB 的是一個未定義的列舉值）。</summary>
public record UpsertWorkCalendarExceptionRequest(string? Kind, string? Name);
