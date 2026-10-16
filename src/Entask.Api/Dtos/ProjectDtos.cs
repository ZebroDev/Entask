namespace Entask.Api.Dtos;

public record CreateProjectRequest(string Name, string? Description, string? TimeZoneId);
public record UpdateProjectRequest(string? Name, string? Description);
public record ProjectResponse(Guid Id, Guid TeamId, string Name, string? Description, int MemberCount, int BoardCount, DateTime CreatedAt);
// `Code` 是系統角色的穩定識別碼（`SystemRoleCodes` 的六個值；自訂角色是 null）——
// 顯示端用它查語系檔（`web/src/lib/role-labels.ts`），查不到才退回 `Name`。
// **`RoleResponse`（自訂角色 CRUD）刻意不補**：它唯一的消費者是編輯表單，
// 那裡的 `Name` 是要寫回資料庫的值，不是文案。
public record ProjectMemberRoleDto(Guid Id, string Name, string? Code);
// `Deactivated` 同 `MemberResponse`：名冊保留 ＋ 標記（設計 D7）。
public record ProjectMemberResponse(Guid UserId, string Username, string DisplayName, string? AvatarUrl,
    bool Deactivated, List<ProjectMemberRoleDto> Roles, List<Guid> RoleIds);
public record AddProjectMemberRequest(Guid UserId, List<Guid> RoleIds, string? TimeZoneId);
public record UpdateProjectMemberRequest(List<Guid> RoleIds, string? TimeZoneId);
