using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace Entask.Api.Hubs;

/// <summary>
/// 追蹤使用中的協作連線，讓撤權／停用可以立即中止既有連線（F-03，外部審查 2026-11-09）。
///
/// Hub 只在 JoinBoard／JoinProject 當下驗權，事件推送用的 `Clients.Group(...)` 也不會逐次
/// 重新驗權 ⇒ 已失去權限但仍保持連線的人會繼續收到卡片事件。中止連線是最乾淨的失效方式：
/// 前端使用 `withAutomaticReconnect`，重連後會重新 Join，屆時以最新權限重新驗證；
/// 停用者的重連則會被 HTTP 管線的帳號狀態守衛（F-02）擋下。
///
/// singleton：Hub 是 transient，連線狀態必須跨 Hub 實例共享。
/// 只保存 `HubCallerContext` 參照，`OnDisconnectedAsync` 必定移除，不累積。
/// </summary>
public sealed class CollaborationConnectionRegistry
{
    private readonly ConcurrentDictionary<string, UserConnection> _connections = new();

    public void Register(string connectionId, Guid userId, HubCallerContext context) =>
        _connections[connectionId] = new UserConnection(userId, context);

    public void Unregister(string connectionId) => _connections.TryRemove(connectionId, out _);

    /// <summary>中止某使用者的所有協作連線（可從任何請求執行緒呼叫）。</summary>
    public void AbortUserConnections(Guid userId)
    {
        foreach (var connection in _connections.Values)
        {
            if (connection.UserId != userId) continue;
            try
            {
                connection.Context.Abort();
            }
            catch
            {
                // 單一連線的 Abort 失敗（連線已收斂／傳輸層例外）不得讓其餘連線漏掉撤銷，
                // 也不得把已完成的 DB 變更回報成 500（M-3）。
            }
        }
    }

    private sealed record UserConnection(Guid UserId, HubCallerContext Context);
}
