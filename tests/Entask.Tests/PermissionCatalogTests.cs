using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;

namespace Entask.Tests;

public class PermissionCatalogTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public PermissionCatalogTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task PermissionCatalog_RequiresAuth_And_ReturnsFullCatalog()
    {
        var anonymous = await _client.GetAsync("/api/permissions");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);

        var catalog = await _client.GetAsync("/api/permissions");
        Assert.Equal(HttpStatusCode.OK, catalog.StatusCode);
        var items = await catalog.Content.ReadFromJsonAsync<JsonElement>();
        // 以正典清單為準，避免每次新增權限碼都要改這裡
        Assert.Equal(PermissionCodes.All.Length, items.GetArrayLength());
        Assert.Contains(items.EnumerateArray(), p =>
            p.GetProperty("code").GetString() == "card.review");
        Assert.Contains(items.EnumerateArray(), p =>
            p.GetProperty("code").GetString() == "card.comment");
        Assert.Contains(items.EnumerateArray(), p =>
            p.GetProperty("code").GetString() == "mindmap.edit");
    }
}
