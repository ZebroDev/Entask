using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;

namespace Entask.Api.Hubs;

public class CustomUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection)
    {
        return connection.User?.FindFirst("sub")?.Value
            ?? connection.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }
}
