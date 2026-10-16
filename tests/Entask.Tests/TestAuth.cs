using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

public static class TestAuth
{
    public static async Task<string> GetAdminTokenAsync(ApiWebApplicationFactory factory, HttpClient client)
    {
        var seed = factory.SeedCredentials();
        var r = await client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = seed.Username, password = seed.Password }));
        var json = await r.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("accessToken").GetString()!;
    }
}
