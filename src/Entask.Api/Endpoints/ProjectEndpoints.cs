using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Identity;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjects(this IEndpointRouteBuilder app)
    {
        // 我的專案：admin 全部；其餘 = 專案成員或擁有該團隊 project./board./card. 權限者
        app.MapGet("/api/projects", async (ClaimsPrincipal principal, EntaskDbContext db) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            var isAdmin = principal.FindFirstValue(AdminClaim.Type) == AdminClaim.Value;

            var projects = await db.Projects
                .Where(p => isAdmin ||
                    db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == userId) ||
                    db.TeamMembers.Any(m => m.TeamId == p.TeamId && m.UserId == userId &&
                        m.Role.RolePermissions.Any(rp =>
                            rp.Permission.Code.StartsWith("project.") ||
                            rp.Permission.Code.StartsWith("board.") ||
                            rp.Permission.Code.StartsWith("card."))))
                .Select(p => new ProjectResponse(p.Id, p.TeamId, p.Name, p.Description,
                    db.ProjectMembers.Where(m => m.ProjectId == p.Id).Select(m => m.UserId).Distinct().Count(),
                    db.Boards.Count(b => b.ProjectId == p.Id),
                    p.CreatedAt))
                .ToListAsync();
            return Results.Ok(projects);
        }).RequireAuthorization();

        // 建立專案（團隊範疇 project.create；X-Team-Id 指定團隊）；
        // seed §3.3 預設自訂欄位；建立者自動加入為專案成員
        app.MapPost("/api/projects", async (CreateProjectRequest req, HttpContext context,
            EntaskDbContext db, IAuditService audit) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.ProjectNameRequired, message = "專案名稱不可為空" });

            var principal = context.User;
            var userId = BoardEndpoints.CurrentUserId(principal);
            var teamHeader = context.Request.Headers["X-Team-Id"].FirstOrDefault();
            if (!Guid.TryParse(teamHeader, out var teamId))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "缺少 X-Team-Id header" });

            var teamExists = await db.Teams.AnyAsync(t => t.Id == teamId);
            if (!teamExists)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "團隊不存在" });

            var project = new Project
            {
                TeamId = teamId,
                Name = req.Name.Trim(),
                Description = req.Description,
                CreatedById = userId,
            };
            db.Projects.Add(project);

            // seed 自訂欄位（§3.3）。SystemKey 是識別碼，Name 只是建立當下的預設顯示名稱——
            // 使用者可自由改名，i18n 之後名稱還會隨語系而異。以其為條件的查詢一律用 SystemKey。
            db.CustomFieldDefinitions.AddRange(
                new CustomFieldDefinition { ScopeType = "project", ScopeId = project.Id, Name = "優先級", SystemKey = SystemFieldKeys.Priority, Type = CustomFieldTypes.Select, Options = """["高","中","低"]""", Position = "0" },
                new CustomFieldDefinition { ScopeType = "project", ScopeId = project.Id, Name = "提出需求者", SystemKey = SystemFieldKeys.Requester, Type = CustomFieldTypes.Member, Position = "1" });

            // 建立者自動加入為專案成員（其在該團隊的全部角色）；
            // 建立者於該團隊無任何角色時（如 admin），指派「團隊經理」範本角色以維持「建立者必為成員」
            var myRoles = await db.TeamMembers
                .Where(m => m.TeamId == teamId && m.UserId == userId)
                .Select(m => m.RoleId).ToListAsync();
            if (myRoles.Count == 0)
            {
                // 以穩定識別碼查找；Code 為 null 的舊資料列才退回名稱比對（過渡期
                // fallback，與 RoleSeed 同型）。名稱在 i18n 之後會隨語系而異。
                var managerRoleId = await db.Roles
                    .Where(r => r.TeamId == null &&
                        (r.Code == SystemRoleCodes.TeamManager || (r.Code == null && r.Name == "團隊經理")))
                    .Select(r => r.Id).FirstOrDefaultAsync();
                if (managerRoleId != Guid.Empty)
                    myRoles.Add(managerRoleId);
            }
            // 到職日凍結（Q1／R6）：以**動作發起人**這次帶的時區換算，不是 UTC。認不得的 ID
            // 不 fallback ⇒ 400；沒帶／空白 ⇒ UTC（D8）。位置在任何 `SaveChangesAsync` 之前
            // ——上面的 `db.Projects.Add` 與自訂欄位 `AddRange` 只進 change tracker，不落地
            // （本處理常式在 `SaveChangesAsync` 之前就 return 400，DbContext 也是 request-scoped）。
            if (!TimeZones.TryResolveOptional(req.TimeZoneId, out var tz))
                return Results.BadRequest(new { code = ErrorCodes.TimeZoneInvalid, message = "時區識別碼無效" });
            var joinedLocalDate = TimeZones.LocalToday(DateTime.UtcNow, tz);
            foreach (var roleId in myRoles)
                db.ProjectMembers.Add(new ProjectMember { ProjectId = project.Id, UserId = userId, RoleId = roleId, JoinedAt = DateTime.UtcNow, JoinedLocalDate = joinedLocalDate });

            await db.SaveChangesAsync();
            await audit.AddAsync(userId, teamId, AuditActions.ProjectCreated, "Project", project.Id, project.Name, null, project.Id);

            return Results.Ok(new ProjectResponse(project.Id, project.TeamId, project.Name, project.Description, myRoles.Count > 0 ? 1 : 0, 0, project.CreatedAt));
        }).RequireAuthorization().RequirePermission(PermissionCodes.ProjectCreate);

        // 專案詳情（含成員數、看板數摘要）
        app.MapGet("/api/projects/{projectId:guid}", async (Guid projectId, EntaskDbContext db) =>
        {
            var p = await db.Projects.Where(x => x.Id == projectId)
                .Select(x => new ProjectResponse(x.Id, x.TeamId, x.Name, x.Description,
                    db.ProjectMembers.Where(m => m.ProjectId == x.Id).Select(m => m.UserId).Distinct().Count(),
                    db.Boards.Count(b => b.ProjectId == x.Id), x.CreatedAt))
                .FirstOrDefaultAsync();
            return p is null ? ApiResults.NotFound(ErrorCodes.ProjectNotFound) : Results.Ok(p);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectRead);

        app.MapPut("/api/projects/{projectId:guid}", async (Guid projectId, UpdateProjectRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit) =>
        {
            if (req.Name is not null && string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { code = ErrorCodes.ProjectNameRequired, message = "專案名稱不可為空" });
            var p = await db.Projects.FirstOrDefaultAsync(x => x.Id == projectId);
            if (p is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);
            if (req.Name is not null) p.Name = req.Name.Trim();
            if (req.Description is not null) p.Description = req.Description;
            p.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), p.TeamId, AuditActions.ProjectUpdated, "Project", p.Id, p.Name, null, p.Id);
            return Results.Ok(new ProjectResponse(p.Id, p.TeamId, p.Name, p.Description,
                await db.ProjectMembers.Where(m => m.ProjectId == p.Id).Select(m => m.UserId).Distinct().CountAsync(),
                await db.Boards.CountAsync(b => b.ProjectId == p.Id), p.CreatedAt));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectEdit);

        app.MapDelete("/api/projects/{projectId:guid}", async (Guid projectId, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit, IAttachmentStore store) =>
        {
            var p = await db.Projects.FirstOrDefaultAsync(x => x.Id == projectId);
            if (p is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);
            var storagePaths = await db.Attachments
                .Where(a => a.Card.List.Board.ProjectId == projectId)
                .Select(a => a.StoragePath)
                .ToListAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), p.TeamId, AuditActions.ProjectDeleted, "Project", p.Id, p.Name, null, p.Id);
            db.Projects.Remove(p);   // 級聯依 §3.5（EF cascade 已設定）
            await db.SaveChangesAsync();
            foreach (var path in storagePaths)
                store.Delete(path);
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectDelete);

        // 專案成員列（每位成員一列，Roles 與 RoleIds 聚合其多角色）
        app.MapGet("/api/projects/{projectId:guid}/members", async (Guid projectId, EntaskDbContext db) =>
        {
            var rows = await db.ProjectMembers.Where(m => m.ProjectId == projectId)
                .Select(m => new { m.UserId, m.RoleId, RoleName = m.Role.Name, RoleCode = m.Role.Code })
                .ToListAsync();
            var userIds = rows.Select(r => r.UserId).Distinct().ToList();
            var users = await db.Users.Where(u => userIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u);
            var response = rows
                .GroupBy(r => r.UserId)
                .Select(g =>
                {
                    users.TryGetValue(g.Key, out var user);
                    var roles = g.Select(r => new ProjectMemberRoleDto(r.RoleId, r.RoleName, r.RoleCode)).ToList();
                    return new ProjectMemberResponse(g.Key, user?.UserName ?? "", user?.DisplayName ?? "", user?.AvatarUrl,
                        user is not null && (user.DeactivatedAt is not null || user.DeletedAt is not null),
                        roles,
                        roles.Select(r => r.Id).ToList());
                })
                .ToList();
            return Results.Ok(response);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectRead);

        app.MapPost("/api/projects/{projectId:guid}/members", async (Guid projectId, AddProjectMemberRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.RoleIds is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var project = await db.Projects.FirstOrDefaultAsync(x => x.Id == projectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == req.UserId);
            if (user is null) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "使用者不存在" });

            // 單一目標的指派端點**整個拒絕**、不做差集——理由同 `TeamEndpoints` 的團隊成員端點。
            // 出處：設計 §4.7 那一列要求的是「新增時檢查」，整個拒絕是**計畫**的收緊
            // （`docs/superpowers/plans/2026-10-07-entask-user-deactivation.md:1417-1418`）。
            // 位置在 not-found 檢查之後：`user` 已知非 null。
            if (user.DeactivatedAt is not null || user.DeletedAt is not null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "不可指派已停用的使用者" });

            if (req.RoleIds is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "角色清單不可為 null" });

            // RoleId 必須是系統範本或該成員所屬團隊的自訂角色
            if (!await RoleIdsValidAsync(db, req.UserId, req.RoleIds))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含無效的角色" });

            var existing = await db.ProjectMembers
                .Where(m => m.ProjectId == projectId && m.UserId == req.UserId).Select(m => m.RoleId).ToListAsync();

            // 守衛（2026-09-19 裁定；M2 收斂成單一出處，見 MemberInUseGuardAsync）：
            // 這次操作會讓他的角色歸零（＝移出專案）才擋。
            var guard = await MemberInUseGuardAsync(db, projectId, req.UserId, existing.Count, req.RoleIds.Distinct().Count());
            if (guard is not null) return guard;

            // 到職日凍結（Q1／R6）：以**動作發起人**這次帶的時區換算，不是 UTC。認不得的 ID
            // 不 fallback ⇒ 400；沒帶／空白 ⇒ UTC（D8）。位置在所有既有驗證之後、寫入之前。
            if (!TimeZones.TryResolveOptional(req.TimeZoneId, out var tz))
                return Results.BadRequest(new { code = ErrorCodes.TimeZoneInvalid, message = "時區識別碼無效" });
            var joinedLocalDate = TimeZones.LocalToday(DateTime.UtcNow, tz);
            foreach (var roleId in req.RoleIds.Distinct().Where(r => !existing.Contains(r)))
                db.ProjectMembers.Add(new ProjectMember { ProjectId = projectId, UserId = req.UserId, RoleId = roleId, JoinedAt = DateTime.UtcNow, JoinedLocalDate = joinedLocalDate });
            foreach (var roleId in existing.Where(r => !req.RoleIds.Contains(r)))
                db.ProjectMembers.RemoveRange(db.ProjectMembers.Where(m => m.ProjectId == projectId && m.UserId == req.UserId && m.RoleId == roleId));

            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), project.TeamId, AuditActions.ProjectMemberAdded, "Project", projectId, project.Name, new { req.UserId, req.RoleIds }, projectId);
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectMemberManage);

        // 全量重設該成員角色；roleIds 空 = 移除該成員
        app.MapPut("/api/projects/{projectId:guid}/members/{userId:guid}", async (Guid projectId, Guid userId, UpdateProjectMemberRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.RoleIds is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var project = await db.Projects.FirstOrDefaultAsync(x => x.Id == projectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            if (req.RoleIds is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "角色清單不可為 null" });
            // 取狀態欄位而不是 `AnyAsync`：下面的差集檢查要用它（`null` ⇒ 不存在，形狀不變）。
            var userState = await db.Users.Where(u => u.Id == userId)
                .Select(u => new { u.DeactivatedAt, u.DeletedAt })
                .FirstOrDefaultAsync();
            if (userState is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "使用者不存在" });

            if (!await RoleIdsValidAsync(db, userId, req.RoleIds))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含無效的角色" });

            // 差集重設（roleIds 空 = 移除成員）：同批 SaveChanges 內 EF insert 先於 delete，
            // 重疊角色會撞複合鍵 unique index → 500
            var existing = await db.ProjectMembers
                .Where(m => m.ProjectId == projectId && m.UserId == userId)
                .ToListAsync();
            var desired = req.RoleIds.Distinct().ToList();

            // 只驗「新增」的差集（設計 §4.7 的「單筆增減 ⇒ 新增時檢查」；語意同
            // `CardEndpoints` 卡片成員 PUT 那一段）：`existing.Count == 0` 是這一 PUT 會讓
            // 一個**非成員**取得第一筆成員列的唯一情形，而它才是新增。整條路徑整個拒絕不行
            // ——它同時是既有成員的角色編輯（前端唯一消費者是 `EditProjectMemberRolesDialog`），
            // 整個拒絕會連移除一起擋掉，與 D7「名冊保留、仍移得掉」矛盾。
            if (existing.Count == 0 && desired.Count > 0
                && (userState.DeactivatedAt is not null || userState.DeletedAt is not null))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "不可指派已停用的使用者" });

            // 守衛（同 POST，見該處註解）：desired 空 ⇒ 既有列全被移除 ⇒ 角色歸零。
            var guard = await MemberInUseGuardAsync(db, projectId, userId, existing.Count, desired.Count);
            if (guard is not null) return guard;

            // 到職日凍結（Q1／R6）：以**動作發起人**這次帶的時區換算，不是 UTC。認不得的 ID
            // 不 fallback ⇒ 400；沒帶／空白 ⇒ UTC（D8）。**只寫在被新增的列上**——既有列是
            // 角色編輯、不是重新到職，`JoinedLocalDate` 不重寫（它是凍結值，不是可變欄位）。
            if (!TimeZones.TryResolveOptional(req.TimeZoneId, out var tz))
                return Results.BadRequest(new { code = ErrorCodes.TimeZoneInvalid, message = "時區識別碼無效" });
            var joinedLocalDate = TimeZones.LocalToday(DateTime.UtcNow, tz);
            var existingRoleIds = existing.Select(m => m.RoleId).ToHashSet();
            db.ProjectMembers.RemoveRange(existing.Where(m => !desired.Contains(m.RoleId)));
            foreach (var roleId in desired.Where(r => !existingRoleIds.Contains(r)))
                db.ProjectMembers.Add(new ProjectMember { ProjectId = projectId, UserId = userId, RoleId = roleId, JoinedAt = DateTime.UtcNow, JoinedLocalDate = joinedLocalDate });

            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), project.TeamId, AuditActions.ProjectMemberUpdated, "Project", projectId, project.Name, new { userId, req.RoleIds }, projectId);
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectMemberManage);

        app.MapDelete("/api/projects/{projectId:guid}/members/{userId:guid}", async (Guid projectId, Guid userId, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit) =>
        {
            var project = await db.Projects.FirstOrDefaultAsync(x => x.Id == projectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            // 守衛（同 POST／PUT，見該處註解）：DELETE 一律讓角色歸零（remainingCount: 0）。
            var existingCount = await db.ProjectMembers.CountAsync(m => m.ProjectId == projectId && m.UserId == userId);
            var guard = await MemberInUseGuardAsync(db, projectId, userId, existingCount, remainingCount: 0);
            if (guard is not null) return guard;

            db.ProjectMembers.RemoveRange(db.ProjectMembers.Where(m => m.ProjectId == projectId && m.UserId == userId));
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), project.TeamId, AuditActions.ProjectMemberRemoved, "Project", projectId, project.Name, new { userId }, projectId);
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectMemberManage);

        // 我的專案有效權限（JSON 字串陣列，同 P0 /api/permissions/mine 形狀）
        app.MapGet("/api/projects/{projectId:guid}/permissions/mine", async (Guid projectId, ClaimsPrincipal principal, IPermissionChecker checker) =>
        {
            var userId = BoardEndpoints.CurrentUserId(principal);
            var codes = await checker.GetProjectEffectivePermissionsAsync(userId, projectId);
            return Results.Ok(codes.Order());
        }).RequireAuthorization();

        return app;
    }

    // 專案成員的三條移除路徑（POST 帶空 roleIds／PUT 帶空 roleIds／DELETE）共用同一個守衛。
    // 三個條件同時成立才擋——這次操作讓他的角色歸零（`remainingCount == 0`）、
    // 他目前在該專案至少有一列（`existingCount > 0`）、且本專案仍有卡片參照他。
    // 「至少有一列」是為了讓「本來就不是成員」的 no-op 不因歷史孤兒而回莫名其妙的 409
    // （他不在名冊裡，移除他不會讓任何人失去什麼；卡片上那列本來就違反不變量，是歷史資料）。
    // 三條路徑的輸入形狀不同——POST 的 `remainingCount` 是 `req.RoleIds` 的相異數、
    // PUT 是 `desired.Count`、DELETE 恆為 0——但觸發運算式與 409 的形狀只有這一份（M2）。
    private static async Task<IResult?> MemberInUseGuardAsync(EntaskDbContext db, Guid projectId, Guid userId,
        int existingCount, int remainingCount)
    {
        if (existingCount == 0 || remainingCount > 0) return null;
        var refs = await CountCardReferencesAsync(db, projectId, userId);
        if (refs == 0) return null;
        // `refs` 兩用：一是後備訊息（`message`，zh-TW 成品），二是 `@params`——新前端的譯文是
        // 樣板（`{{refs}}`），值就是這個數字。少了 `@params`，前端只顯示得到泛用句
        // （模板佔位原樣留著或整句被略過），使用者看不到「幾張」（設計 §4.2 的閘門 C 會擋）。
        return Results.Conflict(new
        {
            code = ErrorCodes.ProjectMemberInUse,
            message = $"此成員仍指派於本專案的 {refs} 張卡片，請先從卡片移除",
            @params = new { refs }
        });
    }

    // 卡片指派者與審查者的來源是專案名冊，而卡片的兩個 PUT 只收專案成員 ⇒ 留下
    // 「在卡片上、不在名冊裡」的人，他就再也移不掉（前端下拉列的是專案成員），
    // 待審查的卡片更會永遠送不出去（只有被指派的審查者本人能提交，admin 沒有豁免）。
    // `c.Reviews` 吃 `CardReview` 的全域 query filter（RemovedAt == null）⇒ 只算**現任**審查者，
    // 軟刪除的列不擋移除——「移除審查者」這個動作才不會等於沒用（2026-09-19 裁定 R4）。
    private static async Task<int> CountCardReferencesAsync(EntaskDbContext db, Guid projectId, Guid userId)
        => await db.Cards.CountAsync(c => c.List.Board.ProjectId == projectId
            && (c.Members.Any(m => m.UserId == userId) || c.Reviews.Any(r => r.ReviewerUserId == userId)));

    // RoleId 必須是系統範本或該成員所屬團隊的自訂角色
    private static async Task<bool> RoleIdsValidAsync(EntaskDbContext db, Guid userId, List<Guid> roleIds)
    {
        var memberTeams = await db.TeamMembers.Where(m => m.UserId == userId).Select(m => m.TeamId).ToListAsync();
        var validCount = await db.Roles
            .Where(r => roleIds.Contains(r.Id) && (r.TeamId == null || memberTeams.Contains(r.TeamId!.Value)))
            .CountAsync();
        return validCount == roleIds.Distinct().Count();
    }
}
