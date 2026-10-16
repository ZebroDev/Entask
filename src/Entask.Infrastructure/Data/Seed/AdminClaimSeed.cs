using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Entask.Identity;

namespace Entask.Infrastructure.Data.Seed;

// 把既有的舊管理員 claim 型別遷移到新值。
//
// 為何需要：AdminSeed.InitializeAsync 只在帳號「不存在」時才建立 claim
// （見 AdminSeed.cs 的 if (admin is null) 分支），既有帳號重啟不會補。
// 若只改 AdminClaim.Type 而不處理既有資料列，所有既有管理員會靜默降權——
// 且 IsInRole("Admin") 依設計恆為 false，沒有 fallback 路徑可以救援。
//
// 為何是 additive 插入而非 UPDATE：
//   Fly 是滾動部署（min_machines_running = 1），新舊版本會短暫並存，舊機讀的是舊
//   claim 型別。破壞性的 UPDATE 會讓管理員在那個窗口內失去權限；若要回滾到舊映像，
//   更是直接變成單向門。additive 插入則兩個版本都能運作，代價只是暫時有兩列。
//   這與資料庫角色改採「新建而非 rename」是同一個模式（見 AGENTS.md 的改名章節）。
//
// 併發註記（刻意不處理）：本方法沒有交易或鎖，兩台機器同時啟動時可能都通過「已遷移」
// 檢查而各插一列。AspNetUserClaims 沒有 (UserId, ClaimType, ClaimValue)
// 唯一索引（Identity 預設，已對 snapshot 確認），故不會撞約束、不會讓啟動失敗；
// 而所有讀取路徑都是 Any／FindFirstValue，重複列語意完全等價，且只在首個並存窗口
// 發生一次、不隨重啟累積。加鎖的成本（交易 + AGENTS.md 的 post-commit 例外不變量）
// 高於這個良性重複，故權衡後不加。
public static class AdminClaimSeed
{
    // 刻意保留的歷史字面值：這是資料庫裡「既有的」claim 型別。
    // 與 EF 的 [Migration("...")] 屬性字串同理——改了就會找不到既有資料列。
    // 這裡不能引用 AdminClaim.Type，因為那已經是新值了。
    private const string LegacyClaimType = "taskify:admin";

    public static async Task MigrateAsync(EntaskDbContext db)
    {
        var legacyUserIds = await db.UserClaims
            .Where(c => c.ClaimType == LegacyClaimType)
            .Select(c => c.UserId)
            .Distinct()
            .ToListAsync();

        if (legacyUserIds.Count == 0) return;

        // 冪等：已經有新 claim 的使用者不重複插入
        var alreadyMigrated = await db.UserClaims
            .Where(c => c.ClaimType == AdminClaim.Type && legacyUserIds.Contains(c.UserId))
            .Select(c => c.UserId)
            .ToListAsync();

        var missing = legacyUserIds.Except(alreadyMigrated).ToList();
        if (missing.Count == 0) return;

        foreach (var userId in missing)
        {
            db.UserClaims.Add(new IdentityUserClaim<Guid>
            {
                UserId = userId,
                ClaimType = AdminClaim.Type,
                ClaimValue = AdminClaim.Value,
            });
        }
        await db.SaveChangesAsync();
    }
}
