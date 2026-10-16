using System.Text.Json;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Infrastructure.Audit;

public class AuditService : IAuditService
{
    private readonly EntaskDbContext _db;

    public AuditService(EntaskDbContext db) => _db = db;

    public async Task AddAsync(Guid? userId, Guid? teamId, string action, string entityType,
        Guid entityId, string? entityTitle, object? detail = null, Guid? projectId = null, bool save = true)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            TeamId = teamId,
            ProjectId = projectId,
            Action = action,
            EntityType = entityType,
            EntityId = entityId,
            EntityTitle = entityTitle,
            Detail = detail is null ? null : JsonSerializer.Serialize(detail),
            CreatedAt = DateTime.UtcNow,
        });
        if (save) await _db.SaveChangesAsync();
    }
}
