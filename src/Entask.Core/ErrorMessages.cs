namespace Entask.Core;

/// <summary>
/// 錯誤碼的 zh-TW 訊息表。**服務四個家族 ＋ 兩條例外**：404、401、429 與 500——它們各有一個唯一產生點
/// （<c>ApiResults.NotFound</c> ／ <c>ApiResults.Unauthorized</c> ／
/// <c>ApiResults.WriteTooManyRequestsAsync</c> ／
/// <c>ApiResults.InternalError</c> 與 <c>ApiResults.WriteInternalErrorAsync</c>），
/// 所以訊息集中在這裡；其餘錯誤路徑的 <c>message</c> 由各站點自己寫（設計 §4.2）。
/// ⇒ **與 <see cref="ErrorCodes"/> 不是一對一**：它收走那四個家族
/// （404 的 <c>*NotFound</c> 家族 ＋ <c>TeamRoleSystemNotEditable</c>——後者由
/// <c>TeamRoleEndpoints</c> 用在自己的 404 上；401 的三個 <c>auth.*</c>；
/// 429 的 <c>request.tooManyRequests</c>；500 的 <c>server.internalError</c>
/// ＋ 三個原本內嵌在站點裡、2026-09-21 收斂進來的碼）。
///
/// **2026-10-08 起多收兩條 400 家族的例外**（<c>request.timeZoneInvalid</c>、
/// <c>effort.localDateInFuture</c>）：它們的產生點仍是各站點內嵌的 <c>message</c> 字面值
/// （工時與成員／專案的到職日，合計六處）、由閘門 C 逐字守著；收進這張表的理由是讓那句
/// 六處共用的話也有一份能被閘門 B 對上 zh-TW 語系檔的副本。
/// **別從這裡抄數字**（會隨錯誤碼增減）：要對帳就把下面 switch 的臂數，對上那四個產生點
/// 的相異碼數聯集＋那兩條例外。
/// **完整性靠人工**：下面那個守門員只**單向**比對值，沒有東西把這張表對上「產生點實際
/// 用到的碼」；漏一個臂的後果是 <c>For</c> 在**建構回應時**拋 <c>ArgumentException</c>
/// （500）——大聲，但是在執行期，而且在請求路徑上。
/// <c>ErrorMessagesTests.AllCodes</c> 是手維護的對帳單，新增**訊息表家族的** code 時要一起補
/// （400 家族的碼刻意不進這張表——先例 <c>teamRole.nameDuplicate</c>、<c>label.nameDuplicate</c>）。
///
/// 為什麼是 switch 而不是字典：**重複的臂是編譯錯誤**，重複的字典鍵是執行期例外
/// （而且只在真的查到那個鍵時才爆）。這張表的失敗模式要「大聲且當場」。
///
/// 這裡的值與 <c>export.*.json</c> 那種「成品字串」不同：它們是**後備**，
/// 語系固定 zh-TW，由 <c>ErrorCodes</c> 的檔頭 JSDoc 定義（設計 §4.2）。
/// 守門員是 <c>web/scripts/check-error-messages.mjs</c>（本階段新增，設計 §5 Gate B）：
/// 逐 code 比對這裡的值與 <c>web/src/i18n/locales/zh-TW/error.json</c> 的值。
/// </summary>
public static class ErrorMessages
{
    public static string For(string code) => code switch
    {
        ErrorCodes.TeamRoleSystemNotEditable => "僅能修改團隊自訂角色",
        ErrorCodes.CardNotFound => "找不到這張卡片，可能已被刪除",
        ErrorCodes.CardFieldNotFound => "找不到這個自訂欄位，可能已被刪除",
        ErrorCodes.ListNotFound => "找不到這個列表，可能已被刪除",
        ErrorCodes.BoardNotFound => "找不到這個看板，可能已被刪除",
        ErrorCodes.ProjectNotFound => "找不到這個專案，可能已被刪除",
        ErrorCodes.TeamMemberNotFound => "找不到這位團隊成員",
        ErrorCodes.TeamNotFound => "找不到這個團隊，可能已被刪除",
        ErrorCodes.TeamRoleNotFound => "找不到這個角色，可能已被刪除",
        ErrorCodes.ChecklistNotFound => "找不到這個檢查清單，可能已被刪除",
        ErrorCodes.ChecklistItemNotFound => "找不到這個項目，可能已被刪除",
        ErrorCodes.LabelNotFound => "找不到這個標籤，可能已被刪除",
        ErrorCodes.AttachmentNotFound => "找不到這個附件，可能已被刪除",
        ErrorCodes.CommentNotFound => "找不到這則留言，可能已被刪除",
        ErrorCodes.MindmapNodeNotFound => "找不到這個節點，可能已被刪除",
        ErrorCodes.ReviewNotFound => "找不到這筆審查，可能已被刪除",
        ErrorCodes.NotificationNotFound => "找不到這則通知",
        ErrorCodes.WorkCalendarNotFound => "找不到這天的日曆設定",
        ErrorCodes.UserAvatarNotFound => "找不到這個大頭貼",
        ErrorCodes.AuthUnauthenticated => "尚未登入，或登入已過期",
        ErrorCodes.AuthSessionInvalid => "登入狀態已失效，請重新登入",
        ErrorCodes.AuthInvalidCredentials => "帳號或密碼錯誤",
        // 500 家族（2026-09-21）。前三條是**收斂進來的**：它們原本是 `UserEndpoints`（兩處）
        // 與 `AuthEndpoints`（一處）站點內嵌的字面值，值逐字搬過來、**wire 上零差異**。
        // 搬進來之後，這一族的值就從「各站點自己寫」改成與 404／401 同一個契約：
        // 改字要先改這裡，閘門 B 會把這裡的值對上 `zh-TW/error.json`。
        ErrorCodes.ServerInternalError => "系統發生錯誤，請稍後再試",
        ErrorCodes.UserUpdateFailed => "更新失敗",
        ErrorCodes.UserDeleteFailed => "刪除失敗",
        ErrorCodes.AuthAdminGrantFailed => "無法設定系統管理員權限",
        // 429 家族（2026-09-24）。這一族的值同樣要與 `web/src/i18n/locales/zh-TW/error.json`
        // 的同碼值**逐字元相同**（閘門 B）：六個語系的譯文可以各自不同，但 zh-TW 這一邊
        // 同時是後備與契約。
        // 措辭刻意**不指責頻率的主體**：429 也會打在正常使用者的競態上（多分頁同時送出、
        // 前端重試），「你太頻繁」在誤傷時更難看。這一句只描述狀態與下一步。
        ErrorCodes.RequestTooManyRequests => "請求過於頻繁，請稍後再試",
        // 400 家族的兩條例外（2026-10-08，Q1／R5）。值與各站點內嵌的字面值**逐字相同**：
        // 閘門 B 比這一張表 ↔ zh-TW 語系檔，閘門 C 比站點內嵌字面值 ↔ zh-TW 語系檔，
        // 兩道閘門綠燈時這兩份 C# 副本必然相等（這兩個值都沒有 `{{…}}` 佔位）。
        ErrorCodes.TimeZoneInvalid => "時區識別碼無效",
        ErrorCodes.EffortLocalDateInFuture => "不可登記未來的工時",
        _ => throw new ArgumentException($"錯誤訊息表沒有這個 code：{code}", nameof(code)),
    };
}
