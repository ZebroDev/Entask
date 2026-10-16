using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Entask.Tests;

// 不變量（2026-09-19 裁定，走後端驗證）：
// **每一張卡片的指派者與審查者，都必須是該卡片所屬專案的成員。**
//
// 三半缺一不可：
//   A. 卡片的兩個 PUT 嚴格驗證整份清單（送出的清單就是最終清單）——否則卡片可以合法持有
//      不在專案名冊裡的人，而下拉列的是專案名冊，使用者永遠取消不掉他。
//   B. 專案成員的三條移除路徑，在「這次操作會讓他在該專案的角色歸零」且「他仍在該專案的
//      卡片上」時回 409——否則 A 的嚴格驗證會把那些卡片鎖死（成員改不動、待審的卡片
//      只有被指派的審查者本人能提交，admin 沒有豁免 ⇒ 永遠送不出去）。
//   C. 複製路線（2026-09-22 裁定）：三條會複製卡片的路由都收**顯式的跨專案目標**，
//      而 CopyCardCoreAsync 原本無條件搬成員 ⇒ 新卡片帶著來源專案的成員出現在目標專案，
//      正是 A／B 要消滅的狀態。落地後的規則是「副本的成員 = 來源成員 ∩ 目標專案名冊」。
public class CardProjectMembershipTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CardProjectMembershipTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string CardId, string ProjectId, string EngineerRoleId)> SetupAsync(string tag)
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = $"成員契約團隊-{tag}" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerRoleId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;

        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = $"成員契約專案-{tag}" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;

        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "成員契約板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var list = await (await _client.PostAsync($"/api/boards/{board.GetProperty("id").GetString()}/lists",
            JsonContent.Create(new { name = "列表" }))).Content.ReadFromJsonAsync<JsonElement>();
        var card = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = $"成員契約卡-{tag}" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (card.GetProperty("id").GetString()!, projectId, engineerRoleId);
    }

    private async Task<Guid> CreateUserAsync(string username, string displayName)
    {
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username, password = "Password1!", displayName }));
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return db.Users.First(u => u.UserName == username).Id;
    }

    private async Task AddProjectMemberAsync(string projectId, Guid userId, string roleId)
    {
        var resp = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId, roleIds = new[] { roleId } }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    private async Task<string> AssignCardMemberAsync(string cardId, Guid userId)
    {
        var resp = await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = new[] { userId } }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("members").EnumerateArray().Single().GetString()!;
    }

    // 讀 body 的邏輯只有一份：共用的 ErrorBody（本檔 9 個呼叫端不動）。
    private static async Task<string?> CodeOfAsync(HttpResponseMessage resp)
        => await ErrorBody.CodeOfAsync(resp);

    // 「在卡片上、不在名冊裡」的歷史孤兒：只有直接寫 DB 才造得出來（API 從 2026-09-19 起擋下）。
    private async Task AddOrphanCardMemberRowAsync(string cardId, Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.CardMembers.Add(new CardMember { CardId = Guid.Parse(cardId), UserId = userId });
        await db.SaveChangesAsync();
    }

    private async Task AddOrphanCardReviewRowAsync(string cardId, Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.CardReviews.Add(new CardReview { CardId = Guid.Parse(cardId), ReviewerUserId = userId, Status = ReviewStatuses.Pending });
        await db.SaveChangesAsync();
    }

    // 一律以 projectId 篩選，不用未篩選的 `.Single()`——`WithDbReset()` 是 per-class，
    // 同一個類別每一支測試都建了團隊／專案，未篩選的查詢會撈到別支測試的列。
    private async Task<bool> HasProjectMemberRowAsync(string projectId, Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return await db.ProjectMembers.AnyAsync(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == userId);
    }

    // ---- 複製路線（C 段）的用具 ----

    // 卡片的位置：三條複製路由各要其中一段（清單路線要 listId、看板路線要 boardId、
    // 「副本落在哪個專案」的斷言要 projectId），一次查完。
    private async Task<(string ProjectId, string BoardId, string ListId)> CardLocationAsync(string cardId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var loc = await db.Cards.Where(c => c.Id == Guid.Parse(cardId))
            .Select(c => new { c.ListId, c.List.BoardId, c.List.Board.ProjectId }).FirstAsync();
        return (loc.ProjectId.ToString(), loc.BoardId.ToString(), loc.ListId.ToString());
    }

    // `SetupAsync` 的回傳值不含 teamId，而建立第二個專案要 X-Team-Id header。
    private async Task<string> TeamIdOfProjectAsync(string projectId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return (await db.Projects.Where(p => p.Id == Guid.Parse(projectId))
            .Select(p => p.TeamId).FirstAsync()).ToString();
    }

    // 跨專案複製的目標端：同團隊的另一個專案（含一張板、一個列表）。
    private async Task<(string ProjectId, string BoardId, string ListId)> CreateTargetProjectAsync(string teamId, string tag)
    {
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = $"目標專案-{tag}" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "目標板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "目標列表" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (projectId, boardId, list.GetProperty("id").GetString()!);
    }

    private static List<string?> MembersOf(JsonElement card) =>
        card.GetProperty("members").EnumerateArray().Select(m => m.GetString()).ToList();

    /// <summary>來源端的成員（排序後），供「複製沒有動到來源」的斷言用。
    /// 少了它，把過濾寫成「順手把來源卡上的無效列刪掉」的突變會讓六支全綠（ledger 的 M4）。</summary>
    private async Task<string[]> SourceCardMembersAsync(string cardId) =>
        Sorted((await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("members").EnumerateArray().Select(m => Guid.Parse(m.GetString()!)).ToArray());

    private static string[] Sorted(params Guid[] ids) =>
        ids.Select(i => i.ToString()).OrderBy(x => x, StringComparer.Ordinal).ToArray();

    private async Task<bool> HasCardMemberRowAsync(string cardId, Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        return await db.CardMembers.AnyAsync(m => m.CardId == Guid.Parse(cardId) && m.UserId == userId);
    }

    // ---- A. 卡片的兩個 PUT ----

    [Fact]
    public async Task CardMembersPut_NonProjectMember_Returns400WithCode()
    {
        var (cardId, _, _) = await SetupAsync("a1");
        var bob = await CreateUserAsync("cpm-bob-a1", "非成員鮑伯");
        var resp = await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = new[] { bob } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardMemberNotProjectMember, await CodeOfAsync(resp));
    }

    [Fact]
    public async Task CardMembersPut_ProjectMember_Returns200()
    {
        var (cardId, projectId, roleId) = await SetupAsync("a2");
        var alice = await CreateUserAsync("cpm-alice-a2", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        Assert.Equal(alice.ToString(), await AssignCardMemberAsync(cardId, alice));
    }

    [Fact]
    public async Task CardReviewsPut_NonProjectMember_Returns400WithCode()
    {
        var (cardId, _, _) = await SetupAsync("a3");
        var bob = await CreateUserAsync("cpm-bob-a3", "非成員鮑伯");
        var resp = await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { bob } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.ReviewReviewerNotProjectMember, await CodeOfAsync(resp));
    }

    [Fact]
    public async Task CardReviewsPut_ProjectMember_Returns200()
    {
        var (cardId, projectId, roleId) = await SetupAsync("a4");
        var alice = await CreateUserAsync("cpm-alice-a4", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        var resp = await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { alice } }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(alice.ToString(), body.EnumerateArray().Single().GetProperty("reviewerUserId").GetString());
    }

    // 非法的 user id 仍要回原本的 request.invalid（驗證順序：存在性先於成員資格）。
    [Fact]
    public async Task CardMembersPut_NonexistentUser_StillReturnsRequestInvalid()
    {
        var (cardId, _, _) = await SetupAsync("a5");
        var resp = await _client.PutAsync($"/api/cards/{cardId}/members", JsonContent.Create(new { userIds = new[] { Guid.NewGuid() } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.RequestInvalid, await CodeOfAsync(resp));
    }

    // 這次改動的核心動機（R2）：驗**整份清單**，不是只驗「新增的人」。
    // 實際的呼叫形狀是全量取代——把卡片當下的名冊原樣送回。若只驗新增的人，
    // 已掛在卡片上的孤兒（非專案成員）永遠驗不到：他留在卡片上、下拉列不出他、
    // 使用者取消不掉他，而**任何一次儲存（原樣送回）都會被擋下** ⇒ 那張卡片從此改不動。
    [Fact]
    public async Task CardMembersPut_OrphanAlreadyOnCard_FullListResent_Returns400()
    {
        var (cardId, projectId, roleId) = await SetupAsync("a6");
        var alice = await CreateUserAsync("cpm-alice-a6", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);
        var bob = await CreateUserAsync("cpm-bob-a6", "非成員鮑伯");
        await AddOrphanCardMemberRowAsync(cardId, bob);

        // 卡片當下的名冊（alice ＋ 孤兒 bob）原樣送回——孤兒一個都不在「新增」的那一群裡
        var resp = await _client.PutAsync($"/api/cards/{cardId}/members",
            JsonContent.Create(new { userIds = new[] { alice, bob } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.CardMemberNotProjectMember, await CodeOfAsync(resp));
    }

    [Fact]
    public async Task CardReviewsPut_OrphanAlreadyOnCard_FullListResent_Returns400()
    {
        var (cardId, projectId, roleId) = await SetupAsync("a7");
        var alice = await CreateUserAsync("cpm-alice-a7", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        var assigned = await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { alice } }));
        Assert.Equal(HttpStatusCode.OK, assigned.StatusCode);
        var bob = await CreateUserAsync("cpm-bob-a7", "非成員鮑伯");
        await AddOrphanCardReviewRowAsync(cardId, bob);

        var resp = await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { alice, bob } }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(ErrorCodes.ReviewReviewerNotProjectMember, await CodeOfAsync(resp));
    }

    // ---- B. 專案成員的三條移除路徑 ----

    [Fact]
    public async Task ProjectMemberDelete_AssignedOnCard_Returns409WithCode()
    {
        var (cardId, projectId, roleId) = await SetupAsync("b1");
        var alice = await CreateUserAsync("cpm-alice-b1", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);

        var resp = await _client.DeleteAsync($"/api/projects/{projectId}/members/{alice}");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        Assert.Equal(ErrorCodes.ProjectMemberInUse, await CodeOfAsync(resp));
    }

    [Fact]
    public async Task ProjectMemberPut_EmptyRoleIds_AssignedOnCard_Returns409()
    {
        var (cardId, projectId, roleId) = await SetupAsync("b2");
        var alice = await CreateUserAsync("cpm-alice-b2", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);

        var resp = await _client.PutAsync($"/api/projects/{projectId}/members/{alice}",
            JsonContent.Create(new { roleIds = Array.Empty<string>() }));
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        Assert.Equal(ErrorCodes.ProjectMemberInUse, await CodeOfAsync(resp));
    }

    // 守衛條件的另一半是**反過度阻擋**：他已被卡片參照，但這次 PUT 讓他**仍有角色**
    // （`remainingCount > 0`）時不該被擋。少了這一半，擋過頭是靜默的——上面的 b2 照樣綠。
    [Fact]
    public async Task ProjectMemberPut_MemberWithCardReference_NonEmptyRoles_Returns200()
    {
        var (cardId, projectId, roleId) = await SetupAsync("b10");
        var alice = await CreateUserAsync("cpm-alice-b10", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);

        // 換一個仍然合法的系統角色（`TeamId == null` ⇒ 對任何使用者都通過 RoleIdsValidAsync），
        // 讓「角色確實更新」驗到的是變化，而不是原樣送回。
        Guid otherRoleId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            otherRoleId = await db.Roles
                .Where(r => r.TeamId == null && r.Id != Guid.Parse(roleId))
                .Select(r => r.Id).FirstAsync();
        }

        var resp = await _client.PutAsync($"/api/projects/{projectId}/members/{alice}",
            JsonContent.Create(new { roleIds = new[] { otherRoleId } }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        using (var verify = _factory.Services.CreateScope())
        {
            var db = verify.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var rows = await db.ProjectMembers
                .Where(m => m.ProjectId == Guid.Parse(projectId) && m.UserId == alice)
                .Select(m => m.RoleId).ToListAsync();
            Assert.Equal(new[] { otherRoleId }, rows);
        }
    }

    [Fact]
    public async Task ProjectMemberPost_EmptyRoleIds_AssignedOnCard_Returns409()
    {
        var (cardId, projectId, roleId) = await SetupAsync("b3");
        var alice = await CreateUserAsync("cpm-alice-b3", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);

        var resp = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = alice, roleIds = Array.Empty<string>() }));
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        Assert.Equal(ErrorCodes.ProjectMemberInUse, await CodeOfAsync(resp));
    }

    // 回歸鎖：守衛不能變成全面禁止。
    [Fact]
    public async Task ProjectMemberDelete_NotOnAnyCard_Returns200()
    {
        var (_, projectId, roleId) = await SetupAsync("b4");
        var alice = await CreateUserAsync("cpm-alice-b4", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);

        var resp = await _client.DeleteAsync($"/api/projects/{projectId}/members/{alice}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var members = await (await _client.GetAsync($"/api/projects/{projectId}/members")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.DoesNotContain(members.EnumerateArray(), m => m.GetProperty("userId").GetString() == alice.ToString());
    }

    // 判別力所在：全域 query filter 只讓「現任審查者」擋移除。
    // 少了 filter，這一支會紅（軟刪除的列還在，會被算成參照）。
    [Fact]
    public async Task ProjectMemberDelete_SoftDeletedReviewer_Returns200()
    {
        var (cardId, projectId, roleId) = await SetupAsync("b5");
        var alice = await CreateUserAsync("cpm-alice-b5", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);

        var assigned = await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = new[] { alice } }));
        Assert.Equal(HttpStatusCode.OK, assigned.StatusCode);

        // 現任審查者仍在時 → 擋（先確立守衛確實在作用，否則下一段的 200 沒有判別力）
        var blocked = await _client.DeleteAsync($"/api/projects/{projectId}/members/{alice}");
        Assert.Equal(HttpStatusCode.Conflict, blocked.StatusCode);

        // 換掉審查者（軟刪除、RemovedAt 有值、列還在）→ 不該再擋
        var cleared = await _client.PutAsync($"/api/cards/{cardId}/reviews", JsonContent.Create(new { reviewerUserIds = Array.Empty<Guid>() }));
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var row = await db.CardReviews.IgnoreQueryFilters()
                .SingleAsync(r => r.CardId == Guid.Parse(cardId) && r.ReviewerUserId == alice);
            Assert.NotNull(row.RemovedAt);
        }

        var resp = await _client.DeleteAsync($"/api/projects/{projectId}/members/{alice}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    // 「他目前在該專案至少有一列」這個條件的判別力：本來就不是成員時，移除是 no-op，
    // 不該因為他是歷史孤兒（卡片上有他、名冊裡沒有他）而回一次莫名其妙的 409。
    [Fact]
    public async Task ProjectMemberDelete_NotAMember_WithOrphanCardRow_Returns200()
    {
        var (cardId, projectId, _) = await SetupAsync("b6");
        var bob = await CreateUserAsync("cpm-bob-b6", "非成員鮑伯");
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            db.CardMembers.Add(new CardMember { CardId = Guid.Parse(cardId), UserId = bob });
            await db.SaveChangesAsync();
        }

        var resp = await _client.DeleteAsync($"/api/projects/{projectId}/members/{bob}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    // 三條移除路徑各自是一份獨立的觸發運算式，條件 (b)「他目前在該專案至少有一列」
    // 因此要逐條釘住（H1）：不是成員時帶空 roleIds 是 no-op——不會刪掉任何列、
    // 不會新增任何列，也不該因為他是歷史孤兒而回一次莫名其妙的 409。
    [Fact]
    public async Task ProjectMemberPost_NotAMember_WithOrphanCardRow_Returns200()
    {
        var (cardId, projectId, _) = await SetupAsync("b8");
        var bob = await CreateUserAsync("cpm-bob-b8", "非成員鮑伯");
        await AddOrphanCardMemberRowAsync(cardId, bob);

        var resp = await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = bob, roleIds = Array.Empty<string>() }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.False(await HasProjectMemberRowAsync(projectId, bob));
    }

    // PUT 與 POST 的守衛各自一份運算式（`desired.Count == 0 && existing.Count > 0`）。
    [Fact]
    public async Task ProjectMemberPut_NotAMember_WithOrphanCardRow_Returns200()
    {
        var (cardId, projectId, _) = await SetupAsync("b9");
        var bob = await CreateUserAsync("cpm-bob-b9", "非成員鮑伯");
        await AddOrphanCardMemberRowAsync(cardId, bob);

        var resp = await _client.PutAsync($"/api/projects/{projectId}/members/{bob}",
            JsonContent.Create(new { roleIds = Array.Empty<string>() }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.False(await HasProjectMemberRowAsync(projectId, bob));
    }

    // 移除路徑的既有驗證順序不變（project 不存在仍回 404，不是 409）。
    [Fact]
    public async Task ProjectMemberDelete_UnknownProject_StillReturns404()
    {
        await SetupAsync("b7");
        var resp = await _client.DeleteAsync($"/api/projects/{Guid.NewGuid()}/members/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    // ---- C. 複製路線 ----
    //
    // 落地後：**副本的成員 = 來源成員 ∩ 目標專案名冊**，無條件（含同專案複製）。
    // 每支都先立「前提」再斷言結果——沒有前提斷言時，「過濾器寫成清空成員」與
    // 「過濾器寫對」在負向測試上長得一樣。

    [Fact]
    public async Task CardCopy_CrossProject_DropsMemberNotInTargetProject()
    {
        var (cardId, projectId, roleId) = await SetupAsync("c1");
        var alice = await CreateUserAsync("cpm-alice-c1", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);
        var (targetProjectId, _, targetListId) =
            await CreateTargetProjectAsync(await TeamIdOfProjectAsync(projectId), "c1");
        Assert.False(await HasProjectMemberRowAsync(targetProjectId, alice));   // 前提：目標名冊沒有她

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy",
            JsonContent.Create(new { targetListId }))).Content.ReadFromJsonAsync<JsonElement>();

        Assert.Empty(MembersOf(copy));
        // 前提的第二半：副本**真的落在目標專案**——否則這一支測的是「同專案複製」，
        // 而它綠的理由會變成「過濾器把所有人都丟掉」。
        Assert.Equal(targetProjectId, (await CardLocationAsync(copy.GetProperty("id").GetString()!)).ProjectId);
        Assert.Equal(Sorted(alice), await SourceCardMembersAsync(cardId));   // 來源不得被動到
    }

    // 過濾器的反向對照：兩邊都在名冊裡的人**必須留著**。
    [Fact]
    public async Task CardCopy_CrossProject_KeepsMemberWhoIsInBothProjects()
    {
        var (cardId, projectId, roleId) = await SetupAsync("c2");
        var alice = await CreateUserAsync("cpm-alice-c2", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);
        var (targetProjectId, _, targetListId) =
            await CreateTargetProjectAsync(await TeamIdOfProjectAsync(projectId), "c2");
        await AddProjectMemberAsync(targetProjectId, alice, roleId);

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy",
            JsonContent.Create(new { targetListId }))).Content.ReadFromJsonAsync<JsonElement>();

        // 判別力：把過濾寫成「副本不帶任何成員」或「比錯名冊」都會讓這一支紅。
        Assert.Equal(new[] { alice.ToString() }, MembersOf(copy));
        Assert.Equal(Sorted(alice), await SourceCardMembersAsync(cardId));
    }

    // 裁定是**無條件**套用，不只在跨專案時：歷史孤兒在副本上本來就無效。
    // 判別力：把過濾侷限成「來源專案 != 目標專案」時，只有這一支會紅
    // （C1／C4／C5 走的都是跨專案，照樣綠）。
    [Fact]
    public async Task CardCopy_SameProject_DropsOrphanMember()
    {
        var (cardId, projectId, roleId) = await SetupAsync("c3");
        var alice = await CreateUserAsync("cpm-alice-c3", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);
        var bob = await CreateUserAsync("cpm-bob-c3", "非成員鮑伯");
        await AddOrphanCardMemberRowAsync(cardId, bob);
        // 前提：孤兒列真的在來源卡上、而且他真的不在名冊裡。少了這兩條，這一支會退化成 C2
        // （正向案例）——而它正是**唯一**釘住「過濾是無條件的」那一支（M3 只讓它變紅）。
        Assert.True(await HasCardMemberRowAsync(cardId, bob));
        Assert.False(await HasProjectMemberRowAsync(projectId, bob));

        var copy = await (await _client.PostAsync($"/api/cards/{cardId}/copy",
            JsonContent.Create(new { }))).Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(new[] { alice.ToString() }, MembersOf(copy));
        Assert.Equal(Sorted(alice, bob), await SourceCardMembersAsync(cardId));   // 來源的孤兒原樣留著
    }

    // 清單路線自己算一次名冊（它不經過 CopyCardAsync）。
    [Fact]
    public async Task ListCopy_CrossProject_DropsMemberNotInTargetProject()
    {
        var (cardId, projectId, roleId) = await SetupAsync("c4");
        var alice = await CreateUserAsync("cpm-alice-c4", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);
        var (targetProjectId, targetBoardId, _) =
            await CreateTargetProjectAsync(await TeamIdOfProjectAsync(projectId), "c4");
        Assert.False(await HasProjectMemberRowAsync(targetProjectId, alice));

        var sourceListId = (await CardLocationAsync(cardId)).ListId;
        var copy = await (await _client.PostAsync($"/api/lists/{sourceListId}/copy",
            JsonContent.Create(new { targetBoardId }))).Content.ReadFromJsonAsync<JsonElement>();

        Assert.Empty(MembersOf(copy.GetProperty("cards").EnumerateArray().Single()));
        Assert.Equal(Sorted(alice), await SourceCardMembersAsync(cardId));
    }

    // 看板路線：真正的跨專案看板複製（前端補上選單後就會走到的形狀）。
    [Fact]
    public async Task BoardCopy_CrossProject_DropsMemberNotInTargetProject()
    {
        var (cardId, projectId, roleId) = await SetupAsync("c5");
        var alice = await CreateUserAsync("cpm-alice-c5", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);
        var (targetProjectId, _, _) = await CreateTargetProjectAsync(await TeamIdOfProjectAsync(projectId), "c5");
        Assert.False(await HasProjectMemberRowAsync(targetProjectId, alice));

        var sourceBoardId = (await CardLocationAsync(cardId)).BoardId;
        var copy = await (await _client.PostAsync($"/api/boards/{sourceBoardId}/copy",
            JsonContent.Create(new { targetProjectId }))).Content.ReadFromJsonAsync<JsonElement>();

        var detail = await (await _client.GetAsync($"/api/boards/{copy.GetProperty("id").GetString()}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var copiedCard = detail.GetProperty("lists").EnumerateArray().Single()
            .GetProperty("cards").EnumerateArray().Single();
        Assert.Empty(MembersOf(copiedCard));
        Assert.Equal(Sorted(alice), await SourceCardMembersAsync(cardId));
    }

    // 專案複製不該被這個過濾器誤傷：它**先複製名冊、之後才複製卡片**，
    // 所以來源卡片上的成員在副本專案裡仍是成員。
    // 判別力：把名冊查詢搬到存檔之前（或在同一次 SaveChanges 裡算），這一支會紅
    // ——那會讓**專案複製把所有卡片成員一次清光**，而三支跨專案的測試全都是綠的。
    [Fact]
    public async Task ProjectCopy_KeepsCardMembers()
    {
        var (cardId, projectId, roleId) = await SetupAsync("c6");
        var alice = await CreateUserAsync("cpm-alice-c6", "成員艾莉絲");
        await AddProjectMemberAsync(projectId, alice, roleId);
        await AssignCardMemberAsync(cardId, alice);

        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{projectId}/copy");
        req.Headers.Add("X-Team-Id", await TeamIdOfProjectAsync(projectId));
        req.Content = JsonContent.Create(new { name = "專案副本" });
        var copy = await (await _client.SendAsync(req)).Content.ReadFromJsonAsync<JsonElement>();
        var copyProjectId = copy.GetProperty("id").GetString()!;
        Assert.True(await HasProjectMemberRowAsync(copyProjectId, alice));

        var boards = await (await _client.GetAsync($"/api/projects/{copyProjectId}/boards"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var detail = await (await _client.GetAsync($"/api/boards/{boards.EnumerateArray().Single().GetProperty("id").GetString()}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var copiedCard = detail.GetProperty("lists").EnumerateArray().Single()
            .GetProperty("cards").EnumerateArray().Single();

        Assert.Equal(new[] { alice.ToString() }, MembersOf(copiedCard));
        Assert.Equal(Sorted(alice), await SourceCardMembersAsync(cardId));
    }
}
