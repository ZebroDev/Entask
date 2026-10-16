using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class UserWorkEndpoints
{
    public static IEndpointRouteBuilder MapUserWork(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/me/work", GetMyWork)
           .RequireAuthorization();

        return app;
    }

    private static async Task<IResult> GetMyWork(
        EntaskDbContext db,
        ClaimsPrincipal principal)
    {
        var userId = BoardEndpoints.CurrentUserId(principal);
        var utcNow = DateTime.UtcNow;
        var todayStart = utcNow.Date;
        var todayEnd = todayStart.AddDays(1);

        var cards = await db.Cards
            .Where(c => !c.IsArchived && c.Members.Any(m => m.UserId == userId))
            .OrderBy(c => c.CompletedAt != null)
            .ThenBy(c => c.DueAt == null)
            .ThenBy(c => c.DueAt)
            .Select(c => new MyWorkCardItem(
                c.Id,
                c.Title,
                c.List.Board.ProjectId,
                c.List.Board.Project.Name,
                c.List.BoardId,
                c.List.Board.Name,
                c.ListId,
                c.List.Name,
                c.DueAt,
                c.CompletedAt,
                c.DueAt.HasValue && c.DueAt < utcNow && c.CompletedAt == null,
                c.Labels.Select(l => l.Label.Name).ToList(),
                c.Checklists.SelectMany(ch => ch.Items).Count(),
                c.Checklists.SelectMany(ch => ch.Items).Count(i => i.IsChecked)
            ))
            .ToListAsync();

        var pendingReviews = await db.CardReviews
            .Where(r => r.ReviewerUserId == userId && r.Status == ReviewStatuses.Pending && !r.Card.IsArchived)
            .OrderBy(r => r.Card.DueAt == null)
            .ThenBy(r => r.Card.DueAt)
            .Select(r => new MyPendingReviewItem(
                r.CardId,
                r.Card.Title,
                r.Card.List.Board.ProjectId,
                r.Card.List.Board.Project.Name,
                r.Card.List.BoardId,
                r.Card.List.Board.Name,
                r.Card.DueAt,
                r.Status
            ))
            .ToListAsync();

        var totalAssigned = cards.Count;
        var dueToday = cards.Count(c => c.DueAt.HasValue && c.DueAt.Value >= todayStart && c.DueAt.Value < todayEnd && c.CompletedAt == null);
        var overdue = cards.Count(c => c.IsOverdue);
        var inProgress = cards.Count(c => c.CompletedAt == null);
        var completed = cards.Count(c => c.CompletedAt != null);
        var pendingReviewCount = pendingReviews.Count;

        var stats = new MyWorkStats(totalAssigned, dueToday, overdue, inProgress, completed, pendingReviewCount);
        return Results.Ok(new MyWorkResponse(cards, pendingReviews, stats));
    }
}
