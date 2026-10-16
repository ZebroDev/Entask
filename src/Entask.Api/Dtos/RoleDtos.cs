namespace Entask.Api.Dtos;

public record CreateRoleRequest(string Name, string? Description, List<string> PermissionCodes);
public record UpdateRoleRequest(string Name, string? Description, List<string> PermissionCodes);
public record RoleResponse(Guid Id, string Name, string? Description, bool IsSystem, List<string> PermissionCodes);
