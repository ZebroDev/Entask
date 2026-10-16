using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Entask.Tests;

// `GET /api/auth/users/search` 的契約（2026-09-24）。
//
// **這條端點存在的理由**：2026-09-23 把 `/users` 收斂成「該團隊成員 ∪ 未歸屬任何團隊者」
// 之後，指派成員下拉再也選不到**其他團隊**的人。指派本身在後端一直是允許的
// （`PUT /api/teams/{teamId}/members` 只認 username、且是冪等的），缺的是「輸入名稱找人」
// 這條路徑 ⇒ `/search` 的範圍刻意是**全目錄**，與 `/users` 的「可指派池」是兩個集合。
//
// **所有情境寫在同一支 `[Fact]` 是刻意的**（同 `AuthUsersListPermissionTests` 與
// `TeamReadPermissionTests` 的形狀）：`ApiWebApplicationFactory.WithDbReset()` 每條 factory
// **只重置一次**、不是 per-test（`_pendingReset` 旗標一旦被 `CreateClient()` 消費就不再重置），
// 所以同一類別的兩個 `[Fact]` 會互相看到對方建立的使用者。這裡要建 21 個使用者去驗上限，
// 拆開來會直接撞 `identity.duplicateUserName`（那個檔的檔頭記載了實測踩到的訊息）。
//
// **這一支守的是端點的「列舉」面**：能打它的人是 admin 或持有某個團隊 `team.member.manage`
// 的人，而他們可以拿它把全庫名冊一批一批倒出來。①／⑤／⑥ 就是那三層防護的守門員
// （最短長度／萬用字元逃逸／硬上限）——少了任何一支，端點裡對應的那一段就只是註解。
public class UserSearchTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly HttpClient _client;

    public UserSearchTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task SearchUsers_EnforcesLengthEscapingAndCap_AndSeesOtherTeams()
    {
        var adminToken = await LoginAsync("admin-test", "TestPass123!");
        var teamAId = await CreateTeamAsync(adminToken, "A 團隊");
        var teamBId = await CreateTeamAsync(adminToken, "B 團隊");

        // carol：A 團隊經理（含 team.member.manage）；dave：沒有任何團隊角色；
        // grace：B 團隊的成員——她正是「`/users` 看不到、`/search` 看得到」的那一個；
        // alice：未歸屬任何團隊，給大小寫那一格用；
        // pct：顯示名稱裡有一個**字面**的 `%`，給⑤b（逃逸順序）那一格用。它的形狀是刻意的、
        // 不是隨手取的：**恰好一個 `%`、零個 `_`**，且不被 `%%%`／`___`／`alice`／`grace`／
        // `zqx` 命中——多一個 `%` 就會是「庫裡真的有人叫 `%%%`」而把⑤弄紅，含 `_` 或落在
        // `zqx` 系列裡則會弄髒⑥。
        foreach (var (username, displayName) in new[]
                 {
                     ("carol", "卡蘿"), ("dave", "戴夫"), ("grace", "葛瑞絲"), ("alice", "愛麗絲"),
                     ("pct", "百分比%測試")
                 })
        {
            var created = await SendAsync(HttpMethod.Post, "/api/auth/users", adminToken,
                JsonContent.Create(new { username, password = "Password1!", displayName }));
            Assert.True(created.StatusCode == HttpStatusCode.OK,
                $"建立 {username} 失敗：{(int)created.StatusCode} {await created.Content.ReadAsStringAsync()}");
        }

        await AssignMemberAsync(adminToken, teamAId, "carol");
        await AssignMemberAsync(adminToken, teamBId, "grace");

        var carolToken = await LoginAsync("carol", "Password1!");
        var daveToken = await LoginAsync("dave", "Password1!");

        // ①（B-1）最短長度：trim 後 < 3 個字元 ⇒ 400 `request.invalid`。
        //    `q` 那一側有三種**不同**的形狀要驗，因為它們是**三條不同的繫結路徑**：
        //    缺席（null）、`q=`（空字串）、`q="   "`（非空、但 trim 後為空）——漏掉任何一種，
        //    那一種就會是「查詢條件被當成合法值送進 ILIKE」的入口。
        //    （`ab` 是第四格，代表「太短但不是空的」。）
        foreach (var (label, shortQuery) in new (string, string?)[]
                 {
                     ("q=ab", "ab"), ("q=（空）", ""), ("q=三個空白", "   "), ("完全不帶 q", null)
                 })
        {
            var tooShort = await SearchAsync(adminToken, teamId: null, shortQuery);
            Assert.True(tooShort.StatusCode == HttpStatusCode.BadRequest,
                $"{label} 應拿到 400，實得 {(int)tooShort.StatusCode}");
            var body = await tooShort.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("request.invalid", body.GetProperty("code").GetString());
        }

        // ①b（B-1b）**控制字元**：`q=%00%00%00`（三個 NUL）在長度那一關是**合格**的
        //    ——`Trim()` 不剝 NUL、`Length == 3`——於是閘門會放它進 ILIKE，而 PostgreSQL 的
        //    `text` 不能含 `0x00` ⇒ 請求在驅動層爆掉，以 **500** 收場而不是契約說的 400。
        //    呼叫端可以拿它隨意製造 500（不是注入、也不是列舉繞過，就是把一個 400 變成 500）。
        //    這一格量的是「閘門要連**內容**一起擋」——與①那四格量的「長度的四條繫結路徑」
        //    是不同的性質，所以兩邊都要在。
        var withControls = await SearchAsync(adminToken, teamId: null, "\0\0\0");
        Assert.True(withControls.StatusCode == HttpStatusCode.BadRequest,
            $"含控制字元的 q 應拿到 400（不是 500），實得 {(int)withControls.StatusCode}");
        Assert.Equal("request.invalid",
            (await withControls.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // ②（B-2）閘門**早於**驗證：dave 沒有 team.member.manage，送的是**短查詢**（①裡會 400
        //    的那一種），但他拿到的是 403 ⇒ 篩選器在 handler 之前就把請求攔掉了，短查詢根本
        //    沒有機會被評估。
        //    判別力：把新端點那條 `.RequirePermission(PermissionCodes.TeamMemberManage)`
        //    **整段刪掉** ⇒ 閘門消失、短查詢進得了 handler ⇒ 這一格變 400 ⇒ 紅。
        //    （**不是**「把長度檢查搬到權限檢查之前」：權限是宣告式中繼資料，一律先於 handler
        //    執行，那個動作做不出來——它只是聽起來像個突變。）
        //    **X-Team-Id 必須是合法的值**，否則篩選器會先回「缺少 X-Team-Id header」那個 400，
        //    這一格就變成在驗另一件事。
        var denied = await SearchAsync(daveToken, teamAId, "ab");
        Assert.True(denied.StatusCode == HttpStatusCode.Forbidden,
            $"無 team.member.manage 者應拿到 403（不是 400），實得 {(int)denied.StatusCode}");
        Assert.Equal("permission.denied",
            (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // ③（B-3）本端點存在的理由。**兩個方向都要斷言**：只驗「`/search` 找得到 grace」的話，
        //    一個「`/search` 根本沒過濾、直接回全庫」的壞實作也會綠——那個對照正是這條端點的
        //    全部價值，而它必須是**同一個 header** 之下的對照。
        var managerPool = await UsernamesAsync(await ListUsersAsync(carolToken, teamAId));
        Assert.Contains("carol", managerPool);       // 正向對照：這份清單不是空的
        Assert.DoesNotContain("grace", managerPool); // 別的團隊 ⇒ 不在可指派池裡

        var foundAcrossTeams = await UsernamesAsync(await SearchAsync(carolToken, teamAId, "grace"));
        Assert.Contains("grace", foundAcrossTeams);

        // ④（B-4）不分大小寫：走的是 `ILike` 而不是 `Contains`——後者在 PostgreSQL 會翻成
        //    **區分大小寫**的 LIKE，於是 `ALICE` 找不到 `alice`。
        var caseInsensitive = await SearchAsync(adminToken, teamId: null, "ALICE");
        Assert.Equal(HttpStatusCode.OK, caseInsensitive.StatusCode);
        Assert.Contains("alice", await UsernamesAsync(caseInsensitive));

        // ⑤（B-5）★ 萬用字元逃逸——**本檔案最重要的一格**。`q=%%%`（3 個字元，會**通過**①的
        //    最短長度檢查）若不逃逸，pattern 會變成 `%%%%%%%` ⇒ 比對到**全部**使用者 ⇒
        //    一次請求倒出前 20 名，而①與⑥的防護看起來完全沒被繞過。
        //    逃逸之後它只比對「名字裡字面上含 `%%%` 的人」，而這座庫裡沒有這種名字 ⇒ **空陣列**。
        //    `_` 是 second wildcard（單一字元），所以它也要一格——少了它，只有那一段
        //    `.Replace("_", "\\_")` 被刪掉時不會有任何測試變紅。
        //    判別力：拿掉 `%` 或 `_` 那一段 ⇒ 對應那一格變成 20 筆 ⇒ 紅。
        Assert.Empty(await UsernamesAsync(await SearchAsync(adminToken, teamId: null, "%%%")));
        Assert.Empty(await UsernamesAsync(await SearchAsync(adminToken, teamId: null, "___")));

        // ⑤b（B-5b）**逃逸的順序**。上面兩格守的是「有沒有逃逸」，這一格守的是「先逃逸哪一個」
        //    ——兩者是不同的性質，而上面兩格對後者**全盲**：順序顛倒時 `%%%` 會變成
        //    `\\%\\%\\%`，每個 `\\` 被讀成**字面的反斜線**、`%` 仍是萬用字元 ⇒ pattern 要求
        //    三個反斜線 ⇒ 誰都不符 ⇒ `Assert.Empty` 因為**錯的理由**通過。
        //    要分開兩者，庫裡得有一個**名字真的含 `%`** 的使用者：正確順序下那個 `%` 被逃逸成
        //    字面值 ⇒ 命中；順序顛倒時它變成「字面反斜線 ＋ 萬用字元」⇒ 不命中。
        //    判別力：把 `AuthEndpoints` 那三個 `Replace` 的順序顛倒 ⇒ 這一格變空陣列 ⇒ 紅，
        //    而上面兩格**照樣全綠**（另外兩個方向——拿掉 `%` 或 `_` 那一段——由上面兩格負責）。
        Assert.Equal(new[] { "pct" },
            await UsernamesAsync(await SearchAsync(adminToken, teamId: null, "比%測")));

        // ⑥（B-6）硬上限：**21 個**相符的使用者 ⇒ 恰好回 **20** 筆。
        //    前綴 `zqx` 刻意與其他情境不相干——比對的是 username **或** displayName 的子字串，
        //    所以每一個 zqx 系列的人都要只被這一格的關鍵字命中（下面那一格會再確認一次）。
        const int matchingUsers = 21;
        for (var i = 1; i <= matchingUsers; i++)
        {
            var created = await SendAsync(HttpMethod.Post, "/api/auth/users", adminToken,
                JsonContent.Create(new
                {
                    username = $"zqx-user-{i:D2}",
                    password = "Password1!",
                    displayName = $"Zqx 測試員 {i:D2}"
                }));
            Assert.True(created.StatusCode == HttpStatusCode.OK,
                $"建立 zqx-user-{i:D2} 失敗：{(int)created.StatusCode} {await created.Content.ReadAsStringAsync()}");
        }

        var capped = await SearchAsync(adminToken, teamId: null, "zqx");
        Assert.Equal(HttpStatusCode.OK, capped.StatusCode);
        var cappedBody = await capped.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(20, cappedBody.GetArrayLength());

        // 對照：21 個**都在庫裡**（`/api/auth/users` 沒有上限）而上面的搜尋只回了 20
        // ⇒ 少掉的那一筆是**上限砍的**，不是「剛好只有 20 個相符」。少了這一格，⑥在
        // 只建了 20 個相符使用者的世界裡也會綠（那就變成在驗一個恆真的數字）。
        var allUsers = await UsernamesAsync(await ListUsersAsync(adminToken, teamId: null));
        Assert.Equal(matchingUsers, allUsers.Count(u => u.StartsWith("zqx-user-", StringComparison.Ordinal)));

        // ⑦（B-7）不得多洩欄位：回應物件的 JSON 屬性**恰好**這四個。
        //    這一格防的是未來有人往 `UserSummaryResponse` 加 `email` 或 `teamName`——
        //    那個 DTO 是所有消費端共用的，而**這條端點的範圍是全目錄**（別隊的人也回得來）
        //    ⇒ 在那裡多一個欄位，就是多洩一份別隊的資料，而目前沒有任何測試會變紅。
        var expectedProperties = new[] { "id", "username", "displayName", "avatarUrl" };
        Assert.NotEqual(0, cappedBody.GetArrayLength()); // 下面走訪的集合不能是空的
        foreach (var item in cappedBody.EnumerateArray())
        {
            var names = item.EnumerateObject().Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
            Assert.True(names.SetEquals(expectedProperties),
                $"回應欄位應恰好是 [{string.Join(", ", expectedProperties)}]，實得 [{string.Join(", ", names)}]");
        }

        // ⑧（B-8）admin **不帶** `X-Team-Id` ⇒ 200。這是 `RequirePermission` 的 claim 分支既有語意
        //    （admin 一律直接放行），不是本端點自己的判斷——寫下來是為了不讓「admin 也要帶 header」
        //    這個誤解被當成契約，也讓上面那些 admin 情境的前提在檔案裡看得見。
        var asAdmin = await SearchAsync(adminToken, teamId: null, "alice");
        Assert.True(asAdmin.StatusCode == HttpStatusCode.OK,
            $"admin 不帶 X-Team-Id 應拿到 200，實得 {(int)asAdmin.StatusCode}");
        Assert.Contains("alice", await UsernamesAsync(asAdmin));
    }

    /// <summary>
    /// 打 `/api/auth/users/search`。`q` 為 null ⇒ **完全不帶**那個 query 參數（與 `q=` 是兩條
    /// 不同的繫結路徑）；其餘一律先 percent-encode——`%%%` 這種查詢不編碼的話 `Uri` 根本解析
    /// 不了，而編碼之後伺服器收到的正是使用者打的那三個字元。
    /// </summary>
    private Task<HttpResponseMessage> SearchAsync(string token, string? teamId, string? q)
    {
        var url = q is null
            ? "/api/auth/users/search"
            : $"/api/auth/users/search?q={Uri.EscapeDataString(q)}";
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new("Bearer", token);
        if (teamId is not null) request.Headers.Add("X-Team-Id", teamId);
        return _client.SendAsync(request);
    }

    /// <summary>列出使用者。`teamId` 為 null 時不帶 X-Team-Id（admin 不需要它）。</summary>
    private Task<HttpResponseMessage> ListUsersAsync(string token, string? teamId)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/auth/users");
        request.Headers.Authorization = new("Bearer", token);
        if (teamId is not null) request.Headers.Add("X-Team-Id", teamId);
        return _client.SendAsync(request);
    }

    /// <summary>讀出回應陣列裡的 username 清單。</summary>
    private static async Task<List<string>> UsernamesAsync(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>())
        .EnumerateArray().Select(u => u.GetProperty("username").GetString()!).ToList();

    private async Task<string> CreateTeamAsync(string adminToken, string name) =>
        (await (await SendAsync(HttpMethod.Post, "/api/teams", adminToken, JsonContent.Create(new { name })))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

    /// <summary>把 <paramref name="username"/> 指派進團隊，並掛上該團隊的「團隊經理」範本角色。</summary>
    private async Task AssignMemberAsync(string adminToken, string teamId, string username)
    {
        var roles = await (await SendAsync(HttpMethod.Get, $"/api/teams/{teamId}/roles", adminToken))
            .Content.ReadFromJsonAsync<JsonElement>();
        var managerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "團隊經理")
            .GetProperty("id").GetString()!;

        var assign = await SendAsync(HttpMethod.Put, $"/api/teams/{teamId}/members", adminToken,
            JsonContent.Create(new { username, roleIds = new[] { managerRoleId } }));
        Assert.True(assign.StatusCode == HttpStatusCode.OK,
            $"指派 {username} 失敗：{(int)assign.StatusCode} {await assign.Content.ReadAsStringAsync()}");
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
