namespace Entask.Core;

/// <summary>
/// 錯誤碼。與 <see cref="ActivityTypes"/>／<see cref="RatingCodes"/> 同型：
/// 機器可讀的識別碼，不是文案。
///
/// 為什麼需要：錯誤訊息原本是「後端送過來、被前端拿去顯示」的字串——它同時是
/// 機器契約與 UI 文案。這與 P-A（<c>f.Name == "優先級"</c>）、B2-6a（評級 S/A/B/C）、
/// F2（角色顯示名稱當查詢鍵）是同一個根因。本專案對這一類的定案是：
/// **只要一個字串被當成識別碼用過，它就不能是譯文。**
///
/// 契約：`code` 是機器契約；`message`（回應 body 的另一個欄位）是除錯與後備，
/// 內容是遷移當下字面值的原樣、語系固定 zh-TW。**兩者刻意不設閘門鎖它們相等**
/// ——UI 文案日後改寫不該逼後端跟著改。代價是同一個中文有兩份，那是**刻意的重複，
/// 不是漂移**（設計 §4.2）。
///
/// 值會進入 API 回應、日誌與未來的告警規則，**不可重新命名**。
/// 守門員是 `web/scripts/check-label-tables.mjs` 的第八張表（常數集 ↔ 前端 case 集）
/// 與 `web/scripts/check-error-codes.mjs`（不得再出現字面值）。
/// </summary>
public static class ErrorCodes
{
    // board
    public const string BoardNameRequired = "board.nameRequired";
    public const string BoardNotFound = "board.notFound";
    // list
    public const string ListTitleRequired = "list.titleRequired";
    public const string ListNotFound = "list.notFound";
    // card
    public const string CardPositionInvalid = "card.positionInvalid";
    public const string CardTitleRequired = "card.titleRequired";
    public const string CardStartAfterDue = "card.startAfterDue";
    public const string CardEstimateNotPositive = "card.estimateNotPositive";
    public const string CardCoverInvalid = "card.coverInvalid";
    public const string CardFieldValueNotInOptions = "card.fieldValueNotInOptions";
    public const string CardFieldTextTooLong = "card.fieldTextTooLong";
    public const string CardFieldMemberNotFound = "card.fieldMemberNotFound";
    public const string CardMemberNotProjectMember = "card.memberNotProjectMember";
    public const string CardNotFound = "card.notFound";
    public const string CardFieldNotFound = "card.fieldNotFound";
    // checklist
    public const string ChecklistTitleRequired = "checklist.titleRequired";
    public const string ChecklistNotFound = "checklist.notFound";
    public const string ChecklistItemTextRequired = "checklistItem.textRequired";
    public const string ChecklistItemNotFound = "checklistItem.notFound";
    // comment
    public const string CommentBodyRequired = "comment.bodyRequired";
    public const string CommentNotOwner = "comment.notOwner";
    public const string CommentNotFound = "comment.notFound";
    // label
    public const string LabelNameRequired = "label.nameRequired";
    public const string LabelColorInvalid = "label.colorInvalid";
    public const string LabelNameDuplicate = "label.nameDuplicate";
    public const string LabelNotFound = "label.notFound";
    // project
    public const string ProjectNameRequired = "project.nameRequired";
    public const string ProjectMemberInUse = "project.memberInUse";
    public const string ProjectNotFound = "project.notFound";
    // permission
    public const string PermissionDenied = "permission.denied";
    // team
    public const string TeamNameRequired = "team.nameRequired";
    public const string TeamNameInvalid = "team.nameInvalid";
    public const string TeamNameTooLong = "team.nameTooLong";
    public const string TeamNotMember = "team.notMember";
    public const string TeamRoleAssigned = "team.roleAssigned";
    public const string TeamNotFound = "team.notFound";
    public const string TeamMemberNotFound = "team.memberNotFound";
    // teamRole
    public const string TeamRoleNameRequired = "teamRole.nameRequired";
    public const string TeamRoleNameDuplicate = "teamRole.nameDuplicate";
    public const string TeamRoleSystemNotEditable = "teamRole.systemNotEditable";
    public const string TeamRoleSystemNotDeletable = "teamRole.systemNotDeletable";
    public const string TeamRoleNotFound = "teamRole.notFound";
    // mindmap
    public const string MindmapNodeTitleRequired = "mindmap.nodeTitleRequired";
    public const string MindmapMoveIntoSelf = "mindmap.moveIntoSelf";
    public const string MindmapNodeNotFound = "mindmap.nodeNotFound";
    // auth
    public const string AuthUsernameRequired = "auth.usernameRequired";
    public const string AuthAdminGrantFailed = "auth.adminGrantFailed";
    // 401 家族（2026-09-20）。三者的分工見 AuthErrorBodyTests 的檔頭：
    // unauthenticated ＝ 認證挑戰（沒有憑證／憑證壞了）；sessionInvalid ＝ token 有效但主體
    // 不可用；invalidCredentials ＝ 登入失敗（三條路徑共用一個碼是安全性質，不是圖方便）。
    public const string AuthUnauthenticated = "auth.unauthenticated";
    public const string AuthSessionInvalid = "auth.sessionInvalid";
    public const string AuthInvalidCredentials = "auth.invalidCredentials";
    // user
    public const string UserDisplayNameRequired = "user.displayNameRequired";
    public const string UserDisplayNameTooLong = "user.displayNameTooLong";
    public const string UserUpdateFailed = "user.updateFailed";
    public const string UserDeleteFailed = "user.deleteFailed";
    public const string UserAvatarTooLarge = "user.avatarTooLarge";
    public const string UserAvatarUnsupportedFormat = "user.avatarUnsupportedFormat";
    public const string UserAvatarNotFound = "user.avatarNotFound";
    // attachment
    public const string AttachmentTooLarge = "attachment.tooLarge";
    public const string AttachmentUnsupportedType = "attachment.unsupportedType";
    public const string AttachmentNotFound = "attachment.notFound";
    // review
    public const string ReviewRatingInvalid = "review.ratingInvalid";
    public const string ReviewStatusNotSubmittable = "review.statusNotSubmittable";
    public const string ReviewScoreNotAllowedOnReject = "review.scoreNotAllowedOnReject";
    public const string ReviewCommentRequiredOnReject = "review.commentRequiredOnReject";
    public const string ReviewNotReviewer = "review.notReviewer";
    public const string ReviewRateNotPermitted = "review.rateNotPermitted";
    public const string ReviewReviewerNotProjectMember = "review.reviewerNotProjectMember";
    public const string ReviewNotFound = "review.notFound";
    // effort
    public const string EffortHoursNotPositive = "effort.hoursNotPositive";
    // 補登的日期落在作者時區的「今天」之後（Q1／R5，2026-10-08）。
    // 判準是**作者本地日**、不是 UTC 日——這一條是「日界線要用誰的日」的第一個守門員。
    public const string EffortLocalDateInFuture = "effort.localDateInFuture";
    // concurrency
    public const string ConcurrencyConflict = "concurrency.conflict";
    // query
    public const string QueryRangeTooLong = "query.rangeTooLong";
    // 集合上限（2026-10-10）。400 家族 ⇒ 照 `request.invalid` 的慣例由各站點寫內嵌字面值，
    // **不進 `ErrorMessages` 那張表**（見該檔檔頭的裁定）。上限值在 `Entask.Api.RequestLimits`。
    public const string RequestCollectionTooLarge = "request.collectionTooLarge";
    // identity
    public const string IdentityUnknown = "identity.unknown";
    public const string IdentityPasswordTooShort = "identity.passwordTooShort";
    public const string IdentityPasswordRequiresDigit = "identity.passwordRequiresDigit";
    public const string IdentityPasswordRequiresLower = "identity.passwordRequiresLower";
    public const string IdentityPasswordRequiresUpper = "identity.passwordRequiresUpper";
    public const string IdentityPasswordRequiresNonAlphanumeric = "identity.passwordRequiresNonAlphanumeric";
    public const string IdentityPasswordRequiresUniqueChars = "identity.passwordRequiresUniqueChars";
    public const string IdentityPasswordMismatch = "identity.passwordMismatch";
    public const string IdentityDuplicateUserName = "identity.duplicateUserName";
    public const string IdentityInvalidUserName = "identity.invalidUserName";
    // 通用
    public const string RequestInvalid = "request.invalid";
    public const string RequestBodyTooLarge = "request.bodyTooLarge";
    // 時區識別碼缺漏或認不得（2026-10-08，Q1／R5）。**六個寫入站點共用**：工時（`EffortEndpoints`）
    // 與成員／專案的到職日（`TeamEndpoints`／`ProjectEndpoints` 等五處，T3）。
    // 認不得時**不 fallback 到 UTC**——猜一個時區等於讓錯誤的日界線靜默生效（見 `TimeZones`）。
    public const string TimeZoneInvalid = "request.timeZoneInvalid";
    // 429（2026-09-24）。`request.` 這一軸＝「你送來的東西有問題」——逾額也在同一條軸上，
    // 差別只在判準是**頻率**而不是內容（送來的每一份請求都合法，只是太快）。
    // ★ 它與上面兩條有一個不同的性質：**這是第一個「只有一個入口」的單一產生點家族**。
    // `request.invalid`／`request.bodyTooLarge` 是各站點自己寫字面值；這一個由
    // `ApiResults.WriteTooManyRequestsAsync` 獨佔產生——限流器是全域中介層，手上只有
    // `HttpContext`、沒有 `IResult` 可回，所以這一族**刻意不提供 `IResult` 版本**。
    // 守門員是 `web/scripts/check-error-codes.mjs` 的 429 家族（編號見該檔，別寫死在這裡）。
    public const string RequestTooManyRequests = "request.tooManyRequests";
    // server（2026-09-21）。`server.` 與上面的 `request.` 是同一條軸的兩端：
    // request.* 是「你送來的東西有問題」、server.* 是「我這邊壞了」。
    // 今天是這個前綴的第一個、也是唯一一個碼——它由 `ApiResults.WriteInternalErrorAsync`
    // 獨佔產生（那個入口刻意不收 code 參數，見該檔），所以第二個 server.* 碼要出現時
    // 得先改那個簽章，不會無聲多出來。
    public const string ServerInternalError = "server.internalError";
    // workCalendar（2026-10-05）
    public const string WorkCalendarKindInvalid = "workCalendar.kindInvalid";
    public const string WorkCalendarNameTooLong = "workCalendar.nameTooLong";
    public const string WorkCalendarNotFound = "workCalendar.notFound";
    // notification
    public const string NotificationNotFound = "notification.notFound";
}
