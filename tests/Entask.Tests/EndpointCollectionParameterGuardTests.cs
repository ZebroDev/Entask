using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

// 集合型別參數的**普查閘門**（2026-10-11，公開前硬化批次的裁定 R19）。
//
// 背景：2026-10-10 的 T5 為「請求面集合」加了硬上限（`src/Entask.Api/RequestLimits.cs`，
// 值 500／200／500／100），站點逐一檢查是 `if (req.X is { Count: > RequestLimits.Max… })`。
// 但**那份站點清單是手寫的**，而同一條路在同一批裡漏了**兩次**：
//   · 第 14 站（複審 F1）：`NotificationEndpoints` 的 `[FromBody] List<PreferenceUpdateDto>`——
//     普查當時掃的是 `Dtos/` 底下的**型別宣告**，而那個型別 inline 宣告在端點檔裡。
//   · 第 15 站（修正輪 R31）：`CustomFieldEndpoints` 的 `Dictionary<Guid, JsonElement>`——
//     那是 **BCL 泛型**，根本不是本 repo 宣告的型別。
// ⇒ **病根不是「有人忘了加」，是「用型別宣告當普查方法本身就不完備」**。這支把普查方法換成
// **端點圖**：`RouteEndpoint.Metadata.GetMetadata<MethodInfo>()` 逐個參數看型別。
// （可行性是**量出來的**，不是推的：`.superpowers/sdd/2026-10-11-entask-gate-and-type-coverage/
//  t1-probe/` 的 T1 探針實測六種形狀都看得到，且 `FromBodyAttribute`／`FromQueryAttribute`
//  仍在參數上；同一份探針也量到 metadata 裡的 `Delegate` 與 `RequestDelegate` **都是 null**
//  ⇒ `MethodInfo` 是唯一的路。）
//
// ★ **2026-10-11 量測更正（T2）**：`docs/state/44` 的處方逐字是「掃**端點簽章上的**集合型別
//   參數」。**照字面做只罩得住 2 站**——第一次跑（空宣告表）量到端點圖上**總共只有 2 個**
//   頂層集合參數（`List<PreferenceUpdateDto>`、`Dictionary&lt;Guid, JsonElement&gt;`，正是複審與
//   修正輪補的那兩站），而 T5 的另外 **13 站是 DTO 的屬性**：例如
//   `PUT /api/cards/{cardId:guid}/members` 的簽章是 `UpdateCardMembersRequest req`（複雜型別
//   ⇒ 隱式 body 綁定），被檢查的 `req.UserIds` 是它**內部的**集合。
//   ⇒ 只掃簽章 ⇒ 閘門對那 13 站**永久失明、而且全綠**（正是本 repo 最怕的那一種）。
//   **正確形狀 ＝ 參數 ＋ 參數型別圖內的集合屬性**（見 `Walk`）。
//
// 這一支守的是「**每個集合型別參數都被盤點過**」，兩個方向都會紅：
//   ① 端點圖上有、`Declared` 裡沒有 ⇒ 有人新增了吃集合的參數而沒有處理它；
//   ② `Declared` 裡有、端點圖上沒有 ⇒ 宣告過期（參數改名、端點移除）——少了這一半，
//      清單會腐爛成一份沒有人敢刪的死資料（同 `EndpointAuthorizationGuardTests` 的設計）。
//
// **它看不到什麼（誠實記載，別當它完備）**：
//   ① **「有沒有真的檢查」不在這支的視野**。檢查寫在 handler 內文，而 `RequestLimits` 的
//      常數是 `const int` ⇒ 進 IL 時被內聯成 `ldc.i4`、**連欄位參考都不留**，掃 IL 也看不到。
//      這一半由既有的 `RequestCollectionLimitTests`（逐站行為）守，兩支是互補的兩半。
//      ⇒ 一條宣告寫著「已檢查」而檢查被刪掉時，這支仍然全綠。
//   ② **handler 不是 minimal-API 委派者就看不到**（例如 SignalR 的 `MapHub`：端點圖上
//      沒有 `MethodInfo`）。這一類的數量**當場量、印在失敗訊息裡**，不寫死在這裡。
//   ③ **型別圖只往下走本 repo 宣告的型別**（`Entask*`）——走進 BCL 只會撿到 `string.Chars`
//      那種雜訊。代價：一個第三方（或 BCL）DTO 型別**內部**的集合屬性看不到。
//   ④ 它盤點的是**測試 host 的**端點圖，不是部署組態的（同 `EndpointAuthorizationGuardTests`
//      的盲區④；那條 SPA fallback 是既存環境紅，它沒有參數 ⇒ 不影響這支）。
public class EndpointCollectionParameterGuardTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public EndpointCollectionParameterGuardTests(ApiWebApplicationFactory factory)
    {
        _factory = factory;
        // `CreateClient()` 是必要的：端點圖在 host 啟動時才建起來（同
        // `EndpointAuthorizationGuardTests`）。**它會跑 DB**——`Program.cs` 的 host 啟動含
        // `MigrateAsync` ＋ seed。這裡不呼叫 `WithDbReset()`：不需要重置，而 DB 重置是
        // 本專案已知 transient 的站點。
        _ = factory.CreateClient();
    }

    /// <summary>
    /// 逐條宣告：`Site` 是 `"{method} {pattern} :: {參數名}[.{屬性路徑}]"`，`Reason` 要寫出
    /// **這一個集合的上限是什麼、或為什麼刻意沒有限制**。每一條都必須命中一個真實的集合型別
    /// 參數（兩個方向各自會紅），所以這裡不會累積死條目。
    ///
    /// 建這份清單的方式是**兩次互相獨立的量測**（2026-10-11，T2），不是肉眼配對：
    ///   ① 端點圖反射（本檔）→ 15 條 `{route} :: {屬性路徑}`；
    ///   ② 原始碼掃描（`.superpowers/sdd/2026-10-11-entask-gate-and-type-coverage/t2-verify-limits.py`）
    ///      → 15 個 `Count: > RequestLimits.X` 各自所屬的 route。
    ///   兩邊**逐條吻合、都是 15**，而 2026-10-10 T5 的手寫清單也是 15 ⇒ 三者一致。
    ///   （四條走 `MapGroup` 的站點在②裡只印得出相對路徑，由 HTTP 方法消歧：
    ///   `POST …/roles/` 對 `TeamRoleEndpoints` 的 `POST /`，`PUT …/roles/{roleId:guid}` 對 `PUT /{roleId:guid}`。）
    ///
    /// **不動行為**：這一支只做普查，不改任何端點。上限的行為由既有的
    /// `RequestCollectionLimitTests`（逐站）守——見類別開頭盲區①。
    /// </summary>
    private static readonly (string Site, string Reason)[] Declared =
    [
        // ── 自訂欄位的 select 選項：RequestLimits.MaxSelectOptions（200）──────────
        ("POST /api/boards/{boardId:guid}/custom-fields :: req.Options", "RequestLimits.MaxSelectOptions（CustomFieldEndpoints.cs）"),
        ("POST /api/projects/{projectId:guid}/custom-fields :: req.Options", "RequestLimits.MaxSelectOptions（CustomFieldEndpoints.cs）"),
        ("PUT /api/boards/{boardId:guid}/custom-fields/{fieldId:guid} :: req.Options", "RequestLimits.MaxSelectOptions（CustomFieldEndpoints.cs）"),
        ("PUT /api/projects/{projectId:guid}/custom-fields/{fieldId:guid} :: req.Options", "RequestLimits.MaxSelectOptions（CustomFieldEndpoints.cs）"),

        // ── 一批參照（成員／標籤／審查者／角色的 id，以及角色的權限碼）：MaxReferenceIds（500）──
        ("POST /api/projects/{projectId:guid}/members :: req.RoleIds", "RequestLimits.MaxReferenceIds（ProjectEndpoints.cs）"),
        ("POST /api/teams/{teamId:guid}/roles/ :: req.PermissionCodes", "RequestLimits.MaxReferenceIds（TeamRoleEndpoints.cs；權限碼與 id 是同一種東西——見 RequestLimits 的摘要）"),
        ("PUT /api/cards/{cardId:guid}/custom-fields :: values", "RequestLimits.MaxReferenceIds（CustomFieldEndpoints.cs；**第 15 站**，BCL 泛型 `Dictionary<Guid, JsonElement>`，修正輪 R31 補上）"),
        ("PUT /api/cards/{cardId:guid}/labels :: req.LabelIds", "RequestLimits.MaxReferenceIds（CardEndpoints.cs）"),
        ("PUT /api/cards/{cardId:guid}/members :: req.UserIds", "RequestLimits.MaxReferenceIds（CardEndpoints.cs）"),
        ("PUT /api/cards/{cardId:guid}/reviews :: req.ReviewerUserIds", "RequestLimits.MaxReferenceIds（ReviewEndpoints.cs）"),
        ("PUT /api/projects/{projectId:guid}/members/{userId:guid} :: req.RoleIds", "RequestLimits.MaxReferenceIds（ProjectEndpoints.cs）"),
        ("PUT /api/teams/{teamId:guid}/members :: req.RoleIds", "RequestLimits.MaxReferenceIds（TeamEndpoints.cs）"),
        ("PUT /api/teams/{teamId:guid}/roles/{roleId:guid} :: req.PermissionCodes", "RequestLimits.MaxReferenceIds（TeamRoleEndpoints.cs）"),

        // ── 心智圖節點座標批次：MaxMindMapCoordinates（500）────────────────────────
        ("PUT /api/projects/{projectId:guid}/mindmap/nodes/coordinates :: req.Nodes", "RequestLimits.MaxMindMapCoordinates（MindMapEndpoints.cs）"),

        // ── 通知偏好設定的批次更新：MaxPreferenceUpdates（100）─────────────────────
        // **第 14 站**：型別 inline 宣告在端點檔裡（不在 `Dtos/`），複審 F1 補上。
        ("PUT /api/notifications/preferences :: updates", "RequestLimits.MaxPreferenceUpdates（NotificationEndpoints.cs；型別 inline 在端點檔，`Dtos/` 掃不到）"),
    ];

    [Fact]
    public void EveryCollectionParameter_IsAccountedFor()
    {
        var (rows, opaque) = Census();
        var collections = rows.Where(r => r.IsCollection).ToList();

        var undeclared = collections
            .Where(r => !Declared.Any(d => d.Site == r.Site))
            .Select(r => $"{r.Site}\n      {r.Binding} {r.TypeName}")
            .ToList();
        // 過期的宣告連理由一起印——否則讀者得自己去檔案裡找那一條原本在講什麼
        var stale = Declared
            .Where(d => !collections.Any(r => r.Site == d.Site))
            .Select(d => $"{d.Site}\n      ← {d.Reason}")
            .ToList();

        Assert.True(undeclared.Count == 0 && stale.Count == 0,
            $"""
             未被盤點的集合型別參數（{undeclared.Count} 條）：
             {Bullets(undeclared)}

             宣告了卻不存在（{stale.Count} 條，宣告過期）：
             {Bullets(stale)}

             全部集合型別參數（{collections.Count} 條；`Site` ＝ method ＋ pattern ＋ 參數名）：
             {string.Join("\n", collections.Select(r => $"  {r.Site}   [{r.Binding}] {r.TypeName}"))}

             端點圖上看不到 `MethodInfo` 的端點（{opaque.Count} 條，本閘門的盲區②）：
             {Bullets(opaque)}
             """);
    }

    private (List<(string Site, string TypeName, string Binding, bool IsCollection)> Rows, List<string> Opaque) Census()
    {
        var rows = new List<(string Site, string TypeName, string Binding, bool IsCollection)>();
        var opaque = new List<string>();
        // 參數是「服務」還是「請求內容」——**用與 `RequestDelegateFactory` 同一個判斷**
        // （`IServiceProviderIsService`），不是自己猜命名或命名空間：猜錯就會去走
        // `EntaskDbContext` 的屬性圖。
        var isService = _factory.Services.GetRequiredService<IServiceProviderIsService>();

        foreach (var e in _factory.Services.GetServices<EndpointDataSource>()
                     .SelectMany(ds => ds.Endpoints)
                     // 防禦性去重（同 `EndpointAuthorizationGuardTests`；`.Distinct()` 是參考相等）
                     .Distinct()
                     .OfType<RouteEndpoint>()
                     .OrderBy(e => $"{Methods(e)} {Pattern(e)}", StringComparer.Ordinal))
        {
            var key = $"{Methods(e)} {Pattern(e)}";
            var method = e.Metadata.GetMetadata<MethodInfo>();
            if (method is null)
            {
                opaque.Add(key);
                continue;
            }

            foreach (var p in method.GetParameters())
            {
                if (IsFrameworkType(p.ParameterType) || isService.IsService(p.ParameterType))
                {
                    continue;
                }

                // `seen` 從**空集合**起算：根型別由 `Walk` 自己加進去。初版把根型別放進種子
                // 集合裡 ⇒ `Walk` 第一行就被自己的環路守衛擋掉 ⇒ 13 站全部隱形
                // （2026-10-11 實測：端點圖上仍是 2 條，看起來像「模型圖裡沒有集合」）。
                Walk(p.ParameterType, $"{key} :: {p.Name}", Binding(p), 0, [], rows);
            }
        }

        return (rows, opaque);
    }

    /// <summary>
    /// 從一個參數型別往下走它的**公開實例屬性**，把路上遇到的集合型別全部記成一列。
    ///
    /// `seen` 是**每一個參數各自一份**的環路守衛（不是全域）——同一個型別在兩條路徑上各出現
    /// 一次時，那兩列是不同的站點，不該被去重掉。深度上限 3 是防爆，不是語意：本 repo 的
    /// 請求 DTO 沒有那麼深。
    ///
    /// **只往下走本 repo 宣告的型別**（命名空間 `Entask*`）：BCL 的型別再走下去只會撿到
    /// `string.Chars`（`char[]`）那種雜訊。這是一個**刻意的邊界**，列在類別開頭的盲區③。
    /// </summary>
    private static void Walk(
        Type type,
        string path,
        string binding,
        int depth,
        HashSet<Type> seen,
        List<(string Site, string TypeName, string Binding, bool IsCollection)> rows)
    {
        if (IsCollection(type))
        {
            rows.Add((path, Format(type), binding, true));
            return; // 不再往下：元素的內部不是「請求面的一次輸入」
        }

        if (depth >= 3
            || type.Namespace is null
            || !type.Namespace.StartsWith("Entask", StringComparison.Ordinal)
            || !seen.Add(type))
        {
            return;
        }

        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (prop.GetIndexParameters().Length > 0)
            {
                continue; // 索引子不是請求欄位
            }

            Walk(prop.PropertyType, $"{path}.{prop.Name}", binding, depth + 1, [.. seen], rows);
        }
    }

    /// <summary>
    /// 框架自己吃掉的參數（不是請求內容、也不是服務）。**刻意不放 `IFormFile`／
    /// `IFormFileCollection`**——後者是集合，該被盤點到；前者不是集合，兩者都不會產生雜訊列。
    /// </summary>
    private static bool IsFrameworkType(Type t) =>
        t == typeof(System.Security.Claims.ClaimsPrincipal)
        || t == typeof(HttpContext)
        || t == typeof(HttpRequest)
        || t == typeof(HttpResponse)
        || t == typeof(CancellationToken)
        || t == typeof(Stream);

    /// <summary>
    /// 「一批東西」的判定。刻意**不**從「型別宣告在哪裡」推（那正是漏掉第 14／15 站的方法），
    /// 而是看型別本身：陣列、BCL 的泛型集合介面／實作、以及任何 `IEnumerable`（排除 `string`，
    /// 它是 `IEnumerable&lt;char&gt;` 但語意上是一個值）。`IFormFileCollection` 由介面那條撿到
    /// （它實作 `IReadOnlyList&lt;IFormFile&gt;`）。
    /// </summary>
    private static bool IsCollection(Type t)
    {
        if (t == typeof(string))
        {
            return false;
        }

        if (t.IsArray)
        {
            return true;
        }

        if (typeof(System.Collections.IEnumerable).IsAssignableFrom(t))
        {
            return true;
        }

        return false;
    }

    private static string Binding(ParameterInfo p)
    {
        if (p.GetCustomAttribute<FromBodyAttribute>() is not null)
        {
            return "Body";
        }

        if (p.GetCustomAttribute<FromQueryAttribute>() is not null)
        {
            return "Query";
        }

        if (p.GetCustomAttribute<FromRouteAttribute>() is not null)
        {
            return "Route";
        }

        return "（隱式）";
    }

    private static string Format(Type t)
    {
        if (t.IsArray)
        {
            return Format(t.GetElementType()!) + "[]";
        }

        if (t.IsGenericType)
        {
            return t.Name.Split('`')[0] + "<" + string.Join(",", t.GetGenericArguments().Select(Format)) + ">";
        }

        return t.Name;
    }

    private static string Pattern(RouteEndpoint e) => "/" + (e.RoutePattern.RawText ?? "").TrimStart('/');

    private static string Methods(RouteEndpoint e)
    {
        var methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
        return methods is null or { Count: 0 } ? "ANY" : string.Join(",", methods);
    }

    private static string Bullets(IEnumerable<string> items) =>
        items.Count() == 0 ? "  （無）" : string.Join("\n", items.Select(i => "  " + i));
}
