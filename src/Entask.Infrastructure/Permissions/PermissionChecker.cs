using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Identity;
using Entask.Infrastructure.Data;

namespace Entask.Infrastructure.Permissions;

public class PermissionChecker : IPermissionChecker
{
    private readonly EntaskDbContext _db;
    private readonly IMemoryCache _cache;

    public PermissionChecker(EntaskDbContext db, IMemoryCache cache)
    {
        _db = db;
        _cache = cache;
    }

    public async Task<HashSet<string>> GetEffectivePermissionsAsync(Guid userId, Guid teamId)
    {
        var isAdmin = await _db.UserClaims.AnyAsync(c =>
            c.UserId == userId && c.ClaimType == AdminClaim.Type && c.ClaimValue == AdminClaim.Value);
        if (isAdmin) return AllPermissionCodes();

        var cacheKey = $"perm:{userId}:{teamId}";
        if (_cache.TryGetValue<HashSet<string>>(cacheKey, out var cached)) return cached!;

        var codes = await _db.TeamMembers
            .Where(m => m.UserId == userId && m.TeamId == teamId)
            .SelectMany(m => m.Role.RolePermissions)
            .Select(rp => rp.Permission.Code)
            .Distinct()
            .ToListAsync();

        var set = new HashSet<string>(codes);
        _cache.Set(cacheKey, set, TimeSpan.FromSeconds(30));
        return set;
    }

    public async Task<bool> HasPermissionAsync(Guid userId, Guid teamId, string permissionCode) =>
        (await GetEffectivePermissionsAsync(userId, teamId)).Contains(permissionCode);

    public async Task<HashSet<string>> GetProjectEffectivePermissionsAsync(Guid userId, Guid projectId)
    {
        var isAdmin = await _db.UserClaims.AnyAsync(c =>
            c.UserId == userId && c.ClaimType == AdminClaim.Type && c.ClaimValue == AdminClaim.Value);
        if (isAdmin) return AllPermissionCodes();

        var cacheKey = $"perm:p:{projectId}:{userId}";
        if (_cache.TryGetValue<HashSet<string>>(cacheKey, out var cached)) return cached!;

        var project = await _db.Projects
            .Where(p => p.Id == projectId)
            .Select(p => new { p.TeamId })
            .FirstOrDefaultAsync();
        if (project is null) return [];

        // 專案角色聯集
        var projectCodes = await _db.ProjectMembers
            .Where(m => m.ProjectId == projectId && m.UserId == userId)
            .SelectMany(m => m.Role.RolePermissions)
            .Select(rp => rp.Permission.Code)
            .Distinct()
            .ToListAsync();

        // 所屬團隊角色聯集（僅當使用者是該團隊成員）
        var teamCodes = await _db.TeamMembers
            .Where(m => m.UserId == userId && m.TeamId == project.TeamId)
            .SelectMany(m => m.Role.RolePermissions)
            .Select(rp => rp.Permission.Code)
            .Distinct()
            .ToListAsync();

        var set = new HashSet<string>(projectCodes.Concat(teamCodes));
        _cache.Set(cacheKey, set, TimeSpan.FromSeconds(30));
        return set;
    }

    public async Task<bool> HasProjectPermissionAsync(Guid userId, Guid projectId, string permissionCode) =>
        (await GetProjectEffectivePermissionsAsync(userId, projectId)).Contains(permissionCode);

    private static HashSet<string> AllPermissionCodes() => new(PermissionCodes.All);
}
