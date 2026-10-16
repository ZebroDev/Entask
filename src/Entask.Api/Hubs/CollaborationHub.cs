using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
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

    public CollaborationHub(EntaskDbContext db, IPermissionChecker checker)
    {
        _db = db;
        _checker = checker;
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

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
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
        var board = await _db.Boards.FindAsync(boardGuid);
        if (board is null) return false;
        return await _checker.HasProjectPermissionAsync(userId, board.ProjectId, PermissionCodes.BoardRead);
    }

    private async Task<bool> CanAccessProjectAsync(string projectId)
    {
        if (!Guid.TryParse(GetUserId(), out var userId) || !Guid.TryParse(projectId, out var projectGuid)) return false;
        return await _checker.HasProjectPermissionAsync(userId, projectGuid, PermissionCodes.ProjectRead);
    }

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
