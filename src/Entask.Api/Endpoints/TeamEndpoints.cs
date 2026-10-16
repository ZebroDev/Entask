using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class TeamEndpoints
{
    public static IEndpointRouteBuilder MapTeams(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/teams").RequireAuthorization();

        // 我的團隊
        group.MapGet("/", async (EntaskDbContext db, ClaimsPrincipal principal) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            var teams = await db.TeamMembers
                .Where(m => m.UserId == userId)
                .Select(m => m.Team)
                .Distinct()
                .Select(t => new TeamResponse(t.Id, t.Name, t.Description, t.CreatedAt))
                .ToListAsync();
            // 管理員看得到全部團隊
            if (principal.FindFirstValue(AdminClaim.Type) == AdminClaim.Value)
                teams = await db.Teams.Select(t => new TeamResponse(t.Id, t.Name, t.Description, t.CreatedAt)).ToListAsync();
            return Results.Ok(teams);
        });

        // 我的團隊有效權限碼（#24）：單查詢回 [{teamId, codes}]，取代前端每團隊 1+N 的
        // /api/permissions/mine 呼叫。非團隊成員團隊不回（等同無權限）；admin 回全部團隊 × 全部權限碼
        group.MapGet("/my-permissions", async (EntaskDbContext db, ClaimsPrincipal principal) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            if (principal.FindFirstValue(AdminClaim.Type) == AdminClaim.Value)
            {
                var adminRows = await db.Teams
                    .OrderBy(t => t.CreatedAt)
                    .Select(t => new TeamPermissionsResponse(t.Id, PermissionCodes.All.ToArray()))
                    .ToListAsync();
                return Results.Ok(adminRows);
            }

            // 單查詢：成員 → 角色 → 權限碼（沿 PermissionChecker 既有關聯），in-memory 分組聯集
            var rows = await db.TeamMembers
                .Where(m => m.UserId == userId)
                .Select(m => new
                {
                    m.TeamId,
                    Codes = m.Role.RolePermissions.Select(rp => rp.Permission.Code),
                })
                .ToListAsync();
            var result = rows
                .GroupBy(r => r.TeamId)
                .Select(g => new TeamPermissionsResponse(g.Key, g.SelectMany(r => r.Codes).Distinct().Order().ToArray()))
                .ToList();
            return Results.Ok(result);
        });

        // 建立團隊（系統管理員）
        group.MapPost("/", async (CreateTeamRequest req, EntaskDbContext db,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            if (principal.FindFirstValue(AdminClaim.Type) != AdminClaim.Value)
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            var (name, error) = ValidateTeamName(req.Name);
            if (error is not null) return error;

            var team = new Team
            {
                Id = Guid.NewGuid(),
                Name = name!,
                Description = req.Description,
                CreatedById = BoardEndpoints.CurrentUserId(principal),
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            db.Teams.Add(team);
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), team.Id, AuditActions.TeamCreated, "team", team.Id, team.Name);
            return Results.Ok(new TeamResponse(team.Id, team.Name, team.Description, team.CreatedAt));
        });

        // 編輯團隊（名稱與描述）
        group.MapPut("/{teamId:guid}", async (
            Guid teamId, UpdateTeamRequest req, EntaskDbContext db,
            IAuditService audit, ClaimsPrincipal principal, IPermissionChecker checker) =>
        {
            var team = await db.Teams.FindAsync(teamId);
            if (team is null) return ApiResults.NotFound(ErrorCodes.TeamNotFound);

            var userId = BoardEndpoints.CurrentUserId(principal);
            var isAdmin = principal.FindFirstValue(AdminClaim.Type) == AdminClaim.Value;
            if (!isAdmin)
            {
                var hasPerm = await checker.HasPermissionAsync(userId, teamId, PermissionCodes.TeamRoleManage);
                if (!hasPerm)
                    return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                        statusCode: StatusCodes.Status403Forbidden);
            }

            var (name, error) = ValidateTeamName(req.Name);
            if (error is not null) return error;

            var oldName = team.Name;
            team.Name = name!;
            team.Description = req.Description?.Trim();
            team.UpdatedAt = DateTime.UtcNow;

            await db.SaveChangesAsync();
            await audit.AddAsync(userId, team.Id, AuditActions.TeamUpdated, "team", team.Id, team.Name,
                new { oldName, newName = team.Name });

            return Results.Ok(new TeamResponse(team.Id, team.Name, team.Description, team.CreatedAt));
        });

        // 團隊詳情（成員含多角色 + 團隊可用角色清單）
        group.MapGet("/{teamId:guid}", async (Guid teamId, EntaskDbContext db) =>
        {
            var team = await db.Teams.FindAsync(teamId);
            if (team is null) return ApiResults.NotFound(ErrorCodes.TeamNotFound);

            var memberRows = await db.TeamMembers
                .Where(m => m.TeamId == teamId)
                .Include(m => m.Role).ThenInclude(r => r.RolePermissions).ThenInclude(rp => rp.Permission)
                .Select(m => new { m.UserId, m.Role })
                .ToListAsync();

            // 成員：以 UserId 分組，聚合多角色
            var userIds = memberRows.Select(m => m.UserId).Distinct().ToList();
            var users = await db.Users.Where(u => userIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u);

            var members = memberRows
                .GroupBy(m => m.UserId)
                .Select(g => new MemberResponse(
                    g.Key,
                    users[g.Key].UserName ?? "",
                    users[g.Key].DisplayName,
                    users[g.Key].DeactivatedAt is not null || users[g.Key].DeletedAt is not null,
                    g.Select(m => new TeamRoleResponse(m.Role.Id, m.Role.Name, m.Role.Description,
                        m.Role.IsSystem, m.Role.RolePermissions
                            .Select(rp => rp.Permission.Code).Order().ToList(), m.Role.Code)).ToList()))
                .ToList();

            var roles = await db.Roles
                .Where(r => r.TeamId == null || r.TeamId == teamId)
                .Select(r => new TeamRoleResponse(r.Id, r.Name, r.Description, r.IsSystem,
                    r.RolePermissions.Select(rp => rp.Permission.Code).Order().ToList(), r.Code))
                .ToListAsync();

            return Results.Ok(new TeamDetailResponse(team.Id, team.Name, team.Description, members, roles));
        }).RequirePermission(PermissionCodes.TeamRead);

        // 角色清單（系統範本 + 團隊自訂）—— 指派成員前需要，提前於本 task 提供
        group.MapGet("/{teamId:guid}/roles", async (Guid teamId, EntaskDbContext db) =>
        {
            var teamExists = await db.Teams.AnyAsync(t => t.Id == teamId);
            if (!teamExists) return ApiResults.NotFound(ErrorCodes.TeamNotFound);

            var roles = await db.Roles
                .Where(r => r.TeamId == null || r.TeamId == teamId)
                .Select(r => new TeamRoleResponse(r.Id, r.Name, r.Description, r.IsSystem,
                    r.RolePermissions.Select(rp => rp.Permission.Code).Order().ToList(), r.Code))
                .ToListAsync();
            return Results.Ok(roles);
        }).RequirePermission(PermissionCodes.TeamRead);

        group.MapPut("/{teamId:guid}/members", async (
            Guid teamId, AssignMemberRequest req, EntaskDbContext db, UserManager<ApplicationUser> userManager,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.RoleIds is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var team = await db.Teams.FindAsync(teamId);
            if (team is null) return ApiResults.NotFound(ErrorCodes.TeamNotFound);

            if (req.RoleIds is null) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "角色清單不可為 null" });

            var user = await userManager.FindByNameAsync(req.Username);
            if (user is null) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "使用者不存在" });

            // 單一目標的指派端點**整個拒絕**、不做差集——它是指名一個人的明確指派行為，
            // 不是編輯的副作用，所以 D8 的「只拒絕新增」在這裡不適用。出處：設計 §4.7 的
            // 「單筆增減」列要求的是「新增時檢查」，整個拒絕是**計畫**對指派 act 的收緊
            // （`docs/superpowers/plans/2026-10-07-entask-user-deactivation.md:1417-1418`）。
            // 位置在 not-found 檢查**之後**：`user` 到這裡已知非 null。
            if (user.DeactivatedAt is not null || user.DeletedAt is not null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "不可指派已停用的使用者" });

            // 驗證 roleIds 全部合法（系統範本或該團隊自訂）
            var validRoleIds = await db.Roles
                .Where(r => r.TeamId == null || r.TeamId == teamId)
                .Select(r => r.Id)
                .ToListAsync();
            if (req.RoleIds.Any(id => !validRoleIds.Contains(id)))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含無效的角色" });

            // 到職日凍結（Q1／R6）：以**動作發起人**這次帶的時區換算，不是被加入者的、也不是 UTC。
            // 認不得的 ID 不 fallback（猜一個時區等於讓錯誤的日界線靜默生效）⇒ 400；
            // 沒帶／空白 ⇒ UTC（D8 的文件化預設）。在所有既有驗證之後，不動既有錯誤的先後。
            if (!TimeZones.TryResolveOptional(req.TimeZoneId, out var tz))
                return Results.BadRequest(new { code = ErrorCodes.TimeZoneInvalid, message = "時區識別碼無效" });
            var joinedLocalDate = TimeZones.LocalToday(DateTime.UtcNow, tz);

            // 差集指派（冪等）：只移除不再需要的、只新增缺失的——同批 SaveChanges 內
            // EF insert 先於 delete，重疊角色會撞 unique index (TeamId, UserId, RoleId) → 500
            var existing = await db.TeamMembers
                .Where(m => m.TeamId == teamId && m.UserId == user.Id)
                .ToListAsync();
            var desired = req.RoleIds.Distinct().ToList();
            var existingRoleIds = existing.Select(m => m.RoleId).ToHashSet();
            db.TeamMembers.RemoveRange(existing.Where(m => !desired.Contains(m.RoleId)));
            foreach (var roleId in desired.Where(r => !existingRoleIds.Contains(r)))
                db.TeamMembers.Add(new TeamMember
                {
                    Id = Guid.NewGuid(), TeamId = teamId, UserId = user.Id, RoleId = roleId,
                    JoinedAt = DateTime.UtcNow, JoinedLocalDate = joinedLocalDate,
                });
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.MemberAssigned, "member",
                user.Id, user.UserName, new { username = req.Username, roleIds = req.RoleIds });
            return Results.Ok();
        }).RequirePermission(PermissionCodes.TeamMemberManage);

        group.MapDelete("/{teamId:guid}/members/{userId:guid}", async (
            Guid teamId, Guid userId, EntaskDbContext db, UserManager<ApplicationUser> userManager,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            var existing = await db.TeamMembers
                .Where(m => m.TeamId == teamId && m.UserId == userId).ToListAsync();
            if (existing.Count == 0) return ApiResults.NotFound(ErrorCodes.TeamMemberNotFound);
            db.TeamMembers.RemoveRange(existing);
            await db.SaveChangesAsync();
            var user = await userManager.FindByIdAsync(userId.ToString());
            // 名稱查不到時退回 userId，不讓 entityTitle 留 null——前端在 null 時會退回
            // 顯示 entityType（裸字 "member"），那是把後端識別碼印到使用者面前。
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.MemberRemoved, "member",
                userId, user?.UserName ?? userId.ToString());
            return Results.NoContent();
        }).RequirePermission(PermissionCodes.TeamMemberManage);

        return group;
    }

    // 建立與更新共用的隊名規則（使用者裁定 2026-10-09：兩條路線同一套、既有資料不回溯）。
    // 順序：空白 → 控制字元 → 超長（R1）。回傳清理後的名字，或 400 的結果。
    private static (string? Name, IResult? Error) ValidateTeamName(string? raw)
    {
        var name = raw?.Trim();
        if (string.IsNullOrWhiteSpace(name))
            return (null, Results.BadRequest(new { code = ErrorCodes.TeamNameRequired, message = "團隊名稱不可為空" }));
        if (name.Any(char.IsControl))
            return (null, Results.BadRequest(new { code = ErrorCodes.TeamNameInvalid, message = "團隊名稱含無效字元" }));
        if (name.Length > 100)
            return (null, Results.BadRequest(new
            {
                code = ErrorCodes.TeamNameTooLong,
                message = "團隊名稱不可超過 100 字元",
                @params = new { max = 100 }
            }));
        return (name, null);
    }
}
