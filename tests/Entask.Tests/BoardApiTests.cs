using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class BoardApiTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public BoardApiTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string TeamId, string ProjectId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "板測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "板測試專案" });
        var project = await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>();
        return (teamId, project.GetProperty("id").GetString()!);
    }

    [Fact]
    public async Task BoardCrud_ListCreateDetailDelete_Works()
    {
        var (_, projectId) = await SetupAsync();

        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "開發板", description = "第一板" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        Assert.Equal("開發板", board.GetProperty("name").GetString());

        var boards = await (await _client.GetAsync($"/api/projects/{projectId}/boards"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(boards.EnumerateArray());

        // 列表建立（依序置底）＋順序斷言（Position 的 C collation 保序：U < j < r）
        var l1 = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "待辦" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var l2 = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "進行中" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var l3 = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "已完成" })))
            .Content.ReadFromJsonAsync<JsonElement>();

        // 看板詳情含 lists（無卡片），且依建立順序回傳
        var detail = await (await _client.GetAsync($"/api/boards/{boardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(3, detail.GetProperty("lists").GetArrayLength());
        Assert.Equal(new[] { "待辦", "進行中", "已完成" },
            detail.GetProperty("lists").EnumerateArray().Select(l => l.GetProperty("name").GetString()));

        // 列表改名
        var renamed = await (await _client.PutAsync($"/api/lists/{l1.GetProperty("id").GetString()}",
            JsonContent.Create(new { name = "已改名" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("已改名", renamed.GetProperty("name").GetString());

        // 刪除列表與看板
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/lists/{l2.GetProperty("id").GetString()}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/boards/{boardId}")).StatusCode);
        Assert.Empty((await (await _client.GetAsync($"/api/projects/{projectId}/boards")).Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray());
    }

    [Fact]
    public async Task LabelCrud_ValidationAndCardUnlink_Works()
    {
        var (_, projectId) = await SetupAsync();
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "標籤板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;

        // 非法顏色 → 400
        var bad = await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "bug", color = "red" }));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        var label = await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "bug", color = "#ff0000" }))).Content.ReadFromJsonAsync<JsonElement>();
        var labelId = label.GetProperty("id").GetString()!;

        // 改名
        var updated = await (await _client.PutAsync($"/api/boards/{boardId}/labels/{labelId}",
            JsonContent.Create(new { name = "缺陷" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("缺陷", updated.GetProperty("name").GetString());

        // 歸屬驗證：以另一看板的 boardId 操作此 label → 404
        var otherBoard = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "另一板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherBoardId = otherBoard.GetProperty("id").GetString()!;
        var cross = await _client.PutAsync($"/api/boards/{otherBoardId}/labels/{labelId}",
            JsonContent.Create(new { name = "hack" }));
        Assert.Equal(HttpStatusCode.NotFound, cross.StatusCode);

        // 建立卡片並關聯此標籤（直接寫 DB；卡片 API 為 Task 5）
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var user = db.Users.First(u => u.UserName == "admin-test");
            var list = new Core.Entities.BoardList { Id = Guid.NewGuid(), BoardId = Guid.Parse(boardId), Name = "清單", Position = "m" };
            db.Lists.Add(list);
            var card = new Core.Entities.Card { Id = Guid.NewGuid(), ListId = list.Id, Title = "標籤卡", Position = "m", CreatedById = user.Id };
            db.Cards.Add(card);
            db.CardLabels.Add(new Core.Entities.CardLabel { CardId = card.Id, LabelId = Guid.Parse(labelId) });
            await db.SaveChangesAsync();
        }

        // 刪除標籤：先解除 CardLabels 關聯再刪標籤，卡片本身保留
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/boards/{boardId}/labels/{labelId}")).StatusCode);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            Assert.False(db.CardLabels.Any(cl => cl.LabelId == Guid.Parse(labelId)));
            Assert.True(db.Cards.Any(c => c.Title == "標籤卡"));
            Assert.False(db.Labels.Any(l => l.Id == Guid.Parse(labelId)));
        }
    }

    [Fact]
    public async Task BoardDetail_ComputedCardFields_ArePopulated()
    {
        var (_, projectId) = await SetupAsync();
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "計算板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = Guid.Parse(list.GetProperty("id").GetString()!);

        // 以 DbContext 直接建立卡片＋檢查清單＋工時（卡片 API 為 Task 5）
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var user = db.Users.First(u => u.UserName == "admin-test");
            var card = new Core.Entities.Card
            {
                Id = Guid.NewGuid(), ListId = listId, Title = "計算卡", Position = "m",
                EstimatedHours = 10m, CreatedById = user.Id,
            };
            db.Cards.Add(card);
            db.Cards.Add(new Core.Entities.Card { Id = Guid.NewGuid(), ListId = listId, Title = "封存卡", Position = "n", IsArchived = true, CreatedById = user.Id });
            var checklist = new Core.Entities.Checklist { Id = Guid.NewGuid(), CardId = card.Id, Title = "驗收", Position = "m" };
            db.Checklists.Add(checklist);
            db.ChecklistItems.Add(new Core.Entities.ChecklistItem { Id = Guid.NewGuid(), ChecklistId = checklist.Id, Text = "A", IsChecked = true, Position = "m" });
            db.ChecklistItems.Add(new Core.Entities.ChecklistItem { Id = Guid.NewGuid(), ChecklistId = checklist.Id, Text = "B", IsChecked = false, Position = "n" });
            var loggedAt = DateTime.UtcNow;
            db.EffortLogs.Add(new Core.Entities.EffortLog
            {
                Id = Guid.NewGuid(), CardId = card.Id, UserId = user.Id, Hours = 4m,
                LoggedAt = loggedAt, LocalDate = DateOnly.FromDateTime(loggedAt),
                LoggedAtLocal = DateTime.SpecifyKind(loggedAt, DateTimeKind.Unspecified),
            });
            await db.SaveChangesAsync();
        }

        var detail = await (await _client.GetAsync($"/api/boards/{boardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var listNode = detail.GetProperty("lists").EnumerateArray().First();
        var cards = listNode.GetProperty("cards").EnumerateArray().ToList();
        Assert.Equal(2, cards.Count);   // 含封存卡片（前端過濾）

        var calcCard = cards.First(c => c.GetProperty("title").GetString() == "計算卡");
        Assert.Equal(1, calcCard.GetProperty("checklistDone").GetInt32());
        Assert.Equal(2, calcCard.GetProperty("checklistTotal").GetInt32());
        Assert.Equal(4m, calcCard.GetProperty("loggedHours").GetDecimal());
        Assert.Equal(6m, calcCard.GetProperty("remainingHours").GetDecimal());
    }

    [Fact]
    public async Task BoardAndList_ArchiveFlag_RoundTrips()
    {
        var (_, projectId) = await SetupAsync();
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "封存板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;

        // 看板封存 round-trip（PUT 回應即反映）
        var archivedBoard = await (await _client.PutAsync($"/api/boards/{boardId}",
            JsonContent.Create(new { isArchived = true }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(archivedBoard.GetProperty("isArchived").GetBoolean());

        // 列表封存 round-trip
        var archivedList = await (await _client.PutAsync($"/api/lists/{listId}",
            JsonContent.Create(new { isArchived = true }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(archivedList.GetProperty("isArchived").GetBoolean());

        // 看板詳情亦反映兩者的封存旗標
        var detail = await (await _client.GetAsync($"/api/boards/{boardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(detail.GetProperty("isArchived").GetBoolean());
        var listNode = detail.GetProperty("lists").EnumerateArray()
            .First(l => l.GetProperty("id").GetString() == listId);
        Assert.True(listNode.GetProperty("isArchived").GetBoolean());
    }

    [Fact]
    public async Task BoardAndList_NonexistentIds_Return404()
    {
        var (_, projectId) = await SetupAsync();
        var ghost = Guid.NewGuid();

        var boardDetail = await _client.GetAsync($"/api/boards/{ghost}");
        Assert.Equal(HttpStatusCode.NotFound, boardDetail.StatusCode);
        Assert.Equal(ErrorCodes.BoardNotFound, await ErrorBody.CodeOfAsync(boardDetail));
        Assert.Equal(HttpStatusCode.NotFound, (await _client.PutAsync($"/api/boards/{ghost}",
            JsonContent.Create(new { name = "x" }))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.DeleteAsync($"/api/boards/{ghost}")).StatusCode);
        var listUpdate = await _client.PutAsync($"/api/lists/{ghost}", JsonContent.Create(new { name = "x" }));
        Assert.Equal(HttpStatusCode.NotFound, listUpdate.StatusCode);
        Assert.Equal(ErrorCodes.ListNotFound, await ErrorBody.CodeOfAsync(listUpdate));
        var listDelete = await _client.DeleteAsync($"/api/lists/{ghost}");
        Assert.Equal(HttpStatusCode.NotFound, listDelete.StatusCode);
        Assert.Equal(ErrorCodes.ListNotFound, await ErrorBody.CodeOfAsync(listDelete));
    }

    // 建立路由（專案/看板不存在）與標籤操作（看板不存在）→ 404
    [Fact]
    public async Task CreateAndLabelRoutes_NonexistentParents_Return404()
    {
        var (_, projectId) = await SetupAsync();
        var ghost = Guid.NewGuid();

        var createBoard = await _client.PostAsync($"/api/projects/{ghost}/boards",
            JsonContent.Create(new { name = "x" }));
        Assert.Equal(HttpStatusCode.NotFound, createBoard.StatusCode);
        Assert.Equal(ErrorCodes.ProjectNotFound, await ErrorBody.CodeOfAsync(createBoard));
        Assert.Equal(HttpStatusCode.NotFound, (await _client.PostAsync($"/api/boards/{ghost}/lists",
            JsonContent.Create(new { name = "x" }))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.PostAsync($"/api/boards/{ghost}/labels",
            JsonContent.Create(new { name = "x", color = "#ff0000" }))).StatusCode);
        var labelUpdate = await _client.PutAsync($"/api/boards/{ghost}/labels/{ghost}",
            JsonContent.Create(new { name = "x" }));
        Assert.Equal(HttpStatusCode.NotFound, labelUpdate.StatusCode);
        Assert.Equal(ErrorCodes.LabelNotFound, await ErrorBody.CodeOfAsync(labelUpdate));
        var labelDelete = await _client.DeleteAsync($"/api/boards/{ghost}/labels/{ghost}");
        Assert.Equal(HttpStatusCode.NotFound, labelDelete.StatusCode);
        Assert.Equal(ErrorCodes.LabelNotFound, await ErrorBody.CodeOfAsync(labelDelete));
    }

    // 非 admin 成員（工程師：card.* 無 board.*）不得動看板/列表——驗證 RequireProjectPermission 的非 bypass 路徑
    [Fact]
    public async Task NonAdmin_EngineerWithoutBoardEdit_IsForbidden()
    {
        var (teamId, projectId) = await SetupAsync();
        await _client.PostAsync("/api/auth/users",
            JsonContent.Create(new { username = "boardeng", password = "Password1!", displayName = "看板工程師" }));

        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineerId = roles.EnumerateArray()
            .First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members",
            JsonContent.Create(new { username = "boardeng", roleIds = new[] { engineerId } }));

        // 指派為專案成員（工程師）
        Guid engUserId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            engUserId = db.Users.First(u => u.UserName == "boardeng").Id;
        }
        await _client.PostAsync($"/api/projects/{projectId}/members",
            JsonContent.Create(new { userId = engUserId, roleIds = new[] { Guid.Parse(engineerId) } }));

        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "權限板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists",
            JsonContent.Create(new { name = "權限清單" }))).Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;

        var login = await _client.PostAsync("/api/auth/login",
            JsonContent.Create(new { username = "boardeng", password = "Password1!" }));
        var engToken = (await login.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("accessToken").GetString()!;

        var putBoard = new HttpRequestMessage(HttpMethod.Put, $"/api/boards/{boardId}");
        putBoard.Headers.Authorization = new("Bearer", engToken);
        putBoard.Content = JsonContent.Create(new { name = "hack" });
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(putBoard)).StatusCode);

        var putList = new HttpRequestMessage(HttpMethod.Put, $"/api/lists/{listId}");
        putList.Headers.Authorization = new("Bearer", engToken);
        putList.Content = JsonContent.Create(new { name = "hack" });
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(putList)).StatusCode);
    }

    // 2026-10-09：看板內標籤名唯一。API 端只翻譯 DB 的 23505 ⇒ 這支同時罩住
    // 正常路徑與競態路徑（沒有 pre-check 這條岔路）。
    [Fact]
    public async Task LabelDuplicateName_IsRejectedWithCode_AndScopeIsPerBoard()
    {
        var (_, projectId) = await SetupAsync();
        var boardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "重名板" }))).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var otherBoardId = (await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "另一重名板" }))).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var first = await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "bug", color = "#ff0000" }));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        // GET 是 seed 的去重來源（原病灶是 seed 讀錯端點）——形狀要被看住
        var listed = await (await _client.GetAsync($"/api/boards/{boardId}/labels")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(listed.EnumerateArray(), l => l.GetProperty("name").GetString() == "bug");

        // 同名 → 400 + label.nameDuplicate；前後空白 trim 後同名也一樣
        var dup = await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "bug", color = "#00ff00" }));
        Assert.Equal(HttpStatusCode.BadRequest, dup.StatusCode);
        Assert.Equal(ErrorCodes.LabelNameDuplicate, await ErrorBody.CodeOfAsync(dup));

        var trimmed = await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "  bug  ", color = "#00ff00" }));
        Assert.Equal(HttpStatusCode.BadRequest, trimmed.StatusCode);
        Assert.Equal(ErrorCodes.LabelNameDuplicate, await ErrorBody.CodeOfAsync(trimmed));

        // 約束是 per-board：另一看板可同名
        var onOther = await _client.PostAsync($"/api/boards/{otherBoardId}/labels",
            JsonContent.Create(new { name = "bug", color = "#ff0000" }));
        Assert.Equal(HttpStatusCode.OK, onOther.StatusCode);

        // PUT 是第二個入口：改名撞別條 → 400；改回自己同名 → 200（不誤報）
        var secondId = (await (await _client.PostAsync($"/api/boards/{boardId}/labels",
            JsonContent.Create(new { name = "feature", color = "#0000ff" }))).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var rename = await _client.PutAsync($"/api/boards/{boardId}/labels/{secondId}",
            JsonContent.Create(new { name = "bug" }));
        Assert.Equal(HttpStatusCode.BadRequest, rename.StatusCode);
        Assert.Equal(ErrorCodes.LabelNameDuplicate, await ErrorBody.CodeOfAsync(rename));
        var self = await _client.PutAsync($"/api/boards/{boardId}/labels/{secondId}",
            JsonContent.Create(new { name = "feature" }));
        Assert.Equal(HttpStatusCode.OK, self.StatusCode);
    }

    // 端點測試分不出「只有 API 擋」與「DB 真的有約束」——這支直接對 DB 撞它。
    // 測試庫走 EnsureDeleted + Migrate ⇒ 它也證明 migration 真的把唯一索引建出來了。
    [Fact]
    public async Task LabelNameUnique_IsEnforcedByDatabaseConstraint()
    {
        var (_, projectId) = await SetupAsync();
        var boardId = Guid.Parse((await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "約束板" }))).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        db.Labels.Add(new Core.Entities.Label { Id = Guid.NewGuid(), BoardId = boardId, Name = "dup", Color = "#ff0000", Position = "m" });
        db.Labels.Add(new Core.Entities.Label { Id = Guid.NewGuid(), BoardId = boardId, Name = "dup", Color = "#00ff00", Position = "n" });

        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        var pg = Assert.IsType<Npgsql.PostgresException>(ex.InnerException);
        Assert.Equal("23505", pg.SqlState);
    }
}
