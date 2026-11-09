using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

// F-03（外部審查 2026-11-09）：撤權／停用後，既有 SignalR 連線必須立即失效。
// Hub 只在 JoinBoard／JoinProject 當下驗權，事件推送也不再逐次驗權；少了伺服器端的
// 連線處置，已失去權限但保持連線的使用者會繼續收到協作事件（cardId、移動、完成狀態）。
// 這裡用真的 SignalR client 連上 TestServer，釘住「撤權 → 連線被中止」這一行為。
public class CollaborationRevocationTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CollaborationRevocationTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task DeactivatedUser_ConnectedToProject_IsDisconnected()
    {
        var (projectId, userId, token) = await CreateProjectMemberAsync("hub-off");
        await using var connection = CreateHubConnection(token);
        await connection.StartAsync();
        await connection.InvokeAsync("JoinProject", projectId.ToString());

        var closed = NewClosedSignal(connection);

        await WithAdminTokenAsync(async client =>
        {
            var response = await client.PostAsync($"/api/admin/users/{userId}/deactivate", null);
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        });

        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(HubConnectionState.Disconnected, connection.State);
    }

    [Fact]
    public async Task RemovedProjectMember_ConnectedToProject_IsDisconnected()
    {
        var (projectId, userId, token) = await CreateProjectMemberAsync("hub-removed");
        await using var connection = CreateHubConnection(token);
        await connection.StartAsync();
        await connection.InvokeAsync("JoinProject", projectId.ToString());

        var closed = NewClosedSignal(connection);

        await WithAdminTokenAsync(async client =>
        {
            var response = await client.DeleteAsync($"/api/projects/{projectId}/members/{userId}");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        });

        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(HubConnectionState.Disconnected, connection.State);

        // 撤權後立刻重連：Join 必須失敗。少了權限快取的世代號，30 秒內的舊快取會讓
        // JoinProject 繼續成功——連線斷了也等於沒斷。
        await using var reconnect = CreateHubConnection(token);
        await reconnect.StartAsync();
        await Assert.ThrowsAsync<HubException>(
            () => reconnect.InvokeAsync("JoinProject", projectId.ToString()));
    }

    // L-5（code review 2026-11-09）：角色權限縮減時，受影響的人是 `TeamMembers` **與**
    // `ProjectMembers` 兩張表的聯集（TeamRoleEndpoints 是唯一一處這樣收集的程式碼）。
    // 少了 ProjectMembers 那一半，只在專案層持有該角色的人不會被中止連線——這支就是
    // 那一半的判別格；同時也釘住角色更新路徑的權限快取 Bump（重連必須 Join 失敗）。
    [Fact]
    public async Task ProjectRoleHolder_LosesConnection_WhenRolePermissionsShrink()
    {
        var (projectId, userId, token) = await CreateProjectMemberAsync("hub-role");

        var roleId = Guid.Empty;
        var teamId = await GetProjectTeamIdAsync(projectId);
        await WithAdminTokenAsync(async client =>
        {
            // 團隊成員身分是專案端點接受「團隊自訂角色」的前提（RoleIdsValidAsync）。
            // 團隊層刻意掛一個**零權限**角色：project.read 的唯一來源是下面的專案層角色，
            // 收掉它之後重連才必定失敗（系統角色多半含 project.read，會遮住判別力）。
            var teamRole = await client.PostAsync($"/api/teams/{teamId}/roles", JsonContent.Create(new
            {
                name = "hub-role-team",
                description = "團隊層零權限",
                permissionCodes = Array.Empty<string>(),
            }));
            var teamRoleBody = await teamRole.Content.ReadAsStringAsync();
            Assert.True(teamRole.StatusCode == HttpStatusCode.OK, teamRoleBody);
            var teamRoleId = Guid.Parse(JsonDocument.Parse(teamRoleBody).RootElement
                .GetProperty("id").GetString()!);
            await AddTeamMemberAsync(teamId, userId, teamRoleId);

            var created = await client.PostAsync($"/api/teams/{teamId}/roles", JsonContent.Create(new
            {
                name = "hub-role-custom",
                description = "連線撤權測試",
                permissionCodes = new[] { "project.read" },
            }));
            var createdBody = await created.Content.ReadAsStringAsync();
            Assert.True(created.StatusCode == HttpStatusCode.OK, createdBody);
            roleId = Guid.Parse(JsonDocument.Parse(createdBody).RootElement
                .GetProperty("id").GetString()!);

            var assigned = await client.PutAsync($"/api/projects/{projectId}/members/{userId}",
                JsonContent.Create(new { roleIds = new[] { roleId } }));
            var assignedBody = await assigned.Content.ReadAsStringAsync();
            Assert.True(assigned.StatusCode == HttpStatusCode.OK, assignedBody);
        });

        await using var connection = CreateHubConnection(token);
        await connection.StartAsync();
        await connection.InvokeAsync("JoinProject", projectId.ToString());

        var closed = NewClosedSignal(connection);

        await WithAdminTokenAsync(async client =>
        {
            var updated = await client.PutAsync($"/api/teams/{teamId}/roles/{roleId}", JsonContent.Create(new
            {
                name = "hub-role-custom",
                description = "權限縮減",
                permissionCodes = Array.Empty<string>(),
            }));
            Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
        });

        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(HubConnectionState.Disconnected, connection.State);

        await using var reconnect = CreateHubConnection(token);
        await reconnect.StartAsync();
        await Assert.ThrowsAsync<HubException>(
            () => reconnect.InvokeAsync("JoinProject", projectId.ToString()));
    }

    private async Task<Guid> GetProjectTeamIdAsync(Guid projectId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return await db.Projects.Where(p => p.Id == projectId).Select(p => p.TeamId).FirstAsync();
    }

    private async Task AddTeamMemberAsync(Guid teamId, Guid userId, Guid roleId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.TeamMembers.Add(new Entask.Core.Entities.TeamMember
        {
            Id = Guid.NewGuid(), TeamId = teamId, UserId = userId, RoleId = roleId,
            JoinedLocalDate = DateOnly.MinValue,
        });
        await db.SaveChangesAsync();
    }

    private static TaskCompletionSource NewClosedSignal(HubConnection connection)
    {
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.Closed += _ =>
        {
            closed.TrySetResult();
            return Task.CompletedTask;
        };
        return closed;
    }

    private HubConnection CreateHubConnection(string token) =>
        new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "/hubs/collaboration"), options =>
            {
                // TestServer 的記憶體管線不支援 WebSocket 傳輸；long polling 走的是一般 HTTP。
                options.Transports = HttpTransportType.LongPolling;
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    private async Task WithAdminTokenAsync(Func<HttpClient, Task> action)
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        try
        {
            await action(_client);
        }
        finally
        {
            _client.DefaultRequestHeaders.Authorization = null;
        }
    }

    private async Task<(Guid ProjectId, Guid UserId, string Token)> CreateProjectMemberAsync(string username)
    {
        await WithAdminTokenAsync(async client =>
        {
            var created = await client.PostAsync("/api/auth/users", JsonContent.Create(new
            {
                username,
                password = "Password1!",
                displayName = username,
            }));
            Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        });

        var (projectId, userId) = await TestSeed.ProjectWithMemberAsync(_factory, username);

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password = "Password1!" }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        return (projectId, userId, token);
    }
}
