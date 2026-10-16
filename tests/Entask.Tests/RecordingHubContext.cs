using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace Entask.Tests;

/// <summary>
/// SignalR 廣播的測試替身。
///
/// 為什麼要手寫：`IHubContext&lt;THub&gt;` 是介面，而本測試專案**沒有任何 mocking 函式庫**
/// （只有 xunit、Mvc.Testing、coverlet、Test.Sdk），所以只能自己實作。
///
/// ★ **每一個 `IHubClients` 成員都記錄，不是只記錄 `Group`**。這不是完備癖：實查
/// `src/Entask.Api` 之後發現 `Clients.User(...)` 另有六處在用（留言、審查、工時、指派），
/// 若替身對它拋例外，受傷的是一整批**與本功能無關**的既有測試。反過來說，也**不可以
/// 讓任何成員變成靜默 no-op**——那會讓「端點換了一種寫法」變成靜默通過（廣播沒有發生，
/// 而斷言恆綠）。
///
/// 唯一拋例外的是 `Groups`（`IGroupManager`）：全庫沒有端點用到它，留著當金絲雀——
/// 哪天有人開始用，這裡會當場紅，而不是靜默少記錄一筆。
///
/// 註冊為 singleton（見 <c>ApiWebApplicationFactory</c>），所以記錄會跨測試累積；
/// 每支測試開頭呼叫 <see cref="Clear"/>。
/// </summary>
public sealed class RecordingHubContext : IHubContext<Entask.Api.Hubs.CollaborationHub>
{
    /// <summary>
    /// 一次廣播。<paramref name="Kind"/> 是收件者種類（"group"／"user"／"all"／…），
    /// <paramref name="Target"/> 是原始名稱（例如 <c>board:{guid}</c> 或使用者 id）。
    /// 兩者分開是刻意的：只留一個字串欄位的話，「群組恰好叫 user」與「真的送給某個使用者」
    /// 在斷言裡長得一樣。
    ///
    /// <paramref name="Payload"/> 是 <c>args[0]</c> 序列化後的結果——端點送的是匿名物件，
    /// 序列化成 <see cref="JsonElement"/> 之後測試才能像其他測試檔一樣用
    /// <c>GetProperty("cardId")</c> 讀欄位（匿名型別本身在測試裡沒有名字可 cast）。
    /// 預設選項不套 camelCase 原則，而端點宣告的屬性名本來就是小寫，故鍵名逐字等於宣告。
    /// </summary>
    public sealed record Broadcast(string Kind, string Target, string Method, JsonElement Payload);

    private readonly List<Broadcast> _broadcasts = new();
    private readonly object _gate = new();

    public RecordingHubContext()
    {
        Clients = new RecordingHubClients(this);
    }

    public IHubClients Clients { get; }

    public IGroupManager Groups =>
        throw new NotImplementedException("測試替身不支援 Groups：全庫目前沒有端點用到它，用到就代表這裡要補");

    /// <summary>目前為止的廣播（複本，可安全列舉）。</summary>
    public IReadOnlyList<Broadcast> Broadcasts
    {
        get { lock (_gate) return _broadcasts.ToArray(); }
    }

    public void Clear()
    {
        lock (_gate) _broadcasts.Clear();
    }

    private void Record(string kind, string target, string method, object? payload)
    {
        var element = JsonSerializer.SerializeToElement(payload);
        lock (_gate) _broadcasts.Add(new Broadcast(kind, target, method, element));
    }

    private sealed class RecordingHubClients : IHubClients
    {
        private readonly RecordingHubContext _owner;

        public RecordingHubClients(RecordingHubContext owner) => _owner = owner;

        public IClientProxy Group(string groupName) => Proxy("group", groupName);
        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) =>
            Proxy("group-except", groupName);
        public IClientProxy Groups(IReadOnlyList<string> groupNames) =>
            Proxy("groups", string.Join(",", groupNames));
        public IClientProxy All => Proxy("all", "");
        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => Proxy("all-except", "");
        public IClientProxy Client(string connectionId) => Proxy("client", connectionId);
        public IClientProxy Clients(IReadOnlyList<string> connectionIds) =>
            Proxy("clients", string.Join(",", connectionIds));
        public IClientProxy User(string userId) => Proxy("user", userId);
        public IClientProxy Users(IReadOnlyList<string> userIds) =>
            Proxy("users", string.Join(",", userIds));

        private IClientProxy Proxy(string kind, string target) =>
            new RecordingClientProxy(_owner, kind, target);
    }

    private sealed class RecordingClientProxy : IClientProxy
    {
        private readonly RecordingHubContext _owner;
        private readonly string _kind;
        private readonly string _target;

        public RecordingClientProxy(RecordingHubContext owner, string kind, string target)
        {
            _owner = owner;
            _kind = kind;
            _target = target;
        }

        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
        {
            _owner.Record(_kind, _target, method, args.Length > 0 ? args[0] : null);
            return Task.CompletedTask;
        }
    }
}
