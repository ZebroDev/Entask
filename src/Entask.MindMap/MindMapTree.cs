namespace Entask.MindMap;

/// <summary>
/// 心智圖純函式 helper（無 DbContext）：reparent 環檢測沿祖先鏈上溯（含 parentId == nodeId 自環）。
/// 輸入為整張圖的 (節點 → 父節點) 對照表；未知 parent（不在對照表內）回 false——
/// 由呼叫端的存在性檢查（404 fail-closed）負責。已訪防呆直接回 false（正常樹資料不會成環）。
/// </summary>
public static class MindMapTree
{
    public static bool IsCyclicAfterReparent(Guid nodeId, Guid? newParentId, IReadOnlyDictionary<Guid, Guid?> parentById)
    {
        var cursor = newParentId;
        var visited = new HashSet<Guid>();
        while (cursor is not null)
        {
            if (cursor == nodeId) return true;
            if (!visited.Add(cursor.Value)) return false;
            if (!parentById.TryGetValue(cursor.Value, out cursor)) return false;
        }
        return false;
    }
}
