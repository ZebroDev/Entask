namespace Entask.Core.Abstractions;

public interface IPermissionChecker
{
    Task<HashSet<string>> GetEffectivePermissionsAsync(Guid userId, Guid teamId);
    Task<bool> HasPermissionAsync(Guid userId, Guid teamId, string permissionCode);
    Task<HashSet<string>> GetProjectEffectivePermissionsAsync(Guid userId, Guid projectId);
    Task<bool> HasProjectPermissionAsync(Guid userId, Guid projectId, string permissionCode);
}
