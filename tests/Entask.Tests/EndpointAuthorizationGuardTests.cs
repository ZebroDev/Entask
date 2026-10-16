using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Entask.Api.Authorization;

namespace Entask.Tests;

// 「守衛是 opt-in」這件事的機器保證。
//
// 背景（2026-09-23，外部架構報告的 3.1 條）：`RequireProjectPermission` 與
// `RequirePermission` 是**篩選器擴充方法**、不是 attribute——它們直接換掉
// `RequestDelegate`，端點圖上不留痕跡。
// 該報告把這件事寫成「非標準路由時過濾器失效」是**方向錯了**（解不出 projectId 是
// fail-closed → 403，見 `RequireProjectPermissionAttribute.cs` 的 `projectId is null` 那一段）；
// 真正的風險是這一支在守的：**守衛要記得掛**。
//
// ★ 2026-10-10 起 `Program.cs` 有 fallback policy（`RequireAuthenticatedUser`）。它沒有讓這個
//   類別失業——兩支問的事，以及 fallback 對它們各自改變了什麼：
//     · 忘了掛**權限**守衛（`EveryRouteEndpoint_IsGuardedOrDeclared`）：後果是「**任何已登入的
//       人**可用」——fallback 只管認證，管不到「這個人該不該看這個專案」。★ fallback **沒有**
//       改變這一格：**有 `RequireAuthorization()` 的那些**既存端點早就都要求認證了，而
//       **掛 `AllowAnonymous()` 的那幾條**一直是匿名可用的（fallback 到不了它們）；缺的
//       從來只有權限那一層 ⇒ 這一支仍然是「有沒有權限守衛」唯一的機器保證。
//     · 忘了宣告**認證意圖**（`EveryRouteEndpoint_DeclaresItsAuthenticationIntent`）：
//       後果由「匿名」變成「需登入」——fail-closed 讓它**安全**，但**意圖在端點圖上仍然看不出
//       來**：「真的忘了宣告」與「意圖是匿名」在端點圖上長得一模一樣，而這一支要求的正是把
//       意圖寫出來（`.AllowAnonymous()` 是明示、不是放寬——fallback 到不了它）⇒ 那一支問的
//       問題在 fallback 之後**更重要**，不是更不重要。
//
// 這支走訪 `EndpointDataSource`，逐一判定每個 `RouteEndpoint` 落在：
//   A. 有 `ProjectPermissionMetadata`（專案範圍權限）
//   B. 有 `TeamPermissionMetadata`（團隊範圍權限）
//   C. `Declared` 裡逐條附理由的宣告
// 落在三類之外 ⇒ 紅。`Declared` 的每一條另受**兩個方向**的腐爛檢查（都是紅）：
//   ① 指不到任何端點（宣告過期）——少了這一半，清單會腐爛成一份沒有人敢刪的死資料；
//   ② 指到了，但那條端點**已經有守衛**（宣告已無標的，2026-09-23 補）。
// ② 在此之前是靜默的：端點被加上守衛之後仍然存在 ⇒ `stale` 不響，而 `undeclared` 又
// 因為它在 `Declared` 裡而放行。實例是 `GET /api/auth/users`——收緊時那條宣告是**人工**
// 移除的，不是機器逼出來的。
//
// **已知盲區（誠實記載，別當它完備）**：
//   ① 它問的是「**有沒有**守衛」，不是「守衛的權限碼**對不對**」——挑了錯的碼照樣綠。
//   ② 它看不到 handler 內部的資源層檢查（`/api/attachments/{id}` 的手寫 `CardRead` 就是
//      這一類），所以「掛了專案守衛」不等於「範圍綁定正確」。
//   ③ 它認的是 metadata，不是行為——`builder.WithMetadata(...)` 之後才把委派換掉的順序
//      若被改壞（見兩個篩選器的 `builder.Add`），這裡照樣綠。真正的行為由既有的
//      `ProjectPermissionTests` / `PermissionDeniedBodyTests` / `CommentPermissionTests` 守。
//   ④ **它盤點的是「測試 host 的」端點圖，不是部署組態的。** 落差已知且具體：SPA fallback
//      （`Program.cs` 的 `MapFallbackToFile`，端點形狀 `GET,HEAD /{*path:nonfile}`）只在
//      `wwwroot/index.html` 存在時才 map，而那個目錄被 gitignore（`.gitignore` 的
//      `src/Entask.Api/wwwroot/`）⇒ **這條端點在不在取決於機器**：本機有它（2026-10-10
//      實查 `ls src/Entask.Api/wwwroot/` ⇒ `assets/`、`favicon.svg`、`index.html`、
//      `manifest.json`），它就是那一條**既存環境紅**（`undeclared` 恰好 1 條）；乾淨
//      clone／CI 沒有它 ⇒ 那一支在那裡是綠的。
//      **不要**試著把它寫進 `Declared`——那等於把一條取決於機器的端點寫成契約：
//      「乾淨 clone 上 `stale` 紅」與「本機 `undeclared` 紅」只能選一個。
//   ⑤ `Declared` 以 `"{method} {pattern}"` **字串**為鍵，不是端點身分：兩個 `RouteEndpoint`
//      共用同一組 method＋pattern 時（同一條路線掛兩次），一條宣告會同時放行兩個，而
//      `undeclared` 與 `stale` 兩邊都不會察覺。今天沒有這種端點。
//   ⑥ **宣告的「理由」是一句話，那一句話有沒有過期只有人看得出來。** 上面的兩個腐爛檢查
//      管的是「指不到端點」與「端點已經有守衛」；但「handler 內有 admin claim 檢查」這類
//      理由在**那個檢查被刪掉之後**，端點還在、也還是沒守衛 ⇒ 三個方向全綠，而它已經
//      不成立了。機器守不到這一半（理由不是可判定的輸入），**改動那些 handler 時要回頭看
//      這裡**。這是本檔刻意留下的最後一個盲區，不是漏的。
public class EndpointAuthorizationGuardTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public EndpointAuthorizationGuardTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        // `CreateClient()` 是必要的：端點圖在 host 啟動時才建起來。只要它的副作用，
        // client 本身不用（留成欄位會是「已賦值但從未讀取」）。
        //
        // **它會跑 DB**——`Program.cs` 的 host 啟動含 `MigrateAsync` ＋ 四支 seed，
        // 全打在測試庫上。這裡**不呼叫 `WithDbReset()`** 的理由是「不需要重置」，
        // 不是「不碰 DB」（初版註解寫成後者是錯的，2026-09-23 審查抓到）。
        // DB 重置是本專案已知 transient 的站點（見 AGENTS.md），能不踩就不踩。
        // 連帶事實：`ENTASK_TEST_CONNECTION` 沒設時這支測試照樣失敗（`DbFixture.cs`）。
        _ = factory.CreateClient();
    }

    /// <summary>
    /// 「不需要專案／團隊權限」的逐條宣告。**每一條都必須命中一個真實端點、而且那個端點
    /// 必須還沒有守衛**（兩個方向各自會紅，見類別開頭），所以這裡不會累積死條目。
    ///
    /// 建這份清單的方式是逐條開檔實查（2026-09-23），不是看端點名字猜——
    /// 「看似該有檢查」的那幾條（`POST /api/auth/users`、`PUT /api/teams/{teamId}`、
    /// `GET /api/users/{userId}/performance`、`POST /api/teams`）都各自在 handler 裡
    /// 有寫死的檢查，理由逐條記在下面。
    /// </summary>
    private static readonly (string Endpoint, string Reason)[] Declared =
    [
        // ── 明示匿名：端點自己掛了 `AllowAnonymous()` ──────────────────────────
        ("GET /api/health", "探針。`.AllowAnonymous()` 是 2026-09-23 補的明示（HealthEndpoint.cs）"),
        ("GET /api/avatars/{fileName}", "頭像公開。`.AllowAnonymous()`（UserEndpoints.cs；檔名已過 `Path.GetFileName` + `IsValidAvatarFileName`）"),
        ("POST /api/auth/login", "取得憑證本身即此端點的職責"),
        ("POST /api/auth/refresh", "以 refresh token 換新憑證"),
        ("POST /api/auth/logout", "撤銷僅憑 refresh token 本身（token 值即秘密，OAuth 撤銷端點慣例；handler 有註解）"),

        // ── 自己範圍：handler 由 principal 取 userId，不看 route／query 的識別碼 ──
        ("GET /api/auth/me", "自己"),
        ("GET /api/me/work", "自己（`BoardEndpoints.CurrentUserId`）"),
        ("GET /api/me/worklog", "自己"),
        ("GET /api/me/worklog/export", "自己"),
        ("PUT /api/me/avatar", "自己"),
        ("DELETE /api/me/avatar", "自己"),
        ("PUT /api/me/password", "自己"),
        ("PUT /api/me/profile", "自己"),
        ("GET /api/notifications/", "自己（查詢條件 `n.UserId == userId`）"),
        ("PUT /api/notifications/{id:guid}/read", "自己（`n.Id == id && n.UserId == userId`）"),
        ("PUT /api/notifications/read-all", "自己"),
        ("GET /api/notifications/preferences", "自己"),
        ("PUT /api/notifications/preferences", "自己"),

        // ── 查詢內以成員資格收斂：沒有單一 projectId 可以餵給 resolver ──────────
        ("GET /api/projects", "查詢內以 ProjectMembers／TeamMembers 過濾（ProjectEndpoints.cs 的 `Where`）"),
        ("GET /api/teams/", "查詢內 `m.UserId == userId`（TeamEndpoints.cs）"),

        // ── 自己的有效權限：唯讀、且只回自己那一份 ──────────────────────────────
        ("GET /api/permissions", "權限目錄，唯讀且非使用者資料（PermissionEndpoints.cs）"),
        ("GET /api/permissions/mine", "自己的有效權限（多角色聯集）"),
        ("GET /api/projects/{projectId:guid}/permissions/mine", "自己的有效權限；非成員拿到空集合"),
        ("GET /api/teams/my-permissions", "自己的有效權限"),

        // ── handler 內部自寫檢查：路線沒有可解析的範圍鍵，或需要 admin ───────────
        ("GET /api/attachments/{id:guid}", "handler 內手寫 `CardRead`（AttachmentEndpoints.cs）——路線只有 `{id}`，沒有 projectId／boardId／listId／cardId 可餵給 resolver"),
        ("GET /api/users/{userId:guid}/performance", "handler 內檢查自己／admin／同團隊主管（TeamReportEndpoints.cs）"),
        ("POST /api/auth/users", "handler 內 admin claim 檢查（AuthEndpoints.cs）"),
        // admin 群組（2026-10-07）。★ **`RequireAuthorization()` 在這裡不算「有守衛」**：
        // 這一支的 `Guarded` 讀的是 `ProjectPermissionMetadata`／`TeamPermissionMetadata`，
        // 而 `RequireAuthorization()` 給的是 `IAuthorizeData`（那是**另一支**測試
        // `EveryRouteEndpoint_DeclaresItsAuthenticationIntent` 在問的）。實測：少了這兩條
        // 宣告，`undeclared` 由 1 條變成 3 條（`GET /api/admin/users/` 與下面那一條），
        // 而清單看起來只像是環境紅多長了兩行。真正的閘門在 handler 裡：
        // `AdminUserEndpoints.RequireAdminAsync`（`ResolveCurrentUserAsync` ＋ admin claim）。
        ("GET /api/admin/users/", "handler 內 admin claim 檢查（AdminUserEndpoints.RequireAdminAsync；群組根的 pattern 帶尾斜線，照端點圖實測值寫）"),
        ("GET /api/admin/users/{userId:guid}/offboarding", "同上（AdminUserEndpoints.RequireAdminAsync）"),
        // 三個動作端點（Task 5，2026-10-07）：**同一個群組的同一道閘門**，但這三條不是走
        // `RequireAdminAsync`——它們各自在 handler 裡行內做同一組檢查（`ResolveCurrentUserAsync`
        // ＋ `AdminClaim`），因為它們還需要 `caller`（停用的稽核與「不可停用自己」都要他）。
        // 實測：少了這三條宣告，`undeclared` 由 1 條（SPA fallback 的既存環境紅）變成 4 條。
        ("POST /api/admin/users/{userId:guid}/deactivate", "handler 內 admin claim 檢查（AdminUserEndpoints；`ResolveCurrentUserAsync` ＋ `AdminClaim` 逐字同 `RequireAdminAsync`）"),
        ("POST /api/admin/users/{userId:guid}/reactivate", "同上（AdminUserEndpoints）"),
        ("DELETE /api/admin/users/{userId:guid}", "同上（AdminUserEndpoints）"),
        ("POST /api/admin/users/{userId:guid}/reset-password", "同上（AdminUserEndpoints）"),
        // 系統級稽核（Task 2，2026-10-10）：與上面那個 admin 群組同一道閘門形狀，但**刻意
        // 不掛 `.RequirePermission(...)`**——團隊權限語意（`X-Team-Id` 為範圍）對全域資源
        // 不成立，任何持有任一團隊 `team.read` 的人都會過關。實測：少了這一條宣告，
        // `undeclared` 由 1 條（SPA fallback 的既存環境紅）變成 2 條。
        ("GET /api/audit-logs/system", "handler 內 admin claim 檢查（AuditLogEndpoints；`ResolveCurrentUserAsync` ＋ `AdminClaim` 逐字同 `AdminUserEndpoints.RequireAdminAsync`）"),
        ("POST /api/teams/", "handler 內 admin claim 檢查（TeamEndpoints.cs）"),
        ("PUT /api/teams/{teamId:guid}", "handler 內 `TeamRoleManage` 檢查（TeamEndpoints.cs）"),

        // ── SignalR ──────────────────────────────────────────────────────────
        ("ANY /hubs/collaboration", "`[Authorize]` 在 hub 類別上；`JoinBoard`／`JoinProject` 各自再查 `BoardRead`／`ProjectRead`（CollaborationHub.cs）"),
        ("ANY /hubs/collaboration/negotiate", "同上（negotiate 是連線握手）"),

        // （原本這裡有一節「已知的寬鬆處」，唯一一條是 `GET /api/auth/users`。2026-09-23 收緊為
        //   `RequirePermission(PermissionCodes.TeamMemberManage)` ⇒ 端點圖上從 `-` 變成 `G`，
        //   宣告隨之刪除。行為測試在 `AuthUsersListPermissionTests`，不掛在這裡——本檔問的是
        //   「有沒有守衛」，行為由那些測試守。）
    ];

    [Fact]
    public void EveryRouteEndpoint_IsGuardedOrDeclared()
    {
        var rows = Rows();

        var undeclared = rows
            .Where(r => !r.Guarded && !Declared.Any(d => d.Endpoint == r.Key))
            .Select(r => r.Key)
            .ToList();
        // 過期的宣告連理由一起印——否則讀者得自己去檔案裡找那一條原本在講什麼
        var stale = Declared
            .Where(d => !rows.Any(r => r.Key == d.Endpoint))
            .Select(d => $"{d.Endpoint}\n      ← {d.Reason}")
            .ToList();
        // 另一半的腐爛（2026-09-23 補）：宣告還在、端點也還在，但它**已經有守衛了**。
        // 在那之前這一種是靜默的——`undeclared` 因為它在 `Declared` 裡而放行，
        // `stale` 因為端點存在而不響 ⇒ 一條「已知的寬鬆處」可以在理由早已不成立之後
        // 繼續留著，而測試全綠。實例：`GET /api/auth/users` 收緊時，那條宣告是**人工**
        // 移除的（見 `docs/STATE.md`）。
        //
        // 兩邊互斥：一條宣告只有在「端點不存在」或「端點有守衛」時才紅，端點存在且無守衛
        // （＝宣告還成立）時才綠。
        var overDeclared = Declared
            .Where(d => rows.Any(r => r.Key == d.Endpoint && r.Guarded))
            .Select(d => $"{d.Endpoint}\n      ← {d.Reason}")
            .ToList();

        Assert.True(undeclared.Count == 0 && stale.Count == 0 && overDeclared.Count == 0,
            $"""
             未宣告且無權限守衛的端點（{undeclared.Count} 條）：
             {Bullets(undeclared)}

             宣告了卻不存在（{stale.Count} 條，宣告過期）：
             {Bullets(stale)}

             宣告了、但那條端點已經有守衛（{overDeclared.Count} 條，宣告已無標的）：
             {Bullets(overDeclared)}

             全部端點（{rows.Count} 條；`G` = 有守衛）：
             {string.Join("\n", rows.Select(r => $"  {(r.Guarded ? "G" : "-")} {r.Key}"))}
             """);
    }

    // 認證意圖的宣告。與上面那支**不同層**：上面問「有沒有授權守衛」，這支只問
    // 「有沒有明示要或不要認證」。兩者都必要——一個端點可以既要求認證、又沒有
    // 專案／團隊權限（自己的通知、自己的頭像就是這一類），也可以兩者皆無（登入本身）。
    [Fact]
    public void EveryRouteEndpoint_DeclaresItsAuthenticationIntent()
    {
        var undeclared = Rows()
            .Where(r => !r.Authenticated && !r.Anonymous)
            .Select(r => r.Key)
            .ToList();

        Assert.True(undeclared.Count == 0,
            $"""
             沒有宣告認證意圖的端點（{undeclared.Count} 條）——既沒有 `RequireAuthorization()`
             也沒有 `AllowAnonymous()`。2026-10-10 起 `Program.cs` 有 fallback policy ⇒ 這些端點
             在**執行期**是需登入的（不會裸奔），但**意圖在端點圖上仍然看不出來**：它們與一個
             「意圖是匿名」的端點長得一模一樣。要嘛補 `RequireAuthorization()`，
             要嘛補 `AllowAnonymous()` 把「刻意匿名」講出來：
             {Bullets(undeclared)}
             """);
    }

    private List<(string Key, bool Guarded, bool Authenticated, bool Anonymous)> Rows() =>
        _factory.Services.GetServices<EndpointDataSource>()
            .SelectMany(ds => ds.Endpoints)
            // 防禦性去重。**實測（2026-09-23）：拿掉它端點數不變（116 → 116）**——
            // `GetServices<EndpointDataSource>()` 在這個 app 只回一個 `CompositeEndpointDataSource`，
            // 成員沒有各自註冊，所以「同一個端點被算兩次」目前不會發生。
            // 留著是因為那個註冊形狀不是契約；`.Distinct()` 是參考相等（`RouteEndpoint` 沒有覆寫
            // `Equals`），真要發生時它會正確地收斂。
            .Distinct()
            .OfType<RouteEndpoint>()
            .Select(e => (
                Key: $"{Methods(e)} {Pattern(e)}",
                Guarded: e.Metadata.GetMetadata<ProjectPermissionMetadata>() is not null
                      || e.Metadata.GetMetadata<TeamPermissionMetadata>() is not null,
                Authenticated: e.Metadata.GetMetadata<IAuthorizeData>() is not null,
                Anonymous: e.Metadata.GetMetadata<IAllowAnonymous>() is not null))
            .OrderBy(r => r.Key, StringComparer.Ordinal)
            .ToList();

    private static string Pattern(RouteEndpoint e) => "/" + (e.RoutePattern.RawText ?? "").TrimStart('/');

    private static string Methods(RouteEndpoint e)
    {
        var methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
        return methods is null or { Count: 0 } ? "ANY" : string.Join(",", methods);
    }

    private static string Bullets(IEnumerable<string> items) =>
        items.Count() == 0 ? "  （無）" : string.Join("\n", items.Select(i => "  " + i));
}
