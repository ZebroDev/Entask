using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Entask.Api.Endpoints;
using Entask.Core;
using Entask.Core.Abstractions;

namespace Entask.Tests;

// 500 家族（本階段）。**改動前未處理的例外是空 body**（框架預設只送狀態碼），所以這一檔
// 的前四支在改動前都紅——但它們紅在**形狀**上（讀不到 body），不是紅在文案上。
//
// 到達方式：這一批沒有為測試開任何後門。`Program.cs` 的中介層是管線層的，要讓它響就得
// 真的丟一個例外出來，而全庫唯一「在同一條請求路徑上、沒有 try/catch、可用 DI 換掉」的
// 站點是 `AttachmentEndpoints.cs` 下載路徑的 `store.OpenRead(...)`（`:112`，前面只有
// `Exists` 的檢查）。本檔把 `IAttachmentStore` 換成一個「`Exists` 回 true、`OpenRead` 丟例外」
// 的實作——上傳時 `SaveAsync` 回的 `StoredFile` 只是一組欄位（`StoragePath`／`Size`），
// 所以整個流程不會碰到任何真實檔案。
//
// **刻意不斷言 `message` 的字面值**（同 `AuthErrorBodyTests`／`PermissionDeniedBodyTests`）：
// 那是產品文案，改字是產品決定，由閘門 B（`check:error-messages`：`ErrorMessages.cs` ↔ zh-TW
// 語系值）與閘門 C（`check:message-values`）擁有。這一檔釘的是**形狀**：狀態碼、
// Content-Type、`code`、body 的成員集合、**沒有例外細節**，以及產生點只有一個。
public class InternalErrorBodyTests : IClassFixture<UnhandledExceptionFactory>
{
    private const string InternalErrorCode = "server.internalError";

    // 洩漏偵測用的哨兵。外層與內層刻意不同字串：只擋住其中一種的實作要能被分辨出來。
    private const string OuterSentinel = "LEAK-OUTER-7f3a";
    private const string InnerSentinel = "LEAK-INNER-91c2";

    private readonly UnhandledExceptionFactory _factory;
    private readonly HttpClient _client;

    public InternalErrorBodyTests(UnhandledExceptionFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    // ① 使用者要的那一條：未處理的例外必須回 500 ＋ `{ code, message }`。
    [Fact]
    public async Task UnhandledException_ReturnsInternalErrorBody()
    {
        var response = await SendThrowingRequestAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("application/json; charset=utf-8", response.Content.Headers.ContentType?.ToString());

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(InternalErrorCode, doc.RootElement.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(doc.RootElement.GetProperty("message").GetString()));

        // 訊息必須來自那張表（單一來源），不是站點自己又寫一份字面值——這一批的收斂
        // 做的正是這件事，而閘門 B 只守「表 ↔ 語系值」這一半，守不到「產生點有沒有查表」。
        // 刻意比對**表的輸出**而不是字串字面值：改文案時這一條不會紅（那是產品決定）。
        Assert.Equal(ErrorMessages.For(ErrorCodes.ServerInternalError),
            doc.RootElement.GetProperty("message").GetString());
    }

    // ② body 的成員集合是契約的一部分。多一個欄位（`detail`、`stackTrace`、`traceId`…）
    // 就是一個新的洩漏面，而 ① 只看 `code`／`message` 兩個鍵、看不到多出來的東西。
    [Fact]
    public async Task UnhandledException_BodyHasExactlyTwoProperties()
    {
        var response = await SendThrowingRequestAsync();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var names = doc.RootElement.EnumerateObject().Select(p => p.Name).OrderBy(n => n).ToArray();
        Assert.Equal(new[] { "code", "message" }, names);
    }

    // ③ 不得外洩例外細節（設計 §4.4；security 規則：錯誤訊息不洩漏敏感資料）。
    // 三個層次都驗：訊息本文、型別名稱、堆疊框架。
    [Fact]
    public async Task UnhandledException_DoesNotLeakExceptionDetail()
    {
        var response = await SendThrowingRequestAsync();
        var raw = await response.Content.ReadAsStringAsync();

        // 外層與內層的 Message——`ex.ToString()`／`ex.InnerException.Message` 都會漏這兩個。
        Assert.DoesNotContain(OuterSentinel, raw);
        Assert.DoesNotContain(InnerSentinel, raw);

        // 型別名稱——`ex.GetType().Name` 或預設的 ProblemDetails 標題會漏這個。
        Assert.DoesNotContain(nameof(InvalidOperationException), raw);
        Assert.DoesNotContain(nameof(ApplicationException), raw);

        // 堆疊框架與宣告型別——`ex.StackTrace` 會漏這兩個。
        Assert.DoesNotContain("   at ", raw);
        Assert.DoesNotContain(nameof(InternalErrorBodyTests), raw);
    }

    // ④ 兩個**不同**的例外必須產生**逐位元相同**的 body。
    // 判別力：只驗一支請求的話，「訊息取自例外」與「訊息是固定字面值」兩種實作在
    // ① ② ③ 下都可能是綠的——這一條把「依例外而變」變成看得到的紅燈。
    // （形狀對照 `PermissionDeniedBodyTests` 的兩條路徑逐字比對、`AuthErrorBodyTests`
    //   的三條登入路徑逐字比對。）
    [Fact]
    public async Task TwoDifferentExceptions_ProduceByteIdenticalBodies()
    {
        var first = await (await SendThrowingRequestAsync(LeakException())).Content.ReadAsByteArrayAsync();

        var second = await (await SendThrowingRequestAsync(
            () => new ArgumentOutOfRangeException("OTHER-PARAM-4d19", "OTHER-MSG-8b57")))
            .Content.ReadAsByteArrayAsync();

        Assert.Equal(first, second);
    }

    // ⑤ 「兩個入口、一個 wire 形狀」——`ApiResults.cs` 的類別註解對這一點寫了「逐位元相同」
    // 的斷言，而在此之前那是**推論、未實測**：中介層走 `WriteInternalErrorAsync`（HttpContext 側），
    // 端點走 `InternalError`（IResult 側）。少了這一條，兩個入口各自漂移不會有任何紅燈，
    // 而其中一側（端點側的三個碼）在今天的測試裡幾乎到不了。
    [Fact]
    public async Task ExceptionBody_MatchesTheEndpointEntryPoint()
    {
        var response = await SendThrowingRequestAsync();
        var fromMiddleware = await response.Content.ReadAsByteArrayAsync();

        var (status, fromEndpoint) = await InvokeInternalErrorAsync(InternalErrorCode);

        Assert.Equal(StatusCodes.Status500InternalServerError, status);
        Assert.Equal(fromEndpoint, fromMiddleware);
    }

    // ⑥ 500 的**四個碼**（一個中介層的 ＋ 三個收斂進來的）都必須由同一個產生點產生，
    // 且各自的訊息互不相同——「四個碼共用一句話」與「碼被吃掉、一律回 server.internalError」
    // 這兩種退化在 ①～⑤ 下都是綠的（那五支只看得到 server.internalError 這一個碼）。
    [Fact]
    public async Task InternalError_AllFourCodes_EchoCodeAndCarryDistinctMessages()
    {
        string[] codes =
        [
            ErrorCodes.ServerInternalError,
            ErrorCodes.UserUpdateFailed,
            ErrorCodes.UserDeleteFailed,
            ErrorCodes.AuthAdminGrantFailed,
        ];

        var messages = new List<string>();
        foreach (var code in codes)
        {
            var (status, body) = await InvokeInternalErrorAsync(code);

            Assert.Equal(StatusCodes.Status500InternalServerError, status);
            using var doc = JsonDocument.Parse(body);
            Assert.Equal(code, doc.RootElement.GetProperty("code").GetString());

            var message = doc.RootElement.GetProperty("message").GetString();
            Assert.False(string.IsNullOrWhiteSpace(message));
            messages.Add(message!);
        }

        // 四個碼必須有四句不同的話。`Assert.Equal(4, messages.Distinct().Count())` 同時擋住
        // 「全部折成一句」與「其中兩個碼指到同一個臂」。
        Assert.Equal(codes.Length, messages.Distinct().Count());
    }

    // ---- helpers ----

    /// <summary>帶兩個哨兵的例外——測試 ③ 的洩漏偵測與測試 ④ 的第一個輸入都用它。</summary>
    private static Func<Exception> LeakException()
        => () => new InvalidOperationException(OuterSentinel, new ApplicationException(InnerSentinel));

    /// <summary>
    /// 每一次都**明確指派**例外（沒有參數時指回哨兵那一組）。這不是潔癖：xUnit 同一個類別的
    /// 測試執行順序未定義，少了這一行，測試 ④ 留下的 `ArgumentOutOfRangeException` 會依
    /// 執行順序滲進測試 ③——那麼 ③ 是否驗到 `OuterSentinel` 就取決於誰先跑。
    /// </summary>
    private async Task<HttpResponseMessage> SendThrowingRequestAsync(Func<Exception>? exception = null)
    {
        _factory.NextException = exception ?? LeakException();
        var cardId = await SetupCardAsync();
        var attachmentId = await UploadAsync(cardId);
        // 下載路徑：`Exists` 回 true（不觸發 404），接著 `OpenRead` 丟出 `_factory.NextException()`。
        return await _client.GetAsync($"/api/attachments/{attachmentId}");
    }

    /// <summary>
    /// 在**不經過伺服器**的前提下執行端點側的產生點。`Results.Json(...)` 需要一個有
    /// `RequestServices` 的 `HttpContext`（它從那裡解析 `JsonOptions`），所以這裡建一個
    /// 最小容器——`AddLogging` ＋ `AddOptions` 就是它要的全部。
    /// </summary>
    private static async Task<(int Status, byte[] Body)> InvokeInternalErrorAsync(string code)
    {
        var services = new ServiceCollection().AddLogging().AddOptions().BuildServiceProvider();
        using var body = new MemoryStream();
        var context = new DefaultHttpContext { RequestServices = services };
        context.Response.Body = body;

        await ApiResults.InternalError(code).ExecuteAsync(context);

        return (context.Response.StatusCode, body.ToArray());
    }

    private async Task<string> SetupCardAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "500 測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "500 測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "500 板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var card = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "500 卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return card.GetProperty("id").GetString()!;
    }

    private async Task<string> UploadAsync(string cardId)
    {
        using var form = new MultipartFormDataContent();
        var bytes = Encoding.UTF8.GetBytes("fake-image-bytes");
        form.Add(new ByteArrayContent(bytes) { Headers = { ContentType = new("image/png") } }, "file", "cover.png");
        var resp = await _client.PostAsync($"/api/cards/{cardId}/attachments", form);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var att = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return att.GetProperty("id").GetString()!;
    }
}

/// <summary>
/// 把 <see cref="IAttachmentStore"/> 換成一個「上傳照常、下載必定丟例外」的實作，
/// 用來讓 `Program.cs` 的全域例外中介層在**真實的請求路徑**上被觸發。
///
/// <para>
/// `NextException` 是 <c>Func&lt;Exception&gt;</c> 而不是一個實例：同一個例外物件被丟第二次時
/// 堆疊會疊上去，而測試 ④ 要的是「兩個**不同**的例外」，用同一個實例等於在測同一個東西。
/// </para>
/// <para>
/// 狀態放在 fixture 實例上、不用 static：xUnit 同一個測試類別的測試是**循序**執行的，
/// 而這個 fixture 只服務這一個類別（`IClassFixture`），所以不需要額外的同步。
/// </para>
/// </summary>
public class UnhandledExceptionFactory : ApiWebApplicationFactory
{
    /// <summary>下一個要被丟出來的例外。每次取值都建一個新的——見測試檔對堆疊疊加的說明。</summary>
    public Func<Exception> NextException { get; set; } = () => new InvalidOperationException("unset");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // 必須先呼叫：base 負責注入連線字串／JWT 設定與 DB 重置，漏掉它整類測試會在
        // 建構子以「ConnectionString property has not been initialized」紅。
        base.ConfigureWebHost(builder);

        builder.ConfigureServices(services =>
        {
            // `RemoveAll` 而不是再加一個：`AddScoped<IAttachmentStore, AttachmentStore>()` 是
            // 後註冊者勝，但留著舊註冊會讓「換不掉」在讀者眼中看不出來。
            services.RemoveAll<IAttachmentStore>();
            services.AddSingleton<IAttachmentStore>(new ThrowingAttachmentStore(this));
        });
    }

    private sealed class ThrowingAttachmentStore(UnhandledExceptionFactory factory) : IAttachmentStore
    {
        // 上傳路徑只用到這組回傳值填 `Attachment` 的欄位（`StoragePath`／`Size`），
        // 所以這裡回一組合成的值即可——整個測試不會建立或讀取任何真實檔案。
        public Task<StoredFile> SaveAsync(Stream content, string extension)
            => Task.FromResult(new StoredFile($"throwing-store/{Guid.NewGuid():N}{extension}", 0));

        public void Delete(string storagePath)
        {
        }

        // 下載端點在呼叫它之前只檢查了 `Exists`（`AttachmentEndpoints.cs:111`），
        // 沒有 try/catch——這就是這一檔要的那個「未處理的例外」。
        public Stream OpenRead(string storagePath) => throw factory.NextException();

        public bool Exists(string storagePath) => true;
    }
}
