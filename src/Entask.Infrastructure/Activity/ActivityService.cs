using System.Text.Json;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Infrastructure.Activity;

public class ActivityService : IActivityService
{
    private readonly EntaskDbContext _db;

    public ActivityService(EntaskDbContext db) => _db = db;

    public async Task AddAsync(Guid cardId, Guid userId, string type, string? text = null, object? detail = null, bool save = true)
    {
        _db.ActivityItems.Add(new ActivityItem
        {
            CardId = cardId,
            UserId = userId,
            Type = type,
            Text = text,
            Detail = detail is null ? null : JsonSerializer.Serialize(detail),
        });
        if (save) await _db.SaveChangesAsync();
    }
}
