using Microsoft.EntityFrameworkCore;
using Entask.Board.Positioning;
using Entask.Core;
using Entask.Core.Abstractions;
using Entask.Core.Entities;
using Entask.Infrastructure.Data;
using BoardEntity = Entask.Core.Entities.Board;

namespace Entask.Board.Copying;

public class BoardCopyService : IBoardCopyService
{
    private readonly EntaskDbContext _db;
    private readonly IActivityService _activity;
    private readonly IAuditService _audit;

    public BoardCopyService(EntaskDbContext db, IActivityService activity, IAuditService audit)
    {
        _db = db;
        _activity = activity;
        _audit = audit;
    }

    /// <summary>複製後的預設名稱：樣板由 api 層依**操作者語系**解析後帶入，這裡只做代換、
    /// 不認識語系。`{{name}}` 是原標題——做成樣板而非後綴，是為了讓前綴式的語系
    /// （如 es 的 `Copia de {{name}}`）也成立。</summary>
    private static string CopiedName(string sourceName, string format) =>
        format.Replace("{{name}}", sourceName, StringComparison.Ordinal);

    public async Task<Guid> CopyCardAsync(Guid cardId, Guid? targetListId, Guid actorUserId, string copyNameFormat)
    {
        var ownsTx = _db.Database.CurrentTransaction is null;
        await using var tx = ownsTx ? await _db.Database.BeginTransactionAsync() : null;
        try
        {
            var card = await LoadCardAsync(cardId) ?? throw new InvalidOperationException("card not found");
            var sourceList = await _db.Lists.AsNoTracking().FirstAsync(l => l.Id == card.ListId);
            var targetList = targetListId is null
                ? sourceList
                : await _db.Lists.AsNoTracking().FirstAsync(l => l.Id == targetListId.Value);
            var targetProject = await _db.Boards.Where(b => b.Id == targetList.BoardId)
                .Select(b => new { b.ProjectId, TeamId = b.Project.TeamId }).FirstAsync();
            var targetMemberIds = await LoadProjectMemberIdsAsync(targetProject.ProjectId);
            var copyId = await CopyCardCoreAsync(card, sourceList.BoardId, targetList, actorUserId,
                targetProject.ProjectId, targetProject.TeamId, targetMemberIds, copyNameFormat, null, null);
            if (tx is not null) await tx.CommitAsync();
            return copyId;
        }
        catch
        {
            // 不變量：tx.CommitAsync 必須是 try 內最後一個可拋錯陳述式——
            // 此處 tx 物件在 commit 後仍非 null，若 commit 後尚有查詢，RollbackAsync 會拋例外遮蓋原始錯誤
            if (tx is not null) await tx.RollbackAsync();
            throw;
        }
    }

    private async Task<Card?> LoadCardAsync(Guid cardId) =>
        await _db.Cards.AsNoTracking()
            .Include(c => c.Members).Include(c => c.Labels).Include(c => c.Checklists).ThenInclude(cl => cl.Items)
            .Include(c => c.FieldValues)
            .FirstOrDefaultAsync(c => c.Id == cardId);

    /// <summary>目標專案的名冊（UserIds）。呼叫端一次查詢後帶入逐卡呼叫——逐卡重查為 N+1。</summary>
    private async Task<IReadOnlySet<Guid>> LoadProjectMemberIdsAsync(Guid projectId) =>
        (await _db.ProjectMembers.AsNoTracking()
            .Where(m => m.ProjectId == projectId)
            .Select(m => m.UserId).Distinct().ToListAsync()).ToHashSet();

    private async Task<Guid> CopyCardCoreAsync(Card card, Guid sourceBoardId, BoardList targetList, Guid actorUserId,
        Guid targetProjectId, Guid targetTeamId, IReadOnlySet<Guid> targetMemberIds, string copyNameFormat,
        IReadOnlyDictionary<Guid, Guid>? labelIdMap, IReadOnlyDictionary<Guid, Guid>? fieldIdMap,
        string? nextPosition = null, bool save = true)
    {
        var sameBoard = sourceBoardId == targetList.BoardId;

        var last = nextPosition ?? await _db.Cards.Where(c => c.ListId == targetList.Id).OrderBy(c => c.Position).ThenBy(c => c.Id)
            .Select(c => c.Position).LastOrDefaultAsync();
        var copy = new Card
        {
            ListId = targetList.Id,
            Title = CopiedName(card.Title, copyNameFormat),
            Description = card.Description,
            Position = FractionalPosition.After(last),
            DueAt = card.DueAt,
            EstimatedHours = card.EstimatedHours,
            CreatedById = actorUserId,
        };
        _db.Cards.Add(copy);

        // 不變量（2026-09-22 裁定）：**副本的成員 = 來源卡片成員 ∩ 目標專案名冊**。
        // 三條會複製卡片的路由都收**顯式的跨專案目標**，而卡片的指派者必須是**該卡片所屬
        // 專案**的成員（2026-09-19 裁定的 A／B 兩半）——原樣搬會讓來源專案的成員出現在目標
        // 專案的卡片上，正是那一批要消滅的狀態。搬不過去的就留在原地，與跨看板的標籤／
        // 欄位值同型（在那裡也是對不上就丟）。
        // 過濾是**無條件**的（含同專案複製），不是只在跨專案時：不變量的原文是「該卡片所屬
        // 專案的成員」，沒有「同專案時例外」這一半，而歷史孤兒在副本上同樣無效。
        foreach (var m in card.Members)
            if (targetMemberIds.Contains(m.UserId))
                _db.CardMembers.Add(new CardMember { CardId = copy.Id, UserId = m.UserId });
        if (sameBoard)
        {
            foreach (var l in card.Labels)
                _db.CardLabels.Add(new CardLabel { CardId = copy.Id, LabelId = l.LabelId });
            foreach (var v in card.FieldValues)
                _db.CardFieldValues.Add(new CardFieldValue { CardId = copy.Id, FieldDefinitionId = v.FieldDefinitionId, ValueJson = v.ValueJson });
        }
        else if (labelIdMap is not null)
        {
            // 跨看板複製（看板/專案複製流程）：目標標籤已由 CopyBoardAsync 重建，
            // 以來源→新 ID 映射重建卡片關聯（舊實作直接跳過 → 標籤與欄位值全數遺失）
            foreach (var l in card.Labels)
                if (labelIdMap.TryGetValue(l.LabelId, out var newLabelId))
                    _db.CardLabels.Add(new CardLabel { CardId = copy.Id, LabelId = newLabelId });
            foreach (var v in card.FieldValues)
            {
                // 未映射者（同專案之專案範疇定義）沿用原 ID——定義仍有效
                var fid = fieldIdMap is not null && fieldIdMap.TryGetValue(v.FieldDefinitionId, out var mapped)
                    ? mapped
                    : v.FieldDefinitionId;
                _db.CardFieldValues.Add(new CardFieldValue { CardId = copy.Id, FieldDefinitionId = fid, ValueJson = v.ValueJson });
            }
        }
        foreach (var cl in card.Checklists)
        {
            var newCl = new Checklist { CardId = copy.Id, Title = cl.Title, Position = cl.Position };
            _db.Checklists.Add(newCl);
            foreach (var item in cl.Items)
                _db.ChecklistItems.Add(new ChecklistItem { Checklist = newCl, Text = item.Text, IsChecked = item.IsChecked, Position = item.Position });
        }
        if (save) await _db.SaveChangesAsync();
        await _activity.AddAsync(copy.Id, actorUserId, ActivityTypes.Copy, detail: new { sourceCardId = card.Id }, save: save);
        // 目標專案/團隊由呼叫端一次查詢後帶入——逐卡重查為 N+1（copy per-card audit）
        await _audit.AddAsync(actorUserId, targetTeamId, AuditActions.CardCreated,
            "Card", copy.Id, copy.Title, null, targetProjectId, save: save);
        return copy.Id;
    }

    public async Task<Guid> CopyListAsync(Guid listId, Guid? targetBoardId, Guid actorUserId, string copyNameFormat,
        IReadOnlyDictionary<Guid, Guid>? labelIdMap = null, IReadOnlyDictionary<Guid, Guid>? fieldIdMap = null)
    {
        var ownsTx = _db.Database.CurrentTransaction is null;
        await using var tx = ownsTx ? await _db.Database.BeginTransactionAsync() : null;
        try
        {
            var list = await _db.Lists.AsNoTracking().FirstAsync(l => l.Id == listId);
            var targetBoardIdValue = targetBoardId ?? list.BoardId;

            var last = await _db.Lists.Where(l => l.BoardId == targetBoardIdValue).OrderBy(l => l.Position).ThenBy(l => l.Id)
                .Select(l => l.Position).LastOrDefaultAsync();
            var newList = new BoardList { BoardId = targetBoardIdValue, Name = list.Name, Position = FractionalPosition.After(last) };
            _db.Lists.Add(newList);
            await _db.SaveChangesAsync();

            var cards = await _db.Cards.AsNoTracking()
                .Include(c => c.Members).Include(c => c.Labels).Include(c => c.Checklists).ThenInclude(cl => cl.Items)
                .Include(c => c.FieldValues)
                .Where(c => c.ListId == listId).OrderBy(c => c.Position).ThenBy(c => c.Id).ToListAsync();
            // 目標專案/團隊對同列表所有卡相同：查一次後帶入逐卡呼叫（避免逐卡 N+1）
            var targetProject = await _db.Boards.Where(b => b.Id == targetBoardIdValue)
                .Select(b => new { b.ProjectId, TeamId = b.Project.TeamId }).FirstAsync();
            var targetMemberIds = await LoadProjectMemberIdsAsync(targetProject.ProjectId);
            var lastPos = FractionalPosition.After(null);
            foreach (var card in cards)
            {
                await CopyCardCoreAsync(card, list.BoardId, newList, actorUserId,
                    targetProject.ProjectId, targetProject.TeamId, targetMemberIds, copyNameFormat, labelIdMap, fieldIdMap, lastPos, false);
                lastPos = FractionalPosition.After(lastPos);
            }
            await _db.SaveChangesAsync();
            if (tx is not null) await tx.CommitAsync();
            return newList.Id;
        }
        catch
        {
            // 不變量：tx.CommitAsync 必須是 try 內最後一個可拋錯陳述式——
            // 此處 tx 物件在 commit 後仍非 null，若 commit 後尚有查詢，RollbackAsync 會拋例外遮蓋原始錯誤
            if (tx is not null) await tx.RollbackAsync();
            throw;
        }
    }

    public async Task<Guid> CopyBoardAsync(Guid boardId, Guid? targetProjectId, string? name, Guid actorUserId,
        string copyNameFormat, IReadOnlyDictionary<Guid, Guid>? projectFieldIdMap = null)
    {
        var ownsTx = _db.Database.CurrentTransaction is null;
        await using var tx = ownsTx ? await _db.Database.BeginTransactionAsync() : null;
        try
        {
            var board = await _db.Boards.AsNoTracking().FirstAsync(b => b.Id == boardId);
            var targetProjectIdValue = targetProjectId ?? board.ProjectId;

            var last = await _db.Boards.Where(b => b.ProjectId == targetProjectIdValue).OrderBy(b => b.Position).ThenBy(b => b.Id)
                .Select(b => b.Position).LastOrDefaultAsync();
            var newBoard = new BoardEntity
            {
                ProjectId = targetProjectIdValue,
                Name = string.IsNullOrWhiteSpace(name) ? CopiedName(board.Name, copyNameFormat) : name.Trim(),
                Description = board.Description,
                Position = FractionalPosition.After(last),
                CreatedById = actorUserId,
            };
            _db.Boards.Add(newBoard);
            await _db.SaveChangesAsync();
            var teamId = await _db.Projects.Where(p => p.Id == targetProjectIdValue).Select(p => p.TeamId).FirstAsync();
            await _audit.AddAsync(actorUserId, teamId, AuditActions.BoardCreated, "Board", newBoard.Id, newBoard.Name, null, targetProjectIdValue);

            // 標籤重建（看板範疇）＋來源→新 ID 映射（卡片複製時以映射重建關聯）
            var labelIdMap = new Dictionary<Guid, Guid>();
            var labels = await _db.Labels.AsNoTracking().Where(l => l.BoardId == boardId).ToListAsync();
            foreach (var label in labels)
            {
                var newLabel = new Label { BoardId = newBoard.Id, Name = label.Name, Color = label.Color, Position = label.Position };
                _db.Labels.Add(newLabel);
                labelIdMap[label.Id] = newLabel.Id;
            }
            // 看板範疇自訂欄位定義重建＋映射；專案範疇映射（專案複製流程帶入）合併
            var fieldIdMap = new Dictionary<Guid, Guid>();
            var fields = await _db.CustomFieldDefinitions.AsNoTracking()
                .Where(f => f.ScopeType == "board" && f.ScopeId == boardId).ToListAsync();
            foreach (var f in fields)
            {
                var newDef = new CustomFieldDefinition
                {
                    ScopeType = "board", ScopeId = newBoard.Id, Name = f.Name, Type = f.Type,
                    Options = f.Options, Position = f.Position,
                };
                _db.CustomFieldDefinitions.Add(newDef);
                fieldIdMap[f.Id] = newDef.Id;
            }
            if (projectFieldIdMap is not null)
                foreach (var (sourceId, newId) in projectFieldIdMap)
                    fieldIdMap[sourceId] = newId;
            await _db.SaveChangesAsync();

            var listIds = await _db.Lists.Where(l => l.BoardId == boardId).OrderBy(l => l.Position).ThenBy(l => l.Id).Select(l => l.Id).ToListAsync();
            foreach (var listId in listIds)
                await CopyListAsync(listId, newBoard.Id, actorUserId, copyNameFormat, labelIdMap, fieldIdMap);
            if (tx is not null) await tx.CommitAsync();
            return newBoard.Id;
        }
        catch
        {
            // 不變量：tx.CommitAsync 必須是 try 內最後一個可拋錯陳述式——
            // 此處 tx 物件在 commit 後仍非 null，若 commit 後尚有查詢，RollbackAsync 會拋例外遮蓋原始錯誤
            if (tx is not null) await tx.RollbackAsync();
            throw;
        }
    }

    public async Task<Guid> CopyProjectAsync(Guid projectId, Guid targetTeamId, string? name, Guid actorUserId,
        string copyNameFormat, TimeZoneInfo actorTz)
    {
        var ownsTx = _db.Database.CurrentTransaction is null;
        await using var tx = ownsTx ? await _db.Database.BeginTransactionAsync() : null;
        try
        {
            var project = await _db.Projects.AsNoTracking().FirstAsync(p => p.Id == projectId);
            var newProject = new Project
            {
                TeamId = targetTeamId,
                Name = string.IsNullOrWhiteSpace(name) ? CopiedName(project.Name, copyNameFormat) : name.Trim(),
                Description = project.Description,
                CreatedById = actorUserId,
            };
            _db.Projects.Add(newProject);
            await _db.SaveChangesAsync();

            // 專案成員原樣複製
            var members = await _db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == projectId).ToListAsync();
            // 到職日凍結（Q1／R6）：複製出的成員列也是「新列」，同樣以**發起人**的時區凍結本地日
            // ——來源列的 `JoinedLocalDate` 不沿用（那是來源動作當下的日界線）。值**提出迴圈外**
            // （與其餘四個站點同形狀）：逐列各算一次的話，一批正好跨過本地午夜就會有兩個日界線。
            var joinedLocalDate = TimeZones.LocalToday(DateTime.UtcNow, actorTz);
            foreach (var m in members)
                _db.ProjectMembers.Add(new ProjectMember { ProjectId = newProject.Id, UserId = m.UserId, RoleId = m.RoleId, JoinedAt = DateTime.UtcNow, JoinedLocalDate = joinedLocalDate });

            // 專案範疇自訂欄位定義重建＋來源→新 ID 映射（卡片複製時以映射重建值）
            var projectFieldIdMap = new Dictionary<Guid, Guid>();
            var fields = await _db.CustomFieldDefinitions.AsNoTracking()
                .Where(f => f.ScopeType == "project" && f.ScopeId == projectId).ToListAsync();
            foreach (var f in fields)
            {
                var newDef = new CustomFieldDefinition
                {
                    ScopeType = "project", ScopeId = newProject.Id, Name = f.Name, Type = f.Type,
                    Options = f.Options, Position = f.Position,
                };
                _db.CustomFieldDefinitions.Add(newDef);
                projectFieldIdMap[f.Id] = newDef.Id;
            }
            await _db.SaveChangesAsync();

            var boardIds = await _db.Boards.Where(b => b.ProjectId == projectId).OrderBy(b => b.Position).ThenBy(b => b.Id).Select(b => b.Id).ToListAsync();
            foreach (var boardId in boardIds)
                await CopyBoardAsync(boardId, newProject.Id, null, actorUserId, copyNameFormat, projectFieldIdMap);
            if (tx is not null) await tx.CommitAsync();
            return newProject.Id;
        }
        catch
        {
            // 不變量：tx.CommitAsync 必須是 try 內最後一個可拋錯陳述式——
            // 此處 tx 物件在 commit 後仍非 null，若 commit 後尚有查詢，RollbackAsync 會拋例外遮蓋原始錯誤
            if (tx is not null) await tx.RollbackAsync();
            throw;
        }
    }
}
