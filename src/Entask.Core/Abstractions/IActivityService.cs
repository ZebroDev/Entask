namespace Entask.Core.Abstractions;

public interface IActivityService
{
    Task AddAsync(Guid cardId, Guid userId, string type, string? text = null, object? detail = null, bool save = true);
}
