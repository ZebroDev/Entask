using Entask.Core;

namespace Entask.Tests;

/// <summary>
/// 權限分類識別碼的契約。
///
/// `RoleEditDialog` 以「權限碼的第一段」當分組鍵（`card.effort.update` → `card`），
/// 而 <see cref="PermissionCategories"/> 是那個推導的宣告來源。兩者漂移的症狀是
/// **分組靜默搬家**——某個權限跑到別組、或整組消失，沒有任何錯誤訊息；而閘門
/// （`check-label-tables.mjs`）比的是「後端分類 ↔ 前端 switch」，看不到權限碼這一側。
///
/// 刻意只驗「前綴 ∈ 已宣告分類」。反向（每個宣告的分類都必須有人用）**不驗**：
/// 先宣告一個還沒有人用的分類是允許的，把它變成紅燈只會逼人刪掉合法的宣告。
/// </summary>
public class PermissionCategoriesTests
{
    [Fact]
    public void 每個權限碼的前綴都是已宣告的分類()
    {
        var declared = PermissionCategories.All.ToHashSet();
        var orphans = PermissionCodes.All
            .Where(c => !declared.Contains(PermissionCategories.ForCode(c)))
            .ToList();

        Assert.True(
            orphans.Count == 0,
            "下列權限碼的分類不在 PermissionCategories.All 裡："
                + string.Join("、", orphans.Select(c => c + " → " + PermissionCategories.ForCode(c))));
    }

    [Fact]
    public void 分類識別碼不得重複()
    {
        Assert.Equal(PermissionCategories.All.Length, PermissionCategories.All.Distinct().Count());
    }

    [Fact]
    public void ForCode_取第一個點之前的段落()
    {
        Assert.Equal(PermissionCategories.Card, PermissionCategories.ForCode("card.effort.update"));
        Assert.Equal(PermissionCategories.Team, PermissionCategories.ForCode("team.read"));
    }
}
