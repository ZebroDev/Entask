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

namespace Entask.Api.Endpoints;

public static class CardEndpoints
{
    public static IEndpointRouteBuilder MapCards(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/lists/{listId:guid}/cards", async (Guid listId, CreateCardRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IAuditService audit, IHubContext<CollaborationHub> hub) =>
        {
            if (string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "卡片標題不可為空" });
            var list = await db.Lists.FirstOrDefaultAsync(l => l.Id == listId);
            if (list is null) return ApiResults.NotFound(ErrorCodes.ListNotFound);

            var userId = BoardEndpoints.CurrentUserId(principal);
            var last = await db.Cards.Where(c => c.ListId == listId).OrderBy(c => c.Position).ThenBy(c => c.Id)
                .Select(c => c.Position).LastOrDefaultAsync();
            var card = new Card
            {
                ListId = listId, Title = req.Title.Trim(), Description = req.Description,
                Position = FractionalPosition.After(last), CreatedById = userId,
            };
            db.Cards.Add(card);
            await db.SaveChangesAsync();
            await activity.AddAsync(card.Id, userId, ActivityTypes.Create);

            var projectId = await db.Lists.Where(l => l.Id == listId)
                .Select(l => (Guid?)l.Board.ProjectId).FirstAsync();
            var teamId = await db.Projects.Where(p => p.Id == projectId).Select(p => (Guid?)p.TeamId).FirstAsync();
            await audit.AddAsync(userId, teamId, AuditActions.CardCreated, "Card", card.Id, card.Title, null, projectId);

            if (projectId.HasValue)
            {
                await hub.Clients.Group($"board:{list.BoardId}").SendAsync("CardCreated", new { cardId = card.Id, listId, boardId = list.BoardId, projectId = projectId.Value });
                await hub.Clients.Group($"project:{projectId.Value}").SendAsync("CardCreated", new { cardId = card.Id, listId, boardId = list.BoardId, projectId = projectId.Value });
            }

            return Results.Ok(await GetCardResponseAsync(db, card.Id));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardCreate);

        app.MapGet("/api/cards/{cardId:guid}", async (Guid cardId, EntaskDbContext db) =>
        {
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            return Results.Ok(await GetCardResponseAsync(db, cardId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        app.MapPut("/api/cards/{cardId:guid}", async (Guid cardId, JsonElement body, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            var userId = BoardEndpoints.CurrentUserId(principal);

            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                if (body.TryGetProperty("title", out var titleEl))
                {
                    if (titleEl.ValueKind != JsonValueKind.String)
                        return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "title 須為字串" });
                    var title = titleEl.GetString();
                    if (string.IsNullOrWhiteSpace(title))
                        return Results.BadRequest(new { code = ErrorCodes.CardTitleRequired, message = "卡片標題不可為空" });
                    if (title.Trim() != card.Title)
                    {
                        card.Title = title.Trim();
                        await activity.AddAsync(card.Id, userId, ActivityTypes.Rename);
                    }
                }
                if (body.TryGetProperty("description", out var descEl))
                {
                    if (descEl.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
                        return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "description 須為字串或 null" });
                    var desc = descEl.ValueKind == JsonValueKind.Null ? null : descEl.GetString();
                    if (desc != card.Description)
                    {
                        card.Description = desc;
                        await activity.AddAsync(card.Id, userId, ActivityTypes.DescriptionChange);
                    }
                }
                if (body.TryGetProperty("isArchived", out var archEl))
                {
                    if (archEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "isArchived 須為布林" });
                    var isArchived = archEl.GetBoolean();
                    if (isArchived != card.IsArchived)
                    {
                        card.IsArchived = isArchived;
                        await activity.AddAsync(card.Id, userId, card.IsArchived ? ActivityTypes.Archive : ActivityTypes.Restore);
                    }
                }
                if (body.TryGetProperty("dueAt", out var dueEl))
                {
                    DateTime? newDue;
                    if (dueEl.ValueKind == JsonValueKind.Null) newDue = null;
                    else if (dueEl.ValueKind == JsonValueKind.String && dueEl.TryGetDateTime(out var d)) newDue = d;
                    else return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "dueAt 須為 ISO 日期或 null" });
                    if (newDue != card.DueAt)
                    {
                        // detail 記「變更前／變更後」：on-time drill-down 靠它還原每一次挪動
                        // （讀取端在 `ReportDrilldownQueries.ParseDueChangeEntry`）。
                        // 屬性名刻意是小寫 `from`／`to`——匿名型別照寫，不要改成 PascalCase。
                        var previousDue = card.DueAt;
                        card.DueAt = newDue;
                        await activity.AddAsync(card.Id, userId, ActivityTypes.DueChange,
                            detail: new { @from = previousDue, to = newDue });
                    }
                }
                if (body.TryGetProperty("startAt", out var startEl))
                {
                    DateTime? newStart;
                    if (startEl.ValueKind == JsonValueKind.Null) newStart = null;
                    else if (startEl.ValueKind == JsonValueKind.String && startEl.TryGetDateTime(out var d)) newStart = d;
                    else return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "startAt 須為 ISO 日期或 null" });
                    if (newStart != card.StartAt)
                    {
                        card.StartAt = newStart;
                        await activity.AddAsync(card.Id, userId, ActivityTypes.StartChange);
                    }
                }
                if (card.StartAt is not null && card.DueAt is not null && card.StartAt > card.DueAt)
                    return Results.BadRequest(new { code = ErrorCodes.CardStartAfterDue, message = "開工日不可晚於截止日" });
                if (body.TryGetProperty("estimatedHours", out var estEl))
                {
                    decimal? newEst;
                    if (estEl.ValueKind == JsonValueKind.Null) newEst = null;
                    else if (estEl.ValueKind == JsonValueKind.Number && estEl.TryGetDecimal(out var e)) newEst = e;
                    else return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "estimatedHours 須為數字或 null" });
                    if (newEst <= 0)
                        return Results.BadRequest(new { code = ErrorCodes.CardEstimateNotPositive, message = "預估工時須大於 0" });
                    card.EstimatedHours = newEst;
                }
                if (body.TryGetProperty("coverAttachmentId", out var coverEl))
                {
                    Guid? newCover;
                    if (coverEl.ValueKind == JsonValueKind.Null) newCover = null;
                    else if (coverEl.ValueKind == JsonValueKind.String && coverEl.TryGetGuid(out var g)) newCover = g;
                    else return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "coverAttachmentId 須為 GUID 或 null" });
                    if (newCover is not null && newCover != card.CoverAttachmentId)
                    {
                        var valid = await db.Attachments.AnyAsync(a =>
                            a.Id == newCover && a.CardId == cardId && a.ContentType.StartsWith("image/"));
                        if (!valid) return Results.BadRequest(new { code = ErrorCodes.CardCoverInvalid, message = "封面必須是該卡片的圖片附件" });
                        card.CoverAttachmentId = newCover;
                        await activity.AddAsync(card.Id, userId, ActivityTypes.CoverChange, detail: new { attachmentId = newCover });
                    }
                    else if (newCover is null && card.CoverAttachmentId is not null)
                    {
                        card.CoverAttachmentId = null;
                        await activity.AddAsync(card.Id, userId, ActivityTypes.CoverChange);
                    }
                }
                card.UpdatedAt = DateTime.UtcNow;
                await db.SaveChangesAsync();
                await tx.CommitAsync();

                var cardInfo = await db.Cards.Where(c => c.Id == cardId)
                    .Select(c => new { c.List.BoardId, c.List.Board.ProjectId }).FirstOrDefaultAsync();
                if (cardInfo != null)
                {
                    await hub.Clients.Group($"board:{cardInfo.BoardId}").SendAsync("CardUpdated", new { cardId, boardId = cardInfo.BoardId, projectId = cardInfo.ProjectId, action = "update" });
                    await hub.Clients.Group($"project:{cardInfo.ProjectId}").SendAsync("CardUpdated", new { cardId, boardId = cardInfo.BoardId, projectId = cardInfo.ProjectId, action = "update" });
                }

                return Results.Ok(await GetCardResponseAsync(db, cardId));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapPut("/api/cards/{cardId:guid}/members", async (Guid cardId, UpdateCardMembersRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.UserIds is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            if (req.UserIds is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "使用者清單不可為 null" });

            var userIds = req.UserIds.Distinct().ToList();
            var existingCount = await db.Users.CountAsync(u => userIds.Contains(u.Id));
            if (existingCount != userIds.Count)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含不存在的使用者" });

            // 不變量（2026-09-19 裁定）：卡片的指派者必須是該卡片所屬專案的成員。
            // 為什麼驗整份清單、不是只驗新增的：這個 PUT 是**全量取代**，而前端下拉列的是
            // 專案名冊——只驗新增者的話，被移出專案的人會留在卡片上、下拉列不出他、
            // 使用者取消不掉他，而任何一次儲存（原樣送回）都會被擋下 ⇒ 那張卡片從此改不動。
            // 形狀與同型的 ReviewEndpoints 一致（N1）：可為 null 的投影 ＋ 顯式檢查，
            // 而不是 `FirstAsync`——兩次查詢之間卡片若被併發刪除，前者回 404、後者拋 NRE→500。
            var projectId = await db.Cards.Where(c => c.Id == cardId)
                .Select(c => (Guid?)c.List.Board.ProjectId).FirstOrDefaultAsync();
            if (projectId is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            var memberIds = await db.ProjectMembers
                .Where(m => m.ProjectId == projectId.Value && userIds.Contains(m.UserId))
                .Select(m => m.UserId).Distinct().CountAsync();
            if (memberIds != userIds.Count)
                return Results.BadRequest(new { code = ErrorCodes.CardMemberNotProjectMember, message = "只能指派本專案的成員" });

            // 並發 PUT 為 full-replace idempotent（last-write-wins）：衝突時以最新資料重試
            // （下一輪重讀 current 即 reload＋reapply，bounded 2 次），重試耗盡回 409
            var actor = BoardEndpoints.CurrentUserId(principal);
            var attempt = 0;
            while (true)
            {
                attempt++;
                await using var tx = await db.Database.BeginTransactionAsync();
                try
                {
                    var current = await db.CardMembers.Where(m => m.CardId == cardId).Select(m => m.UserId).ToListAsync();
                    var added = userIds.Where(u => !current.Contains(u)).ToList();
                    var removed = current.Where(u => !userIds.Contains(u)).ToList();

                    // 只驗**新增的差集**（設計 D8）。驗全部的話，任何一次卡片編輯都會把
                    // 已停用的成員踢掉——而那正是名冊刻意保留他們的原因的反面（D7）。
                    if (added.Count > 0)
                    {
                        var blocked = await db.Users
                            .Where(u => added.Contains(u.Id)
                                        && (u.DeactivatedAt != null || u.DeletedAt != null))
                            .Select(u => u.DisplayName)
                            .ToListAsync();
                        if (blocked.Count > 0)
                            return Results.BadRequest(new
                            {
                                code = ErrorCodes.RequestInvalid,
                                message = $"不可指派已停用的使用者：{string.Join("、", blocked)}",
                            });
                    }

                    db.CardMembers.RemoveRange(db.CardMembers.Where(m => m.CardId == cardId && removed.Contains(m.UserId)));
                    foreach (var uid in added)
                        db.CardMembers.Add(new CardMember { CardId = cardId, UserId = uid });

                    foreach (var uid in added)
                        await activity.AddAsync(cardId, actor, ActivityTypes.MemberAdded, detail: new { userId = uid });
                    foreach (var uid in removed)
                        await activity.AddAsync(cardId, actor, ActivityTypes.MemberRemoved, detail: new { userId = uid });

                    await db.SaveChangesAsync();
                    await tx.CommitAsync();

                    var cardInfo = await db.Cards.Where(c => c.Id == cardId)
                        .Select(c => new { c.List.BoardId, c.List.Board.ProjectId, c.Title }).FirstOrDefaultAsync();
                    if (cardInfo != null)
                    {
                        await hub.Clients.Group($"board:{cardInfo.BoardId}").SendAsync("CardUpdated", new { cardId, boardId = cardInfo.BoardId, projectId = cardInfo.ProjectId, action = "members" });
                        await hub.Clients.Group($"project:{cardInfo.ProjectId}").SendAsync("CardUpdated", new { cardId, boardId = cardInfo.BoardId, projectId = cardInfo.ProjectId, action = "members" });

                        var addedUids = added.Where(u => u != actor).ToList();
                        if (addedUids.Any())
                        {
                            var prefs = await db.NotificationPreferences
                                .Where(p => addedUids.Contains(p.UserId) && p.Type == NotificationTypes.Assigned)
                                .ToListAsync();

                            foreach (var uid in addedUids)
                            {
                                var pref = prefs.FirstOrDefault(p => p.UserId == uid);
                                if (pref == null || pref.InAppEnabled)
                                {
                                    var notif = NotificationPayloads.Create(
                                        uid,
                                        NotificationTypes.Assigned,
                                        NotificationKinds.CardAssigned,
                                        new { card = cardInfo.Title },
                                        $"/projects/{cardInfo.ProjectId}/boards/{cardInfo.BoardId}?cardId={cardId}");
                                    db.Notifications.Add(notif);
                                    await db.SaveChangesAsync();

                                    await hub.Clients.User(uid.ToString())
                                        .SendAsync("NotificationReceived", NotificationPayloads.Push(notif));
                                }
                            }
                        }
                    }

                    return Results.Ok(await GetCardResponseAsync(db, cardId));
                }
                catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || (ex.InnerException is Npgsql.PostgresException pgEx && pgEx.SqlState == "23505"))
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    if (attempt >= 3) return Results.Conflict(new { code = ErrorCodes.ConcurrencyConflict, message = "並發更新衝突，請重試" });
                    db.ChangeTracker.Clear();
                }
                catch
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    throw;
                }
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardAssign);

        app.MapPut("/api/cards/{cardId:guid}/labels", async (Guid cardId, UpdateCardLabelsRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.LabelIds is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            if (req.LabelIds is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "標籤清單不可為 null" });

            var boardId = await db.Lists.Where(l => l.Id == card.ListId).Select(l => l.BoardId).FirstAsync();
            var labelIds = req.LabelIds.Distinct().ToList();
            var validCount = await db.Labels.CountAsync(l => labelIds.Contains(l.Id) && l.BoardId == boardId);
            if (validCount != labelIds.Count)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含不屬於本看板的標籤" });

            // 並發 PUT 為 full-replace idempotent（last-write-wins）：衝突時以最新資料重試
            // （下一輪重讀 current 即 reload＋reapply，bounded 2 次），重試耗盡回 409
            var actor = BoardEndpoints.CurrentUserId(principal);
            var attempt = 0;
            while (true)
            {
                attempt++;
                await using var tx = await db.Database.BeginTransactionAsync();
                try
                {
                    var current = await db.CardLabels.Where(m => m.CardId == cardId).Select(m => m.LabelId).ToListAsync();
                    var added = labelIds.Where(l => !current.Contains(l)).ToList();
                    var removed = current.Where(l => !labelIds.Contains(l)).ToList();
                    db.CardLabels.RemoveRange(db.CardLabels.Where(m => m.CardId == cardId && removed.Contains(m.LabelId)));
                    foreach (var lid in added)
                        db.CardLabels.Add(new CardLabel { CardId = cardId, LabelId = lid });

                    foreach (var lid in added)
                        await activity.AddAsync(cardId, actor, ActivityTypes.LabelAdded, detail: new { labelId = lid });
                    foreach (var lid in removed)
                        await activity.AddAsync(cardId, actor, ActivityTypes.LabelRemoved, detail: new { labelId = lid });

                    await db.SaveChangesAsync();
                    await tx.CommitAsync();
                    return Results.Ok(await GetCardResponseAsync(db, cardId));
                }
                catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || (ex.InnerException is Npgsql.PostgresException pgEx && pgEx.SqlState == "23505"))
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    if (attempt >= 3) return Results.Conflict(new { code = ErrorCodes.ConcurrencyConflict, message = "並發更新衝突，請重試" });
                    db.ChangeTracker.Clear();
                }
                catch
                {
                    await TransactionGuard.RollbackIfActiveAsync(db);
                    throw;
                }
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapPut("/api/cards/{cardId:guid}/position", async (Guid cardId, MoveCardRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            if (!PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            // 目標列表必須與卡片同看板
            var sameBoard = await db.Lists.AnyAsync(l => l.Id == req.ListId &&
                l.BoardId == db.Lists.Where(x => x.Id == card.ListId).Select(x => x.BoardId).First());
            if (!sameBoard)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "目標列表不在同一看板" });

            var fromListId = card.ListId;
            if (req.ListId != card.ListId || req.Position != card.Position)
            {
                card.ListId = req.ListId;
                card.Position = req.Position;
                card.UpdatedAt = DateTime.UtcNow;
                await activity.AddAsync(card.Id, BoardEndpoints.CurrentUserId(principal), ActivityTypes.Move,
                    detail: new { fromListId, toListId = req.ListId });
            }
            await db.SaveChangesAsync();

            var cardInfo = await db.Cards.Where(c => c.Id == cardId)
                .Select(c => new { c.List.BoardId, c.List.Board.ProjectId }).FirstOrDefaultAsync();
            if (cardInfo != null)
            {
                await hub.Clients.Group($"board:{cardInfo.BoardId}").SendAsync("CardMoved", new { cardId, listId = req.ListId, position = req.Position, sourceListId = fromListId, boardId = cardInfo.BoardId, projectId = cardInfo.ProjectId });
                await hub.Clients.Group($"project:{cardInfo.ProjectId}").SendAsync("CardMoved", new { cardId, listId = req.ListId, position = req.Position, sourceListId = fromListId, boardId = cardInfo.BoardId, projectId = cardInfo.ProjectId });
            }

            return Results.Ok(await GetCardResponseAsync(db, cardId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapPut("/api/cards/{cardId:guid}/completion", async (Guid cardId, [Microsoft.AspNetCore.Mvc.FromBody] JsonElement body, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IAuditService audit, IHubContext<CollaborationHub> hub) =>
        {
            var card = await db.Cards.Include(c => c.List.Board).FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            if (!body.TryGetProperty("isCompleted", out var p) || (p.ValueKind != JsonValueKind.True && p.ValueKind != JsonValueKind.False))
            {
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "isCompleted 欄位必須為布林值" });
            }
            bool isCompleted = p.GetBoolean();
            if (isCompleted && !card.CompletedAt.HasValue)
            {
                card.CompletedAt = DateTime.UtcNow;
                var actor = BoardEndpoints.CurrentUserId(principal);
                // 有指派審查者 → 這是一次「交付待審查」：把所有人的立場重設為 pending
                // （歷史 entry 全部保留），活動記 delivery_submitted 而不是 complete。
                // 沒有審查者的卡片（使用者的行政工作場景）走原本的路徑，不查也不寫任何審查資料。
                var hasReviewers = await db.CardReviews.AnyAsync(r => r.CardId == cardId);
                if (hasReviewers)
                {
                    foreach (var r in await db.CardReviews.Where(r => r.CardId == cardId).ToListAsync())
                    {
                        r.Status = ReviewStatuses.Pending;
                        r.Score = null;
                        r.Comment = null;
                        r.UpdatedAt = DateTime.UtcNow;
                    }
                    await activity.AddAsync(cardId, actor, ActivityTypes.DeliverySubmitted);
                }
                else
                {
                    await activity.AddAsync(cardId, actor, ActivityTypes.Complete);
                }
            }
            else if (!isCompleted && card.CompletedAt.HasValue)
            {
                card.CompletedAt = null;
                await activity.AddAsync(cardId, BoardEndpoints.CurrentUserId(principal), ActivityTypes.Uncomplete);
            }
            card.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();

            await hub.Clients.Group($"board:{card.List.BoardId}").SendAsync("CardUpdated", new { cardId, boardId = card.List.BoardId, projectId = card.List.Board.ProjectId, action = "completion", completedAt = card.CompletedAt });
            await hub.Clients.Group($"project:{card.List.Board.ProjectId}").SendAsync("CardUpdated", new { cardId, boardId = card.List.BoardId, projectId = card.List.Board.ProjectId, action = "completion", completedAt = card.CompletedAt });

            return Results.Ok(await GetCardResponseAsync(db, cardId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapDelete("/api/cards/{cardId:guid}", async (Guid cardId, ClaimsPrincipal principal,
            EntaskDbContext db, IAuditService audit, IAttachmentStore store, IHubContext<CollaborationHub> hub) =>
        {
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            var boardId = await db.Cards.Where(c => c.Id == cardId)
                .Select(c => (Guid?)c.List.BoardId).FirstOrDefaultAsync();
            var projectId = await db.Cards.Where(c => c.Id == cardId)
                .Select(c => (Guid?)c.List.Board.ProjectId).FirstAsync();
            var teamId = await db.Projects.Where(p => p.Id == projectId).Select(p => (Guid?)p.TeamId).FirstAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.CardDeleted, "Card", card.Id, card.Title, null, projectId);

            var storagePaths = await db.Attachments.Where(a => a.CardId == cardId).Select(a => a.StoragePath).ToListAsync();
            db.Cards.Remove(card);
            await db.SaveChangesAsync();
            foreach (var path in storagePaths)
            {
                try { store.Delete(path); } catch { /* ignore missing/locked files */ }
            }

            if (boardId.HasValue)
            {
                await hub.Clients.Group($"board:{boardId.Value}").SendAsync("CardDeleted", new { cardId, boardId = boardId.Value, projectId });
            }
            if (projectId.HasValue)
            {
                await hub.Clients.Group($"project:{projectId.Value}").SendAsync("CardDeleted", new { cardId, boardId, projectId = projectId.Value });
            }

            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardDelete);

        return app;
    }

    internal static async Task<CardResponse> GetCardResponseAsync(EntaskDbContext db, Guid cardId)
    {
        var c = await db.Cards.Where(c => c.Id == cardId)
            .AsSplitQuery() // P7: Join 效能優化
            .Select(c => new
            {
                c.Id, c.ListId, BoardId = c.List.BoardId, c.Title, c.Description, c.Position, c.IsArchived,
                c.StartAt, c.DueAt, c.CompletedAt, c.EstimatedHours, c.CoverAttachmentId, c.CreatedById, c.CreatedAt, c.UpdatedAt,
                Members = c.Members.Select(m => m.UserId).ToList(),
                Labels = c.Labels.Select(cl => new LabelResponse(cl.LabelId, cl.Label.Name, cl.Label.Color, cl.Label.Position)).ToList(),
                Checklists = c.Checklists.OrderBy(ch => ch.Position).ThenBy(ch => ch.Id)
                    .Select(ch => new ChecklistResponse(ch.Id, ch.Title, ch.Position,
                        ch.Items.OrderBy(i => i.Position).ThenBy(i => i.Id)
                            .Select(i => new ChecklistItemResponse(i.Id, i.Text, i.IsChecked, i.Position)).ToList()))
                    .ToList(),
                Attachments = c.Attachments.OrderBy(a => a.CreatedAt)
                    .Select(a => new AttachmentResponse(a.Id, a.FileName, a.ContentType, a.Size, a.CreatedAt)).ToList(),
            })
            .FirstAsync();
            
        var fieldValues = await db.CardFieldValues.Where(v => v.CardId == cardId)
            .Select(v => new { v.FieldDefinitionId, v.ValueJson }).ToListAsync();
        var customFields = fieldValues
            .Select(v => new CardFieldValueResponse(v.FieldDefinitionId,
                JsonDocument.Parse(v.ValueJson).RootElement.Clone())).ToList();
        var reviews = await ReviewEndpoints.GetReviewRowsAsync(db, cardId);
        var effort = await EffortEndpoints.GetEffortRowsAsync(db, cardId);
        var mindMapNodes = await db.MindMapNodes.Where(n => n.CardId == cardId).OrderBy(n => n.Position).ThenBy(n => n.Id)
            .Select(n => new MindMapNodeResponse(n.Id, n.ParentId, n.Title, n.Note, n.Position, n.PositionX, n.PositionY, n.CardId, null))
            .ToListAsync();
        
        var reviewerIds = reviews.Select(r => r.ReviewerUserId).ToList();
        var effortUserIds = effort.Select(e => e.UserId).ToList();
        var users = await ActivityEndpoints.GetUsersAsync(db, reviewerIds.Concat(effortUserIds));

        // 審查狀態的 rollup 與 CompletedAt 無關（設計 §4.2）；單卡走同一支批次查詢，
        // 不在這裡另寫一份判斷——`Rollup` 是唯一的計算點。
        var reviewState = (await ReviewEndpoints.RollupForCardsAsync(db, [cardId])).GetValueOrDefault(cardId);

        return new CardResponse(c.Id, c.ListId, c.BoardId, c.Title, c.Description, c.Position, c.IsArchived,
            c.StartAt, c.DueAt, c.CompletedAt, c.EstimatedHours, c.CoverAttachmentId, c.CreatedById, c.CreatedAt, c.UpdatedAt,
            c.Members, c.Labels, c.Checklists, c.Attachments, customFields,
            ReviewEndpoints.ComposeReviews(reviews, users),
            reviewState,
            EffortEndpoints.ComposeEffort(effort, users),
            mindMapNodes);
    }
}
