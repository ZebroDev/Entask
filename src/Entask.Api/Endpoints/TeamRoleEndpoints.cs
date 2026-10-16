using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class TeamRoleEndpoints
{
    public static IEndpointRouteBuilder MapTeamRoles(this IEndpointRouteBuilder app)
    {
        // GET /api/teams/{teamId}/roles 已於 Task 5 Step 4 實作，本 task 補 POST/PUT/DELETE
        var group = app.MapGroup("/api/teams/{teamId:guid}/roles").RequireAuthorization();

        // 建立團隊自訂角色（team.role.manage）
        group.MapPost("/", async (Guid teamId, CreateRoleRequest req, EntaskDbContext db,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            // 權限碼是字串不是 Guid，但與 id 清單共用同一個上限：它們是同一種東西（一批參照）。
            if (req.PermissionCodes is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.TeamRoleNameRequired, message = "角色名稱不可為空" });
            if (req.PermissionCodes is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "權限碼清單不可為 null" });
            if (await db.Roles.AnyAsync(r => r.TeamId == teamId && r.Name == req.Name))
                return Results.BadRequest(new { code = ErrorCodes.TeamRoleNameDuplicate, message = "角色名稱已存在" });

            var permissionIds = await db.Permissions
                .Where(p => req.PermissionCodes.Contains(p.Code))
                .Select(p => p.Id).ToListAsync();
            if (permissionIds.Count != req.PermissionCodes.Distinct().Count())
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含無效的權限碼" });

            var role = new Role
            {
                Id = Guid.NewGuid(), TeamId = teamId, Name = req.Name, Description = req.Description,
                IsSystem = false, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
                RolePermissions = permissionIds.Select(pid => new RolePermission { RoleId = Guid.Empty, PermissionId = pid }).ToList(),
            };
            foreach (var rp in role.RolePermissions) rp.RoleId = role.Id;
            db.Roles.Add(role);
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.RoleCreated, "role",
                role.Id, role.Name, new { permissionCodes = req.PermissionCodes });
            return Results.Ok(new RoleResponse(role.Id, role.Name, role.Description, false, req.PermissionCodes));
        }).RequirePermission(PermissionCodes.TeamRoleManage);

        // 更新自訂角色
        group.MapPut("/{roleId:guid}", async (Guid teamId, Guid roleId, UpdateRoleRequest req, EntaskDbContext db,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要
            // 與 POST 那一站的同一句（權限碼與 id 清單共用同一個上限）。
            if (req.PermissionCodes is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var role = await db.Roles.Include(r => r.RolePermissions).FirstOrDefaultAsync(r => r.Id == roleId && r.TeamId == teamId);
            if (role is null) return ApiResults.NotFound(ErrorCodes.TeamRoleSystemNotEditable);

            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.TeamRoleNameRequired, message = "角色名稱不可為空" });
            if (req.PermissionCodes is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "權限碼清單不可為 null" });
            if (await db.Roles.AnyAsync(r => r.TeamId == teamId && r.Name == req.Name && r.Id != roleId))
                return Results.BadRequest(new { code = ErrorCodes.TeamRoleNameDuplicate, message = "角色名稱已存在" });

            var permissionIds = await db.Permissions
                .Where(p => req.PermissionCodes.Contains(p.Code))
                .Select(p => p.Id).ToListAsync();
            if (permissionIds.Count != req.PermissionCodes.Distinct().Count())
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含無效的權限碼" });

            role.Name = req.Name;
            role.Description = req.Description;
            role.UpdatedAt = DateTime.UtcNow;
            // 差集更新權限碼（冪等）：EF insert 先於 delete，重疊權限碼會撞
            // 複合鍵 unique index (RoleId, PermissionId) → 500
            var keep = role.RolePermissions.Where(rp => permissionIds.Contains(rp.PermissionId)).ToList();
            db.RolePermissions.RemoveRange(role.RolePermissions.Where(rp => !permissionIds.Contains(rp.PermissionId)));
            foreach (var pid in permissionIds.Where(p => !keep.Any(k => k.PermissionId == p)))
                db.RolePermissions.Add(new RolePermission { RoleId = roleId, PermissionId = pid });
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.RoleUpdated, "role",
                role.Id, role.Name, new { permissionCodes = req.PermissionCodes });
            return Results.Ok(new RoleResponse(role.Id, role.Name, role.Description, false, req.PermissionCodes));
        }).RequirePermission(PermissionCodes.TeamRoleManage);

        // 刪除自訂角色（刪除保護：系統範本或被指派時 400）
        group.MapDelete("/{roleId:guid}", async (Guid teamId, Guid roleId, EntaskDbContext db,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            var role = await db.Roles.FirstOrDefaultAsync(r => r.Id == roleId);
            if (role is null) return ApiResults.NotFound(ErrorCodes.TeamRoleNotFound);
            if (role.TeamId != teamId) return Results.BadRequest(new { code = ErrorCodes.TeamRoleSystemNotDeletable, message = "僅能刪除團隊自訂角色" });

            // 指派的來源有兩層：團隊成員（`TeamMembers`）與專案成員（`ProjectMembers`）。
            // 後者不能漏——`FK_ProjectMembers_Roles_RoleId` 是 ON DELETE CASCADE
            // （migration 20260814214206_AddBoardCore.cs:101-105），刪掉一個只在專案層被指派的
            // 角色會靜默級聯刪掉那些 `ProjectMember` 列，把仍在卡片上的人踢出專案名冊，
            // 而卡片的兩個 PUT 只收專案成員 ⇒ 那些卡片從此改不動（2026-09-19 裁定 I1）。
            // 錯誤碼沿用既有的 `team.roleAssigned`（守衛範圍擴大，不是新的失敗種類）。
            var assigned = await db.TeamMembers.AnyAsync(m => m.RoleId == roleId)
                || await db.ProjectMembers.AnyAsync(m => m.RoleId == roleId);
            if (assigned) return Results.BadRequest(new { code = ErrorCodes.TeamRoleAssigned, message = "該角色仍有人被指派，請先移除指派" });

            db.Roles.Remove(role);
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.RoleDeleted, "role",
                role.Id, role.Name);
            return Results.NoContent();
        }).RequirePermission(PermissionCodes.TeamRoleManage);

        return group;
    }
}
