using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using Entask.Core.Entities;

namespace Entask.Api.Endpoints;

/// <summary>
/// 通知的建立與推播——四個寫入點唯一的出口。
///
/// 存在的理由不是省行數，是**兩件事只能在一處發生**：
/// ① 新的列不寫散文（`Title` / `Message` 為 null，文案由前端依 kind 渲染）；
/// ② REST 與 SignalR 送**同一組欄位**（兩份手寫的匿名物件正是 P-C 之前
///    `time = "剛剛"` 只在 SignalR 那一份寫死、REST 送另一種格式的成因）。
/// </summary>
internal static class NotificationPayloads
{
    private static readonly JsonSerializerOptions Options = new()
    {
        // 不以 \uXXXX 轉義：payload 是給人看的診斷素材（DB 裡直接讀得到中文人名與卡片標題）。
        // 對 JSON 的語意沒有影響——前端兩種都解得開。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static Notification Create(Guid userId, string type, string kind, object payload, string? link) => new()
    {
        UserId = userId,
        Type = type,
        Kind = kind,
        Payload = JsonSerializer.Serialize(payload, Options),
        Link = link,
    };

    /// <summary>
    /// REST 的列與 SignalR 的酬載——**兩邊共用這一個產生器**。
    ///
    /// 端點務必直接以它投影，不要手寫第二份匿名物件：P-C 之前 `time = "剛剛"` 只在
    /// SignalR 那一份寫死、REST 送另一種格式，成因就是兩份手寫物件各自漂移。
    /// 欄位名一律小寫——hub 的序列化命名原則不影響它們，
    /// 不必去猜 `JsonHubProtocol` 用的是哪一組 options（既有的四個站點本來就是這個寫法）。
    /// </summary>
    public static object Push(Notification n) => new
    {
        id = n.Id.ToString(),
        type = n.Type,
        kind = n.Kind,
        payload = Parse(n.Payload),
        // ISO 8601 UTC。`"o"` 的輸出本身與文化無關，但一律明示 InvariantCulture
        // （P21 泰曆年份事件的護欄形狀：非西曆主機文化會讓 ToString 印出 2569）。
        createdAt = n.CreatedAt.ToString("o", CultureInfo.InvariantCulture),
        read = n.IsRead,
        link = n.Link,
        title = n.Title,
        message = n.Message,
    };

    /// <summary>DB 的 jsonb 文字 → <see cref="JsonElement"/>；null／空字串 → null。</summary>
    /// <remarks>
    /// 一定要 <c>Clone()</c>：<see cref="JsonDocument"/> 解構後它的 <c>RootElement</c> 就失效，
    /// 而這個元素會被裝進匿名物件、在序列化時才被讀取。
    /// </remarks>
    public static JsonElement? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }
}
