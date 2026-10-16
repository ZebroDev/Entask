using Microsoft.EntityFrameworkCore;
using Entask.Core;
using Entask.Core.Entities;

namespace Entask.Infrastructure.Data.Seed;

public static class RoleSeed
{
    // (穩定識別碼, 建立當下的預設顯示名稱, 權限碼集合)
    //
    // 名稱只是「第一次寫入」的預設值，之後就是使用者的資料——查找一律用 Code。
    // 名稱在 i18n 之後會隨語系而異，以名稱當冪等鍵會讓既有角色被視為不存在而重複建立。
    private static readonly (string Code, string Name, string[] Codes)[] Templates =
    [
        (SystemRoleCodes.TeamManager, "團隊經理", [PermissionCodes.TeamRead, PermissionCodes.TeamMemberManage, PermissionCodes.TeamRoleManage,
            PermissionCodes.TeamWorkCalendarManage,
            PermissionCodes.ProjectRead, PermissionCodes.ProjectCreate, PermissionCodes.ProjectEdit, PermissionCodes.ProjectDelete,
            PermissionCodes.ProjectMemberManage, PermissionCodes.BoardRead, PermissionCodes.BoardCreate, PermissionCodes.BoardEdit,
            PermissionCodes.BoardDelete, PermissionCodes.CardRead, PermissionCodes.CardComment, PermissionCodes.CardCreate, PermissionCodes.CardEdit,
            PermissionCodes.CardDelete, PermissionCodes.CardAssign, PermissionCodes.CardReview, PermissionCodes.CardRate, PermissionCodes.CardEffortUpdate,
            PermissionCodes.MindMapEdit, PermissionCodes.ReportView]),
        (SystemRoleCodes.ProjectManager, "專案經理", [PermissionCodes.ProjectRead, PermissionCodes.ProjectCreate, PermissionCodes.ProjectEdit,
            PermissionCodes.ProjectDelete, PermissionCodes.ProjectMemberManage, PermissionCodes.BoardRead, PermissionCodes.BoardCreate,
            PermissionCodes.BoardEdit, PermissionCodes.BoardDelete, PermissionCodes.CardRead, PermissionCodes.CardComment, PermissionCodes.CardCreate,
            PermissionCodes.CardEdit, PermissionCodes.CardDelete, PermissionCodes.CardAssign, PermissionCodes.CardReview,
            PermissionCodes.CardRate, PermissionCodes.CardEffortUpdate, PermissionCodes.MindMapEdit, PermissionCodes.ReportView]),
        (SystemRoleCodes.ProjectAssistant, "專案助理", [PermissionCodes.ProjectRead, PermissionCodes.BoardRead, PermissionCodes.CardRead, PermissionCodes.CardComment,
            PermissionCodes.CardCreate, PermissionCodes.CardEdit, PermissionCodes.CardEffortUpdate,
            PermissionCodes.MindMapEdit, PermissionCodes.ReportView]),
        (SystemRoleCodes.EngineeringLead, "工程組長", [PermissionCodes.ProjectRead, PermissionCodes.BoardRead, PermissionCodes.CardRead, PermissionCodes.CardComment, PermissionCodes.CardEdit,
            PermissionCodes.CardAssign, PermissionCodes.CardReview, PermissionCodes.CardRate, PermissionCodes.CardEffortUpdate,
            PermissionCodes.MindMapEdit]),
        (SystemRoleCodes.Engineer, "工程師", [PermissionCodes.ProjectRead, PermissionCodes.BoardRead, PermissionCodes.CardRead, PermissionCodes.CardComment, PermissionCodes.CardEdit,
            PermissionCodes.CardReview, PermissionCodes.CardEffortUpdate, PermissionCodes.MindMapEdit]),
        (SystemRoleCodes.QaEngineer, "測試工程師", [PermissionCodes.ProjectRead, PermissionCodes.BoardRead, PermissionCodes.CardRead, PermissionCodes.CardComment, PermissionCodes.CardCreate,
            PermissionCodes.CardReview]),
    ];

    public static async Task SeedAsync(EntaskDbContext db)
    {
        var permissions = await db.Permissions.ToDictionaryAsync(p => p.Code, p => p.Id);
        foreach (var (code, name, codes) in Templates)
        {
            // 過渡期 fallback：migration 之前建立、或滾動部署期間由舊映像建立的資料列
            // 還沒有 Code，此時才用名稱比對。與 AdminClaimSeed 的 additive 精神一致。
            var role = await db.Roles
                .Include(r => r.RolePermissions)
                .FirstOrDefaultAsync(r => r.TeamId == null &&
                    (r.Code == code || (r.Code == null && r.Name == name)));

            if (role is null)
            {
                role = new Role
                {
                    Id = Guid.NewGuid(),
                    TeamId = null,
                    Name = name,
                    Code = code,
                    IsSystem = true,
                    CreatedAt = DateTime.UtcNow,
                    UpdatedAt = DateTime.UtcNow,
                };
                role.RolePermissions = codes
                    .Where(c => permissions.ContainsKey(c))
                    .Select(c => new RolePermission { RoleId = role.Id, PermissionId = permissions[c] })
                    .ToList();
                db.Roles.Add(role);
            }
            else
            {
                // 自我修復：以名稱比對到的舊資料列在此補上識別碼，下次啟動起只認 Code。
                // 既有列的 Name 刻意不改寫——名稱是使用者的資料，不是 seed 的財產。
                role.Code ??= code;

                // 對既有系統角色補足範本新權限（如 project.read / mindmap.edit / board.read）
                var existingPermIds = role.RolePermissions.Select(rp => rp.PermissionId).ToHashSet();
                foreach (var permCode in codes)
                {
                    if (permissions.TryGetValue(permCode, out var permId) && !existingPermIds.Contains(permId))
                    {
                        role.RolePermissions.Add(new RolePermission { RoleId = role.Id, PermissionId = permId });
                    }
                }
            }
        }
        await db.SaveChangesAsync();
    }
}
