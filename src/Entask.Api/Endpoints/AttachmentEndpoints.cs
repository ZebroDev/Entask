using System.Security.Claims;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.EntityFrameworkCore;
using Entask.Api.Authorization;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Storage;

namespace Entask.Api.Endpoints;

public static class AttachmentEndpoints
{
    private const long MaxFileSize = 20 * 1024 * 1024;
    // multipart 上限（global Kestrel 已收緊為 1MiB——僅此端點以 per-endpoint 上限豁免）
    private const long MaxMultipartBodySize = 135_266_304;

    private sealed class RequestSizeLimitMetadata(long maxRequestBodySize) : IRequestSizeLimitMetadata
    {
        public long? MaxRequestBodySize { get; } = maxRequestBodySize;
    }

    public static IEndpointRouteBuilder MapAttachments(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/cards/{cardId:guid}/attachments", async (Guid cardId, HttpRequest request, ClaimsPrincipal principal,
            EntaskDbContext db, IAttachmentStore store, IActivityService activity) =>
        {
            var card = await db.Cards.FirstOrDefaultAsync(c => c.Id == cardId);
            if (card is null) return ApiResults.NotFound(ErrorCodes.CardNotFound);
            if (!request.HasFormContentType)
                return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "必須以 multipart/form-data 上傳" });
            IFormFile? file;
            try
            {
                var form = await request.ReadFormAsync();
                file = form.Files.FirstOrDefault();
            }
            catch (InvalidDataException)
            {
                // multipart body 介於 Kestrel 上限與 FormOptions.MultipartBodyLengthLimit 之間時
                return Results.BadRequest(new { code = ErrorCodes.RequestBodyTooLarge, message = "請求的資料量過大或格式錯誤" });
            }
            if (file is null) return Results.BadRequest(new { code = ErrorCodes.RequestInvalid, message = "缺少檔案" });

            var contentType = file.ContentType.Contains(';')
                ? file.ContentType[..file.ContentType.IndexOf(';')].Trim()
                : file.ContentType;
            if (file.Length > MaxFileSize) return Results.BadRequest(new { code = ErrorCodes.AttachmentTooLarge, message = "檔案超過 20MB 上限", @params = new { max = MaxFileSize / (1024 * 1024) } });
            if (!AttachmentStore.AllowedContentTypes.Contains(contentType))
                return Results.BadRequest(new { code = ErrorCodes.AttachmentUnsupportedType, message = "不支援的檔案型態" });

            var extension = AttachmentStore.ContentTypeExtension(contentType);
            await using var stream = file.OpenReadStream();
            var stored = await store.SaveAsync(stream, extension);

            var attachment = new Attachment
            {
                CardId = cardId,
                UserId = BoardEndpoints.CurrentUserId(principal),
                FileName = AttachmentStore.SafeFileName(file.FileName, contentType),
                ContentType = contentType,
                Size = stored.Size,
                StoragePath = stored.StoragePath,
            };
            db.Attachments.Add(attachment);
            await db.SaveChangesAsync();
            await activity.AddAsync(cardId, attachment.UserId, ActivityTypes.AttachmentAdded,
                detail: new { attachmentId = attachment.Id, fileName = attachment.FileName });

            return Results.Ok(new
            {
                attachment.Id, attachment.FileName, attachment.ContentType, attachment.Size, attachment.CreatedAt,
            });
        }).WithMetadata(new RequestSizeLimitMetadata(MaxMultipartBodySize))
          .RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapDelete("/api/cards/{cardId:guid}/attachments/{attachmentId:guid}", async (Guid cardId, Guid attachmentId,
            ClaimsPrincipal principal, EntaskDbContext db, IAttachmentStore store, IActivityService activity) =>
        {
            var attachment = await db.Attachments.FirstOrDefaultAsync(a => a.Id == attachmentId && a.CardId == cardId);
            if (attachment is null) return ApiResults.NotFound(ErrorCodes.AttachmentNotFound);

            var card = await db.Cards.FirstAsync(c => c.Id == cardId);
            if (card.CoverAttachmentId == attachmentId)
                card.CoverAttachmentId = null;

            db.Attachments.Remove(attachment);
            await db.SaveChangesAsync();
            try { store.Delete(attachment.StoragePath); } catch { /* ignore missing/locked files */ }
            await activity.AddAsync(cardId, BoardEndpoints.CurrentUserId(principal), ActivityTypes.AttachmentRemoved,
                detail: new { attachmentId, fileName = attachment.FileName });
            return Results.Ok();
        }).RequireAuthorization().RequireProjectPermission(PermissionCodes.CardEdit);

        app.MapGet("/api/attachments/{id:guid}", async (Guid id, ClaimsPrincipal principal,
            EntaskDbContext db, IAttachmentStore store, IPermissionChecker checker) =>
        {
            var attachment = await db.Attachments.FirstOrDefaultAsync(a => a.Id == id);
            if (attachment is null) return ApiResults.NotFound(ErrorCodes.AttachmentNotFound);
            var projectId = await db.Cards.Where(c => c.Id == attachment.CardId)
                .Select(c => (Guid?)c.List.Board.ProjectId).FirstOrDefaultAsync();
            if (projectId is null) return ApiResults.NotFound(ErrorCodes.ProjectNotFound);

            var userId = BoardEndpoints.CurrentUserId(principal);
            var isAdmin = principal.FindFirstValue(Entask.Identity.AdminClaim.Type) == Entask.Identity.AdminClaim.Value;
            if (!isAdmin && !await checker.HasProjectPermissionAsync(userId, projectId.Value, PermissionCodes.CardRead))
                return Results.Json(new { code = ErrorCodes.PermissionDenied, message = "你沒有存取這個資源的權限" },
                    statusCode: StatusCodes.Status403Forbidden);

            if (!store.Exists(attachment.StoragePath)) return ApiResults.NotFound(ErrorCodes.AttachmentNotFound);
            var stream = store.OpenRead(attachment.StoragePath);
            var isImage = attachment.ContentType.StartsWith("image/");
            return isImage
                ? Results.File(stream, attachment.ContentType)
                : Results.File(stream, attachment.ContentType, AttachmentStore.SafeFileName(attachment.FileName, attachment.ContentType));
        }).RequireAuthorization();

        return app;
    }
}
