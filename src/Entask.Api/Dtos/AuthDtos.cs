namespace Entask.Api.Dtos;

public record CreateUserRequest(string Username, string Password, string DisplayName, bool IsAdmin = false);
public record LoginRequest(string Username, string Password);
public record RefreshRequest(string RefreshToken);
public record AuthResponse(string AccessToken, string RefreshToken, Guid UserId, string Username, string DisplayName, bool IsAdmin, string? AvatarUrl);
public record MeResponse(Guid UserId, string Username, string DisplayName, bool IsAdmin, string? AvatarUrl);
public record UserSummaryResponse(Guid Id, string Username, string DisplayName, string? AvatarUrl);

/// <summary>admin 專頁的清單列（`GET /api/admin/users`）。與 `UserSummaryResponse` 的差別：
/// 那一支是可指派池（已排除停用者），所以它不需要狀態欄位；這一支是**全部**使用者。</summary>
public record AdminUserResponse(Guid UserId, string Username, string DisplayName, string? AvatarUrl,
    bool IsAdmin, DateTime? DeactivatedAt, DateTime? DeletedAt);

/// <summary>停用前的未完事項（`GET /api/admin/users/{userId}/offboarding`）。
/// **顯示、不阻擋**（設計的 D4）：緊急停權不該被一份清單擋住。</summary>
public record OffboardingResponse(int OpenCards, int PendingReviews, int ProjectMemberships, int TeamMemberships);
