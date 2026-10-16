using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

public class AuthUserCreationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public AuthUserCreationTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        factory.WithDbReset(); // 見 Step 2 的 factory 擴充
    }

    private JsonContent Body(object o) => JsonContent.Create(o);

    [Fact]
    public async Task Admin_CreatesUser()
    {
        var client = _factory.CreateClient();
        var adminToken = await GetAdminTokenAsync(client);

        client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var response = await client.PostAsync("/api/auth/users", Body(new
        {
            username = "alice",
            password = "Password1!",
            displayName = "王小明"
        }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Admin_CreatesUser_WithLongDisplayName_Returns400()
    {
        var client = _factory.CreateClient();
        var adminToken = await GetAdminTokenAsync(client);

        client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var response = await client.PostAsync("/api/auth/users", Body(new
        {
            username = "longname",
            password = "Password1!",
            displayName = new string('長', 101)
        }));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Admin_CreatesUser_WithEmptyUsername_Returns400()
    {
        var client = _factory.CreateClient();
        var adminToken = await GetAdminTokenAsync(client);

        client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var response = await client.PostAsync("/api/auth/users", Body(new
        {
            username = "",
            password = "Password1!",
            displayName = "空帳號"
        }));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Admin_CreatesUser_WithMissingDisplayName_Returns400()
    {
        var client = _factory.CreateClient();
        var adminToken = await GetAdminTokenAsync(client);

        client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var response = await client.PostAsync("/api/auth/users", Body(new
        {
            username = "nodisplay",
            password = "Password1!"
        }));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // 站點 A：`POST /api/auth/users` 的「必須是 admin claim」守衛是**手寫**的
    // （`AuthEndpoints.cs`，不是 `RequirePermission` 篩選器）。判別力：只斷言 403 的話，
    // 改動前（`Results.Forbid()`，空 body）與改動後（帶 body）都是綠的。
    [Fact]
    public async Task NonAdmin_CreatesUser_Returns403WithPermissionDeniedBody()
    {
        var client = _factory.CreateClient();
        var adminToken = await GetAdminTokenAsync(client);
        client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        await client.PostAsync("/api/auth/users", Body(new
        {
            username = "nonadmin",
            password = "Password1!",
            displayName = "非管理員"
        }));

        var login = await client.PostAsync("/api/auth/login", JsonContent.Create(new
        {
            username = "nonadmin",
            password = "Password1!"
        }));
        var nonAdminToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        var nonAdminClient = _factory.CreateClient();
        nonAdminClient.DefaultRequestHeaders.Authorization = new("Bearer", nonAdminToken);
        var response = await nonAdminClient.PostAsync("/api/auth/users", Body(new
        {
            username = "shouldnotexist",
            password = "Password1!",
            displayName = "不該被建立"
        }));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("permission.denied", body.GetProperty("code").GetString());
        Assert.Equal("你沒有存取這個資源的權限", body.GetProperty("message").GetString());
    }

    private async Task<string> GetAdminTokenAsync(HttpClient client)
    {
        // 第一個管理員由 AdminSeed 建立（appsettings: Seed:AdminUsername / AdminPassword）
        var seed = _factory.SeedCredentials();
        var r = await client.PostAsync("/api/auth/login", JsonContent.Create(new
        {
            username = seed.Username,
            password = seed.Password
        }));
        var json = await r.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("accessToken").GetString()!;
    }
}
