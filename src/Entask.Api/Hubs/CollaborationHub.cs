using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Entask.Core.Abstractions;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Api.Hubs;

public record UserPresenceInfo(string UserId, string DisplayName, string? UserName);

[Authorize]
public class CollaborationHub : Hub
{
    private readonly EntaskDbContext _db;
    private readonly IPermissionChecker _checker;
    private readonly CollaborationConnectionRegistry _connections;

    public CollaborationHub(EntaskDbContext db, IPermissionChecker checker,
        CollaborationConnectionRegistry connections)
    {
        _db = db;
        _checker = checker;
        _connections = connections;
    }

    // boardId -> (connectionId -> UserPresenceInfo)
    private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, UserPresenceInfo>> _boardPresences = new();

    public async Task JoinBoard(string boardId)
    {
        // 群組加入須驗證權限——任意登入者不可訂閱任意看板的即時事件與 presence 名單
        if (!await CanAccessBoardAsync(boardId))
        {
            throw new HubException("無權限存取此看板");
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, $"board:{boardId}");
        var user = GetUserInfo();
        if (user != null)
        {
            var dict = _boardPresences.GetOrAdd(boardId, _ => new ConcurrentDictionary<string, UserPresenceInfo>());
            dict[Context.ConnectionId] = user;
            await BroadcastBoardPresence(boardId);
        }
    }

    public async Task LeaveBoard(string boardId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"board:{boardId}");
        if (_boardPresences.TryGetValue(boardId, out var dict))
        {
            dict.TryRemove(Context.ConnectionId, out _);
            await BroadcastBoardPresence(boardId);
        }
    }

    public async Task JoinProject(string projectId)
    {
        // 群組加入須驗證權限——任意登入者不可訂閱任意專案的即時事件
        if (!await CanAccessProjectAsync(projectId))
        {
            throw new HubException("無權限存取此專案");
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, $"project:{projectId}");
    }

    public async Task LeaveProject(string projectId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"project:{projectId}");
    }

    public override async Task OnConnectedAsync()
    {
        if (Guid.TryParse(GetUserId(), out var userId))
        {
            // M-3：撤權請求可能在 handshake 註冊進 registry **之前**就完成快照，這條連線
            // 會逃過中止。建立時再驗一次帳號狀態；停用／刪除者不建立連線。
            if (!await IsActiveUserAsync(userId))
            {
                Context.Abort();
                return;
            }
            // F-03：撤權／停用時由 CollaborationConnectionRegistry 中止這條連線。
            _connections.Register(Context.ConnectionId, userId, Context);
        }
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _connections.Unregister(Context.ConnectionId);
        foreach (var (boardId, dict) in _boardPresences)
        {
            if (dict.TryRemove(Context.ConnectionId, out _))
            {
                await BroadcastBoardPresence(boardId);
            }
        }
        await base.OnDisconnectedAsync(exception);
    }

    private async Task<bool> CanAccessBoardAsync(string boardId)
    {
        if (!Guid.TryParse(GetUserId(), out var userId) || !Guid.TryParse(boardId, out var boardGuid)) return false;
        if (!await IsActiveUserAsync(userId)) return false;
        var board = await _db.Boards.FindAsync(boardGuid);
        if (board is null) return false;
        return await _checker.HasProjectPermissionAsync(userId, board.ProjectId, PermissionCodes.BoardRead);
    }

    private async Task<bool> CanAccessProjectAsync(string projectId)
    {
        if (!Guid.TryParse(GetUserId(), out var userId) || !Guid.TryParse(projectId, out var projectGuid)) return false;
        if (!await IsActiveUserAsync(userId)) return false;
        return await _checker.HasProjectPermissionAsync(userId, projectGuid, PermissionCodes.ProjectRead);
    }

    // 既有連線不經過 HTTP 管線的帳號狀態守衛（F-02）；Join 時補驗一次，避免停用者
    // 在連線被中止前搶先加入群組。撤權本身則由權限檢查（含快取世代號）負責。
    private Task<bool> IsActiveUserAsync(Guid userId) =>
        _db.Users.AnyAsync(u => u.Id == userId && u.DeactivatedAt == null && u.DeletedAt == null);

    private async Task BroadcastBoardPresence(string boardId)
    {
        if (_boardPresences.TryGetValue(boardId, out var dict))
        {
            var users = dict.Values.GroupBy(u => u.UserId).Select(g => g.First()).ToList();
            await Clients.Group($"board:{boardId}").SendAsync("BoardPresenceChanged", new { boardId, users });
        }
    }

    private string? GetUserId()
    {
        return Context.User?.FindFirst("sub")?.Value
            ?? Context.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }

    private UserPresenceInfo? GetUserInfo()
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId)) return null;
        var displayName = Context.User?.FindFirst("displayName")?.Value ?? Context.User?.Identity?.Name ?? "User";
        var userName = Context.User?.FindFirst("unique_name")?.Value ?? Context.User?.Identity?.Name;
        return new UserPresenceInfo(userId, displayName, userName);
    }
}
