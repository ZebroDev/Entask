namespace Entask.Tests;

public class HealthTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public HealthTests(ApiWebApplicationFactory factory)
    {
        // App 啟動會跑 AdminSeed（需 Identity tables），故每個測試 class 的 host 都要先重置 DB
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Health_ReturnsOk()
    {
        var response = await _client.GetAsync("/api/health");
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"ok\"", body);
    }
}
