using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Core;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using MindMapEntity = Entask.Core.Entities.MindMap;

namespace Entask.Tests;

public class MindMapTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public MindMapTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ProjectId, string CardId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "心智圖團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "心智圖專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "心智圖板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var card = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "綁定卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (projectId, card.GetProperty("id").GetString()!);
    }

    private async Task SeedMindMapAsync(Guid projectId, Guid cardId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        var map = new MindMapEntity { ProjectId = projectId };
        db.MindMaps.Add(map);
        await db.SaveChangesAsync();
        var root = new MindMapNode { MindMapId = map.Id, ParentId = null, Title = "根", Position = "h" };
        var child = new MindMapNode { MindMapId = map.Id, ParentId = root.Id, Title = "子", Position = "h", CardId = cardId };
        db.MindMapNodes.AddRange(root, child);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task MindMap_GetEmptyProject_ReturnsEmptyTree()
    {
        var (projectId, _) = await SetupAsync();
        var resp = await _client.GetAsync($"/api/projects/{projectId}/mindmap");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var json = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(json.GetProperty("nodes").EnumerateArray());
        Assert.Equal(Guid.Empty.ToString(), json.GetProperty("id").GetString());
    }

    [Fact]
    public async Task MindMap_GetWithTree_ReturnsFlatListAndCardSummary()
    {
        var (projectId, cardId) = await SetupAsync();
        await SeedMindMapAsync(Guid.Parse(projectId), Guid.Parse(cardId));
        var json = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var nodes = json.GetProperty("nodes").EnumerateArray().ToList();
        Assert.Equal(2, nodes.Count);
        var child = nodes.Single(n => n.GetProperty("title").GetString() == "子");
        Assert.Equal(cardId, child.GetProperty("cardId").GetString());
        Assert.Equal("綁定卡", child.GetProperty("card").GetProperty("title").GetString());
        Assert.False(child.GetProperty("card").GetProperty("isArchived").GetBoolean());
        var root = nodes.Single(n => n.GetProperty("title").GetString() == "根");
        Assert.Equal(root.GetProperty("id").GetString(), child.GetProperty("parentId").GetString());
    }

    // 綁定卡片的完成狀態須隨心智圖回傳，讓畫布/大綱免點開即可辨識（沿卡片 completedAt 慣例）
    [Fact]
    public async Task MindMap_GetWithTree_ReflectsBoundCardCompletion()
    {
        var (projectId, cardId) = await SetupAsync();
        await SeedMindMapAsync(Guid.Parse(projectId), Guid.Parse(cardId));

        var before = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var beforeChild = before.GetProperty("nodes").EnumerateArray()
            .Single(n => n.GetProperty("title").GetString() == "子");
        Assert.Equal(JsonValueKind.Null, beforeChild.GetProperty("card").GetProperty("completedAt").ValueKind);

        // 斷言端點回應，否則端點被拒（4xx/5xx）會被誤讀成 DTO 少了欄位
        var complete = await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = true }));
        Assert.Equal(HttpStatusCode.OK, complete.StatusCode);

        var after = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var afterChild = after.GetProperty("nodes").EnumerateArray()
            .Single(n => n.GetProperty("title").GetString() == "子");
        Assert.Equal(JsonValueKind.String, afterChild.GetProperty("card").GetProperty("completedAt").ValueKind);

        var uncomplete = await _client.PutAsync($"/api/cards/{cardId}/completion", JsonContent.Create(new { isCompleted = false }));
        Assert.Equal(HttpStatusCode.OK, uncomplete.StatusCode);

        var reverted = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var revertedChild = reverted.GetProperty("nodes").EnumerateArray()
            .Single(n => n.GetProperty("title").GetString() == "子");
        Assert.Equal(JsonValueKind.Null, revertedChild.GetProperty("card").GetProperty("completedAt").ValueKind);
    }

    /// <summary>
    /// 心智圖節點酬載的 rollup 接線（設計 §4.4）。`MindMapCardSummary` 在此之前只有四個
    /// 欄位，而心智圖是本階段唯一「spec 從未提及」的視圖——沒有這條測試，把
    /// `MindMapEndpoints` 的 rollup 拿掉不會有任何紅燈（四個前端測試全部吃 mock 資料）。
    /// </summary>
    [Fact]
    public async Task MindMap_GetWithTree_ReflectsBoundCardReviewState()
    {
        var (projectId, cardId) = await SetupAsync();
        await SeedMindMapAsync(Guid.Parse(projectId), Guid.Parse(cardId));

        // 沒有審查者時是 null（設計 §4.2 第一列）
        var before = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var beforeChild = before.GetProperty("nodes").EnumerateArray()
            .Single(n => n.GetProperty("title").GetString() == "子");
        Assert.Equal(JsonValueKind.Null, beforeChild.GetProperty("card").GetProperty("reviewState").ValueKind);

        // seed admin 當審查者，然後提交「退回」
        Guid adminId;
        using (var scope = _factory.Services.CreateScope())
            adminId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Users.First(u => u.UserName == _factory.SeedCredentials().Username).Id;

        await _client.PutAsync($"/api/cards/{cardId}/reviews",
            JsonContent.Create(new { reviewerUserIds = new[] { adminId } }));
        var reviews = await (await _client.GetAsync($"/api/cards/{cardId}/reviews"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var reviewId = reviews.EnumerateArray().First().GetProperty("id").GetString()!;
        var submit = await _client.PutAsync($"/api/cards/{cardId}/reviews/{reviewId}",
            JsonContent.Create(new { status = "rejected", score = (int?)null, comment = "不行" }));
        Assert.Equal(HttpStatusCode.OK, submit.StatusCode);

        var after = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var afterChild = after.GetProperty("nodes").EnumerateArray()
            .Single(n => n.GetProperty("title").GetString() == "子");
        Assert.Equal(ReviewStatuses.Rejected, afterChild.GetProperty("card").GetProperty("reviewState").GetString());
    }

    [Fact]
    public async Task MindMap_GetAnonymous_Returns401()
    {
        var (projectId, _) = await SetupAsync();
        _client.DefaultRequestHeaders.Authorization = null;
        var resp = await _client.GetAsync($"/api/projects/{projectId}/mindmap");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPost_CreatesRootAndLazyMap()
    {
        var (projectId, _) = await SetupAsync();
        var json = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "根節點" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotEqual(Guid.Empty.ToString(), json.GetProperty("id").GetString());   // lazy map 已建立
        var nodes = json.GetProperty("nodes").EnumerateArray().ToList();
        Assert.Single(nodes);
        Assert.Equal("根節點", nodes[0].GetProperty("title").GetString());
        Assert.Equal(JsonValueKind.Null, nodes[0].GetProperty("parentId").ValueKind);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            Assert.Equal(1, await db.MindMaps.CountAsync(m => m.ProjectId == Guid.Parse(projectId)));
        }
    }

    [Fact]
    public async Task MindMapPost_ChildGetsPositionAfterSibling()
    {
        var (projectId, _) = await SetupAsync();
        var first = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "甲" }))).Content.ReadFromJsonAsync<JsonElement>();
        var rootId = first.GetProperty("nodes")[0].GetProperty("id").GetString()!;
        var second = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "乙", parentId = rootId }))).Content.ReadFromJsonAsync<JsonElement>();
        var child = second.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("title").GetString() == "乙");
        Assert.Equal(rootId, child.GetProperty("parentId").GetString());
        Assert.Equal("U", child.GetProperty("position").GetString());   // After(null) = "U"（FractionalPosition 契約）
    }

    [Fact]
    public async Task MindMapPost_EmptyTitle_Returns400()
    {
        var (projectId, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "   " }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPost_ParentInOtherProject_Returns404()
    {
        var (projectId, _) = await SetupAsync();
        // 第二專案（同團隊）建節點
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        string teamId;
        using (var scope = _factory.Services.CreateScope())
            teamId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Projects.First(p => p.Id == Guid.Parse(projectId)).TeamId.ToString();
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "異專案" });
        var otherProjectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var other = await (await _client.PostAsync($"/api/projects/{otherProjectId}/mindmap/nodes",
            JsonContent.Create(new { title = "外節點" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherNodeId = other.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        var resp = await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "內節點", parentId = otherNodeId }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);   // fail-closed
    }

    [Fact]
    public async Task MindMapPost_CardInOtherProject_Returns400()
    {
        var (projectId, _) = await SetupAsync();
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        string teamId;
        using (var scope = _factory.Services.CreateScope())
            teamId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Projects.First(p => p.Id == Guid.Parse(projectId)).TeamId.ToString();
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "異專案二" });
        var otherProjectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{otherProjectId}/boards",
            JsonContent.Create(new { name = "外板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var list = await (await _client.PostAsync($"/api/boards/{board.GetProperty("id").GetString()}/lists",
            JsonContent.Create(new { name = "外列表" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherCard = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "外卡" }))).Content.ReadFromJsonAsync<JsonElement>();

        var resp = await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "內節點", cardId = otherCard.GetProperty("id").GetString() }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPost_Anonymous_Returns401()
    {
        var (projectId, _) = await SetupAsync();
        _client.DefaultRequestHeaders.Authorization = null;
        var resp = await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點" }));
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPut_RenameNoteAndBind_WritesBoundActivity()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "原標題" }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        var updated = await (await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{nodeId}",
            JsonContent.Create(new { title = "新標題", note = "備註", cardId }))).Content.ReadFromJsonAsync<JsonElement>();
        var node = updated.GetProperty("nodes").EnumerateArray().Single();
        Assert.Equal("新標題", node.GetProperty("title").GetString());
        Assert.Equal("備註", node.GetProperty("note").GetString());
        Assert.Equal(cardId, node.GetProperty("cardId").GetString());
        Assert.Equal("綁定卡", node.GetProperty("card").GetProperty("title").GetString());

        var activity = await (await _client.GetAsync($"/api/cards/{cardId}/activity"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(activity.GetProperty("items").EnumerateArray(), a => a.GetProperty("type").GetString() == ActivityTypes.MindMapBound);
    }

    [Fact]
    public async Task MindMapPut_EmptyTitleOnUnknownNode_Returns400Before404()
    {
        var (projectId, _) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{Guid.NewGuid()}",
            JsonContent.Create(new { title = "  " }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);   // 驗證先於存在性
    }

    [Fact]
    public async Task MindMapPut_InvalidCardIdType_Returns400()
    {
        var (projectId, _) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點" }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;
        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{nodeId}",
            JsonContent.Create(new { cardId = "not-a-guid" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPut_NodeInOtherProject_Returns404()
    {
        var (projectId, _) = await SetupAsync();
        var otherProjectId = await CreateOtherProjectAsync();
        var other = await (await _client.PostAsync($"/api/projects/{otherProjectId}/mindmap/nodes",
            JsonContent.Create(new { title = "外節點" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherNodeId = other.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{otherNodeId}",
            JsonContent.Create(new { title = "改名" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal(ErrorCodes.MindmapNodeNotFound, await ErrorBody.CodeOfAsync(resp));
    }

    [Fact]
    public async Task MindMapPut_CardInOtherProject_Returns400()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點" }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;
        // 第二專案的卡片
        var otherProjectId = await CreateOtherProjectAsync();
        var board = await (await _client.PostAsync($"/api/projects/{otherProjectId}/boards",
            JsonContent.Create(new { name = "外板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var list = await (await _client.PostAsync($"/api/boards/{board.GetProperty("id").GetString()}/lists",
            JsonContent.Create(new { name = "外列表" }))).Content.ReadFromJsonAsync<JsonElement>();
        var otherCard = await (await _client.PostAsync($"/api/lists/{list.GetProperty("id").GetString()}/cards",
            JsonContent.Create(new { title = "外卡" }))).Content.ReadFromJsonAsync<JsonElement>();

        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{nodeId}",
            JsonContent.Create(new { cardId = otherCard.GetProperty("id").GetString() }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPut_CardIdNull_UnbindsAndWritesActivity()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點", cardId }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;
        Assert.Equal(cardId, created.GetProperty("nodes")[0].GetProperty("cardId").GetString());

        var updated = await (await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{nodeId}",
            JsonContent.Create(new { cardId = (string?)null }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, updated.GetProperty("nodes")[0].GetProperty("cardId").ValueKind);
        Assert.Equal(JsonValueKind.Null, updated.GetProperty("nodes")[0].GetProperty("card").ValueKind);

        var activity = await (await _client.GetAsync($"/api/cards/{cardId}/activity"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(activity.GetProperty("items").EnumerateArray(), a => a.GetProperty("type").GetString() == ActivityTypes.MindMapUnbound);
    }

    [Fact]
    public async Task MindMapPut_TitleOnly_DoesNotUnbind()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點", cardId }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        var updated = await (await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{nodeId}",
            JsonContent.Create(new { title = "只改名" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(cardId, updated.GetProperty("nodes")[0].GetProperty("cardId").GetString());
    }

    [Fact]
    public async Task MindMapPosition_InvalidOnUnknownNode_Returns400Before404()
    {
        var (projectId, _) = await SetupAsync();
        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{Guid.NewGuid()}/position",
            JsonContent.Create(new { parentId = Guid.NewGuid(), position = "z!!" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);   // 驗證先於存在性（P4 慣例）
    }

    [Fact]
    public async Task MindMapPosition_ReparentToSibling_Works()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var b = await PostNodeAsync(projectId, "B", null);
        var json = await (await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{b}/position",
            JsonContent.Create(new { parentId = Guid.Parse(a), position = "h" }))).Content.ReadFromJsonAsync<JsonElement>();
        var moved = json.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("id").GetString() == b);
        Assert.Equal(a, moved.GetProperty("parentId").GetString());
        Assert.Equal("h", moved.GetProperty("position").GetString());
    }

    [Fact]
    public async Task MindMapPosition_SelfCycle_Returns400()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{a}/position",
            JsonContent.Create(new { parentId = Guid.Parse(a), position = "h" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPosition_IndirectCycle_Returns400()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var b = await PostNodeAsync(projectId, "B", a);
        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{a}/position",
            JsonContent.Create(new { parentId = Guid.Parse(b), position = "h" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapPosition_ParentInOtherTree_Returns404()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var otherProjectId = await CreateOtherProjectAsync();
        var foreign = await PostNodeAsync(otherProjectId, "外", null);
        var resp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{a}/position",
            JsonContent.Create(new { parentId = Guid.Parse(foreign), position = "h" }));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);   // 同樹 404（fail-closed）
    }

    [Fact]
    public async Task MindMapPosition_MoveToRoot_Works()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var b = await PostNodeAsync(projectId, "B", a);
        var json = await (await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{b}/position",
            JsonContent.Create(new { parentId = (string?)null, position = "n" }))).Content.ReadFromJsonAsync<JsonElement>();
        var moved = json.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("id").GetString() == b);
        Assert.Equal(JsonValueKind.Null, moved.GetProperty("parentId").ValueKind);
    }

    [Fact]
    public async Task MindMapPosition_ReorderSiblings_OrderReflectsPosition()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var c1 = await PostNodeAsync(projectId, "C1", a);
        var c2 = await PostNodeAsync(projectId, "C2", a);
        await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/{c1}/position",
            JsonContent.Create(new { parentId = Guid.Parse(a), position = "p" }));
        var json = await (await _client.GetAsync($"/api/projects/{projectId}/mindmap"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var nodes = json.GetProperty("nodes").EnumerateArray()
            .Where(n => n.GetProperty("parentId").ValueKind != JsonValueKind.Null).Select(n => n.GetProperty("id").GetString()).ToList();
        Assert.Equal(new[] { c2, c1 }, nodes);   // "n" < "p"
    }

    [Fact]
    public async Task MindMapDelete_CascadesSubtree()
    {
        var (projectId, _) = await SetupAsync();
        var a = await PostNodeAsync(projectId, "A", null);
        var b = await PostNodeAsync(projectId, "B", a);
        var c = await PostNodeAsync(projectId, "C", b);

        var json = await (await _client.DeleteAsync($"/api/projects/{projectId}/mindmap/nodes/{b}"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var ids = json.GetProperty("nodes").EnumerateArray().Select(n => n.GetProperty("id").GetString()).ToList();
        Assert.Contains(a, ids);
        Assert.DoesNotContain(b, ids);
        Assert.DoesNotContain(c, ids);
    }

    [Fact]
    public async Task MindMapDelete_NodeInOtherProject_Returns404()
    {
        var (projectId, _) = await SetupAsync();
        var otherProjectId = await CreateOtherProjectAsync();
        var foreign = await PostNodeAsync(otherProjectId, "外", null);
        var resp = await _client.DeleteAsync($"/api/projects/{projectId}/mindmap/nodes/{foreign}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapDelete_UnknownNode_Returns404()
    {
        var (projectId, _) = await SetupAsync();
        var resp = await _client.DeleteAsync($"/api/projects/{projectId}/mindmap/nodes/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapDelete_BoundCardSurvives()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "綁定節點", cardId }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        await _client.DeleteAsync($"/api/projects/{projectId}/mindmap/nodes/{nodeId}");
        var cardResp = await _client.GetAsync($"/api/cards/{cardId}");
        Assert.Equal(HttpStatusCode.OK, cardResp.StatusCode);
    }

    [Fact]
    public async Task MindMap_CardDelete_SetNullUnbindsNode()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "綁定節點", cardId }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        var resp = await _client.DeleteAsync($"/api/cards/{cardId}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var node = await db.MindMapNodes.SingleAsync(n => n.Id == Guid.Parse(nodeId));   // 節點存活
            Assert.Null(node.CardId);   // SetNull 自動解綁
        }
    }

    [Fact]
    public async Task CardResponse_ContainsMindMapNodes()
    {
        var (projectId, cardId) = await SetupAsync();
        var created = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "綁定節點", cardId }))).Content.ReadFromJsonAsync<JsonElement>();
        var nodeId = created.GetProperty("nodes")[0].GetProperty("id").GetString()!;

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        var links = card.GetProperty("mindMapNodes").EnumerateArray().ToList();
        Assert.Single(links);
        Assert.Equal(nodeId, links[0].GetProperty("id").GetString());
        Assert.Equal("綁定節點", links[0].GetProperty("title").GetString());
        Assert.Equal(cardId, links[0].GetProperty("cardId").GetString());
    }

    [Fact]
    public async Task CardMindMapNodesEndpoint_ReturnsLinks()
    {
        var (projectId, cardId) = await SetupAsync();
        await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "綁定節點", cardId }));
        var json = await (await _client.GetAsync($"/api/cards/{cardId}/mindmap-nodes"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var links = json.EnumerateArray().ToList();
        Assert.Single(links);
        Assert.Equal("綁定節點", links[0].GetProperty("title").GetString());
        Assert.Equal(projectId, links[0].GetProperty("projectId").GetString());
        Assert.NotEqual(Guid.Empty.ToString(), links[0].GetProperty("mindMapId").GetString());
    }

    [Fact]
    public async Task CardMindMapNodesEndpoint_UnknownCard_Returns404()
    {
        await SetupAsync();   // 確保 admin 授權標頭就緒（其他測試可能清空 shared client 標頭）
        var resp = await _client.GetAsync($"/api/cards/{Guid.NewGuid()}/mindmap-nodes");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task CardMindMapNodesEndpoint_Anonymous_Returns401()
    {
        _client.DefaultRequestHeaders.Authorization = null;
        var resp = await _client.GetAsync($"/api/cards/{Guid.NewGuid()}/mindmap-nodes");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    private async Task<(string ProjectId, string Engineer, string Tester, string Assistant)> SetupRoleUsersAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = $"權限團隊{Guid.NewGuid():N}" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "erin", password = "Password1!", displayName = "艾琳" }));
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "tina", password = "Password1!", displayName = "蒂娜" }));
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = "pam", password = "Password1!", displayName = "潘姆" }));
        var roles = await (await _client.GetAsync($"/api/teams/{teamId}/roles")).Content.ReadFromJsonAsync<JsonElement>();
        var engineer = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "工程師").GetProperty("id").GetString()!;
        var tester = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "測試工程師").GetProperty("id").GetString()!;
        var assistant = roles.EnumerateArray().First(r => r.GetProperty("name").GetString() == "專案助理").GetProperty("id").GetString()!;
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "erin", roleIds = new[] { engineer } }));
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "tina", roleIds = new[] { tester } }));
        await _client.PutAsync($"/api/teams/{teamId}/members", JsonContent.Create(new { username = "pam", roleIds = new[] { assistant } }));
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "權限專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        return (projectId, "erin", "tina", "pam");
    }

    private async Task LoginAsync(string username, string password)
    {
        var login = await _client.PostAsync("/api/auth/login", JsonContent.Create(new { username, password }));
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        _client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    [Fact]
    public async Task MindMapEdit_Engineer_CanPostNode()
    {
        var (projectId, engineer, _, _) = await SetupRoleUsersAsync();
        await LoginAsync(engineer, "Password1!");
        var resp = await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點" }));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapEdit_Tester_Returns403()
    {
        var (projectId, _, tester, _) = await SetupRoleUsersAsync();
        await LoginAsync(tester, "Password1!");
        var resp = await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title = "節點" }));
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task MindMapView_Assistant_CanGet_NonMember403()
    {
        var (projectId, _, _, assistant) = await SetupRoleUsersAsync();
        await LoginAsync(assistant, "Password1!");
        var ok = await _client.GetAsync($"/api/projects/{projectId}/mindmap");
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var stranger = $"stranger_{Guid.NewGuid():N}";
        await _client.PostAsync("/api/auth/users", JsonContent.Create(new { username = stranger, password = "Password1!", displayName = "外人" }));
        await LoginAsync(stranger, "Password1!");
        var forbidden = await _client.GetAsync($"/api/projects/{projectId}/mindmap");
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
    }

    [Fact]
    public async Task UpdateCoordinates_PersistsAndReturns_InGetMindMap()
    {
        var (projectId, _) = await SetupAsync();
        var node1 = await PostNodeAsync(projectId, "節點1", null);
        var node2 = await PostNodeAsync(projectId, "節點2", node1);

        var coordReq = new
        {
            nodes = new[]
            {
                new { id = node1, x = 125.5, y = 340.2 },
                new { id = node2, x = 450.0, y = 680.7 }
            }
        };

        var putResp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/coordinates",
            JsonContent.Create(coordReq));
        Assert.Equal(HttpStatusCode.OK, putResp.StatusCode);

        var getResp = await _client.GetAsync($"/api/projects/{projectId}/mindmap");
        Assert.Equal(HttpStatusCode.OK, getResp.StatusCode);
        var map = await getResp.Content.ReadFromJsonAsync<JsonElement>();
        var nodes = map.GetProperty("nodes").EnumerateArray().ToList();

        var n1 = nodes.Single(n => n.GetProperty("id").GetString() == node1);
        Assert.Equal(125.5, n1.GetProperty("positionX").GetDouble());
        Assert.Equal(340.2, n1.GetProperty("positionY").GetDouble());

        var n2 = nodes.Single(n => n.GetProperty("id").GetString() == node2);
        Assert.Equal(450.0, n2.GetProperty("positionX").GetDouble());
        Assert.Equal(680.7, n2.GetProperty("positionY").GetDouble());
    }

    [Fact]
    public async Task UpdateCoordinates_EmptyOrInvalid_ReturnsBadRequestOrNotFound()
    {
        var (projectId, _) = await SetupAsync();
        var node1 = await PostNodeAsync(projectId, "測試節點", null);

        // 空陣列回 400
        var emptyReq = new { nodes = Array.Empty<object>() };
        var emptyResp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/coordinates",
            JsonContent.Create(emptyReq));
        Assert.Equal(HttpStatusCode.BadRequest, emptyResp.StatusCode);

        // 不存在的 NodeId 回 404
        var notFoundReq = new
        {
            nodes = new[]
            {
                new { id = Guid.NewGuid().ToString(), x = 100.0, y = 100.0 }
            }
        };
        var notFoundResp = await _client.PutAsync($"/api/projects/{projectId}/mindmap/nodes/coordinates",
            JsonContent.Create(notFoundReq));
        Assert.Equal(HttpStatusCode.NotFound, notFoundResp.StatusCode);
    }

    private async Task<string> PostNodeAsync(string projectId, string title, string? parentId)
    {
        var json = await (await _client.PostAsync($"/api/projects/{projectId}/mindmap/nodes",
            JsonContent.Create(new { title, parentId }))).Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("title").GetString() == title)
            .GetProperty("id").GetString()!;
    }

    private async Task<string> CreateOtherProjectAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        string teamId;
        using (var scope = _factory.Services.CreateScope())
            teamId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Projects.First(p => p.Name == "心智圖專案").TeamId.ToString();
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = $"異專案{Guid.NewGuid():N}" });
        return (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
    }
}
