using Microsoft.EntityFrameworkCore;
using Entask.Core;
using Entask.Core.Entities;

namespace Entask.Infrastructure.Data.Seed;

public static class PermissionSeed
{
    private static readonly (string Code, string Category, string Description)[] Catalog =
    [
        (PermissionCodes.TeamRead, "團隊", "檢視團隊"),
        (PermissionCodes.TeamMemberManage, "團隊", "管理團隊成員"),
        (PermissionCodes.TeamRoleManage, "團隊", "定義團隊角色"),
        (PermissionCodes.TeamWorkCalendarManage, "團隊", "管理團隊工作日曆"),
        (PermissionCodes.ProjectRead, "專案", "檢視專案"),
        (PermissionCodes.ProjectCreate, "專案", "建立專案"),
        (PermissionCodes.ProjectEdit, "專案", "編輯專案"),
        (PermissionCodes.ProjectDelete, "專案", "刪除專案"),
        (PermissionCodes.ProjectMemberManage, "專案", "管理專案成員"),
        (PermissionCodes.BoardRead, "看板", "檢視看板"),
        (PermissionCodes.BoardCreate, "看板", "建立看板"),
        (PermissionCodes.BoardEdit, "看板", "編輯看板"),
        (PermissionCodes.BoardDelete, "看板", "刪除看板"),
        (PermissionCodes.CardRead, "卡片", "檢視卡片"),
        (PermissionCodes.CardCreate, "卡片", "建立卡片"),
        (PermissionCodes.CardEdit, "卡片", "編輯卡片"),
        (PermissionCodes.CardDelete, "卡片", "刪除卡片"),
        (PermissionCodes.CardAssign, "卡片", "指派卡片"),
        (PermissionCodes.CardReview, "卡片", "審查卡片"),
        (PermissionCodes.CardRate, "卡片", "填寫審查評分"),
        (PermissionCodes.CardComment, "卡片", "留言"),
        (PermissionCodes.CardEffortUpdate, "卡片", "更新工時與進度"),
        (PermissionCodes.MindMapEdit, "心智圖", "編輯心智圖節點"),
        (PermissionCodes.ReportView, "報告", "檢視績效報告"),
    ];

    public static async Task SeedAsync(EntaskDbContext db)
    {
        foreach (var (code, category, description) in Catalog)
        {
            if (!await db.Permissions.AnyAsync(p => p.Code == code))
                db.Permissions.Add(new Permission { Id = Guid.NewGuid(), Code = code, Category = category, Description = description });
        }
        await db.SaveChangesAsync();
    }
}
