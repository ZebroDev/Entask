namespace Entask.Api.Dtos;

/// <summary>
/// 稽核列的 API 形狀（**兩個端點共用**：團隊範圍 `GET /api/audit-logs` 與系統範圍
/// `GET /api/audit-logs/system`）。
///
/// `UserDisplayName` 由 `AuditLogEndpoints.QueryAsync` 以「先取列、再一次查名」的模式補上
/// ——Core 不引用 Identity 那條不變量管的是 Core／Board／Performance；Api 層本來就用
/// `UserManager`（`AdminUserEndpoints` 同型）。查不到（`UserId` 為 null 或列不存在）
/// ⇒ null，前端走 fallback 文案。
///
/// ★ 顯示的是使用者**現在的** `DisplayName`，不是事件當下的快照——快照要改 schema。
/// 這與 `state/37` 的「角色名快照」是**相反**的取捨：actor 問的是「誰」，不是「什麼身分」。
/// </summary>
public record AuditLogDto(
    Guid Id,
    Guid? UserId,
    string Action,
    string EntityType,
    Guid EntityId,
    string? EntityTitle,
    string? Detail,
    DateTime CreatedAt,
    string? UserDisplayName);

/// <summary>
/// 稽核列的分頁信封（**兩個端點共用**）。
///
/// `NextCursor` 非 null ⟺ 還有更多。實作是 `Take(頁面大小 + 1)` 探測後裁掉多的那一列
/// ——與 `ActivityEndpoints.cs:44-49` 同一個手法。
/// `NextCursor` 取自**這一頁回傳的最後一列**（不是被裁掉的那一列）⇒ 次頁嚴格更舊，
/// 不會重複也不會遺漏。
/// </summary>
public record AuditLogPage(List<AuditLogDto> Items, string? NextCursor);
