using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

// `GET /api/auth/users` 的存取收緊（2026-09-23）。
//
// 收緊前它只掛 `RequireAuthorization()` ⇒ **任何已認證者**都能列舉全庫使用者的
// Id／UserName／DisplayName／AvatarUrl。單一團隊部署下可承受，多租戶時是一條橫向的
// 使用者列舉路徑。現在要求 admin 或「X-Team-Id 所指團隊」的 `team.member.manage`。
//
// **三個情境寫在同一支 `[Fact]` 是刻意的**（同 `TeamReadPermissionTests` 的形狀）：
// `ApiWebApplicationFactory.WithDbReset()` 每條 factory **只重置一次**、不是 per-test
// （`_pendingReset` 旗標一旦被 `CreateClient()` 消費就不再重置），所以同一類別的兩個
// `[Fact]` 會互相看到對方建立的使用者——拆成三支會拿到
// `identity.duplicateUserName: Username 'carol' is already taken`（實測踩到）。
//
// **「非管理者」的形狀刻意用「完全沒有團隊權限的已認證者」**：它與「只有 team.read 的
// 團隊成員」在後端走的是 `RequirePermission` 的同一個分支（`HasPermissionAsync` 回
// false → 403），所以這一支驗得到收緊本身。
// 「只有 team.read 卻進得去 TeamMembersTab」是**前端**才分得出來的差異——那個閘門由
// `TeamMembersTab.test.tsx` 守，不在這裡重複。
public class AuthUsersListPermissionTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public AuthUsersListPermissionTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task ListUsers_AdminAndTeamManager_Return200_AuthenticatedNonManager_Returns403()
    {
        var adminToken = await LoginAsync("admin-test", "TestPass123!");

        var teamAId = (await (await SendAsync(HttpMethod.Post, "/api/teams", adminToken,
                JsonContent.Create(new { name = "A 團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // carol 會成為 A 的團隊經理（含 team.member.manage）；dave 不做任何指派
        foreach (var (username, displayName) in new[] { ("carol", "卡蘿"), ("dave", "戴夫") })
        {
            var created = await SendAsync(HttpMethod.Post, "/api/auth/users", adminToken,
                JsonContent.Create(new { username, password = "Password1!", displayName }));
            Assert.True(created.StatusCode == HttpStatusCode.OK,
                $"建立 {username} 失敗：{(int)created.StatusCode} {await created.Content.ReadAsStringAsync()}");
        }

        var roles = await (await SendAsync(HttpMethod.Get, $"/api/teams/{teamAId}/roles", adminToken))
            .Content.ReadFromJsonAsync<JsonElement>();
        var managerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理")
            .GetProperty("id").GetString()!;

        var assign = await SendAsync(HttpMethod.Put, $"/api/teams/{teamAId}/members", adminToken,
            JsonContent.Create(new { username = "carol", roleIds = new[] { managerRoleId } }));
        Assert.True(assign.StatusCode == HttpStatusCode.OK,
            $"指派 carol 失敗：{(int)assign.StatusCode} {await assign.Content.ReadAsStringAsync()}");

        var carolToken = await LoginAsync("carol", "Password1!");
        var daveToken = await LoginAsync("dave", "Password1!");

        // ① 管理者 200——`RequirePermission` 的 claim 分支直接放行，**不需要** X-Team-Id
        var asAdmin = await ListUsersAsync(adminToken, teamId: null);
        Assert.True(asAdmin.StatusCode == HttpStatusCode.OK,
            $"admin 應拿到 200，實得 {(int)asAdmin.StatusCode}");
        Assert.True((await asAdmin.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength() >= 3,
            "回應應含 admin-test ＋ carol ＋ dave");

        // ② 具 team.member.manage 的非管理者 200——正向對照：收緊不是「一律拒絕」
        var asManager = await ListUsersAsync(carolToken, teamAId);
        Assert.True(asManager.StatusCode == HttpStatusCode.OK,
            $"團隊經理應拿到 200，實得 {(int)asManager.StatusCode}");

        // ③ 已認證但無團隊角色者 403——收緊前這一個會拿到 200 與全庫使用者清單
        var asNonManager = await ListUsersAsync(daveToken, teamAId);
        Assert.True(asNonManager.StatusCode == HttpStatusCode.Forbidden,
            $"非管理者應拿到 403，實得 {(int)asNonManager.StatusCode}");

        // ④ 範圍收斂（2026-09-23 第二階段）：A 團隊的經理看不到**別的團隊**的人，
        //    但看得到「未歸屬任何團隊」的候選人——後者正是指派成員下拉要挑的那一種。
        //    **必須另發一次請求**：② 的 `asManager` 是在 erin 存在**之前**送出的，它的 body
        //    是那個當下的快照（讀得到、但看不到 erin）⇒ 拿它斷言「erin 不在」**對兩種實作
        //    都會綠**（實測 count=3、[carol|admin-test|dave]），是一個沒有判別力的假綠燈。
        var teamBId = (await (await SendAsync(HttpMethod.Post, "/api/teams", adminToken,
                JsonContent.Create(new { name = "B 團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var erinCreated = await SendAsync(HttpMethod.Post, "/api/auth/users", adminToken,
            JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "艾琳" }));
        Assert.Equal(HttpStatusCode.OK, erinCreated.StatusCode);
        var assignErin = await SendAsync(HttpMethod.Put, $"/api/teams/{teamBId}/members", adminToken,
            JsonContent.Create(new { username = "erin", roleIds = new[] { managerRoleId } }));
        Assert.Equal(HttpStatusCode.OK, assignErin.StatusCode);

        var managerList = (await (await ListUsersAsync(carolToken, teamAId))
                .Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().Select(u => u.GetProperty("username").GetString()).ToList();
        Assert.Contains("carol", managerList);      // 本團隊成員
        Assert.Contains("dave", managerList);       // 未歸屬任何團隊（候選人）
        Assert.DoesNotContain("erin", managerList); // 別的團隊 ⇒ 不在範圍內

        // ⑤ admin 不受範圍限制（D7）——**另發一次請求**：`asAdmin` 的 Content 已在 ① 讀掉
        var adminList = (await (await ListUsersAsync(adminToken, teamId: null))
                .Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().Select(u => u.GetProperty("username").GetString()).ToList();
        Assert.Contains("erin", adminList);

        // ⑥ admin 帶 X-Team-Id 時**仍不受範圍限制**（D7）——⑤ 只涵蓋了不帶 header 的形狀，
        //    少了這一格，「拿掉 scoped 的 admin 判斷」是無效突變（行為零變化）。
        var adminScoped = (await (await ListUsersAsync(adminToken, teamAId))
                .Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().Select(u => u.GetProperty("username").GetString()).ToList();
        Assert.Contains("erin", adminScoped);

        // ⑦ 非 admin 且**不帶** X-Team-Id ⇒ 篩選器回 400（不是 403、更不是 200）。
        //    這一格釘住的是新分支的**安全前提**：`scoped == false` 等於完全不篩選，
        //    而非 admin 之所以到不了那裡，靠的正是篩選器在權限檢查**之前**先驗 header。
        //    判別力：把篩選器的順序對調（先查權限）⇒ dave 變 403 ⇒ 這一格紅。
        var asNonManagerNoHeader = await ListUsersAsync(daveToken, teamId: null);
        Assert.True(asNonManagerNoHeader.StatusCode == HttpStatusCode.BadRequest,
            $"缺 X-Team-Id 的非管理者應拿到 400，實得 {(int)asNonManagerNoHeader.StatusCode}");
    }

    /// <summary>列出使用者。`teamId` 為 null 時不帶 X-Team-Id（admin 不需要它）。</summary>
    private Task<HttpResponseMessage> ListUsersAsync(string token, string? teamId)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/auth/users");
        request.Headers.Authorization = new("Bearer", token);
        if (teamId is not null) request.Headers.Add("X-Team-Id", teamId);
        return _client.SendAsync(request);
    }

    private async Task<string> LoginAsync(string username, string password)
    {
        var response = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username, password }));
        return (await response.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;
    }

    private Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, string token, HttpContent? content = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = content };
        request.Headers.Authorization = new("Bearer", token);
        return _client.SendAsync(request);
    }
}
