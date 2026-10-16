using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Entask.Identity;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Data.Seed;

namespace Entask.Tests;

// 覆蓋 T3 的 claim 型別改名：AdminClaim.Type 由 `taskify:admin` 改為 `entask:admin`，
// 既有資料庫中的舊列靠 AdminClaimSeed.MigrateAsync 以 additive 插入補上。
//
// 為何既有測試抓不到：測試工廠每次 Reset 都建全新的 DB，AdminSeed 一定會走到
// 「帳號不存在 → 建立帳號並授予新 claim」那條路，舊型別的資料列從未存在過。
public class AdminClaimMigrationTests : IClassFixture<ApiWebApplicationFactory>
{
    // 刻意寫死而非引用 AdminClaim.Type：這是「改名前的歷史值」，兩者必須不同，
    // 若引用常數則本測試在改名後會退化成同值比對、永遠通過。
    private const string LegacyClaimType = "taskify:admin";
    private const string UserPassword = "Migrate1!";

    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AdminClaimMigrationTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset();
        _client = factory.CreateClient(); // 觸發 host 建立，DB 重置於此完成
    }

    // 建立一個非管理員使用者（Identity 只給它 password hash，不給任何 claim）。
    private async Task<Guid> CreateUserAsync(string username)
    {
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();

        var user = new ApplicationUser { UserName = username, DisplayName = username };
        var created = await users.CreateAsync(user, UserPassword);
        Assert.True(created.Succeeded, string.Join("; ", created.Errors.Select(e => e.Description)));
        return user.Id;
    }

    // 再補上舊型別的 admin claim，模擬改名前的既有資料。
    private async Task<Guid> SeedLegacyAdminUserAsync(string username)
    {
        var userId = await CreateUserAsync(username);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.UserClaims.Add(new IdentityUserClaim<Guid>
        {
            UserId = userId,
            ClaimType = LegacyClaimType,
            ClaimValue = AdminClaim.Value,
        });
        await db.SaveChangesAsync();
        return userId;
    }

    private async Task RunMigrationAsync()
    {
        using var scope = _factory.Services.CreateScope();
        await AdminClaimSeed.MigrateAsync(scope.ServiceProvider.GetRequiredService<EntaskDbContext>());
    }

    private async Task<List<IdentityUserClaim<Guid>>> ClaimsOfAsync(Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return await db.UserClaims.Where(c => c.UserId == userId).ToListAsync();
    }

    [Fact]
    public async Task LegacyAdminClaim_IsMigrated_AndUserLogsInAsAdmin()
    {
        var username = "legacy-admin";
        var userId = await SeedLegacyAdminUserAsync(username);

        await RunMigrationAsync();

        // 端到端：isAdmin 由登入端點讀 DB 的 claim 判定，故能真正證明遷移生效
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = UserPassword }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var json = await login.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("isAdmin").GetBoolean(), "舊 claim 的使用者遷移後應被視為管理員");

        // additive：舊列必須保留——Fly 滾動部署時舊版機器仍靠它運作，回滾亦然
        var claims = await ClaimsOfAsync(userId);
        Assert.Contains(claims, c => c.ClaimType == LegacyClaimType);
        Assert.Single(claims, c => c.ClaimType == AdminClaim.Type);
    }

    [Fact]
    public async Task Migrate_RunTwice_DoesNotDuplicateClaim()
    {
        var userId = await SeedLegacyAdminUserAsync("legacy-admin-twice");

        await RunMigrationAsync();
        await RunMigrationAsync(); // 各自獨立的 scope：以 DB 現況判斷冪等，非同一 context 的記憶體狀態

        var claims = await ClaimsOfAsync(userId);
        Assert.Single(claims, c => c.ClaimType == AdminClaim.Type);
    }

    [Fact]
    public async Task Migrate_WithoutLegacyClaims_LeavesClaimsUnchanged()
    {
        var userId = await CreateUserAsync("no-claim-user");

        await RunMigrationAsync();

        Assert.Empty(await ClaimsOfAsync(userId));
    }

    // H1：前面三支都「直接呼叫」MigrateAsync——若有人刪掉或搬動 Program.cs 的呼叫點，
    // 它們照樣全綠。但啟動路徑才是唯一不可逆的失效模式：既有 admin 會靜默降權，而
    // IsInRole("Admin") 依設計恆 false、產品內沒有自我提權端點，沒有任何復原手段。
    // 本測試走 hosting 路徑：開一個「不重置 DB」的新 host，讓 Program.cs 自己去跑遷移。
    [Fact]
    public async Task StartupPath_MigratesLegacyClaim()
    {
        var username = "legacy-admin-startup";
        await SeedLegacyAdminUserAsync(username);

        using var freshFactory = new ApiWebApplicationFactory(); // 刻意不 WithDbReset：保留剛寫入的舊列
        using var client = freshFactory.CreateClient();
        var login = await client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = UserPassword }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        var json = await login.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("isAdmin").GetBoolean(),
            "Program.cs 的啟動路徑必須執行 AdminClaimSeed，否則既有管理員會靜默降權");

        // 本測試多開了一個 host。Npgsql 的連線池是行程層級、不隨 host 處置而關閉，
        // 而別的測試類別要 EnsureDeletedAsync 就得先讓 entask_test 沒有其他連線。
        // 明確清池，避免把既有的 DB-reset 競態弄得更頻繁（AGENTS.md 的已知 transient）。
        NpgsqlConnection.ClearAllPools();
    }
}
