namespace Entask.Core;

/// <summary>
/// 系統範本角色的穩定識別碼（Role.Code）。與 <see cref="PermissionCodes"/> 同型：資料層的身分，不是文案。
///
/// 為何需要：Name 是顯示資料——RoleSeed 一度以 Name 作冪等鍵、ProjectEndpoints 一度以
/// Name 查「團隊經理」範本角色。兩者都會在名稱改變時靜默失效（前者產生重複角色，
/// 後者讓建立者不再被加為專案成員）。名稱一旦隨語系改變，這就不是假設性風險而是必然斷裂。
///
/// 對應的 Name 僅為建立當下的預設顯示名稱；既有資料列的名稱不會被改寫
/// （第一次寫入是文案，之後就是使用者的資料）。
/// </summary>
public static class SystemRoleCodes
{
    public const string TeamManager = "team_manager";
    public const string ProjectManager = "project_manager";
    public const string ProjectAssistant = "project_assistant";
    public const string EngineeringLead = "eng_lead";
    public const string Engineer = "engineer";
    public const string QaEngineer = "qa_engineer";
}
