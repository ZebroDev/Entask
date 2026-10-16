using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Entask.Identity.Models;

namespace Entask.Identity;

public static class AdminClaim
{
    // 改這個值時必須一併處理資料庫裡的既有資料列，否則既有管理員會靜默降權。
    // 遷移在 AdminClaimSeed（Entask.Infrastructure/Data/Seed）。
    public const string Type = "entask:admin";
    public const string Value = "true";
}

public static class AdminSeed
{
    public static async Task InitializeAsync(IServiceProvider services, IConfiguration config)
    {
        // UserManager 是 scoped 服務；Development 環境 ValidateScopes 下從 root provider 解析會 throw，必須先開 scope
        using var scope = services.CreateScope();
        var userManager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var username = config["Seed:AdminUsername"];
        var password = config["Seed:AdminPassword"];
        if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) return;

        var admin = await userManager.FindByNameAsync(username);
        if (admin is null)
        {
            admin = new ApplicationUser { UserName = username, DisplayName = "系統管理員" };
            var result = await userManager.CreateAsync(admin, password);
            if (!result.Succeeded)
                throw new InvalidOperationException(string.Join("; ", result.Errors.Select(e => e.Description)));
            var claimResult = await userManager.AddClaimAsync(admin, new System.Security.Claims.Claim(AdminClaim.Type, AdminClaim.Value));
            if (!claimResult.Succeeded)
                throw new InvalidOperationException(string.Join("; ", claimResult.Errors.Select(e => e.Description)));
        }
    }
}
