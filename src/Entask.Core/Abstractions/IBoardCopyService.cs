namespace Entask.Core.Abstractions;

public interface IBoardCopyService
{
    // `copyNameFormat` 是複製產生的名稱樣板（`{{name}}` 是原標題），由 api 層依**操作者語系**
    // 解析後帶入（見 `ExportKeys.CopyName`）——本專案不引用 Entask.Api，所以跨過來的是字串、
    // 不是語系。呼叫端有給 name 時仍然優先，樣板只在沒給時用。
    Task<Guid> CopyCardAsync(Guid cardId, Guid? targetListId, Guid actorUserId, string copyNameFormat);
    Task<Guid> CopyListAsync(Guid listId, Guid? targetBoardId, Guid actorUserId, string copyNameFormat,
        IReadOnlyDictionary<Guid, Guid>? labelIdMap = null, IReadOnlyDictionary<Guid, Guid>? fieldIdMap = null);
    Task<Guid> CopyBoardAsync(Guid boardId, Guid? targetProjectId, string? name, Guid actorUserId,
        string copyNameFormat, IReadOnlyDictionary<Guid, Guid>? projectFieldIdMap = null);
    // `actorTz` 是**發起人**的時區：複製出的成員列要用它凍結 `JoinedLocalDate`（Q1／R6）。
    // 由 api 層解析後帶入（本專案不引用 Entask.Api，所以跨過來的是 `TimeZoneInfo` 本身）；
    // 認不得的 ID 在 api 層就 400，不會走到這裡。
    Task<Guid> CopyProjectAsync(Guid projectId, Guid targetTeamId, string? name, Guid actorUserId,
        string copyNameFormat, TimeZoneInfo actorTz);
}
