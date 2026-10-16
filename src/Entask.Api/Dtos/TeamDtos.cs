namespace Entask.Api.Dtos;

public record CreateTeamRequest(string Name, string? Description);
public record UpdateTeamRequest(string Name, string? Description);
public record AssignMemberRequest(string Username, List<Guid> RoleIds, string? TimeZoneId);
public record TeamResponse(Guid Id, string Name, string? Description, DateTime CreatedAt);
public record TeamDetailResponse(Guid Id, string Name, string? Description,
    List<MemberResponse> Members, List<TeamRoleResponse> Roles);
public record TeamPermissionsResponse(Guid TeamId, string[] Codes);
// `Deactivated` 是**標記、不是過濾器**（設計 D7）：名冊保留已停用者並加這個欄位，
// 卡片頭像是「專案名冊 ∩ 卡片成員 GUID」算出來的——過濾會讓那些人從畫面消失。
public record MemberResponse(Guid UserId, string Username, string DisplayName, bool Deactivated, List<TeamRoleResponse> Roles);
// `Code` 是系統範本角色的穩定識別碼（Role.Code，見 SystemRoleCodes）；團隊自訂角色為 null。
// P-A 之後才有，消費者是 `CreateTeamDialog`——它原本以 **Name** 查「團隊經理」範本角色，
// 那會在名稱隨語系改變時靜默失效（退回 `roles[0]`，也就是指派一個由 DB 順序決定的任意角色）。
// 放在最後是為了讓三個建構點的既有引數不動。
public record TeamRoleResponse(Guid Id, string Name, string? Description, bool IsSystem, List<string> PermissionCodes, string? Code);
