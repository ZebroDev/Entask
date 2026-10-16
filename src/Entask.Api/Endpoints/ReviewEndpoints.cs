using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Api.Hubs;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Identity.Models;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class ReviewEndpoints
{
    public static IEndpointRouteBuilder MapReviews(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/cards/{cardId:guid}/reviews", async (Guid cardId, EntaskDbContext db) =>
        {
            return Results.Ok(await GetReviewsAsync(db, cardId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        // 設計 §6.3：歷史 entry 是 append-only，這一條唯讀。刻意不改 GET .../reviews——
        // 那個形狀被 CardResponse.Reviews 綁住（單一組裝點），改它是破壞性變更。
        app.MapGet("/api/cards/{cardId:guid}/review-history", async (Guid cardId, EntaskDbContext db) =>
        {
            var rows = await db.CardReviewEntries.Where(e => e.CardId == cardId)
                .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id)
                .Select(e => new { e.Id, e.ReviewerUserId, e.Status, e.Score, e.Comment, e.CreatedAt })
                .ToListAsync();
            var users = await ActivityEndpoints.GetUsersAsync(db, rows.Select(r => r.ReviewerUserId));
            return Results.Ok(rows.Select(r =>
            {
                users.TryGetValue(r.ReviewerUserId, out var u);
                return new ReviewEntryResponse(r.Id, r.ReviewerUserId,
                    u?.UserName ?? "", u?.DisplayName ?? "", r.Status, r.Score, r.Comment, r.CreatedAt);
            }).ToList());
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardRead);

        app.MapPut("/api/cards/{cardId:guid}/reviews", async (Guid cardId, UpdateReviewersRequest req, ClaimsPrincipal principal,
            EntaskDbContext db, IActivityService activity, IHubContext<CollaborationHub> hub) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.ReviewerUserIds is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            // 這一組值也在後段用於廣播；它在 SaveChangesAsync 前後都一樣，提前取得是安全的。
            // 顯式的 null 檢查（M1）：舊碼靠 `boardInfo!` 推論「卡片剛查到了，這一查就不會是 null」，
            // 但兩次查詢之間卡片可能被併發刪除 ⇒ 推論不成立時舊碼是 NRE→500，這裡回 404。
            // 有了這一關，下方的廣播區塊也不必再包一層 `if (boardInfo != null)`，語意不變。
            var boardInfo = await db.Cards.Where(c => c.Id == cardId).Select(c => new { c.List.BoardId, c.List.Board.ProjectId }).FirstOrDefaultAsync();
            if (boardInfo is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);

            if (req.ReviewerUserIds is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "審查者清單不可為 null" });

            var reviewerIds = req.ReviewerUserIds.Distinct().ToList();
            var existingCount = await db.Users.CountAsync(u => reviewerIds.Contains(u.Id));
            if (existingCount != reviewerIds.Count)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "包含不存在的使用者" });

            // 不變量（2026-09-19 裁定）：審查者必須是該卡片所屬專案的成員。
            // 嚴格驗整份清單的理由同 PUT .../members——而且這裡還多一個死結：待審查的卡片
            // 只有**被指派的審查者本人**能提交（admin 沒有豁免），留下非成員的審查者
            // 等於讓那張卡永遠送不出去。
            var memberIds = await db.ProjectMembers
                .Where(m => m.ProjectId == boardInfo.ProjectId && reviewerIds.Contains(m.UserId))
                .Select(m => m.UserId).Distinct().CountAsync();
            if (memberIds != reviewerIds.Count)
                return Results.BadRequest(new { code = ErrorCodes.ReviewReviewerNotProjectMember, message = "只能指派本專案的成員為審查者" });

            var current = await db.CardReviews.Where(r => r.CardId == cardId).Select(r => r.ReviewerUserId).ToListAsync();
            var removed = current.Where(u => !reviewerIds.Contains(u)).ToList();
            // 軟刪除（設計 §4.2／D1，2026-09-18）：移除審查者＝設 `RemovedAt`，不刪列。
            // 列必須留下來，才能讓 FPY 的分母真的是「**曾**指派過審查者」——分母問的是歷史，
            // 而硬刪會把「把沒過的卡片的審查者全部移除」變成 FPY 的作弊路徑
            // （FPY ≥ 0.80 是 S 級的第三個資格條件，能做這件事的權限是 `card.assign`）。
            // 被移除的列由 `EntaskDbContext` 的全域 query filter 排除在既有查詢之外，
            // 所以同一批次後面的 `current`／`newlyAdded` 語意不變（設計 §4.5）。
            // **不動 `UpdatedAt`**——它的語意是「立場最後一次改變」。
            var removedAt = DateTime.UtcNow;
            var removals = await db.CardReviews
                .Where(r => r.CardId == cardId && removed.Contains(r.ReviewerUserId)).ToListAsync();
            foreach (var row in removals) row.RemovedAt = removedAt;
            var actor = BoardEndpoints.CurrentUserId(principal);
            var newlyAdded = reviewerIds.Where(u => !current.Contains(u)).ToList();
            // 只驗**新增的差集**（設計 D8），理由同 CardEndpoints 的卡片成員端點：
            // 驗全部的話，任何一次審查者編輯都會把已停用的審查者踢掉。
            if (newlyAdded.Count > 0)
            {
                var blocked = await db.Users
                    .Where(u => newlyAdded.Contains(u.Id)
                                && (u.DeactivatedAt != null || u.DeletedAt != null))
                    .Select(u => u.DisplayName)
                    .ToListAsync();
                if (blocked.Count > 0)
                    return Results.BadRequest(new
                    {
                        code = ErrorCodes.RequestInvalid,
                        message = $"不可指派已停用的審查者：{string.Join("、", blocked)}",
                    });
            }
            foreach (var uid in newlyAdded)
            {
                db.CardReviews.Add(new CardReview { CardId = cardId, ReviewerUserId = uid, Status = ReviewStatuses.Pending });
                await activity.AddAsync(cardId, actor, ActivityTypes.ReviewAdded, detail: new { userId = uid });
            }
            await db.SaveChangesAsync();

            await hub.Clients.Group($"board:{boardInfo.BoardId}").SendAsync("CardUpdated", new { cardId, boardId = boardInfo.BoardId, projectId = boardInfo.ProjectId, action = "reviews" });
            await hub.Clients.Group($"project:{boardInfo.ProjectId}").SendAsync("CardUpdated", new { cardId, boardId = boardInfo.BoardId, projectId = boardInfo.ProjectId, action = "reviews" });

            var addedUids = newlyAdded.Where(u => u != actor).ToList();
            if (addedUids.Any())
            {
                var prefs = await db.NotificationPreferences
                    .Where(p => addedUids.Contains(p.UserId) && p.Type == NotificationTypes.Review)
                    .ToListAsync();

                foreach (var uid in addedUids)
                {
                    var pref = prefs.FirstOrDefault(p => p.UserId == uid);
                    if (pref == null || pref.InAppEnabled)
                    {
                        var notif = NotificationPayloads.Create(
                            uid,
                            NotificationTypes.Review,
                            NotificationKinds.ReviewRequested,
                            new { card = card.Title },
                            $"/projects/{boardInfo.ProjectId}/boards/{boardInfo.BoardId}?cardId={cardId}");
                        db.Notifications.Add(notif);
                        await db.SaveChangesAsync();

                        await hub.Clients.User(uid.ToString())
                            .SendAsync("NotificationReceived", NotificationPayloads.Push(notif));
                    }
                }
            }

            return Results.Ok(await GetReviewsAsync(db, cardId));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardAssign);

        app.MapPut("/api/cards/{cardId:guid}/reviews/{reviewId:guid}", async (Guid cardId, Guid reviewId,
            SubmitReviewRequest req, ClaimsPrincipal principal, EntaskDbContext db, IActivityService activity,
            IHubContext<CollaborationHub> hub, IPermissionChecker checker) =>
        {
            if (!ReviewStatuses.Submittable.Contains(req.Status))
                return Results.BadRequest(new { code = ErrorCodes.ReviewStatusNotSubmittable, message = "審查狀態不可提交" });
            var isReject = req.Status == ReviewStatuses.Rejected;
            if (isReject && req.Score is not null)
                return Results.BadRequest(new { code = ErrorCodes.ReviewScoreNotAllowedOnReject, message = "退回時不可填寫評分" });
            if (isReject && string.IsNullOrWhiteSpace(req.Comment))
                return Results.BadRequest(new { code = ErrorCodes.ReviewCommentRequiredOnReject, message = "退回時必須填寫評語" });
            if (req.Score is not null && (req.Score < 1 || req.Score > 5))
                return Results.BadRequest(new { code = ErrorCodes.ReviewRatingInvalid, message = "評分須為 1–5" });

            var review = await db.CardReviews.FirstOrDefaultAsync(r => r.Id == reviewId && r.CardId == cardId);
            if (review is null) return ApiResults.NotFound(ErrorCodes.ReviewNotFound);
            var userId = BoardEndpoints.CurrentUserId(principal);
            if (review.ReviewerUserId != userId)
                return Results.Json(new { code = ErrorCodes.ReviewNotReviewer, message = "只有被指派的審查者可以提交這筆審查" },
                    statusCode: StatusCodes.Status403Forbidden);

            // 交易內要用到 card（退回時清除完成狀態），故在開交易之前先查一次；
            // commit 之後不再重查，同一份資料兩處共用。
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);

            // 設計 §13.5（D8）：分數只有主管角色能填，技術複核（不帶分數）人人可做——
            // 所以這道閘門看的是 body 裡的 `req.Score` 而不是路由權限碼（`RequireProjectPermission`
            // 是端點篩選器，沒有「同一個請求內依 body 決定」的能力，套上去會連不帶分數的提交一起擋下）。
            //
            // 位置：四道既有驗證（狀態／退回帶分／退回缺意見／評分範圍）與存在性 404、
            // 非本人 403 之後——前面的每一種紅都比這一條先發生（那些都寫在這一段的上面）。
            //
            // 路由沒有 projectId（`/api/cards/{cardId}/reviews/{reviewId}`），所以由卡片反查；
            // **admin claim 的放行必須自己寫**：`RequireProjectPermission` 的 admin 放行在端點
            // 篩選器裡（`RequireProjectPermissionAttribute.cs` 的 `RequireProjectPermissionExtensions`，
            // admin 直通那一段），handler 內另寫一份檢查就沒有那一層了——少了它，
            // 所有以 admin token 提交分數的既有測試會 400。
            // 範本：AttachmentEndpoints.cs:106-107。
            // 「這一次提交能不能動分數」——上面那道閘門與下面的保留規則共用同一個判定。
            async Task<bool> CanSubmitScoreAsync()
            {
                var isAdmin = principal.FindFirstValue(Entask.Identity.AdminClaim.Type) == Entask.Identity.AdminClaim.Value;
                if (isAdmin) return true;
                var projectId = await db.Cards.Where(c => c.Id == cardId)
                    .Select(c => (Guid?)c.List.Board.ProjectId).FirstOrDefaultAsync();
                return projectId is not null
                    && await checker.HasProjectPermissionAsync(userId, projectId.Value, PermissionCodes.CardRate);
            }

            if (req.Score is not null && !await CanSubmitScoreAsync())
                return Results.BadRequest(new { code = ErrorCodes.ReviewRateNotPermitted, message = "沒有填寫評分的權限" });

            // 沒有 `card.rate` 的人送出的 `null` **不是**「不評分」而是「這個欄位我看不到」：
            // 前端在 `!canRate` 時固定送 null（欄位不渲染——「表單送出的內容必須是它顯示的
            // 內容」，`ItemDetailsTab.tsx` 逐字寫了這條原則），所以那個 null 不該被讀成
            // 「把分數清掉」。少了這一格，一次**畫面上什麼都沒變**的提交會寫入第二筆 entry、
            // 發通知，並讓 `CardReviews.Score` 消失（`GetReviewStatsAsync` 取的就是它，
            // 專案報表的 averageScore 跟著改變）——正是本批要擋的那一類誤觸。
            //
            // 退回不在這一條之內：退回本來就必須不帶分數（上面那道驗證），那個 null 是語意本身。
            // 代價只有「有 card.rate 的人把分數改成不評分」那一格多一輪查詢（閘門已經問過
            // 同一個問題，這裡只可能發生在閘門沒問的情形），其餘路徑一次都沒多。
            var effectiveScore = req.Score;
            if (effectiveScore is null && !isReject && review.Score is not null && !await CanSubmitScoreAsync())
                effectiveScore = review.Score;

            // 同值重送不是一次新的核定（2026-10-14，使用者回報「誤觸會重複計算」）：
            // 立場／分數／評語三者都沒變時回 200，但**不寫第二筆 entry、不動 UpdatedAt、
            // 不發通知、不廣播**。
            //
            // 為什麼要擋在**伺服器**而不是只靠前端的確認視窗：`GetTeamReviewStatsAsync`
            // 對**每一筆** approved ＋ 有分數的 entry 各算一個樣本，而 `ApplyScoreAdjustment`
            // 的 `scoreSamples < 3` 是早退、4.5／2.0 是升降級的界線（`TeamReportEndpoints.cs`）
            // ⇒ 多一筆樣本可以直接改掉一個人的評等；entry 又是 append-only，送錯的分數
            // 不會被下一次更正蓋掉。前端擋得住誤觸，擋不住兩個分頁與網路重送。
            //
            // 位置：四道既有驗證（狀態／退回帶分／退回缺意見／評分範圍）、存在性 404、
            // 非本人 403、以及上面那道 `card.rate` 權限閘門**全部之後**——那幾種紅一律
            // 先發生，這一條因此不會變成繞過它們的路徑。
            //
            // `?? ""` 把 null 與空字串讀成同一件事：前端永遠送字串（沒有評語時是 ""），
            // 而 null 是更早期資料的形狀，兩者都該算「沒有評語」。
            //
            // 早退跳過的第五項是交易內退回時的 `card.CompletedAt = null`（2026-10-14 複審
            // 指出的未載明副作用）。這一格**不可達**：能走到早退就代表這一列已是
            // approved／rejected，而交付有審查者的卡片會把所有審查列重設為 pending
            // （`CardEndpoints.cs` 的交付分支：Status／Score／Comment 一起清），
            // 所以一列 rejected 的當下不可能同時掛著 `CompletedAt`。列在這裡是為了讓
            // 「早退跳過了什麼」是完整的清單，而不只是當下觀察得到的那幾項。
            if (req.Status == review.Status
                && effectiveScore == review.Score
                && (req.Comment ?? "") == (review.Comment ?? ""))
            {
                var unchangedBy = await db.Users.FirstAsync(u => u.Id == userId);
                return Results.Ok(new ReviewResponse(review.Id, userId,
                    unchangedBy.UserName ?? "", unchangedBy.DisplayName ?? "",
                    review.Status, review.Score, review.Comment, review.UpdatedAt));
            }

            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                review.Status = req.Status;
                review.Score = effectiveScore;
                review.Comment = req.Comment;
                // 退回要把交付狀態一起撤掉（設計 D4）：被退回的卡片不該繼續掛著完成時間。
                // `card is not null` 是守衛而非可達分支——審查列有 CardId 外鍵，查不到卡片時
                // 本來就是資料不一致；少了它只會讓那個情境由「不做事」變成 NRE→500。
                if (isReject && card is not null && card.CompletedAt.HasValue)
                {
                    card.CompletedAt = null;
                    card.UpdatedAt = DateTime.UtcNow;
                }
                db.CardReviewEntries.Add(new CardReviewEntry
                {
                    CardId = cardId,
                    ReviewerUserId = userId,
                    Status = req.Status,
                    Score = effectiveScore,
                    Comment = req.Comment,
                });
                review.UpdatedAt = DateTime.UtcNow;
                await db.SaveChangesAsync();
                await activity.AddAsync(cardId, userId, ActivityTypes.ReviewSubmitted,
                    detail: new { reviewId, status = review.Status, score = review.Score, comment = review.Comment });
                await tx.CommitAsync();

                var user = await db.Users.FirstAsync(u => u.Id == userId);
                var boardInfo = await db.Cards.Where(c => c.Id == cardId).Select(c => new { c.List.BoardId, c.List.Board.ProjectId }).FirstOrDefaultAsync();
                if (card != null && boardInfo != null)
                {
                    await hub.Clients.Group($"board:{boardInfo.BoardId}").SendAsync("CardUpdated", new { cardId, boardId = boardInfo.BoardId, projectId = boardInfo.ProjectId, action = "review_submitted" });
                    await hub.Clients.Group($"project:{boardInfo.ProjectId}").SendAsync("CardUpdated", new { cardId, boardId = boardInfo.BoardId, projectId = boardInfo.ProjectId, action = "review_submitted" });

                    // `pending` 是「還沒審」而不是一種結果，不發通知：下面的 kind 是兩路三元式
                    // （approved／其餘一律 rejected），少了這半個條件時，審查者兩次點擊就能讓
                    // 卡片建立者收到標題為「審查被退回」的通知——一句關於治理動作的假陳述。
                    //
                    // 本階段起 `pending` 已不可提交（開頭的 `Submittable` 驗證就擋下），所以這半個
                    // 條件是**不可達的防禦**——刻意保留而不刪除（設計 §6.1 第 5 點／§12 第 6 點）：
                    // 刪掉它，未來放寬 `Submittable` 時就少一道守衛，而那個缺口不會有任何紅燈。
                    if (card.CreatedById != userId && req.Status != ReviewStatuses.Pending)
                    {
                        var pref = await db.NotificationPreferences
                            .FirstOrDefaultAsync(p => p.UserId == card.CreatedById && p.Type == NotificationTypes.Review);

                        if (pref == null || pref.InAppEnabled)
                        {
                            var actorName = user.DisplayName ?? user.UserName;
                            // score 只在有值時進 payload（設計 §4.4）
                            object payload = req.Score is int score
                                ? new { actor = actorName, card = card.Title, score }
                                : new { actor = actorName, card = card.Title };
                            var notif = NotificationPayloads.Create(
                                card.CreatedById,
                                NotificationTypes.Review,
                                req.Status == ReviewStatuses.Approved
                                    ? NotificationKinds.ReviewApproved
                                    : NotificationKinds.ReviewRejected,
                                payload,
                                $"/projects/{boardInfo.ProjectId}/boards/{boardInfo.BoardId}?cardId={cardId}");
                            db.Notifications.Add(notif);
                            await db.SaveChangesAsync();

                            await hub.Clients.User(card.CreatedById.ToString())
                                .SendAsync("NotificationReceived", NotificationPayloads.Push(notif));
                        }
                    }
                }

                return Results.Ok(new ReviewResponse(review.Id, userId,
                    user.UserName ?? "", user.DisplayName ?? "",
                    review.Status, review.Score, review.Comment, review.UpdatedAt));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardReview);

        return app;
    }

    // Core 無法引用 Identity（ApplicationUser），故以兩步查詢組出 Username/DisplayName
    // （ActivityEndpoints.GetActivitiesAsync 既有模式），而非導覽屬性投影。
    internal record ReviewRow(Guid Id, Guid ReviewerUserId, string Status, int? Score, string? Comment, DateTime UpdatedAt);

    internal static async Task<List<ReviewRow>> GetReviewRowsAsync(EntaskDbContext db, Guid cardId) =>
        await db.CardReviews.Where(r => r.CardId == cardId).OrderBy(r => r.CreatedAt)
            .Select(r => new ReviewRow(r.Id, r.ReviewerUserId, r.Status, r.Score, r.Comment, r.UpdatedAt))
            .ToListAsync();

    internal static List<ReviewResponse> ComposeReviews(List<ReviewRow> rows, Dictionary<Guid, ApplicationUser> users) =>
        rows.Select(r =>
        {
            users.TryGetValue(r.ReviewerUserId, out var u);
            return new ReviewResponse(r.Id, r.ReviewerUserId,
                u?.UserName ?? "", u?.DisplayName ?? "", r.Status, r.Score, r.Comment, r.UpdatedAt);
        }).ToList();

    internal static async Task<List<ReviewResponse>> GetReviewsAsync(EntaskDbContext db, Guid cardId)
    {
        var rows = await GetReviewRowsAsync(db, cardId);
        var users = await ActivityEndpoints.GetUsersAsync(db, rows.Select(r => r.ReviewerUserId));
        return ComposeReviews(rows, users);
    }

    /// <summary>
    /// 卡片層級的審查狀態彙總。null = 沒有任何審查者（行政工作那類卡片）。
    /// 優先序：任一退回即退回（避免「有人說有問題但卡片仍是完成」），
    /// 全數通過才通過，其餘為待審查。
    /// **與 CompletedAt 完全獨立**——退回後 CompletedAt 被清掉、但立場仍是 rejected，
    /// 卡片因此持續顯示「已退回」直到重新交付（設計 §4.2）。
    /// </summary>
    internal static string? Rollup(IEnumerable<string> statuses)
    {
        var list = statuses.ToList();
        if (list.Count == 0) return null;
        if (list.Contains(ReviewStatuses.Rejected)) return ReviewStatuses.Rejected;
        if (list.All(s => s == ReviewStatuses.Approved)) return ReviewStatuses.Approved;
        return ReviewStatuses.Pending;
    }

    internal static async Task<Dictionary<Guid, string?>> RollupForCardsAsync(EntaskDbContext db, IEnumerable<Guid> cardIds)
    {
        var ids = cardIds.Distinct().ToList();
        var rows = await db.CardReviews.Where(r => ids.Contains(r.CardId))
            .Select(r => new { r.CardId, r.Status }).ToListAsync();
        return rows.GroupBy(r => r.CardId).ToDictionary(g => g.Key, g => Rollup(g.Select(r => r.Status)));
    }
}
