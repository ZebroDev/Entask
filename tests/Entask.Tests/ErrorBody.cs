using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

public static class ErrorBody
{
    /// <summary>讀 404（或任何帶 {code} 的）回應 body 的 code；沒有 body 時丟 JsonException。</summary>
    public static async Task<string?> CodeOfAsync(HttpResponseMessage resp)
        => (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString();
}
