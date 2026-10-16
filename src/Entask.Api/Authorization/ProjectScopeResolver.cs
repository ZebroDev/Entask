using Microsoft.EntityFrameworkCore;
using Entask.Infrastructure.Data;

namespace Entask.Api.Authorization;

public interface IProjectScopeResolver
{
    Task<Guid?> ResolveProjectIdAsync(HttpContext context);
}

public class ProjectScopeResolver : IProjectScopeResolver
{
    private readonly EntaskDbContext _db;

    public ProjectScopeResolver(EntaskDbContext db) => _db = db;

    public async Task<Guid?> ResolveProjectIdAsync(HttpContext context)
    {
        var route = context.Request.RouteValues;
        var query = context.Request.Query;

        var projectId = TryGet(route, "projectId");
        var resolved = (Key: (string?)null, Source: (string?)null);
        if (projectId is null)
        {
            var child = await FromChild(route, query);
            projectId = child.ProjectId;
            resolved = (child.Key, child.Source);
        }
        if (projectId is null) return null;

        // 階層綁定：route 中出現的每一層 ID 必須與 projectId 的鏈一致
        // （FromChild 剛解析過的那層已驗證，跳過重查）
        if (route.TryGetValue("projectId", out var rp) && Guid.TryParse(rp?.ToString(), out var rpId) && rpId != projectId)
            return null;
        if (!(resolved.Key == "boardId" && resolved.Source == "route") && TryGet(route, "boardId") is Guid b &&
            await _db.Boards.Where(x => x.Id == b).Select(x => (Guid?)x.ProjectId).FirstOrDefaultAsync() != projectId)
            return null;
        if (!(resolved.Key == "listId" && resolved.Source == "route") && TryGet(route, "listId") is Guid l &&
            await _db.Lists.Where(x => x.Id == l)
                .Select(x => (Guid?)x.Board.ProjectId).FirstOrDefaultAsync() != projectId)
            return null;
        if (!(resolved.Key == "cardId" && resolved.Source == "route") && TryGet(route, "cardId") is Guid c &&
            await _db.Cards.Where(x => x.Id == c)
                .Select(x => (Guid?)x.List.Board.ProjectId).FirstOrDefaultAsync() != projectId)
            return null;

        // query 側同模式（resolved.Source == "query" 時跳過對應 key）
        if (query.TryGetValue("projectId", out var qp) && Guid.TryParse(qp, out var qpId) && qpId != projectId)
            return null;
        if (!(resolved.Key == "boardId" && resolved.Source == "query") && query.TryGetValue("boardId", out var qb) && Guid.TryParse(qb, out var qbId) &&
            await _db.Boards.Where(x => x.Id == qbId).Select(x => (Guid?)x.ProjectId).FirstOrDefaultAsync() != projectId)
            return null;
        if (!(resolved.Key == "listId" && resolved.Source == "query") && query.TryGetValue("listId", out var ql) && Guid.TryParse(ql, out var qlId) &&
            await _db.Lists.Where(x => x.Id == qlId).Select(x => (Guid?)x.Board.ProjectId).FirstOrDefaultAsync() != projectId)
            return null;
        if (!(resolved.Key == "cardId" && resolved.Source == "query") && query.TryGetValue("cardId", out var qc) && Guid.TryParse(qc, out var qcId) &&
            await _db.Cards.Where(x => x.Id == qcId).Select(x => (Guid?)x.List.Board.ProjectId).FirstOrDefaultAsync() != projectId)
            return null;

        return projectId;
    }

    private async Task<(string? Key, string? Source, Guid? ProjectId)> FromChild(RouteValueDictionary route, IQueryCollection query)
    {
        foreach (var key in new[] { "boardId", "listId", "cardId" })
        {
            if (TryGet(route, key) is Guid id)
                return (key, "route", await Resolve(id, key));
            if (query.TryGetValue(key, out var q) && Guid.TryParse(q, out var qId))
                return (key, "query", await Resolve(qId, key));
        }
        return (null, null, null);
    }

    private async Task<Guid?> Resolve(Guid id, string key) => key switch
    {
        "boardId" => await _db.Boards.Where(x => x.Id == id).Select(x => (Guid?)x.ProjectId).FirstOrDefaultAsync(),
        "listId" => await _db.Lists.Where(x => x.Id == id).Select(x => (Guid?)x.Board.ProjectId).FirstOrDefaultAsync(),
        "cardId" => await _db.Cards.Where(x => x.Id == id).Select(x => (Guid?)x.List.Board.ProjectId).FirstOrDefaultAsync(),
        _ => null,
    };

    private static Guid? TryGet(RouteValueDictionary route, string key) =>
        route.TryGetValue(key, out var v) && Guid.TryParse(v?.ToString(), out var id) ? id : null;
}
