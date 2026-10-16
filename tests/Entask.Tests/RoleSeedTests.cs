using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Data.Seed;

namespace Entask.Tests;

public class RoleSeedTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public RoleSeedTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
    }

    // spec #19：種子非 admin 角色缺 board.read → 非 admin 開看板 403。
    // RoleSeed 為 skip-if-exists 語義，僅對新 DB 生效（WithDbReset 保證全新 DB；
    // 既有 dev DB 需手動補權限或重建，不在本測試範疇）。
    [Fact]
    public async Task RoleSeed_NonAdminRoles_AllContainBoardRead()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        foreach (var name in new[] { "工程師", "工程組長", "測試工程師", "專案助理" })
        {
            var role = await db.Roles
                .Include(r => r.RolePermissions)
                .ThenInclude(rp => rp.Permission)
                .SingleAsync(r => r.TeamId == null && r.Name == name);
            Assert.Contains(role.RolePermissions, rp => rp.Permission.Code == PermissionCodes.BoardRead);
        }
    }

    [Fact]
    public async Task RoleSeed_NonAdminRoles_AllContainProjectRead()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        foreach (var name in new[] { "工程師", "工程組長", "測試工程師", "專案助理" })
        {
            var role = await db.Roles
                .Include(r => r.RolePermissions)
                .ThenInclude(rp => rp.Permission)
                .SingleAsync(r => r.TeamId == null && r.Name == name);
            Assert.Contains(role.RolePermissions, rp => rp.Permission.Code == PermissionCodes.ProjectRead);
        }
    }

    [Fact]
    public async Task RoleSeed_EditorRoles_AllContainMindMapEdit_TesterDoesNot()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        foreach (var name in new[] { "工程師", "工程組長", "專案助理", "專案經理", "團隊經理" })
        {
            var role = await db.Roles
                .Include(r => r.RolePermissions)
                .ThenInclude(rp => rp.Permission)
                .SingleAsync(r => r.TeamId == null && r.Name == name);
            Assert.Contains(role.RolePermissions, rp => rp.Permission.Code == PermissionCodes.MindMapEdit);
        }

        var tester = await db.Roles
            .Include(r => r.RolePermissions)
            .ThenInclude(rp => rp.Permission)
            .SingleAsync(r => r.TeamId == null && r.Name == "測試工程師");
        Assert.DoesNotContain(tester.RolePermissions, rp => rp.Permission.Code == PermissionCodes.MindMapEdit);
    }

    // 設計 §13.5（D8，使用者逐條裁定）：分數會進績效評等，所以只有主管角色能填寫評分。
    // 兩邊都要釘——只釘「主管有」的話，把 CardRate 從所有角色拿掉也照樣綠；
    // 只釘「非主管沒有」的話，六個角色全部授予也照樣綠。
    // 形狀沿用上面的 RoleSeed_EditorRoles_AllContainMindMapEdit_TesterDoesNot：
    // 直接讀種子角色的 RolePermissions，而不是走 API 的 /permissions/mine——
    // 那是聯集，任何一個角色帶著 card.rate 都會讓「其他人沒有」那一半失去判別力。
    [Fact]
    public async Task RoleSeed_OnlyManagerRoles_ContainCardRate()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        foreach (var name in new[] { "團隊經理", "專案經理", "工程組長" })
        {
            var role = await db.Roles
                .Include(r => r.RolePermissions)
                .ThenInclude(rp => rp.Permission)
                .SingleAsync(r => r.TeamId == null && r.Name == name);
            Assert.Contains(role.RolePermissions, rp => rp.Permission.Code == PermissionCodes.CardRate);
        }

        foreach (var name in new[] { "專案助理", "工程師", "測試工程師" })
        {
            var role = await db.Roles
                .Include(r => r.RolePermissions)
                .ThenInclude(rp => rp.Permission)
                .SingleAsync(r => r.TeamId == null && r.Name == name);
            Assert.DoesNotContain(role.RolePermissions, rp => rp.Permission.Code == PermissionCodes.CardRate);
        }
    }

    [Fact]
    public async Task RoleSeed_ExistingSystemRoles_BackfillsMissingTemplatePermissions()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();

        // 模擬既有 DB 缺少某權限：暫時移除「工程師」角色的 project.read
        var engineer = await db.Roles
            .Include(r => r.RolePermissions)
            .ThenInclude(rp => rp.Permission)
            .SingleAsync(r => r.TeamId == null && r.Name == "工程師");
        var projectReadRp = engineer.RolePermissions.FirstOrDefault(rp => rp.Permission.Code == PermissionCodes.ProjectRead);
        if (projectReadRp != null)
        {
            db.RolePermissions.Remove(projectReadRp);
            await db.SaveChangesAsync();
        }

        // 再次執行 SeedAsync
        await RoleSeed.SeedAsync(db);

        // 斷言已自動補齊 project.read
        var reloaded = await db.Roles
            .Include(r => r.RolePermissions)
            .ThenInclude(rp => rp.Permission)
            .SingleAsync(r => r.TeamId == null && r.Name == "工程師");
        Assert.Contains(reloaded.RolePermissions, rp => rp.Permission.Code == PermissionCodes.ProjectRead);
    }
}
