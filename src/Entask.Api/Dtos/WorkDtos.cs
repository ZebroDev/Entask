namespace Entask.Api.Dtos;

public record UpdateReviewersRequest(List<Guid> ReviewerUserIds);
public record ReviewResponse(Guid Id, Guid ReviewerUserId, string ReviewerUsername, string ReviewerDisplayName, string Status, int? Score, string? Comment, DateTime UpdatedAt);
public record ReviewEntryResponse(Guid Id, Guid ReviewerUserId, string ReviewerUsername, string ReviewerDisplayName, string Status, int? Score, string? Comment, DateTime CreatedAt);
public record SubmitReviewRequest(string Status, int? Score, string? Comment);
// `LocalDate` 取代原本的 `LoggedAt`（2026-10-08，Q1／R5）：顯示與分桶都用凍結的工作日，
// JSON 是 `localDate: "yyyy-MM-dd"`。UTC 瞬時仍留在實體上（讀取端的過渡期靠它），只是不再外露。
public record EffortLogResponse(Guid Id, Guid UserId, string Username, string DisplayName, decimal Hours, string? Note, DateOnly LocalDate);
public record EffortListResponse(List<EffortLogResponse> Logs, decimal TotalHours);
// `TimeZoneId` 必填（缺漏＝400 `request.timeZoneInvalid`）：作者時區決定凍結的本地日；
// `LocalDate` 是補登的那一天，未帶＝作者當下的本地日。
public record CreateEffortRequest(decimal Hours, string? Note, string? TimeZoneId, DateOnly? LocalDate);
