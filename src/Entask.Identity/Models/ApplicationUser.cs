using Microsoft.AspNetCore.Identity;

namespace Entask.Identity.Models;

public class ApplicationUser : IdentityUser<Guid>
{
    public string DisplayName { get; set; } = "";
    public string? AvatarUrl { get; set; }

    // 停用（可復原）與刪除（不可逆）。狀態由兩者的組合推導，沒有 enum：
    // enum 的每個值都得回答「那 DeactivatedAt 要填什麼」，而時間戳本身就是要留的稽核資料。
    // 不變量：DeletedAt is not null ⇒ DeactivatedAt is not null（刪除的前置條件是已停用）。
    public DateTime? DeactivatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }
}
