using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class AttachmentTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AttachmentTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<string> SetupCardAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "附件測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "附件測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "附件板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var card = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "附件卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return card.GetProperty("id").GetString()!;
    }

    private async Task<JsonElement> UploadAsync(string cardId, string content, string contentType, string fileName)
    {
        using var form = new MultipartFormDataContent();
        var bytes = System.Text.Encoding.UTF8.GetBytes(content);
        form.Add(new ByteArrayContent(bytes) { Headers = { ContentType = new(contentType) } }, "file", fileName);
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", form);
        return await resp.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Attachment_UploadDownloadSetCoverDelete_Works()
    {
        var cardId = await SetupCardAsync();

        // 上傳 PNG
        var att = await UploadAsync(cardId, "fake-image-bytes", "image/png", "cover.png");
        var attId = att.GetProperty("id").GetString()!;
        Assert.Equal("cover.png", att.GetProperty("fileName").GetString());

        // 下載
        var dl = await _client.GetAsync($"/api/attachments/{attId}");
        Assert.Equal(HttpStatusCode.OK, dl.StatusCode);

        // 設封面
        var covered = await (await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { coverAttachmentId = attId }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(attId, covered.GetProperty("coverAttachmentId").GetString());

        // 刪附件 → 封面自動清除
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/cards/{cardId}/attachments/{attId}")).StatusCode);
        var after = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, after.GetProperty("coverAttachmentId").ValueKind);
    }

    [Fact]
    public async Task Attachment_NonImageCover_Returns400()
    {
        var cardId = await SetupCardAsync();
        var pdf = await UploadAsync(cardId, "%PDF-fake", "application/pdf", "doc.pdf");
        var resp = await _client.PutAsync($"/api/cards/{cardId}",
            JsonContent.Create(new { coverAttachmentId = pdf.GetProperty("id").GetString() }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Attachment_DisallowedType_Returns400()
    {
        var cardId = await SetupCardAsync();
        using var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent(new byte[] { 1, 2, 3 }) { Headers = { ContentType = new("application/x-msdownload") } }, "file", "evil.exe");
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", form);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Attachment_CrossCardDelete_Returns404()
    {
        var cardId = await SetupCardAsync();
        var att = await UploadAsync(cardId, "x", "image/png", "a.png");
        var attId = att.GetProperty("id").GetString()!;

        // 同列表另一張卡
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var card = db.Cards.First(c => c.Id == Guid.Parse(cardId));
            var other = new Core.Entities.Card { Id = Guid.NewGuid(), ListId = card.ListId, Title = "別卡", Position = "z", CreatedById = card.CreatedById };
            db.Cards.Add(other);
            await db.SaveChangesAsync();
            var otherId = other.Id;
            var resp = await _client.DeleteAsync($"/api/cards/{otherId}/attachments/{attId}");
            Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        }
    }

    [Fact]
    public async Task CardDelete_RemovesAttachmentFilesFromDisk()
    {
        var cardId = await SetupCardAsync();
        var att = await UploadAsync(cardId, "disk-test", "image/png", "d.png");

        string storagePath;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            storagePath = db.Attachments.First(a => a.Id == Guid.Parse(att.GetProperty("id").GetString()!)).StoragePath;
        }
        // WebApplicationFactory 的內容根目錄為 API 專案目錄，非測試主機 AppContext.BaseDirectory；
        // 以 IWebHostEnvironment.ContentRootPath 組出絕對路徑檢查
        var env = _factory.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.IWebHostEnvironment>();
        var root = Path.GetDirectoryName(Path.GetFullPath(Path.Combine(env.ContentRootPath, storagePath)))!;
        Assert.True(Directory.Exists(root));
        var fullPath = Path.Combine(env.ContentRootPath, storagePath);
        Assert.True(File.Exists(fullPath));

        await _client.DeleteAsync($"/api/cards/{cardId}");
        Assert.False(File.Exists(fullPath));
    }

    // P4：全域 Kestrel 上限收緊至 1MiB 後，附件上傳端點需以 per-endpoint 上限豁免
    // （RequestSizeLimitAttribute → IRequestSizeLimitMetadata，RequestDelegateFactory 於 binding 前套用）。
    [Fact]
    public void AttachmentUpload_CarriesPerEndpointSizeLimit()
    {
        var dataSource = _factory.Services.GetRequiredService<EndpointDataSource>();
        var endpoint = dataSource.Endpoints
            .OfType<RouteEndpoint>()
            .First(e => e.RoutePattern.RawText == "/api/cards/{cardId:guid}/attachments");
        var metadata = endpoint.Metadata.GetMetadata<IRequestSizeLimitMetadata>();
        Assert.NotNull(metadata);
        Assert.Equal(135_266_304, metadata!.MaxRequestBodySize);
    }
}
