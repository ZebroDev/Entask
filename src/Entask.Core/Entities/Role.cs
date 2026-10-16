namespace Entask.Core.Entities;

public class Role
{
    public Guid Id { get; set; }
    public Guid? TeamId { get; set; }
    public string Name { get; set; } = "";

    /// <summary>
    /// 系統範本角色的穩定識別碼（見 <see cref="SystemRoleCodes"/>）；團隊自訂角色為 null。
    /// Name 是顯示資料（將隨語系改變），Code 才是身分——RoleSeed 的冪等鍵與
    /// ProjectEndpoints 查「團隊經理」範本角色都必須用它，不可用 Name。
    /// </summary>
    public string? Code { get; set; }

    public string? Description { get; set; }
    public bool IsSystem { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public List<RolePermission> RolePermissions { get; set; } = [];
}
