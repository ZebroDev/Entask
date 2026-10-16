using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Entask.Core;

namespace Entask.Api.Endpoints;

/// <summary>
/// 匯出檔的標籤表——伺服器端的資源檔（`src/Entask.Api/Resources/export.&lt;locale&gt;.json`，
/// 內嵌資源）。識別碼在 <see cref="Entask.Core.ExportKeys"/>，文案在這裡。
///
/// **語系清單來自資源檔的檔名**，不另外維護一份：新增一個語系＝放一個檔案。
/// 這條路徑是刻意的——寫死的清單會在新增語系時忘記更新，而「忘記更新的清單」正是
/// 這個設計要防的東西（與 `check-locale-parity.mjs` 解析 `SUPPORTED_LOCALES` 同一個理由）。
/// </summary>
internal sealed class ExportLabels
{
    /// <summary>來源語系。前端的 `DEFAULT_LOCALE`（`web/src/i18n/locales.ts`）是同一件事的
    /// 另一份宣告——兩者不同步時的行為是「匯出用中文」，不影響正確性。</summary>
    private const string Default = "zh-TW";

    private readonly Dictionary<string, string> _values;

    private ExportLabels(Dictionary<string, string> values) => _values = values;

    /// <summary>
    /// 缺 key 時回識別碼本身，讓它在匯出檔裡看得見而不是靜默變空白
    /// （與前端標籤表「認不得的原樣顯示」同一條規則）。正常情況下取不到值代表程式碼有錯，
    /// 因為 parity 的檢查 11 已經把常數集與資源檔的 key 集綁在一起。
    /// </summary>
    public string this[string key] => _values.TryGetValue(key, out var v) ? v : key;

    /// <summary>
    /// 複製後的預設名稱樣板（`{{name}}` 是原標題）——`CopyEndpoints` 用，由呼叫端帶進
    /// `IBoardCopyService`（`Entask.Board` 不可引用本專案，所以跨過去的是**已解析的字串**，
    /// 不是語系）。留在這裡是為了讓 key 只出現一次。
    /// </summary>
    public static string CopyNameFormat(string? locale) => For(locale)[ExportKeys.CopyName];

    /// <summary>帶佔位名的標籤（目前只有 `rating.suffix`）。未知的佔位名原樣留下——看得見。</summary>
    public string Format(string key, params (string Name, string Value)[] args)
    {
        var text = this[key];
        foreach (var (name, value) in args)
            text = text.Replace($"{{{{{name}}}}}", value, StringComparison.Ordinal);
        return text;
    }

    private static readonly ConcurrentDictionary<string, ExportLabels> Cache = new(StringComparer.Ordinal);

    /// <summary>同一個語系只讀一次資源檔（`GetOrAdd` 的 factory 可能被呼叫兩次，代價只是多解一次 JSON）。</summary>
    public static ExportLabels For(string? locale) => Cache.GetOrAdd(Resolve(locale), Load);

    /// <summary>認不得的語系回預設語系，**不是 400**——`?locale=` 來自瀏覽器，
    /// 讓整份匯出失敗比給一份看得懂的預設語系更糟（設計 §6.2）。</summary>
    private static string Resolve(string? locale)
    {
        if (string.IsNullOrWhiteSpace(locale)) return Default;
        foreach (var name in Available.Value)
            if (string.Equals(name, locale, StringComparison.OrdinalIgnoreCase)) return name;
        return Default;
    }

    /// <summary>檔名即語系清單（`….export.&lt;locale&gt;.json`）。</summary>
    private static readonly Lazy<string[]> Available = new(() =>
        Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Select(n => Regex.Match(n, @"\.export\.([^.]+)\.json$"))
            .Where(m => m.Success)
            .Select(m => m.Groups[1].Value)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray());

    private static ExportLabels Load(string locale)
    {
        var suffix = $".export.{locale}.json";
        var resource = Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith(suffix, StringComparison.Ordinal))
            ?? throw new InvalidOperationException(
                $"找不到內嵌資源 {suffix}——請確認 Entask.Api.csproj 仍有 <EmbeddedResource Include=\"Resources\\export.*.json\" />。");

        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)!;
        var values = JsonSerializer.Deserialize<Dictionary<string, string>>(stream)
            ?? throw new InvalidOperationException($"{suffix} 不是一個扁平的 key → 字串物件。");
        return new ExportLabels(values);
    }
}
