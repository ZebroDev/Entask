using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

// `Storage:AvatarsPath` 要真的接通**三個站點**——上傳寫入、讀取、刪除（2026-09-28）。
//
// 為什麼 `AvatarPathResolutionTests` 不夠：那個函式本身對，不等於三個處理常式都拿到了它
// （`IConfiguration` 有沒有被 minimal API 注入進參數列，只有從 HTTP 走一遍才算數）。
//
// **它需要自己的 factory**：覆寫必須在第一支 `CreateClient()` 之前設，而 `IClassFixture`
// 的 host 一個類別只建置一次（且每個測試類別各拿到一份實例）⇒ 與 `AvatarTests` 共用
// 等於把覆寫帶給那一類的每一支，而那裡驗的正是**預設目錄**那條路。
//
// **這個類別刻意只有一支測試**：xUnit 每個測試方法各建一個實例 ⇒ 建構子會拿到一個新的
// `_avatarsRoot`，但 host 早在第一支 `CreateClient()` 時就用**第一個**目錄建好了
// ⇒ 第二支測試會對著一個空的暫存目錄斷言（紅得莫名其妙，而且成因不在它看起來的地方）。
// 要拆成多支就得讓目錄是 static、連帶讓它們互相污染殘檔；一輪掃過三個站點更乾淨。
//
// 判別力（三格各自）：三個呼叫端任一個忽略設定 ⇒ ① 紅；讀取走回預設目錄 ⇒ ② 紅；
// 刪除只清 `user.AvatarUrl` 而沒刪檔 ⇒ ③ 紅。
public class AvatarStoragePathTests : IClassFixture<ApiWebApplicationFactory>, IDisposable
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;
    private readonly string _avatarsRoot;

    public AvatarStoragePathTests(ApiWebApplicationFactory factory)
    {
        // 暫存目錄：不污染 repo 的工作樹（預設那條路寫的是 `src/Entask.Api/storage/avatars`，
        // 那是這條路要驗的**另一邊**，兩者混在一起就分不出設定有沒有生效）。
        _avatarsRoot = Path.Combine(Path.GetTempPath(), "entask-avatar-storage-" + Guid.NewGuid().ToString("N"));
        factory.AvatarsPathOverride = _avatarsRoot;
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    public void Dispose()
    {
        if (Directory.Exists(_avatarsRoot)) Directory.Delete(_avatarsRoot, recursive: true);
        GC.SuppressFinalize(this);
    }

    private static MultipartFormDataContent PngContent()
    {
        // 1x1 透明 PNG（與 `AvatarTests` 同一份素材）
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
        var content = new MultipartFormDataContent();
        var streamContent = new StreamContent(new MemoryStream(png));
        streamContent.Headers.ContentType = new("image/png");
        content.Add(streamContent, "file", "avatar.png");
        return content;
    }

    [Fact]
    public async Task Upload_Fetch_Delete_AllUseTheConfiguredRoot()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

        // ① 上傳寫入：檔案真的落在覆寫的目錄，而且只有一個
        var upload = await _client.PutAsync("/api/me/avatar", PngContent());
        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
        var avatarUrl = (await upload.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("avatarUrl").GetString()!;

        Assert.True(Directory.Exists(_avatarsRoot),
            $"覆寫的目錄不存在——上傳沒有走 Storage:AvatarsPath（{_avatarsRoot}）");
        var stored = Directory.GetFiles(_avatarsRoot);
        Assert.Single(stored);
        Assert.Equal(Path.GetFileName(avatarUrl), Path.GetFileName(stored[0]));

        // ② 讀取：從同一個目錄回應（預設目錄那邊沒有這個檔，走錯邊就是 404）
        var fetch = await _client.GetAsync(avatarUrl);
        Assert.Equal(HttpStatusCode.OK, fetch.StatusCode);
        Assert.Equal("image/png", fetch.Content.Headers.ContentType?.MediaType);

        // ③ 刪除：檔案從同一個目錄消失（不是只把 `user.AvatarUrl` 清成 null）
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync("/api/me/avatar")).StatusCode);
        Assert.Empty(Directory.GetFiles(_avatarsRoot));
        Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync(avatarUrl)).StatusCode);
    }
}
