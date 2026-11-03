using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Entask.Api.Options;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Infrastructure.Data;
using Entask.Infrastructure.Storage;

namespace Entask.Tests;

public class AttachmentHardeningTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AttachmentHardeningTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // team → project → board → list → card；回傳 (cardId, projectId)
    private async Task<(string CardId, string ProjectId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "附件硬化團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "附件硬化專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "附件板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "附件卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (card.GetProperty("id").GetString()!, projectId);
    }

    private async Task<string> UploadTextAsync(string cardId)
    {
        var content = new MultipartFormDataContent();
        var streamContent = new StreamContent(new MemoryStream("hello"u8.ToArray()));
        streamContent.Headers.ContentType = new("text/plain");
        content.Add(streamContent, "file", "note.txt");
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", content);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var attachment = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return attachment.GetProperty("id").GetString()!;
    }

    private async Task<JsonElement> UploadAsync(string cardId, string content, string contentType, string fileName)
    {
        using var form = new MultipartFormDataContent();
        var bytes = System.Text.Encoding.UTF8.GetBytes(content);
        form.Add(new ByteArrayContent(bytes) { Headers = { ContentType = new(contentType) } }, "file", fileName);
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", form);
        return await resp.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task<HttpResponseMessage> UploadRawAsync(
        string cardId, string content, string contentType, string fileName)
    {
        using var form = new MultipartFormDataContent();
        var bytes = System.Text.Encoding.UTF8.GetBytes(content);
        form.Add(new ByteArrayContent(bytes) { Headers = { ContentType = new(contentType) } }, "file", fileName);
        return await _client.PostAsync($"/api/cards/{cardId}/attachments", form);
    }

    // 只宣告 Content-Length，實際只寫 1 byte：用來走 handler 的前置檢查，
    // 而不是先讀完整個 multipart body 才在 file.Length 那一站拒絕。
    private sealed class SpoofedLengthContent : HttpContent
    {
        private readonly byte[] _payload;
        private readonly long _declaredLength;

        public SpoofedLengthContent(byte[] payload, long declaredLength)
        {
            _payload = payload;
            _declaredLength = declaredLength;
            Headers.ContentType = new MediaTypeHeaderValue("multipart/form-data")
            {
                Parameters = { new NameValueHeaderValue("boundary", "spoofed") },
            };
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => stream.WriteAsync(_payload).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = _declaredLength;
            return true;
        }
    }

    [Fact]
    public void FormOptions_MultipartBodyLengthLimit_IsAttachmentLimit()
    {
        // 21 MiB 是規格值：用字面值釘住，避免「常數改壞、測試跟著改」的恆綠。
        Assert.Equal(21L * 1024 * 1024, AttachmentLimits.MaxMultipartBodySize);
        var options = _factory.Services.GetRequiredService<IOptions<FormOptions>>().Value;
        Assert.Equal(AttachmentLimits.MaxMultipartBodySize, options.MultipartBodyLengthLimit);
    }

    [Fact]
    public void AttachmentUploadEndpoint_RequestSizeLimit_IsAttachmentLimit()
    {
        var endpoints = _factory.Services.GetServices<EndpointDataSource>().SelectMany(ds => ds.Endpoints);
        var post = endpoints.OfType<RouteEndpoint>().Single(e =>
            e.RoutePattern.RawText == "/api/cards/{cardId:guid}/attachments"
            && e.Metadata.GetMetadata<IHttpMethodMetadata>()!.HttpMethods.Contains("POST"));

        Assert.Equal(
            (long?)AttachmentLimits.MaxMultipartBodySize,
            post.Metadata.GetMetadata<IRequestSizeLimitMetadata>()!.MaxRequestBodySize);
    }

    [Fact]
    public void AllowedContentTypes_DoNotIncludeExecutableMarkup()
    {
        // 這是護欄，不是新行為：今天的白名單已經沒有這三種。
        // 若有人把 SVG／HTML 加進 ContentTypeExtensions，這一支必須紅。
        Assert.DoesNotContain("image/svg+xml", AttachmentStore.AllowedContentTypes);
        Assert.DoesNotContain("text/html", AttachmentStore.AllowedContentTypes);
        Assert.DoesNotContain("application/xhtml+xml", AttachmentStore.AllowedContentTypes);
    }

    [Fact]
    public async Task AttachmentUpload_CharsetContentType_Accepted()
    {
        var (cardId, _) = await SetupAsync();
        var content = new MultipartFormDataContent();
        var streamContent = new StreamContent(new MemoryStream("hello"u8.ToArray()));
        streamContent.Headers.ContentType = new MediaTypeHeaderValue("text/plain") { CharSet = "utf-8" };
        content.Add(streamContent, "file", "note.txt");
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", content);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var attachment = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var attachmentId = attachment.GetProperty("id").GetString()!;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            Assert.Equal("text/plain", db.Attachments.Single(a => a.Id == Guid.Parse(attachmentId)).ContentType);
        }
    }

    [Fact]
    public async Task AttachmentUpload_NonMultipart_Returns400()
    {
        var (cardId, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments",
            JsonContent.Create(new { not = "multipart" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task AttachmentUpload_Oversized_Returns400()
    {
        var (cardId, _) = await SetupAsync();
        var content = new MultipartFormDataContent();
        var bytes = new byte[20 * 1024 * 1024 + 1];
        var streamContent = new StreamContent(new MemoryStream(bytes));
        streamContent.Headers.ContentType = new("image/png");
        content.Add(streamContent, "file", "big.png");
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", content);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task AttachmentUpload_DeclaredBodyOverLimit_Returns400BeforeReading()
    {
        var (cardId, _) = await SetupAsync();
        using var content = new SpoofedLengthContent(
            new byte[1], AttachmentLimits.MaxMultipartBodySize + 1);

        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", content);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.RequestBodyTooLarge, await ErrorBody.CodeOfAsync(resp));
    }

    [Theory]
    [InlineData("image/svg+xml", "x.svg")]
    [InlineData("text/html", "x.html")]
    public async Task AttachmentUpload_ExecutableMarkup_Returns400UnsupportedType(
        string contentType, string fileName)
    {
        var (cardId, _) = await SetupAsync();
        var resp = await UploadRawAsync(cardId, "<script>alert(1)</script>", contentType, fileName);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.AttachmentUnsupportedType, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task AttachmentGet_MissingFile_Returns404()
    {
        var (cardId, _) = await SetupAsync();
        var attachmentId = await UploadTextAsync(cardId);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var store = scope.ServiceProvider.GetRequiredService<IAttachmentStore>();
            var path = db.Attachments.Single(a => a.Id == Guid.Parse(attachmentId)).StoragePath;
            store.Delete(path);
        }
        var resp = await _client.GetAsync($"/api/attachments/{attachmentId}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.AttachmentNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task AttachmentGet_NonMember_Returns403()
    {
        var (cardId, projectId) = await SetupAsync();
        var attachmentId = await UploadTextAsync(cardId);
        // att-alice：新使用者，**沒有任何團隊／專案成員身分**（更正舊註解的「團隊工程師」——
        // 本支從未把她加進團隊），因此 `HasProjectPermissionAsync(CardRead)` 回 false。
        // 這個端點只掛 `.RequireAuthorization()`，沒有 `RequireProjectPermission` 篩選器
        // ⇒ 走得到 handler 自己的 403 站點（AttachmentEndpoints.cs:107-109）。
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "att-alice", password = "Password1!", displayName = "附件艾莉絲" }));
        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "att-alice", password = "Password1!" }));
        var aliceToken = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/attachments/{attachmentId}");
        req.Headers.Authorization = new("Bearer", aliceToken);
        var resp = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        Assert.Equal("permission.denied",
            (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task AttachmentGet_DeactivatedAdmin_Returns401SessionInvalid()
    {
        var (cardId, _) = await SetupAsync();
        var attachmentId = await UploadTextAsync(cardId);

        var username = "att-admin-" + Guid.NewGuid().ToString("N")[..8];
        var create = await _client.PostAsync("/api/auth/users", JsonContent.Create(new
        {
            username,
            password = "Password1!",
            displayName = "附件管理員二",
            isAdmin = true,
        }));
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        var body = await login.Content.ReadFromJsonAsync<JsonElement>();
        var userId = body.GetProperty("userId").GetString()!;
        var token = body.GetProperty("accessToken").GetString()!;

        var deactivate = await _client.PostAsync($"/api/admin/users/{userId}/deactivate", null);
        Assert.Equal(HttpStatusCode.NoContent, deactivate.StatusCode);

        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/attachments/{attachmentId}");
        req.Headers.Authorization = new("Bearer", token);
        var resp = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
        Assert.Equal(ErrorCodes.AuthSessionInvalid, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task AttachmentGet_NonImage_HasContentDisposition()
    {
        var (cardId, _) = await SetupAsync();
        var attachmentId = await UploadTextAsync(cardId);
        var resp = await _client.GetAsync($"/api/attachments/{attachmentId}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.NotNull(resp.Content.Headers.ContentDisposition);
        Assert.Contains("note.txt", resp.Content.Headers.ContentDisposition.FileName);
    }

    [Fact]
    public async Task Upload_FileNameWithPath_StoresBaseNameOnly()
    {
        var (cardId, _) = await SetupAsync();
        // 上傳端清理：去路徑分段（Windows 與 POSIX 兩種分隔）
        var att = await UploadAsync(cardId, "x", "application/pdf", @"..\..\evil.pdf");
        Assert.Equal("evil.pdf", att.GetProperty("fileName").GetString());

        // 空名保底：content-type 的副檔名
        var dot = await UploadAsync(cardId, "x", "application/pdf", "...");
        Assert.Equal("attachment.pdf", dot.GetProperty("fileName").GetString());
    }

    [Fact]
    public async Task Download_HostileStoredFileName_SanitizedInHeader()
    {
        var (cardId, _) = await SetupAsync();
        var att = await UploadAsync(cardId, "x", "application/pdf", "note.pdf");
        var attId = att.GetProperty("id").GetString()!;

        // 下載防禦半：模擬「既有列」（不回溯清理，R5）——直接改 DB 的值。
        // ★ 這一格刻意不經 multipart：MultipartFormDataContent 對控制字元的標頭驗證未實測
        //   （見計畫 Review Focus 1），直塞 DB 量到的正是「舊資料進到標頭」這條路。
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var row = db.Attachments.First(a => a.Id == Guid.Parse(attId));
            row.FileName = "a\r\nb.pdf";
            await db.SaveChangesAsync();
        }

        var dl = await _client.GetAsync($"/api/attachments/{attId}");
        Assert.Equal(HttpStatusCode.OK, dl.StatusCode);
        var raw = dl.Content.Headers.ContentDisposition!.ToString();
        Assert.DoesNotContain("\r", raw);          // 標頭本身不得帶 CR/LF
        Assert.DoesNotContain("\n", raw);
        Assert.Contains("ab.pdf", raw);            // 控制字元被「移除」不是「拒絕」
    }

    public static TheoryData<string> IdempotencyInputs => new()
    {
        // 本 theory 只驗「冪等」；「對正常檔名恆等」由 HTTP 守門員負責
        // （`AttachmentTests` 的 cover.png；本檔上面的 note.txt）。
        ". .", " a .",                          // Trim 空白與 Trim '.' 互相露出對方
        "cover.png", "note.txt",                // 正常檔名
        "..", "...", @"..\..\evil.pdf",         // 保底名、去路徑分段
        new string('a', 250) + ".pdf",          // 長名：截斷主體、保留副檔名
        new string('a', 250),
        // 截斷點落在空白／'.' 上：單趟「先收斂、後截斷」的輸出不是不動點
        // （落庫 200 字元、下載再跑一次變 199 字元）
        new string('a', 199) + " " + new string('b', 51),
        new string('a', 199) + "." + new string('b', 250),
    };

    [Theory]
    [MemberData(nameof(IdempotencyInputs))]
    public void SafeFileName_Idempotent(string raw)
    {
        // 下載防禦那一側的前提：寫入清理過的值得再跑一次結果相同。
        var once = AttachmentStore.SafeFileName(raw, "application/pdf");
        Assert.Equal(once, AttachmentStore.SafeFileName(once, "application/pdf"));
    }

    // 200 上限本身的判別力（R25）：上限整段拿掉時，冪等 theory 仍會全綠（見報告 §10 的突變實驗），
    // 這一支是唯一會紅的——它斷言的是實際輸出（截到 200、且保留副檔名），不是「再跑一次一樣」。
    [Fact]
    public void SafeFileName_Over200_TruncatedTo200_KeepingExtension()
    {
        var name = AttachmentStore.SafeFileName(new string('a', 250) + ".pdf", "application/pdf");
        Assert.Equal(new string('a', 196) + ".pdf", name);
        Assert.Equal(200, name.Length);
    }

    // content-type 不在副檔名表內 ⇒ 保底名不帶副檔名（miss 分支；斷言的是既有行為，不是新設計）。
    [Fact]
    public void SafeFileName_UnknownContentType_FallbackHasNoExtension()
    {
        Assert.Equal("attachment", AttachmentStore.SafeFileName("...", "application/octet-stream"));
    }

    // 截斷不得留下未配對的代理——切在 emoji 中間時守衛往左退一格，整對被排除，
    // 保證的是「輸出不含孤立代理」（不是「代理對原樣保留」）。
    [Theory]
    [InlineData(199, 60, "")]       // 無副檔名：切點 200 原本落在 emoji 的代理對中間
    [InlineData(195, 60, ".pdf")]   // 有副檔名：切點 196 原本落在 emoji 的代理對中間
    public void SafeFileName_HasNoLoneSurrogate(int prefix, int suffix, string extension)
    {
        var raw = new string('a', prefix) + "\U0001F600" + new string('b', suffix) + extension;
        var name = AttachmentStore.SafeFileName(raw, "application/pdf");
        Assert.False(HasLoneSurrogate(name));
    }

    private static bool HasLoneSurrogate(string s)
    {
        for (var i = 0; i < s.Length; i++)
        {
            if (char.IsHighSurrogate(s[i]))
            {
                if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return true;
                i++;
            }
            else if (char.IsLowSurrogate(s[i])) return true;
        }
        return false;
    }
}
