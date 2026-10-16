using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Dtos;
using Entask.Infrastructure.Data;
using Entask.Api.Authorization;
using Entask.Api.Options;
using Entask.Core;

namespace Entask.Api.Endpoints;

public static class SearchEndpoints
{
    public static IEndpointRouteBuilder MapSearch(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/projects/{projectId:guid}/search", SearchProject)
           .RequireAuthorization()
           .RequireProjectPermission(PermissionCodes.ProjectRead)
           // 限流掛在**端點**上（不是全域）：同一個政策今天還有 `/users/search`
           // （`AuthEndpoints`）。政策名走常數——`.RequireRateLimiting("…")` 打錯字
           // 不會有編譯錯誤，ASP.NET Core 在**請求路徑上**才拋「找不到那個政策」。
           .RequireRateLimiting(RateLimitPolicy.Name);
        return app;
    }

    private static async Task<IResult> SearchProject(
        Guid projectId,
        [FromQuery] string? q,
        [FromQuery] string? types,
        [FromQuery] int limit = 10,
        EntaskDbContext db = default!)
    {
        var trimmed = q?.Trim() ?? "";
        // 長度與**內容**是同一個閘門的兩半（後半於 2026-09-24 補上，與 `/api/auth/users/search`
        // 對齊）：前者擋「太短」，後者擋「長度合法但不該進查詢的值」。`q=%00%00`（兩個 NUL）
        // **會通過**長度檢查（`Trim()` 不剝 NUL、`Length == 2`），而 PostgreSQL 的 `text`
        // 不能含 `0x00` ⇒ 呼叫端可以拿它把一個 400 變成 500。
        // ★ 兄弟站是**實測**（`UserSearchTests` 的 ①b）；本站**2026-09-24 也變成實測**：
        // 突變（把 `|| trimmed.Any(char.IsControl)` 拿掉）之下
        // `SearchTests.Returns400_WhenQueryHasControlCharacters` 紅在
        // `Expected: BadRequest / Actual: InternalServerError` ⇒ 少了這一行就是 500。
        // **訊息仍是長度那一句**：值不短、只是不合法；換句措辭等於替 `request.invalid`
        // 多生一個字面值（`check:message-values` 的粗粒度碼宣告），不精確的訊息勝過膨脹的契約。
        if (trimmed.Length < 2 || trimmed.Any(char.IsControl))
            return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "搜尋關鍵字至少需 2 個字元" });
        if (limit > 20) limit = 20;
        if (limit < 1) limit = 10;

        var typeSet = (types ?? "cards,comments,nodes")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // 逃逸後的 pattern。**`LikePattern` 是唯一建造點**（2026-09-24 之前這一站是自己寫的
        // `$"%{trimmed}%"`，漏了逃逸 ⇒ `q=%%` 兩個字元就通過長度檢查、比對到整個專案）。
        // escape 字元要傳給**每一個** `ILike`（見 `LikePattern` 的類別摘要 ①）。
        var pattern = LikePattern.Contains(trimmed);
        var utcNow = DateTime.UtcNow;

        var cards = new List<SearchCardResult>();
        if (typeSet.Contains("cards"))
        {
            var cardRows = await db.Cards
                .Where(c => c.List.Board.ProjectId == projectId && !c.IsArchived)
                .Where(c => EF.Functions.ILike(c.Title, pattern, LikePattern.EscapeCharacter) ||
                            (c.Description != null && EF.Functions.ILike(c.Description, pattern, LikePattern.EscapeCharacter)))
                .Take(limit)
                .Select(c => new {
                    c.Id,
                    BoardId = c.List.Board.Id,
                    c.Title, c.DueAt,
                    BoardName = c.List.Board.Name,
                    ListName = c.List.Name,
                    c.Description
                })
                .ToListAsync();

            cards = cardRows.Select(c => new SearchCardResult(
                c.Id, c.BoardId, c.Title, c.BoardName, c.ListName, c.DueAt,
                c.DueAt.HasValue && c.DueAt < utcNow,
                ExtractHighlight(c.Title.Contains(trimmed, StringComparison.OrdinalIgnoreCase)
                    ? c.Title : (c.Description ?? c.Title), trimmed)
            )).ToList();
        }

        var comments = new List<SearchCommentResult>();
        if (typeSet.Contains("comments"))
        {
            var commentRows = await db.ActivityItems
                .Where(a => a.Card.List.Board.ProjectId == projectId)
                .Where(a => a.Type == "comment" && a.Text != null && EF.Functions.ILike(a.Text, pattern, LikePattern.EscapeCharacter))
                .Take(limit)
                .Select(a => new {
                    a.Id, a.CardId,
                    BoardId = a.Card.List.Board.Id,
                    Content = a.Text, a.CreatedAt,
                    CardTitle = a.Card.Title,
                    AuthorId = a.UserId
                })
                .ToListAsync();

            var authorIds = commentRows.Select(r => r.AuthorId).Distinct().ToList();
            var authors = await db.Users
                .Where(u => authorIds.Contains(u.Id))
                .Select(u => new { u.Id, Name = u.DisplayName ?? u.UserName ?? "" })
                .ToDictionaryAsync(u => u.Id, u => u.Name);

            comments = commentRows.Select(c => new SearchCommentResult(
                c.Id, c.CardId, c.BoardId, c.CardTitle, c.Content ?? "",
                authors.GetValueOrDefault(c.AuthorId, "unknown"),
                c.CreatedAt,
                ExtractHighlight(c.Content ?? "", trimmed)
            )).ToList();
        }

        var nodes = new List<SearchNodeResult>();
        if (typeSet.Contains("nodes"))
        {
            var mindmap = await db.MindMaps.FirstOrDefaultAsync(m => m.ProjectId == projectId);
            if (mindmap != null)
            {
                var nodeRows = await db.MindMapNodes
                    .Where(n => n.MindMapId == mindmap.Id)
                    .Where(n => EF.Functions.ILike(n.Title, pattern, LikePattern.EscapeCharacter) ||
                               (n.Note != null && EF.Functions.ILike(n.Note, pattern, LikePattern.EscapeCharacter)))
                    .Take(limit)
                    .Select(n => new { n.Id, n.Title, n.Note, n.CardId })
                    .ToListAsync();

                var boundCardIds = nodeRows.Where(n => n.CardId.HasValue)
                    .Select(n => n.CardId!.Value).Distinct().ToList();
                var boundCards = await db.Cards
                    .Where(c => boundCardIds.Contains(c.Id))
                    .Select(c => new { c.Id, c.Title })
                    .ToDictionaryAsync(c => c.Id, c => c.Title);

                nodes = nodeRows.Select(n => new SearchNodeResult(
                    n.Id, n.Title, n.Note, n.CardId,
                    n.CardId.HasValue ? boundCards.GetValueOrDefault(n.CardId.Value) : null,
                    ExtractHighlight(n.Title.Contains(trimmed, StringComparison.OrdinalIgnoreCase)
                        ? n.Title : (n.Note ?? n.Title), trimmed)
                )).ToList();
            }
        }

        return Results.Ok(new SearchResponse(cards, comments, nodes));
    }

    private static string ExtractHighlight(string text, string keyword)
    {
        var idx = text.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return text[..Math.Min(80, text.Length)];
        var start = Math.Max(0, idx - 30);
        var end = Math.Min(text.Length, idx + keyword.Length + 50);
        var prefix = start > 0 ? "..." : "";
        var suffix = end < text.Length ? "..." : "";
        return prefix + text[start..end] + suffix;
    }
}
