namespace Entask.Core;

/// <summary>
/// 權限的分類識別碼，與 <see cref="PermissionCodes"/> 的**前綴**一一對應
/// （`card.effort.update` → `card`，見 <see cref="ForCode"/>）。
///
/// 為何需要：`Permission.Category` 是寫進 DB 的**顯示字**（`"卡片"`），而前端
/// `RoleEditDialog` 同時拿它當 reduce 的鍵與分組標題。今天無害（它不是譯文），
/// 但 P-C 一旦把權限目錄在地化，**鍵就會跟著語系跑**——切一次語系就多出一組分組
/// （`GanttTab` 的 `UNASSIGNED` 哨兵值同一個坑）。
///
/// 判準：**只要一個字串被當成識別碼用過，它就不能是譯文。** 前端因此改以前綴分組，
/// 顯示文字另走 `team:permissionCategory.*`（守門員是標籤表的第七張）。
///
/// **不進 DB**：`PermissionSeed.Catalog` 的中文 Category 維持原樣（它仍驅動
/// `PermissionEndpoints` 的 `OrderBy`），改既有欄位的值對滾動部署不安全（P-A 的裁定）。
/// 代價是 `Permission.Category` 變成前端不再讀的遺留物，記在 `docs/STATE.md`。
/// </summary>
public static class PermissionCategories
{
    public const string Team = "team";
    public const string Project = "project";
    public const string Board = "board";
    public const string Card = "card";
    public const string MindMap = "mindmap";
    public const string Report = "report";

    public static readonly string[] All = [Team, Project, Board, Card, MindMap, Report];

    /// <summary>權限碼的分類＝第一個點之前的段落（`card.effort.update` → `card`）。</summary>
    public static string ForCode(string code)
    {
        var dot = code.IndexOf('.');
        return dot < 0 ? code : code[..dot];
    }
}
