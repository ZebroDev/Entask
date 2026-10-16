namespace Entask.Core;

/// <summary>
/// 稽核紀錄的動作識別碼（<c>AuditLog.Action</c>）。與 <see cref="PermissionCodes"/> 同型：
/// 機器可讀的識別碼，不是文案。
///
/// 為何需要這張表：這些字串原本是散在 9 個檔案、28 個呼叫點的行內字面值，而前端
/// <c>TeamActivityTab</c> 把它們**原樣印在畫面上**——zh-TW 使用者看到的是
/// 「team.created：核心研發團隊」。要讓前端翻成顯示文字，後端這一側必須先有一份
/// 可列舉的清單，<c>web/scripts/check-label-tables.mjs</c> 才比對得到（它讀的是單行的
/// 常數宣告，形狀見該檔的 <c>readBackendValues</c>——**這裡刻意不複寫那個形狀**：
/// 它自己的正規式連註解裡的宣告都會算成一個真的常數，而那個假常數會讓閘門要求前端
/// 為它生一條永遠不會被觸發的 case）。
///
/// 值一經寫入就是歷史資料（<c>AuditLogs</c> 的既有列），**不可重新命名**：改名會讓所有
/// 舊列在前端退回顯示原始識別碼，而且不會有任何錯誤訊息、不會有測試變紅。新增動作時
/// 跑一次 <c>cd web &amp;&amp; npm run check:labels</c>。
///
/// **兩個讀取面的範圍不同**（2026-10-10）：團隊活動牆走
/// <c>GET /api/audit-logs?teamId=</c>（只看得到該團隊的列）；系統活動頁走
/// <c>GET /api/audit-logs/system</c>（admin-only，只看 <c>TeamId == null</c> 的列——
/// 也就是下面那五個 <c>user.*</c>）。所以「團隊端點查不到」不等於「產品裡看不到」。
/// </summary>
public static class AuditActions
{
    public const string TeamCreated = "team.created";
    public const string TeamUpdated = "team.updated";
    public const string MemberAssigned = "member.assigned";
    public const string MemberRemoved = "member.removed";

    /// <summary>
    /// 建立使用者。**這一筆的 TeamId 是 null**，所以 `GET /api/audit-logs?teamId=`
    /// 永遠查不到它（**系統活動頁** `GET /api/audit-logs/system` 看得到，admin-only）——
    /// 前端的標籤表仍必須有這一條，因為閘門比的是「集合相等」。
    /// </summary>
    public const string UserCreated = "user.created";

    /// <summary>停用（可復原）。與 `UserDeleted` 是兩個不同的動作——這張表的值是歷史資料。</summary>
    public const string UserDeactivated = "user.deactivated";

    /// <summary>復原。<c>AuditLogs</c> 裡仍留著當初的 <c>user.deactivated</c>。</summary>
    public const string UserReactivated = "user.reactivated";

    /// <summary>刪除（不可逆）。與 <c>UserCreated</c> 一樣，這一筆的 TeamId 是 null。</summary>
    public const string UserDeleted = "user.deleted";

    /// <summary>管理員重設使用者密碼（2026-10-08）。
    /// 與 `UserCreated`／`UserDeleted` 一樣，這一筆的 `TeamId` 是 null ⇒
    /// `GET /api/audit-logs?teamId=` 查不到它（**系統活動頁**看得到），
    /// 但前端標籤表仍必須有這一條（閘門比的是集合相等）。</summary>
    public const string UserPasswordReset = "user.password_reset";

    public const string BoardCreated = "board.created";
    public const string BoardUpdated = "board.updated";
    public const string BoardDeleted = "board.deleted";

    public const string CardCreated = "card.created";
    public const string CardDeleted = "card.deleted";

    public const string ProjectCreated = "project.created";
    public const string ProjectUpdated = "project.updated";
    public const string ProjectDeleted = "project.deleted";
    public const string ProjectMemberAdded = "project.member.added";
    public const string ProjectMemberUpdated = "project.member.updated";
    public const string ProjectMemberRemoved = "project.member.removed";

    public const string CustomFieldCreated = "custom_field.created";
    public const string CustomFieldUpdated = "custom_field.updated";
    public const string CustomFieldDeleted = "custom_field.deleted";

    public const string RoleCreated = "role.created";
    public const string RoleUpdated = "role.updated";
    public const string RoleDeleted = "role.deleted";

    public const string WorkCalendarUpdated = "work_calendar.updated";
    public const string WorkCalendarDeleted = "work_calendar.deleted";
}
