namespace Entask.Core.Abstractions;

public interface IAuditService
{
    Task AddAsync(Guid? userId, Guid? teamId, string action, string entityType,
        Guid entityId, string? entityTitle, object? detail = null, Guid? projectId = null, bool save = true);
}
