using System.Security.Claims;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Api.Dtos;
using Entask.Board.CustomFields;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;

namespace Entask.Api.Endpoints;

public static class CustomFieldEndpoints
{
    public static IEndpointRouteBuilder MapCustomFields(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/projects/{projectId:guid}/custom-fields", async (Guid projectId, EntaskDbContext db) =>
        {
            var boardIds = db.Boards.Where(b => b.ProjectId == projectId).Select(b => b.Id);
            var rows = await db.CustomFieldDefinitions
                .Where(f => (f.ScopeType == "project" && f.ScopeId == projectId) ||
                            (f.ScopeType == "board" && boardIds.Contains(f.ScopeId)))
                .OrderBy(f => f.ScopeType).ThenBy(f => f.Position).ThenBy(f => f.Id)
                .Select(f => new { f.Id, f.ScopeType, f.ScopeId, f.Name, f.Type, f.Options, f.Position })
                .ToListAsync();
            var fields = rows.Select(f => new CustomFieldResponse(f.Id, f.ScopeType, f.ScopeId, f.Name, f.Type,
                ParseOptions(f.Options), f.Position)).ToList();
            return Results.Ok(fields);
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectRead);

        app.MapPost("/api/projects/{projectId:guid}/custom-fields", async (Guid projectId, CreateCustomFieldRequest req,
            ClaimsPrincipal principal, EntaskDbContext db, IAuditService audit) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.Options is { Count: > RequestLimits.MaxSelectOptions })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxSelectOptions}",
                    @params = new { max = RequestLimits.MaxSelectOptions }
                });

            var validation = ValidateDefinition(req.Name, req.Type, req.Options);
            if (!validation.Ok)
                return Results.BadRequest(new { code = validation.Code, message = validation.Message });
            var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
            if (project is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            var last = await db.CustomFieldDefinitions
                .Where(f => f.ScopeType == "project" && f.ScopeId == projectId).OrderBy(f => f.Position).ThenBy(f => f.Id)
                .Select(f => f.Position).LastOrDefaultAsync();
            var field = new CustomFieldDefinition
            {
                ScopeType = "project", ScopeId = projectId, Name = req.Name.Trim(), Type = req.Type,
                Options = req.Options is null ? null : JsonSerializer.Serialize(req.Options),
                Position = FractionalPosition.After(last),
            };
            db.CustomFieldDefinitions.Add(field);
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal), project.TeamId, AuditActions.CustomFieldCreated,
                "CustomField", field.Id, field.Name, null, projectId);
            return Results.Ok(new CustomFieldResponse(field.Id, field.ScopeType, field.ScopeId, field.Name,
                field.Type, req.Options, field.Position));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectEdit);

        app.MapPut("/api/projects/{projectId:guid}/custom-fields/{fieldId:guid}", async (Guid projectId, Guid fieldId,
            UpdateCustomFieldRequest req, ClaimsPrincipal principal, EntaskDbContext db, IAuditService audit) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.Options is { Count: > RequestLimits.MaxSelectOptions })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxSelectOptions}",
                    @params = new { max = RequestLimits.MaxSelectOptions }
                });

            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                var field = await db.CustomFieldDefinitions
                    .FirstOrDefaultAsync(f => f.Id == fieldId && f.ScopeType == "project" && f.ScopeId == projectId);
                if (field is null) return ApiResults.NotFound(ErrorCodes.CardFieldNotFound);
                // 先取得定義列鎖再執行 ExecuteDeleteAsync：卡片值 PUT 亦鎖定此列——全序化後
                // 同列 delete 只會於持鎖期間執行（消除與卡片值寫入的重疊窗口）。
                // 鎖定結果不可拋棄：並發 delete 於此處 commit 時鎖查詢回空（READ COMMITTED 重估），
                // 不檢查則後續 UPDATE 0 列 → DbUpdateConcurrencyException 500
                if (await db.CustomFieldDefinitions.FromSqlRaw(
                    "SELECT * FROM \"CustomFieldDefinitions\" WHERE \"Id\" = {0} FOR UPDATE",
                    fieldId).AsNoTracking().FirstOrDefaultAsync() is null)
                    return ApiResults.NotFound(ErrorCodes.CardFieldNotFound);

                if (req.Type is not null && req.Type != field.Type)
                {
                    var validation = ValidateDefinition(req.Name ?? field.Name, req.Type, req.Options ?? ParseOptions(field.Options));
                    if (!validation.Ok)
                        return Results.BadRequest(new { code = validation.Code, message = validation.Message });
                    field.Type = req.Type;
                    field.Options = req.Options is null ? null : JsonSerializer.Serialize(req.Options);
                    await db.CardFieldValues.Where(v => v.FieldDefinitionId == fieldId).ExecuteDeleteAsync();
                }
                else if (req.Options is not null)
                {
                    if (field.Type == CustomFieldTypes.Select && !ValidSelectOptions(req.Options))
                        return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "select 欄位需提供非空選項清單" });
                    var serialized = JsonSerializer.Serialize(req.Options);
                    var old = JsonSerializer.Deserialize<List<string>>(field.Options ?? "[]")!;
                    field.Options = serialized;
                    var valid = req.Options.ToHashSet();
                    var staleJson = old.Where(o => !valid.Contains(o)).Select(o => JsonSerializer.Serialize(o)).ToList();
                    if (staleJson.Count > 0)
                        await db.CardFieldValues.Where(v => v.FieldDefinitionId == fieldId &&
                            staleJson.Contains(v.ValueJson)).ExecuteDeleteAsync();
                }
                if (req.Name is not null && !string.IsNullOrWhiteSpace(req.Name)) field.Name = req.Name.Trim();
                if (req.Position is not null) field.Position = req.Position;
                field.UpdatedAt = DateTime.UtcNow;
                await db.SaveChangesAsync();
                await audit.AddAsync(BoardEndpoints.CurrentUserId(principal),
                    await db.Projects.Where(p => p.Id == projectId).Select(p => (Guid?)p.TeamId).FirstAsync(),
                    AuditActions.CustomFieldUpdated, "CustomField", field.Id, field.Name, null, projectId);
                await tx.CommitAsync();
                return Results.Ok(new CustomFieldResponse(field.Id, field.ScopeType, field.ScopeId, field.Name,
                    field.Type, ParseOptions(field.Options), field.Position));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectEdit);

        app.MapDelete("/api/projects/{projectId:guid}/custom-fields/{fieldId:guid}", async (Guid projectId, Guid fieldId,
            ClaimsPrincipal principal, EntaskDbContext db, IAuditService audit) =>
        {
            var field = await db.CustomFieldDefinitions
                .FirstOrDefaultAsync(f => f.Id == fieldId && f.ScopeType == "project" && f.ScopeId == projectId);
            if (field is null) return ApiResults.NotFound(ErrorCodes.CardFieldNotFound);
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal),
                await db.Projects.Where(p => p.Id == projectId).Select(p => (Guid?)p.TeamId).FirstAsync(),
                AuditActions.CustomFieldDeleted, "CustomField", field.Id, field.Name, null, projectId);
            db.CustomFieldDefinitions.Remove(field);   // 值級聯（EF cascade）
            await db.SaveChangesAsync();
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.ProjectEdit);

        app.MapPost("/api/boards/{boardId:guid}/custom-fields", async (Guid boardId, CreateCustomFieldRequest req,
            ClaimsPrincipal principal, EntaskDbContext db, IAuditService audit) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.Options is { Count: > RequestLimits.MaxSelectOptions })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxSelectOptions}",
                    @params = new { max = RequestLimits.MaxSelectOptions }
                });

            var validation = ValidateDefinition(req.Name, req.Type, req.Options);
            if (!validation.Ok)
                return Results.BadRequest(new { code = validation.Code, message = validation.Message });
            var board = await db.Boards.FirstOrDefaultAsync(b => b.Id == boardId);
            if (board is null) return ApiResults.NotFound(ErrorCodes.BoardNotFound);

            var last = await db.CustomFieldDefinitions
                .Where(f => f.ScopeType == "board" && f.ScopeId == boardId).OrderBy(f => f.Position).ThenBy(f => f.Id)
                .Select(f => f.Position).LastOrDefaultAsync();
            var field = new CustomFieldDefinition
            {
                ScopeType = "board", ScopeId = boardId, Name = req.Name.Trim(), Type = req.Type,
                Options = req.Options is null ? null : JsonSerializer.Serialize(req.Options),
                Position = FractionalPosition.After(last),
            };
            db.CustomFieldDefinitions.Add(field);
            await db.SaveChangesAsync();
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal),
                await db.Projects.Where(p => p.Id == board.ProjectId).Select(p => (Guid?)p.TeamId).FirstAsync(),
                AuditActions.CustomFieldCreated, "CustomField", field.Id, field.Name, null, board.ProjectId);
            return Results.Ok(new CustomFieldResponse(field.Id, field.ScopeType, field.ScopeId, field.Name,
                field.Type, req.Options, field.Position));
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapPut("/api/boards/{boardId:guid}/custom-fields/{fieldId:guid}", async (Guid boardId, Guid fieldId,
            UpdateCustomFieldRequest req, ClaimsPrincipal principal, EntaskDbContext db, IAuditService audit) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (req.Options is { Count: > RequestLimits.MaxSelectOptions })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxSelectOptions}",
                    @params = new { max = RequestLimits.MaxSelectOptions }
                });

            if (req.Position is not null && !PositionValidator.IsValid(req.Position))
                return Results.BadRequest(new { code = ErrorCodes.CardPositionInvalid, message = "position 須為有效的排序字串" });
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                var field = await db.CustomFieldDefinitions
                    .FirstOrDefaultAsync(f => f.Id == fieldId && f.ScopeType == "board" && f.ScopeId == boardId);
                if (field is null) return ApiResults.NotFound(ErrorCodes.CardFieldNotFound);
                // 先取得定義列鎖再執行 ExecuteDeleteAsync（與卡片值 PUT 全序化，消除同列 delete 重疊窗口）。
                // 鎖定結果不可拋棄：並發 delete 於此處 commit 時鎖查詢回空（READ COMMITTED 重估），
                // 不檢查則後續 UPDATE 0 列 → DbUpdateConcurrencyException 500
                if (await db.CustomFieldDefinitions.FromSqlRaw(
                    "SELECT * FROM \"CustomFieldDefinitions\" WHERE \"Id\" = {0} FOR UPDATE",
                    fieldId).AsNoTracking().FirstOrDefaultAsync() is null)
                    return ApiResults.NotFound(ErrorCodes.CardFieldNotFound);

                if (req.Type is not null && req.Type != field.Type)
                {
                    var validation = ValidateDefinition(req.Name ?? field.Name, req.Type, req.Options ?? ParseOptions(field.Options));
                    if (!validation.Ok)
                        return Results.BadRequest(new { code = validation.Code, message = validation.Message });
                    field.Type = req.Type;
                    field.Options = req.Options is null ? null : JsonSerializer.Serialize(req.Options);
                    await db.CardFieldValues.Where(v => v.FieldDefinitionId == fieldId).ExecuteDeleteAsync();
                }
                else if (req.Options is not null)
                {
                    if (field.Type == CustomFieldTypes.Select && !ValidSelectOptions(req.Options))
                        return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "select 欄位需提供非空選項清單" });
                    var serialized = JsonSerializer.Serialize(req.Options);
                    var old = JsonSerializer.Deserialize<List<string>>(field.Options ?? "[]")!;
                    field.Options = serialized;
                    var valid = req.Options.ToHashSet();
                    var staleJson = old.Where(o => !valid.Contains(o)).Select(o => JsonSerializer.Serialize(o)).ToList();
                    if (staleJson.Count > 0)
                        await db.CardFieldValues.Where(v => v.FieldDefinitionId == fieldId &&
                            staleJson.Contains(v.ValueJson)).ExecuteDeleteAsync();
                }
                if (req.Name is not null && !string.IsNullOrWhiteSpace(req.Name)) field.Name = req.Name.Trim();
                if (req.Position is not null) field.Position = req.Position;
                field.UpdatedAt = DateTime.UtcNow;
                var board = await db.Boards.FirstAsync(b => b.Id == boardId);
                await db.SaveChangesAsync();
                await audit.AddAsync(BoardEndpoints.CurrentUserId(principal),
                    await db.Projects.Where(p => p.Id == board.ProjectId).Select(p => (Guid?)p.TeamId).FirstAsync(),
                    AuditActions.CustomFieldUpdated, "CustomField", field.Id, field.Name, null, board.ProjectId);
                await tx.CommitAsync();
                return Results.Ok(new CustomFieldResponse(field.Id, field.ScopeType, field.ScopeId, field.Name,
                    field.Type, ParseOptions(field.Options), field.Position));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapDelete("/api/boards/{boardId:guid}/custom-fields/{fieldId:guid}", async (Guid boardId, Guid fieldId,
            ClaimsPrincipal principal, EntaskDbContext db, IAuditService audit) =>
        {
            var field = await db.CustomFieldDefinitions
                .FirstOrDefaultAsync(f => f.Id == fieldId && f.ScopeType == "board" && f.ScopeId == boardId);
            if (field is null) return ApiResults.NotFound(ErrorCodes.CardFieldNotFound);
            var board = await db.Boards.FirstAsync(b => b.Id == boardId);
            await audit.AddAsync(BoardEndpoints.CurrentUserId(principal),
                await db.Projects.Where(p => p.Id == board.ProjectId).Select(p => (Guid?)p.TeamId).FirstAsync(),
                AuditActions.CustomFieldDeleted, "CustomField", field.Id, field.Name, null, board.ProjectId);
            db.CustomFieldDefinitions.Remove(field);
            await db.SaveChangesAsync();
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.BoardEdit);

        app.MapPut("/api/cards/{cardId:guid}/custom-fields", async (Guid cardId, Dictionary<Guid, JsonElement> values,
            ClaimsPrincipal principal, EntaskDbContext db, IActivityService activity) =>
        {
            // 集合上限（2026-10-10 公開前硬化）：在任何 DB 工作之前——見 `RequestLimits` 的摘要。
            if (values is { Count: > RequestLimits.MaxReferenceIds })
                return Results.BadRequest(new
                {
                    code = ErrorCodes.RequestCollectionTooLarge,
                    message = $"清單的項目數超過上限 {RequestLimits.MaxReferenceIds}",
                    @params = new { max = RequestLimits.MaxReferenceIds }
                });

            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            if (values is null)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "欄位值不可為 null" });

            var boardId = await db.Lists.Where(l => l.Id == card.ListId).Select(l => l.BoardId).FirstAsync();
            var projectId = await db.Boards.Where(b => b.Id == boardId).Select(b => b.ProjectId).FirstAsync();

            var defs = await db.CustomFieldDefinitions
                .Where(f => (f.ScopeType == "project" && f.ScopeId == projectId) ||
                            (f.ScopeType == "board" && f.ScopeId == boardId))
                .ToListAsync();
            var defMap = defs.ToDictionary(f => f.Id);

            foreach (var (fieldId, value) in values)
            {
                if (!defMap.TryGetValue(fieldId, out var def))
                    return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "欄位不屬於此卡片可見範疇" });
                JsonElement? options = null;
                if (def.Options is not null)
                {
                    using var doc = JsonDocument.Parse(def.Options);
                    options = doc.RootElement.Clone();
                }
                var (ok, code, message) = CustomFieldValidator.ValidateValue(def.Type, value, options);
                if (!ok)
                {
                    // `card.fieldTextTooLong` 的譯文帶 `{{max}}`，數值由驗證器的常數衍生
                    // ——寫第二份數字會靜默漂移（W8）。
                    if (code == ErrorCodes.CardFieldTextTooLong)
                        return Results.BadRequest(new { code, message, @params = new { max = CustomFieldValidator.MaxTextLength } });
                    return Results.BadRequest(new { code, message });
                }
                if (def.Type == CustomFieldTypes.Member && value.ValueKind == JsonValueKind.String &&
                    !await db.Users.AnyAsync(u => u.Id == Guid.Parse(value.GetString()!)))
                    return Results.BadRequest(new { code = ErrorCodes.CardFieldMemberNotFound, message = "成員欄位指向不存在的使用者" });
            }

            // 並發守護：非 null 寫入的定義列以 FOR UPDATE 鎖定（依 id 排序避免 AB-BA deadlock）。
            // 定義 delete（cascade）、type-change／選項收縮的 ExecuteDeleteAsync 皆需定義列鎖，
            // 會阻塞至本交易 commit 後再清理本請求寫入之列——消除同列 delete 重疊窗口。
            // 鎖定後以 AsNoTracking 新鮮快照複驗 type/options（繞過 identity map），已變更即 409。
            var writes = values.Where(kv => kv.Value.ValueKind != JsonValueKind.Null)
                .Select(kv => kv.Key).OrderBy(id => id).ToList();
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                if (writes.Count > 0)
                {
                    // = ANY(陣列參數) 免動態 SQL；ORDER BY 保證鎖取得順序一致（避免 AB-BA deadlock）
                    var locked = await db.CustomFieldDefinitions.FromSqlRaw(
                        "SELECT * FROM \"CustomFieldDefinitions\" WHERE \"Id\" = ANY({0}) ORDER BY \"Id\" FOR UPDATE",
                        (object)writes.ToArray()).AsNoTracking().ToListAsync();
                    if (locked.Count != writes.Count)
                        return Results.Conflict(new { code = ErrorCodes.ConcurrencyConflict, message = "並發更新衝突，請重試" });
                    foreach (var def in locked)
                    {
                        var snapshot = defMap[def.Id];
                        if (def.Type != snapshot.Type || def.Options != snapshot.Options)
                            return Results.Conflict(new { code = ErrorCodes.ConcurrencyConflict, message = "並發更新衝突，請重試" });
                    }
                }

                var existing = await db.CardFieldValues.Where(v => v.CardId == cardId).ToListAsync();
                var actor = BoardEndpoints.CurrentUserId(principal);
                foreach (var (fieldId, value) in values)
                {
                    var row = existing.FirstOrDefault(v => v.FieldDefinitionId == fieldId);
                    if (value.ValueKind == JsonValueKind.Null)
                    {
                        if (row is not null) db.CardFieldValues.Remove(row);
                        continue;
                    }
                    var serialized = value.GetRawText();
                    if (row is null)
                        db.CardFieldValues.Add(new CardFieldValue { CardId = cardId, FieldDefinitionId = fieldId, ValueJson = serialized });
                    else if (row.ValueJson != serialized)
                        row.ValueJson = serialized;
                    await activity.AddAsync(cardId, actor, ActivityTypes.CustomFieldUpdated,
                        detail: new { fieldId, fieldName = defMap[fieldId].Name });
                }
                await db.SaveChangesAsync();
                await tx.CommitAsync();
                return Results.Ok(await CardEndpoints.GetCardResponseAsync(db, cardId));
            }
            catch
            {
                await TransactionGuard.RollbackIfActiveAsync(db);
                throw;
            }
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        return app;
    }

    /// <summary>
    /// 定義層級的驗證。回傳 **code 與 message 分開**——code 走機器契約，
    /// message 是今天的字面值原樣（設計 §4.1／§5.4：後端不養第二份語系檔，
    /// 呼叫點的複寫是刻意的）。
    /// </summary>
    internal static (bool Ok, string? Code, string? Message) ValidateDefinition(string name, string type, List<string>? options)
    {
        if (string.IsNullOrWhiteSpace(name)) return (false, ErrorCodes.RequestInvalid, "欄位名稱不可為空");
        if (!CustomFieldTypes.All.Contains(type)) return (false, ErrorCodes.RequestInvalid, "未知欄位型態");
        if (type == CustomFieldTypes.Select && !ValidSelectOptions(options))
            return (false, ErrorCodes.RequestInvalid, "select 欄位需提供非空選項清單");
        return (true, null, null);
    }

    internal static bool ValidSelectOptions(List<string>? options) =>
        options is not null && options.Count > 0 && !options.Any(string.IsNullOrWhiteSpace);

    internal static List<string>? ParseOptions(string? json) =>
        json is null ? null : JsonSerializer.Deserialize<List<string>>(json);
}
