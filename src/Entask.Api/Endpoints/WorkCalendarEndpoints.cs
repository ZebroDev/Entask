using System.Globalization;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Entask.Performance;

namespace Entask.Api.Endpoints;

/// <summary>
/// 團隊工作日曆：逐日期的例外（放假日／補班日）。日曆掛在 team（裁定 R1）——各國國定假日不同，
/// 而 team 是本系統最高的工作單位。讀取要 `team.read`（每個成員都看得到「這天為什麼不用填」），
/// 寫入要 `team.workcalendar.manage`。兩者都經 `RequirePermission`，所以 X-Team-Id 與 route teamId
/// 的一致性由它守（跨團隊寫入在進 handler 之前就被擋）。
/// </summary>
public static class WorkCalendarEndpoints
{
    public static IEndpointRouteBuilder MapWorkCalendar(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/teams/{teamId:guid}/work-calendar").RequireAuthorization();

        group.MapGet("/", async (Guid teamId, string? from, string? to, EntaskDbContext db) =>
        {
            if (!TryParseDate(from, out var fromDate) || !TryParseDate(to, out var toDate))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 與 to 須為 yyyy-MM-dd" });
            if (toDate < fromDate)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "from 須早於 to" });
            if (toDate.DayNumber - fromDate.DayNumber > WorkLogQueries.MaxRangeDays)
                return Results.BadRequest(new
                {
                    code = ErrorCodes.QueryRangeTooLong,
                    message = $"查詢的期間不可超過 {WorkLogQueries.MaxRangeDays} 天",
                    @params = new { max = WorkLogQueries.MaxRangeDays }
                });

            // 先在 DB 端篩選、再在記憶體格式化：`e.Date.ToString("yyyy-MM-dd")` 進不了 SQL
            var rows = await db.WorkCalendarExceptions
                .Where(e => e.TeamId == teamId && e.Date >= fromDate && e.Date <= toDate)
                .OrderBy(e => e.Date)
                .Select(e => new { e.Date, e.Kind, e.Name })
                .ToListAsync();
            return Results.Ok(rows.Select(e => Row(e.Date, e.Kind, e.Name)).ToList());
        }).RequirePermission(PermissionCodes.TeamRead);

        group.MapPut("/{date}", async (Guid teamId, string date, UpsertWorkCalendarExceptionRequest req,
            EntaskDbContext db, IAuditService audit, ClaimsPrincipal principal) =>
        {
            if (!TryParseDate(date, out var day))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "日期須為 yyyy-MM-dd" });
            var kind = req.Kind switch
            {
                "Holiday" => (WorkCalendarKind?)WorkCalendarKind.Holiday,
                "Workday" => WorkCalendarKind.Workday,
                _ => null,
            };
            if (kind is null)
                return Results.BadRequest(new { code = ErrorCodes.WorkCalendarKindInvalid, message = "工作日的種類不正確" });
            var name = string.IsNullOrWhiteSpace(req.Name) ? null : req.Name.Trim();
            if (name is { Length: > 100 })
                return Results.BadRequest(new { code = ErrorCodes.WorkCalendarNameTooLong, message = "名稱不可超過 100 字元" });

            var userId = BoardEndpoints.CurrentUserId(principal);
            var now = DateTime.UtcNow;
            // 同一天的第二次寫入是更新、不是第二列（冪等）；唯一索引 (TeamId, Date) 是最後一道防線
            var row = await db.WorkCalendarExceptions.FirstOrDefaultAsync(e => e.TeamId == teamId && e.Date == day);
            if (row is null)
            {
                row = new WorkCalendarException
                {
                    Id = Guid.NewGuid(), TeamId = teamId, Date = day, Kind = kind.Value, Name = name,
                    CreatedById = userId, CreatedAt = now, UpdatedAt = now,
                };
                db.WorkCalendarExceptions.Add(row);
            }
            else
            {
                row.Kind = kind.Value;
                row.Name = name;
                row.UpdatedAt = now;
            }
            await db.SaveChangesAsync();
            await audit.AddAsync(userId, teamId, AuditActions.WorkCalendarUpdated, "workCalendarException",
                row.Id, DayKey(day), new { date = DayKey(day), kind = kind.Value.ToString(), name });
            return Results.Ok(Row(day, kind.Value, name));
        }).RequirePermission(PermissionCodes.TeamWorkCalendarManage);

        group.MapDelete("/{date}", async (Guid teamId, string date, EntaskDbContext db,
            IAuditService audit, ClaimsPrincipal principal) =>
        {
            if (!TryParseDate(date, out var day))
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "日期須為 yyyy-MM-dd" });
            var row = await db.WorkCalendarExceptions.FirstOrDefaultAsync(e => e.TeamId == teamId && e.Date == day);
            if (row is null) return ApiResults.NotFound(ErrorCodes.WorkCalendarNotFound);

            db.WorkCalendarExceptions.Remove(row);
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), teamId, AuditActions.WorkCalendarDeleted,
                "workCalendarException", row.Id, DayKey(day));
            return Results.NoContent();
        }).RequirePermission(PermissionCodes.TeamWorkCalendarManage);

        return app;
    }

    private static WorkCalendarExceptionResponse Row(DateOnly date, WorkCalendarKind kind, string? name) =>
        new(DayKey(date), kind.ToString(), name);

    /// <summary>日期一律 `yyyy-MM-dd` ＋ InvariantCulture：它是傳輸契約，不是主機文化。</summary>
    private static string DayKey(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>**不用 route 的 `DateOnly` 綁定**：綁定失敗的 400 由框架產生，body 會繞過
    /// `{code, message}` 契約（見「錯誤碼與訊息契約」）。</summary>
    private static bool TryParseDate(string? value, out DateOnly date) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
}
