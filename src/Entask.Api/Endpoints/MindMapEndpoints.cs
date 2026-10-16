using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Api.Hubs;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Entask.MindMap;
using MindMapEntity = Entask.Core.Entities.MindMap;   // Entask.MindMap namespace 遮蔽 MindMap 實體

namespace Entask.Api.Endpoints;

public static class MindMapEndpoints
{
    public static IEndpointRouteBuilder MapMindMaps(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/projects/{projectId:guid}/mindmap", async (Guid projectId, EntaskDbContext db) =>
        {
            return Results.Ok(await GetMindMapAsync(db, projectId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectRead);

        app.MapPost("/api/projects/{projectId:guid}/mindmap/nodes", async (Guid projectId, CreateMindMapNodeRequest req,
            ClaimsPrincipal principal, EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            if (string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(new { code = ErrorCodes.MindmapNodeTitleRequired, message = "節點標題不可為空" });
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
                if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

                // 每專案單一圖：無圖時於首個節點 lazily 建立（spec §2）
                var map = await db.MindMaps.FirstOrDefaultAsync(m => m.ProjectId == projectId);
                if (map is null)
                {
                    map = new MindMapEntity { ProjectId = projectId, CreatedById = BoardEndpoints.CurrentUserId(principal) };
                    db.MindMaps.Add(map);
                }
                if (req.ParentId is not null)
                {
                    var parentInProject = await db.MindMapNodes.AnyAsync(n =>
                        n.Id == req.ParentId && n.MindMap.ProjectId == projectId);
                    if (!parentInProject) return ApiResults.NotFound(ErrorCodes.MindmapNodeNotFound);   // fail-closed
                }
                if (req.CardId is not null)
                {
                    var cardInProject = await db.Cards.AnyAsync(c =>
                        c.Id == req.CardId && c.List.Board.ProjectId == projectId);
                    if (!cardInProject) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "卡片不屬於本專案" });
                }
                var last = await db.MindMapNodes
                    .Where(n => n.MindMapId == map.Id && n.ParentId == req.ParentId).OrderBy(n => n.Position).ThenBy(n => n.Id)
                    .Select(n => n.Position).LastOrDefaultAsync();
                var actor = BoardEndpoints.CurrentUserId(principal);
                var node = new MindMapNode
                {
                    MindMapId = map.Id,
                    ParentId = req.ParentId,
                    Title = req.Title.Trim(),
                    CardId = req.CardId,
                    Position = FractionalPosition.After(last),
                    CreatedById = actor,
                };
                db.MindMapNodes.Add(node);
                await db.SaveChangesAsync();
                if (req.CardId is not null)
                    await activity.AddAsync(req.CardId.Value, actor, ActivityTypes.MindMapBound, detail: new { nodeId = node.Id });
                await tx.CommitAsync();

                await hub.Clients.Group($"project:{projectId}").SendAsync("MindMapUpdated", new { projectId, action = "create", nodeId = node.Id });

                return Results.Ok(await GetMindMapAsync(db, projectId));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.MindMapEdit);

        app.MapPut("/api/projects/{projectId:guid}/mindmap/nodes/{nodeId:guid}", async (Guid projectId, Guid nodeId,
            UpdateMindMapNodeRequest req, ClaimsPrincipal principal, EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            if (req.Title is not null && string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(new { code = ErrorCodes.MindmapNodeTitleRequired, message = "節點標題不可為空" });
            Guid? cardId = null;
            var hasCardId = false;
            if (req.CardId.ValueKind != JsonValueKind.Undefined)
            {
                hasCardId = true;
                if (req.CardId.ValueKind == JsonValueKind.Null) cardId = null;
                else if (req.CardId.ValueKind == JsonValueKind.String && req.CardId.TryGetGuid(out var g)) cardId = g;
                else return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "cardId 須為 GUID 或 null" });
            }
            var node = await db.MindMapNodes.FirstOrDefaultAsync(n => n.Id == nodeId && n.MindMap.ProjectId == projectId);
            if (node is null) return ApiResults.NotFound(ErrorCodes.MindmapNodeNotFound);   // nodeId 跨專案 fail-closed
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                if (cardId is not null)
                {
                    var cardInProject = await db.Cards.AnyAsync(c =>
                        c.Id == cardId && c.List.Board.ProjectId == projectId);
                    if (!cardInProject) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "卡片不屬於本專案" });
                }
                var actor = BoardEndpoints.CurrentUserId(principal);
                var changed = false;
                if (req.Title is not null && req.Title.Trim() != node.Title)
                {
                    node.Title = req.Title.Trim();
                    changed = true;
                }
                if (req.Note is not null && req.Note != node.Note)
                {
                    node.Note = req.Note;   // 清空備註 = 送空字串（patch 語義，缺席不變）
                    changed = true;
                }
                if (hasCardId && cardId != node.CardId)
                {
                    var oldCardId = node.CardId;
                    node.CardId = cardId;
                    changed = true;
                    // 綁定/解綁對被綁卡片寫 activity（node CRUD 本身不寫 AuditLogs，spec §5）
                    if (cardId is not null)
                        await activity.AddAsync(cardId.Value, actor, ActivityTypes.MindMapBound, detail: new { nodeId });
                    else if (oldCardId is not null)
                        await activity.AddAsync(oldCardId.Value, actor, ActivityTypes.MindMapUnbound, detail: new { nodeId });
                }
                if (changed)
                {
                    node.UpdatedAt = DateTime.UtcNow;
                    await db.SaveChangesAsync();
                }
                await tx.CommitAsync();

                if (changed)
                {
                    await hub.Clients.Group($"project:{projectId}").SendAsync("MindMapUpdated", new { projectId, action = "update", nodeId });
                }

                return Results.Ok(await GetMindMapAsync(db, projectId));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.MindMapEdit);

        app.MapPut("/api/projects/{projectId:guid}/mindmap/nodes/{nodeId:guid}/position", async (Guid projectId,
            Guid nodeId, MoveMindMapNodeRequest req, EntaskDbContext db, IHubContext<CollaborationHub> hub) =>
        {
            if (!PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });   // 驗證先於存在性（P4 慣例）
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                var node = await db.MindMapNodes.FirstOrDefaultAsync(n => n.Id == nodeId && n.MindMap.ProjectId == projectId);
                if (node is null) return ApiResults.NotFound(ErrorCodes.MindmapNodeNotFound);
                if (req.ParentId is not null)
                {
                    // 同樹檢查：parent 須屬同一張圖（跨圖/跨專案 → 404 fail-closed）
                    var parentInMap = await db.MindMapNodes.AnyAsync(n => n.Id == req.ParentId && n.MindMapId == node.MindMapId);
                    if (!parentInMap) return ApiResults.NotFound(ErrorCodes.MindmapNodeNotFound);
                    var parents = await db.MindMapNodes.Where(n => n.MindMapId == node.MindMapId)
                        .Select(n => new { n.Id, n.ParentId })
                        .ToDictionaryAsync(n => n.Id, n => n.ParentId);
                    if (MindMapTree.IsCyclicAfterReparent(nodeId, req.ParentId, parents))
                        return Results.BadRequest(new { code = ErrorCodes.MindmapMoveIntoSelf, message = "不可將節點移至自身或其子節點之下" });
                }
                node.ParentId = req.ParentId;
                node.Position = req.Position;
                node.UpdatedAt = DateTime.UtcNow;
                await db.SaveChangesAsync();
                await tx.CommitAsync();

                await hub.Clients.Group($"project:{projectId}").SendAsync("MindMapUpdated", new { projectId, action = "position", nodeId });

                return Results.Ok(await GetMindMapAsync(db, projectId));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.MindMapEdit);

        app.MapDelete("/api/projects/{projectId:guid}/mindmap/nodes/{nodeId:guid}", async (Guid projectId, Guid nodeId,
            EntaskDbContext db, IHubContext<CollaborationHub> hub) =>
        {
            var node = await db.MindMapNodes.FirstOrDefaultAsync(n => n.Id == nodeId && n.MindMap.ProjectId == projectId);
            if (node is null) return ApiResults.NotFound(ErrorCodes.MindmapNodeNotFound);
            db.MindMapNodes.Remove(node);   // 子樹由 DB self-FK ON DELETE CASCADE 刪除
            await db.SaveChangesAsync();

            await hub.Clients.Group($"project:{projectId}").SendAsync("MindMapUpdated", new { projectId, action = "delete", nodeId });

            return Results.Ok(await GetMindMapAsync(db, projectId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.MindMapEdit);

        app.MapPut("/api/projects/{projectId:guid}/mindmap/nodes/coordinates", async (Guid projectId,
            BatchUpdateMindMapNodeCoordinatesRequest req, EntaskDbContext db, IHubContext<CollaborationHub> hub) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.Nodes is { Count: > RequestLimits.MaxMindMapCoordinates })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxMindMapCoordinates}",
                    @params = new { max = RequestLimits.MaxMindMapCoordinates }
                });

            if (req.Nodes == null || req.Nodes.Count == 0)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "節點坐標清單不可為空" });

            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                var nodeIds = req.Nodes.Select(n => n.Id).Distinct().ToList();
                var nodes = await db.MindMapNodes
                    .Where(n => nodeIds.Contains(n.Id) && n.MindMap.ProjectId == projectId)
                    .ToListAsync();

                if (nodes.Count != nodeIds.Count)
                    return ApiResults.NotFound(ErrorCodes.MindmapNodeNotFound);

                var coordMap = req.Nodes.ToDictionary(n => n.Id);
                var now = DateTime.UtcNow;
                foreach (var node in nodes)
                {
                    var coord = coordMap[node.Id];
                    node.PositionX = coord.X;
                    node.PositionY = coord.Y;
                    node.UpdatedAt = now;
                }

                await db.SaveChangesAsync();
                await tx.CommitAsync();

                await hub.Clients.Group($"project:{projectId}").SendAsync("MindMapUpdated", new
                {
                    projectId,
                    action = "coordinates",
                    nodes = req.Nodes.Select(n => new { id = n.Id, x = n.X, y = n.Y })
                });

                return Results.Ok();
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.MindMapEdit);

        app.MapGet("/api/cards/{cardId:guid}/mindmap-nodes", async (Guid cardId, EntaskDbContext db) =>
        {
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            var rows = await db.MindMapNodes.Where(n => n.CardId == cardId).OrderBy(n => n.Position).ThenBy(n => n.Id)
                .Select(n => new MindMapCardLinkResponse(n.Id, n.Title, n.MindMap.ProjectId, n.MindMapId))
                .ToListAsync();
            return Results.Ok(rows);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        return app;
    }

    // 心智圖全樹單一組裝點：flat list（依 Position 序）+ 綁定卡片摘要直接 join（無 Identity 名稱需求）
    internal static async Task<MindMapResponse> GetMindMapAsync(EntaskDbContext db, Guid projectId)
    {
        var map = await db.MindMaps.Where(m => m.ProjectId == projectId)
            .Select(m => new { m.Id, m.Name }).FirstOrDefaultAsync();
        if (map is null)
            return new MindMapResponse(Guid.Empty, projectId, null, []);   // 無圖 = 空樹（id 為 Guid.Empty 契約）
        var nodeRows = await db.MindMapNodes.Where(n => n.MindMapId == map.Id)
            .OrderBy(n => n.Position).ThenBy(n => n.Id)
            .Select(n => new { n.Id, n.ParentId, n.Title, n.Note, n.Position, n.PositionX, n.PositionY, n.CardId })
            .ToListAsync();
        var cardIds = nodeRows.Where(n => n.CardId is not null).Select(n => n.CardId!.Value).Distinct().ToList();
        var cards = await db.Cards.Where(c => cardIds.Contains(c.Id))
            .Select(c => new { c.Id, c.Title, c.IsArchived, c.CompletedAt }).ToDictionaryAsync(c => c.Id);
        // 與 BoardEndpoints／ProjectCardEndpoints 同一條路（設計 §4.4）：投影之外、
        // 一次批次查詢。沒有審查者的卡不進字典 ⇒ GetValueOrDefault 回 null。
        var rollups = await ReviewEndpoints.RollupForCardsAsync(db, cardIds);
        var nodes = nodeRows.Select(n => new MindMapNodeResponse(n.Id, n.ParentId, n.Title, n.Note, n.Position, n.PositionX, n.PositionY, n.CardId,
            n.CardId is not null && cards.TryGetValue(n.CardId.Value, out var c)
                ? new MindMapCardSummary(c.Id, c.Title, c.IsArchived, c.CompletedAt, rollups.GetValueOrDefault(c.Id)) : null)).ToList();
        return new MindMapResponse(map.Id, projectId, map.Name, nodes);
    }
}
