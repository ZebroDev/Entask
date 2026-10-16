using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class AvatarTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public AvatarTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static MultipartFormDataContent PngContent()
    {
        // 1x1 透明 PNG
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
        var content = new MultipartFormDataContent();
        var streamContent = new StreamContent(new MemoryStream(png));
        streamContent.Headers.ContentType = new("image/png");
        content.Add(streamContent, "file", "avatar.png");
        return content;
    }

    [Fact]
    public async Task Avatar_Upload_Fetch_Delete_Roundtrip()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        var upload = await _client.PutAsync("/api/me/avatar", PngContent());
        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
        var body = await upload.Content.ReadFromJsonAsync<JsonElement>();
        var avatarUrl = body.GetProperty("avatarUrl").GetString()!;
        Assert.StartsWith("/api/avatars/", avatarUrl);

        var fetch = await _client.GetAsync(avatarUrl);
        Assert.Equal(HttpStatusCode.OK, fetch.StatusCode);
        Assert.Equal("image/png", fetch.Content.Headers.ContentType?.MediaType);

        var delete = await _client.DeleteAsync("/api/me/avatar");
        Assert.Equal(HttpStatusCode.OK, delete.StatusCode);

        // 刪除後檔案應一併移除
        var afterDelete = await _client.GetAsync(avatarUrl);
        Assert.Equal(HttpStatusCode.NotFound, afterDelete.StatusCode);
        Assert.Equal(ErrorCodes.UserAvatarNotFound, await ErrorBody.CodeOfAsync(afterDelete));
    }

    [Fact]
    public async Task Avatar_Get_PathTraversal_ReturnsNotFound()
    {
        // 頭像 GET 為 AllowAnonymous，但仍不得讀出頭像目錄外的任何檔案。
        // 反斜線變體（%5C）於 Windows 上為路徑分隔符，修復前會 200 回傳 appsettings.json。
        foreach (var traversal in new[] { "../../appsettings.json", "..\\..\\appsettings.json" })
        {
            var traversalUrl = "/api/avatars/" + Uri.EscapeDataString(traversal);
            Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync(traversalUrl)).StatusCode);
        }
    }

    [Fact]
    public async Task Avatar_Get_DoubleEncodedPathTraversal_ReturnsNotFound()
    {
        // 雙重編碼遍歷攻擊（%252F 解碼一次得 %2F，再解碼得 /）——不得讀出頭像目錄外檔案。
        // 直接以字面路徑送出，避免 EscapeDataString 再次轉義 % 造成三重編碼而失去測試意義。
        Assert.Equal(HttpStatusCode.NotFound,
            (await _client.GetAsync("/api/avatars/..%252F..%252Fappsettings.json")).StatusCode);
    }

    [Fact]
    public async Task Avatar_Get_InvalidFileName_ReturnsNotFound()
    {
        // 非 {32 位 hex} 檔名一律拒絕（白名單），含編碼後的遍歷片段。
        // 遍歷變體需經 EscapeDataString，否則 HttpClient 會先把路徑正規化掉，測試等同沒打到端點。
        Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync("/api/avatars/malicious.png")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await _client.GetAsync("/api/avatars/" + Uri.EscapeDataString("../../malicious.png"))).StatusCode);
    }
}
