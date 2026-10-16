namespace Entask.Core;

public static class ActivityTypes
{
    public const string Comment = "comment";
    public const string Create = "create";
    public const string Move = "move";
    public const string Rename = "rename";
    public const string DescriptionChange = "description_change";
    public const string DueChange = "due_change";
    public const string StartChange = "start_change";
    public const string MemberAdded = "member_added";
    public const string MemberRemoved = "member_removed";
    public const string LabelAdded = "label_added";
    public const string LabelRemoved = "label_removed";
    public const string ChecklistAdded = "checklist_added";
    public const string ChecklistRemoved = "checklist_removed";
    public const string ItemChecked = "item_checked";
    public const string AttachmentAdded = "attachment_added";
    public const string AttachmentRemoved = "attachment_removed";
    public const string ReviewAdded = "review_added";
    public const string ReviewSubmitted = "review_submitted";
    public const string EffortLogged = "effort_logged";
    public const string CustomFieldUpdated = "custom_field_updated";
    public const string CoverChange = "cover_change";
    public const string Copy = "copy";
    public const string Archive = "archive";
    public const string Restore = "restore";
    public const string MindMapBound = "mindmap_bound";
    public const string MindMapUnbound = "mindmap_unbound";
    public const string Complete = "complete";
    public const string Uncomplete = "uncomplete";
    /// <summary>工程師在有審查者的卡片上按下完成——語意是「交付待審查」而不是「完成」。</summary>
    public const string DeliverySubmitted = "delivery_submitted";
}
