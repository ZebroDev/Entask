using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Api;
using Entask.Core;

namespace Entask.Tests;

/// <summary>
/// 請求面集合的硬上限（2026-10-10 公開前硬化，T5；12 個型別、15 個站點）。
///
/// 站點 14、15 是 2026-10-11 補的，兩者都不是被任何閘門逼出來的——普查方法是「型別宣告」，
/// 而這兩種形狀它都掃不到：14＝`NotificationEndpoints.cs` 的 `List<PreferenceUpdateDto>`
/// （型別 inline 宣告在端點檔內，2026-10-11 最終複審 F1），15＝`CustomFieldEndpoints.cs` 的
/// `Dictionary<Guid, JsonElement>`（BCL 泛型，根本沒有本 repo 的型別宣告，同日修正輪 R31）。
/// 閘門缺口的形狀與病根見 `docs/state/44`。
///
/// 每一站兩支、**刻意不共用**（共用會讓「哪一站忘了掛」重新變成不可見）：
///
///   - `…OverLimit_IsRejectedBeforeAnyLookup`：`RequestLimits` 的上限 ＋ 1 ⇒ 400
///     ＋ `request.collectionTooLarge`。帶的是**全部不存在的 id**（或任意字串碼）——
///     上限檢查必須在**任何 DB 查詢之前**，所以這一支不需要造任何真實物件。
///     若哪一天它非得造真實資料才測得動，那就是檢查被放到了 DB 工作之後（brief Step 1）。
///     ★ **這個推論是單向的**（2026-10-11 scoped 複核的 LOW）：「不需要真實物件」**不證明**
///     檢查就在前面——站點 14（`NotificationPreferences_…`）的既有 DB 讀取對已登入者
///     恆成功，檢查被搬到那一次讀取之後，本支照樣綠。**有位置判別力的是「檢查被搬走之後
///     會拿到該站點自己的回應」**（站點 15：隨機 `cardId` ⇒ 404）；站點 14 目前沒有這種指紋。
///   - `…AtLimit_IsNotRejectedForSize`：**恰好**上限個 ⇒ **不是** collectionTooLarge，
///     而是該站點原本就會給的那個回應（狀態碼與 code 逐條斷言；「不是 collectionTooLarge」
///     那種空泛斷言分不出「邊界正確」與「整段檢查根本沒被執行」）。
///     這一支同時釘住邊界是 `> max` 而不是 `>= max`——差一個就全站失準。
///
/// 上限值一律從 `RequestLimits` 讀、**不寫死數字**：寫死會在調值時靜默失效
/// （測試跟著舊值綠，而新的值沒有人守）。
///
/// 站點路徑上的 GUID 不需要指向真實資源：admin 對 `RequireProjectPermission`／
/// `RequirePermission` 是直接放行（R8），而檢查在 handler 的第一段。
/// </summary>
public class RequestCollectionLimitTests : IClassFixture<ApiWebApplicationFactory>
{
    /// <summary>
    /// 線路契約的字面值（不是 `ErrorCodes` 常量）：`code` 是機器契約，這一格要紅在
    /// 「後端換了字」而不是「兩邊一起換所以看起來沒事」。前端 case
    /// （`error-messages.ts`）與六個語系檔的 key 由 `check:labels`／閘門 C 釘著同一組字。
    /// </summary>
    private const string TooLargeCode = "request.collectionTooLarge";

    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public RequestCollectionLimitTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task AuthAsync()
    {
        var token = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    /// <summary>存在性不可能是真的 id 清單（`Guid.NewGuid()` 每個都不重複）。</summary>
    private static List<Guid> Guids(int count) =>
        Enumerable.Range(0, count).Select(_ => Guid.NewGuid()).ToList();

    /// <summary>相異的選項字串（`select` 欄位用；`ValidSelectOptions` 只擋空白項）。</summary>
    private static List<string> Options(int count) =>
        Enumerable.Range(0, count).Select(i => $"option-{i}").ToList();

    /// <summary>相異的權限碼（形狀合法、內容不存在——打不到任何一列 `Permissions`）。</summary>
    private static List<string> PermissionCodes(int count) =>
        Enumerable.Range(0, count).Select(i => $"limit.probe{i}").ToList();

    /// <summary>相異的通知型別（`PreferenceUpdateDto`；型別是自由字串，站點不驗它存在）。</summary>
    private static List<object> Preferences(int count) =>
        Enumerable.Range(0, count)
            .Select(i => (object)new { type = $"limit.probe{i}", inAppEnabled = true })
            .ToList();

    /// <summary>相異欄位 id ⇒ 任意合法 JSON 值（`Dictionary<Guid, JsonElement>` 的 body）。</summary>
    private static Dictionary<Guid, JsonElement> FieldValues(int count) =>
        Guids(count).ToDictionary(id => id, _ => JsonSerializer.SerializeToElement("value"));

    // ── 站點 1：UpdateCardMembersRequest.UserIds ──────────────────────────────
    // PUT /api/cards/{cardId:guid}/members（CardEndpoints.cs）

    [Fact]
    public async Task CardMembers_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { userIds = Guids(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/members", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task CardMembers_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { userIds = Guids(RequestLimits.MaxReferenceIds) };
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/members", body);
        // 恰好 500 個**不存在**的 id ⇒ 走原路徑：卡片查不到（這一支不碰真實卡片）。
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.CardNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 2：UpdateCardLabelsRequest.LabelIds ─────────────────────────────
    // PUT /api/cards/{cardId:guid}/labels（CardEndpoints.cs）

    [Fact]
    public async Task CardLabels_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { labelIds = Guids(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/labels", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task CardLabels_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { labelIds = Guids(RequestLimits.MaxReferenceIds) };
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/labels", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.CardNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 3：CreateCustomFieldRequest.Options（專案） ──────────────────────
    // POST /api/projects/{projectId:guid}/custom-fields（CustomFieldEndpoints.cs）

    [Fact]
    public async Task ProjectCustomFieldCreate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { name = "臨界欄位", type = "select", options = Options(RequestLimits.MaxSelectOptions + 1) };
        var res = await _client.PostAsJsonAsync($"/api/projects/{Guid.NewGuid()}/custom-fields", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task ProjectCustomFieldCreate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { name = "臨界欄位", type = "select", options = Options(RequestLimits.MaxSelectOptions) };
        var res = await _client.PostAsJsonAsync($"/api/projects/{Guid.NewGuid()}/custom-fields", body);
        // 定義驗證過得去 ⇒ 走原路徑：專案查不到。
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.ProjectNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 4：UpdateCustomFieldRequest.Options（專案） ──────────────────────
    // PUT /api/projects/{projectId:guid}/custom-fields/{fieldId:guid}

    [Fact]
    public async Task ProjectCustomFieldUpdate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { options = Options(RequestLimits.MaxSelectOptions + 1) };
        var res = await _client.PutAsJsonAsync(
            $"/api/projects/{Guid.NewGuid()}/custom-fields/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task ProjectCustomFieldUpdate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { options = Options(RequestLimits.MaxSelectOptions) };
        var res = await _client.PutAsJsonAsync(
            $"/api/projects/{Guid.NewGuid()}/custom-fields/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.CardFieldNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 5：CreateCustomFieldRequest.Options（看板） ──────────────────────
    // POST /api/boards/{boardId:guid}/custom-fields

    [Fact]
    public async Task BoardCustomFieldCreate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { name = "臨界欄位", type = "select", options = Options(RequestLimits.MaxSelectOptions + 1) };
        var res = await _client.PostAsJsonAsync($"/api/boards/{Guid.NewGuid()}/custom-fields", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task BoardCustomFieldCreate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { name = "臨界欄位", type = "select", options = Options(RequestLimits.MaxSelectOptions) };
        var res = await _client.PostAsJsonAsync($"/api/boards/{Guid.NewGuid()}/custom-fields", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.BoardNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 6：UpdateCustomFieldRequest.Options（看板） ──────────────────────
    // PUT /api/boards/{boardId:guid}/custom-fields/{fieldId:guid}

    [Fact]
    public async Task BoardCustomFieldUpdate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { options = Options(RequestLimits.MaxSelectOptions + 1) };
        var res = await _client.PutAsJsonAsync(
            $"/api/boards/{Guid.NewGuid()}/custom-fields/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task BoardCustomFieldUpdate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { options = Options(RequestLimits.MaxSelectOptions) };
        var res = await _client.PutAsJsonAsync(
            $"/api/boards/{Guid.NewGuid()}/custom-fields/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.CardFieldNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 7：AddProjectMemberRequest.RoleIds ──────────────────────────────
    // POST /api/projects/{projectId:guid}/members（ProjectEndpoints.cs）

    [Fact]
    public async Task ProjectMemberAdd_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { userId = Guid.NewGuid(), roleIds = Guids(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PostAsJsonAsync($"/api/projects/{Guid.NewGuid()}/members", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task ProjectMemberAdd_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { userId = Guid.NewGuid(), roleIds = Guids(RequestLimits.MaxReferenceIds) };
        var res = await _client.PostAsJsonAsync($"/api/projects/{Guid.NewGuid()}/members", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.ProjectNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 8：UpdateProjectMemberRequest.RoleIds ───────────────────────────
    // PUT /api/projects/{projectId:guid}/members/{userId:guid}

    [Fact]
    public async Task ProjectMemberUpdate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { roleIds = Guids(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PutAsJsonAsync(
            $"/api/projects/{Guid.NewGuid()}/members/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task ProjectMemberUpdate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { roleIds = Guids(RequestLimits.MaxReferenceIds) };
        var res = await _client.PutAsJsonAsync(
            $"/api/projects/{Guid.NewGuid()}/members/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.ProjectNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 9：UpdateReviewersRequest.ReviewerUserIds ───────────────────────
    // PUT /api/cards/{cardId:guid}/reviews（ReviewEndpoints.cs）

    [Fact]
    public async Task CardReviewers_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { reviewerUserIds = Guids(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/reviews", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task CardReviewers_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { reviewerUserIds = Guids(RequestLimits.MaxReferenceIds) };
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/reviews", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.CardNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 10：AssignMemberRequest.RoleIds ────────────────────────────────
    // PUT /api/teams/{teamId:guid}/members（TeamEndpoints.cs）

    [Fact]
    public async Task TeamMemberAssign_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { username = "nobody", roleIds = Guids(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PutAsJsonAsync($"/api/teams/{Guid.NewGuid()}/members", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task TeamMemberAssign_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { username = "nobody", roleIds = Guids(RequestLimits.MaxReferenceIds) };
        var res = await _client.PutAsJsonAsync($"/api/teams/{Guid.NewGuid()}/members", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.TeamNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 11：CreateRoleRequest.PermissionCodes ───────────────────────────
    // POST /api/teams/{teamId:guid}/roles（TeamRoleEndpoints.cs）

    [Fact]
    public async Task TeamRoleCreate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { name = "臨界角色", permissionCodes = PermissionCodes(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PostAsJsonAsync($"/api/teams/{Guid.NewGuid()}/roles", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task TeamRoleCreate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { name = "臨界角色", permissionCodes = PermissionCodes(RequestLimits.MaxReferenceIds) };
        var res = await _client.PostAsJsonAsync($"/api/teams/{Guid.NewGuid()}/roles", body);
        // 恰好 500 個**不存在**的權限碼 ⇒ 走原路徑的「包含無效的權限碼」。
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 12：UpdateRoleRequest.PermissionCodes ───────────────────────────
    // PUT /api/teams/{teamId:guid}/roles/{roleId:guid}

    [Fact]
    public async Task TeamRoleUpdate_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = new { name = "臨界角色", permissionCodes = PermissionCodes(RequestLimits.MaxReferenceIds + 1) };
        var res = await _client.PutAsJsonAsync($"/api/teams/{Guid.NewGuid()}/roles/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task TeamRoleUpdate_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = new { name = "臨界角色", permissionCodes = PermissionCodes(RequestLimits.MaxReferenceIds) };
        var res = await _client.PutAsJsonAsync($"/api/teams/{Guid.NewGuid()}/roles/{Guid.NewGuid()}", body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.TeamRoleSystemNotEditable, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 13：BatchUpdateMindMapNodeCoordinatesRequest.Nodes ──────────────
    // PUT /api/projects/{projectId:guid}/mindmap/nodes/coordinates（MindMapEndpoints.cs）

    [Fact]
    public async Task MindMapCoordinates_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var nodes = Enumerable.Range(0, RequestLimits.MaxMindMapCoordinates + 1)
            .Select(_ => new { id = Guid.NewGuid(), x = 1.0, y = 2.0 }).ToList();
        var res = await _client.PutAsJsonAsync(
            $"/api/projects/{Guid.NewGuid()}/mindmap/nodes/coordinates", new { nodes });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task MindMapCoordinates_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var nodes = Enumerable.Range(0, RequestLimits.MaxMindMapCoordinates)
            .Select(_ => new { id = Guid.NewGuid(), x = 1.0, y = 2.0 }).ToList();
        var res = await _client.PutAsJsonAsync(
            $"/api/projects/{Guid.NewGuid()}/mindmap/nodes/coordinates", new { nodes });
        // 非空清單 ⇒ 走原路徑：節點查不到（這一批全部不存在）。
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(ErrorCodes.MindmapNodeNotFound, await ErrorBody.CodeOfAsync(res));
    }

    // ── 站點 14：`[FromBody] List<PreferenceUpdateDto>`（body 本身就是集合） ───
    // PUT /api/notifications/preferences（NotificationEndpoints.cs；2026-10-11 最終複審 F1 補上）

    // ★ 本支**不釘位置**（2026-10-11 scoped 複核的 LOW）：這個端點對已登入者的既有 DB
    // 讀取恆成功 ⇒ 檢查被搬到那一次讀取之後，本支照樣 400。它釘的是上限值與 `>` 邊界；
    // 「位置」的釘子在同檔的 `CardCustomFieldValues_OverLimit_…`（隨機 `cardId` ⇒ 404 指紋）。
    [Fact]
    public async Task NotificationPreferences_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = Preferences(RequestLimits.MaxPreferenceUpdates + 1);
        var res = await _client.PutAsJsonAsync("/api/notifications/preferences", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task NotificationPreferences_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = Preferences(RequestLimits.MaxPreferenceUpdates);
        var res = await _client.PutAsJsonAsync("/api/notifications/preferences", body);
        // 恰好上限個相異型別 ⇒ 走原路徑：全部是新增的偏好列，成功後是這站原本的回應
        // 200 空 body（`Results.Ok()`）——沒有 `code` 可斷言，所以只有狀態碼這一格。
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    // ── 站點 15：`Dictionary<Guid, JsonElement>`（BCL 泛型，body 參數） ────────
    // PUT /api/cards/{cardId:guid}/custom-fields（CustomFieldEndpoints.cs；2026-10-11 修正輪 R31 補上）

    [Fact]
    public async Task CardCustomFieldValues_OverLimit_IsRejectedBeforeAnyLookup()
    {
        await AuthAsync();
        var body = FieldValues(RequestLimits.MaxReferenceIds + 1);
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/custom-fields", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(TooLargeCode, await ErrorBody.CodeOfAsync(res));
    }

    [Fact]
    public async Task CardCustomFieldValues_AtLimit_IsNotRejectedForSize()
    {
        await AuthAsync();
        var body = FieldValues(RequestLimits.MaxReferenceIds);
        var res = await _client.PutAsJsonAsync($"/api/cards/{Guid.NewGuid()}/custom-fields", body);
        // 恰好上限個**不存在**的欄位 id ＋ 隨機 cardId ⇒ 走原路徑：卡片查不到。
        // 這一格用線路字面值而不是 `ErrorCodes` 常量（同 `TooLargeCode` 的理由：要紅在
        // 「後端換了字」）；字面值當場讀自 `src/Entask.Core/ErrorCodes.cs` 的 `CardNotFound`。
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("card.notFound", await ErrorBody.CodeOfAsync(res));
    }
}
