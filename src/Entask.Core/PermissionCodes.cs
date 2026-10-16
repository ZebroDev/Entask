namespace Entask.Core;

public static class PermissionCodes
{
    public const string TeamRead = "team.read";
    public const string TeamMemberManage = "team.member.manage";
    public const string TeamRoleManage = "team.role.manage";
    public const string TeamWorkCalendarManage = "team.workcalendar.manage";
    public const string ProjectRead = "project.read";
    public const string ProjectCreate = "project.create";
    public const string ProjectEdit = "project.edit";
    public const string ProjectDelete = "project.delete";
    public const string ProjectMemberManage = "project.member.manage";
    public const string BoardRead = "board.read";
    public const string BoardCreate = "board.create";
    public const string BoardEdit = "board.edit";
    public const string BoardDelete = "board.delete";
    public const string CardRead = "card.read";
    public const string CardCreate = "card.create";
    public const string CardEdit = "card.edit";
    public const string CardDelete = "card.delete";
    public const string CardAssign = "card.assign";
    public const string CardReview = "card.review";
    /// <summary>審查時填寫「評分」的權限。與 CardReview 分開是刻意的：技術複核人人可做，
    /// 但分數會進績效評等（設計 §13.3），所以只給主管角色。</summary>
    public const string CardRate = "card.rate";
    public const string CardComment = "card.comment";
    public const string CardEffortUpdate = "card.effort.update";
    public const string MindMapEdit = "mindmap.edit";
    public const string ReportView = "report.view";

    public static readonly string[] All =
    [
        TeamRead, TeamMemberManage, TeamRoleManage, TeamWorkCalendarManage,
        ProjectRead, ProjectCreate, ProjectEdit, ProjectDelete, ProjectMemberManage,
        BoardRead, BoardCreate, BoardEdit, BoardDelete,
        CardRead, CardCreate, CardEdit, CardDelete, CardAssign, CardReview, CardRate, CardComment, CardEffortUpdate,
        MindMapEdit,
        ReportView,
    ];
}
