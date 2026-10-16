using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class CustomFieldTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public CustomFieldTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
        _client = factory.CreateClient();
    }

    private async Task<(string ProjectId, string BoardId, string CardId, string ListId)> SetupAsync()
    {
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var team = await (await _client.PostAsync("/api/teams", JsonContent.Create(new { name = "欄位測試團隊" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var teamId = team.GetProperty("id").GetString()!;
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "欄位測試專案" });
        var projectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var board = await (await _client.PostAsync($"/api/projects/{projectId}/boards",
            JsonContent.Create(new { name = "欄位板" }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardId = board.GetProperty("id").GetString()!;
        var list = await (await _client.PostAsync($"/api/boards/{boardId}/lists", JsonContent.Create(new { name = "列表" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var listId = list.GetProperty("id").GetString()!;
        var card = await (await _client.PostAsync($"/api/lists/{listId}/cards",
            JsonContent.Create(new { title = "欄位卡" }))).Content.ReadFromJsonAsync<JsonElement>();
        return (projectId, boardId, card.GetProperty("id").GetString()!, listId);
    }

    [Fact]
    public async Task CustomField_DefineSetValueInvalidValue_Works()
    {
        var (projectId, boardId, cardId, _) = await SetupAsync();

        // 專案 seed 的「優先級」應存在
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var priority = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級");
        var priorityId = priority.GetProperty("id").GetString()!;

        // 設定有效值
        var payload = new Dictionary<string, object> { [priorityId] = "高" };
        var set = await (await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload)))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("高", set.GetProperty("customFields").EnumerateArray()
            .First(v => v.GetProperty("fieldDefinitionId").GetString() == priorityId).GetProperty("value").GetString());

        // 無效值（不在 options）→ 400
        var bad = new Dictionary<string, object> { [priorityId] = "緊急" };
        var badResp = await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(bad));
        Assert.Equal(HttpStatusCode.BadRequest, badResp.StatusCode);
    }

    [Fact]
    public async Task CustomField_BoardScopedAndTypeChangeClearsValues_Works()
    {
        var (projectId, boardId, cardId, _) = await SetupAsync();

        // 看板範疇數字欄位
        var field = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "估時", type = "number" }))).Content.ReadFromJsonAsync<JsonElement>();
        var fieldId = field.GetProperty("id").GetString()!;

        var payload = new Dictionary<string, object> { [fieldId] = 3.5 };
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload));

        // Type 變更為 text → 既有值清除
        var changed = await (await _client.PutAsync($"/api/boards/{boardId}/custom-fields/{fieldId}",
            JsonContent.Create(new { type = "text" }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("text", changed.GetProperty("type").GetString());

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(card.GetProperty("customFields").EnumerateArray()
            .Where(v => v.GetProperty("fieldDefinitionId").GetString() == fieldId).ToArray());
    }

    [Fact]
    public async Task CustomField_CrossScopeValue_Returns400()
    {
        var (projectId, _, cardId, _) = await SetupAsync();

        // 另一專案（同團隊）的欄位定義 → 卡片不可見範疇
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);
        _client.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
        var teamId = "";
        using (var scope = _factory.Services.CreateScope())
            teamId = scope.ServiceProvider.GetRequiredService<EntaskDbContext>()
                .Projects.First(p => p.Id == Guid.Parse(projectId)).TeamId.ToString();
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/projects");
        create.Headers.Authorization = new("Bearer", adminToken);
        create.Headers.Add("X-Team-Id", teamId);
        create.Content = JsonContent.Create(new { name = "異專案" });
        var otherProjectId = (await (await _client.SendAsync(create)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var otherFields = await (await _client.GetAsync($"/api/projects/{otherProjectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var otherPriorityId = otherFields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;

        var payload = new Dictionary<string, object> { [otherPriorityId] = "高" };
        var resp = await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CustomField_SelectWithoutOptions_Returns400()
    {
        var (_, boardId, _, _) = await SetupAsync();
        var resp = await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "壞欄位", type = "select" }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CustomField_OptionsChangeRemovesStaleValues_Works()
    {
        var (projectId, boardId, cardId, _) = await SetupAsync();

        // 專案範疇 select（seed 優先級）：設值後縮減 options → 舊值被刪除
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var priorityId = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;
        var payload = new Dictionary<string, object> { [priorityId] = "高" };
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload));

        var changed = await (await _client.PutAsync($"/api/projects/{projectId}/custom-fields/{priorityId}",
            JsonContent.Create(new { options = new[] { "中", "低" } }))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(new[] { "中", "低" }, changed.GetProperty("options").EnumerateArray().Select(o => o.GetString()).ToArray());

        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(card.GetProperty("customFields").EnumerateArray()
            .Where(v => v.GetProperty("fieldDefinitionId").GetString() == priorityId).ToArray());

        // 看板範疇 select：同上
        var boardField = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "看板選項", type = "select", options = new[] { "甲", "乙" } }))).Content.ReadFromJsonAsync<JsonElement>();
        var boardFieldId = boardField.GetProperty("id").GetString()!;
        var payload2 = new Dictionary<string, object> { [boardFieldId] = "甲" };
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload2));

        await _client.PutAsync($"/api/boards/{boardId}/custom-fields/{boardFieldId}",
            JsonContent.Create(new { options = new[] { "乙" } }));

        var card2 = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(card2.GetProperty("customFields").EnumerateArray()
            .Where(v => v.GetProperty("fieldDefinitionId").GetString() == boardFieldId).ToArray());
    }

    [Fact]
    public async Task CustomField_DeleteDefinitionCascadesValues_Works()
    {
        var (projectId, _, cardId, _) = await SetupAsync();

        // 建立專案範疇 select 欄位並設值
        var field = await (await _client.PostAsync($"/api/projects/{projectId}/custom-fields",
            JsonContent.Create(new { name = "待刪欄位", type = "select", options = new[] { "是", "否" } }))).Content.ReadFromJsonAsync<JsonElement>();
        var fieldId = field.GetProperty("id").GetString()!;
        var payload = new Dictionary<string, object> { [fieldId] = "是" };
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload));

        // 刪除定義 → 值級聯刪除
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/projects/{projectId}/custom-fields/{fieldId}")).StatusCode);
        var card = await (await _client.GetAsync($"/api/cards/{cardId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(card.GetProperty("customFields").EnumerateArray()
            .Where(v => v.GetProperty("fieldDefinitionId").GetString() == fieldId).ToArray());
    }

    [Fact]
    public async Task CustomField_MemberValueNonExistent_Returns400()
    {
        var (projectId, _, cardId, _) = await SetupAsync();
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var requesterId = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "提出需求者").GetProperty("id").GetString()!;

        var payload = new Dictionary<string, object> { [requesterId] = Guid.NewGuid().ToString() };
        var resp = await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CustomField_DeleteProjectAndBoardFields_Works()
    {
        var (projectId, boardId, _, _) = await SetupAsync();

        // 專案範疇刪除後不再出現於 GET
        var pf = await (await _client.PostAsync($"/api/projects/{projectId}/custom-fields",
            JsonContent.Create(new { name = "專案待刪", type = "text" }))).Content.ReadFromJsonAsync<JsonElement>();
        var pfId = pf.GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/projects/{projectId}/custom-fields/{pfId}")).StatusCode);
        var pList = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.DoesNotContain(pList.EnumerateArray(), f => f.GetProperty("id").GetString() == pfId);

        // 看板範疇刪除後不再出現於專案 GET（含看板範疇聚合）
        var bf = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "看板待刪", type = "text" }))).Content.ReadFromJsonAsync<JsonElement>();
        var bfId = bf.GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await _client.DeleteAsync($"/api/boards/{boardId}/custom-fields/{bfId}")).StatusCode);
        var bList = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.DoesNotContain(bList.EnumerateArray(), f => f.GetProperty("id").GetString() == bfId);
    }

    [Fact]
    public async Task CustomField_JsonNullValueRemovesRow_Works()
    {
        var (projectId, _, cardId, _) = await SetupAsync();
        var fields = await (await _client.GetAsync($"/api/projects/{projectId}/custom-fields")).Content.ReadFromJsonAsync<JsonElement>();
        var priorityId = fields.EnumerateArray().First(f => f.GetProperty("name").GetString() == "優先級").GetProperty("id").GetString()!;

        var payload = new Dictionary<string, object> { [priorityId] = "高" };
        await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(payload));

        // JSON null → 刪除該值列
        var clear = new Dictionary<string, object?> { [priorityId] = null };
        var cleared = await (await _client.PutAsync($"/api/cards/{cardId}/custom-fields", JsonContent.Create(clear)))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(cleared.GetProperty("customFields").EnumerateArray()
            .Where(v => v.GetProperty("fieldDefinitionId").GetString() == priorityId).ToArray());
    }

    [Fact]
    public async Task CustomField_InvalidTypedValues_Return400()
    {
        var (projectId, boardId, cardId, _) = await SetupAsync();

        var textField = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "長文", type = "text" }))).Content.ReadFromJsonAsync<JsonElement>();
        var numberField = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "數字", type = "number" }))).Content.ReadFromJsonAsync<JsonElement>();
        var dateField = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "日期", type = "date" }))).Content.ReadFromJsonAsync<JsonElement>();
        var checkboxField = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "勾選", type = "checkbox" }))).Content.ReadFromJsonAsync<JsonElement>();
        string IdOf(JsonElement f) => f.GetProperty("id").GetString()!;

        // text 超長（>1000）→ 400
        var r1 = await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [IdOf(textField)] = new string('a', 1001) }));
        Assert.Equal(HttpStatusCode.BadRequest, r1.StatusCode);

        // number 非數字 → 400
        var r2 = await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [IdOf(numberField)] = "abc" }));
        Assert.Equal(HttpStatusCode.BadRequest, r2.StatusCode);

        // date 無效 → 400
        var r3 = await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [IdOf(dateField)] = "不是日期" }));
        Assert.Equal(HttpStatusCode.BadRequest, r3.StatusCode);

        // checkbox 非布林 → 400
        var r4 = await _client.PutAsync($"/api/cards/{cardId}/custom-fields",
            JsonContent.Create(new Dictionary<string, object> { [IdOf(checkboxField)] = "yes" }));
        Assert.Equal(HttpStatusCode.BadRequest, r4.StatusCode);
    }

    [Fact]
    public async Task CustomField_UpdateSelectWithEmptyOptions_Returns400()
    {
        var (projectId, boardId, _, _) = await SetupAsync();

        var pf = await (await _client.PostAsync($"/api/projects/{projectId}/custom-fields",
            JsonContent.Create(new { name = "選項欄", type = "select", options = new[] { "甲", "乙" } }))).Content.ReadFromJsonAsync<JsonElement>();
        var resp = await _client.PutAsync($"/api/projects/{projectId}/custom-fields/{pf.GetProperty("id").GetString()}",
            JsonContent.Create(new { options = Array.Empty<string>() }));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);

        var bf = await (await _client.PostAsync($"/api/boards/{boardId}/custom-fields",
            JsonContent.Create(new { name = "看板選項欄", type = "select", options = new[] { "甲", "乙" } }))).Content.ReadFromJsonAsync<JsonElement>();
        var bResp = await _client.PutAsync($"/api/boards/{boardId}/custom-fields/{bf.GetProperty("id").GetString()}",
            JsonContent.Create(new { options = new[] { " " } }));
        Assert.Equal(HttpStatusCode.BadRequest, bResp.StatusCode);
    }


    // P4：並發語意——卡片值 PUT 與定義 delete/type-change 的同列 delete 重疊窗口。
    // 修復前：delete 於 PUT 寫入前 commit → FK 違例 500；type-change 的 ExecuteDeleteAsync
    // 先於 PUT 插入執行 → 舊型別值殘留。修復後：PUT 以 FOR UPDATE 鎖定定義列，
    // 非 200（delete 等鎖後 cascade）即 400/409（定義已變更），絕不 500、不殘留值。
    [Fact]
    public async Task CustomField_ConcurrentDefinitionDeleteAndValuePut_No500NoOrphan()
    {
        var (projectId, _, cardId, _) = await SetupAsync();
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);

        for (var round = 0; round < 8; round++)
        {
            var field = await (await _client.PostAsync($"/api/projects/{projectId}/custom-fields",
                JsonContent.Create(new { name = $"並發刪除欄{round}", type = "text" })))
                .Content.ReadFromJsonAsync<JsonElement>();
            var fieldId = Guid.Parse(field.GetProperty("id").GetString()!);

            var clientPut = _factory.CreateClient();
            clientPut.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
            var clientDel = _factory.CreateClient();
            clientDel.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

            var put = Task.Run(() => clientPut.PutAsync($"/api/cards/{cardId}/custom-fields",
                JsonContent.Create(new Dictionary<string, object> { [fieldId.ToString()] = "值" })));
            var del = Task.Run(() => clientDel.DeleteAsync($"/api/projects/{projectId}/custom-fields/{fieldId}"));
            var (respPut, respDel) = (await put, await del);

            Assert.Equal(HttpStatusCode.OK, respDel.StatusCode);
            // 400＝delete 先於 PUT 驗證（欄位已不在可見範疇）、409＝驗證後 lock 時消失——皆為合法終態；
            // 唯一禁止者為 500（FK 違例＝delete 於 PUT 寫入前 commit）與 orphan 殘留
            Assert.True(respPut.StatusCode is HttpStatusCode.OK or HttpStatusCode.BadRequest or HttpStatusCode.Conflict,
                $"round {round}: PUT 狀態異常 {respPut.StatusCode}");

            using var scope = _factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var orphans = await db.CardFieldValues.AsQueryable().Where(v => v.FieldDefinitionId == fieldId).CountAsync();
            Assert.Equal(0, orphans);
        }
    }

    [Fact]
    public async Task CustomField_ConcurrentTypeChangeAndValuePut_No500NoStaleValue()
    {
        var (projectId, _, cardId, _) = await SetupAsync();
        var adminToken = await TestAuth.GetAdminTokenAsync(_factory, _client);

        for (var round = 0; round < 8; round++)
        {
            var field = await (await _client.PostAsync($"/api/projects/{projectId}/custom-fields",
                JsonContent.Create(new { name = $"並發型態欄{round}", type = "text" })))
                .Content.ReadFromJsonAsync<JsonElement>();
            var fieldId = Guid.Parse(field.GetProperty("id").GetString()!);

            var clientPut = _factory.CreateClient();
            clientPut.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);
            var clientChange = _factory.CreateClient();
            clientChange.DefaultRequestHeaders.Authorization = new("Bearer", adminToken);

            var put = Task.Run(() => clientPut.PutAsync($"/api/cards/{cardId}/custom-fields",
                JsonContent.Create(new Dictionary<string, object> { [fieldId.ToString()] = "文字值" })));
            var change = Task.Run(() => clientChange.PutAsync($"/api/projects/{projectId}/custom-fields/{fieldId}",
                JsonContent.Create(new { type = "number" })));
            var (respPut, respChange) = (await put, await change);

            Assert.Equal(HttpStatusCode.OK, respChange.StatusCode);
            Assert.True(respPut.StatusCode is HttpStatusCode.OK or HttpStatusCode.BadRequest or HttpStatusCode.Conflict,
                $"round {round}: PUT 狀態異常 {respPut.StatusCode}");

            using var scope = _factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
            var stale = await db.CardFieldValues.AsQueryable().Where(v => v.FieldDefinitionId == fieldId).CountAsync();
            Assert.Equal(0, stale);
        }
    }
}
