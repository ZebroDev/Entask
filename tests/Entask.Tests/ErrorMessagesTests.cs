using Entask.Core;

namespace Entask.Tests;

public class ErrorMessagesTests
{
    // 消息表的完整清單。**新增訊息表家族的 code 時要在這裡加一列**（400 家族的碼刻意不進
    // 這張表——先例 `teamRole.nameDuplicate`、`label.nameDuplicate`）；沒加的話下面那支
    // 「逐 code 都有值」照樣綠，而新 code 會在執行期才炸（`ErrorMessages.For` 對認不得的
    // code 拋 ArgumentException，而它唯一的呼叫端 `ApiResults.NotFound` 就在請求路徑上 ⇒ 500）。
    // 這份名單是**手維護**的：沒有閘門把它對上「404 站點實際用到的碼」。
    // Gate B 也**不是**拿這張表與語系檔比集合——它只**單向**走表上的臂去比對值
    // （語系檔其餘的葉節點是 400／403 站點內嵌字面值的副本，刻意不驗）。
    private static readonly string[] AllCodes =
    [
        ErrorCodes.TeamRoleSystemNotEditable,
        ErrorCodes.CardNotFound,
        ErrorCodes.CardFieldNotFound,
        ErrorCodes.ListNotFound,
        ErrorCodes.BoardNotFound,
        ErrorCodes.ProjectNotFound,
        ErrorCodes.TeamMemberNotFound,
        ErrorCodes.TeamNotFound,
        ErrorCodes.TeamRoleNotFound,
        ErrorCodes.ChecklistNotFound,
        ErrorCodes.ChecklistItemNotFound,
        ErrorCodes.LabelNotFound,
        ErrorCodes.AttachmentNotFound,
        ErrorCodes.CommentNotFound,
        ErrorCodes.MindmapNodeNotFound,
        ErrorCodes.ReviewNotFound,
        ErrorCodes.NotificationNotFound,
        ErrorCodes.UserAvatarNotFound,
        // 2026-10-05：團隊工作日曆的 DELETE 走 `ApiResults.NotFound`（與上面同一族）。
        ErrorCodes.WorkCalendarNotFound,
        // 401 家族（2026-09-20）。三者都由 `ApiResults.Unauthorized` 產生
        // （端點走 IResult 那個入口，篩選器與 `OnChallenge` 走 `WriteUnauthorizedAsync`）。
        ErrorCodes.AuthUnauthenticated,
        ErrorCodes.AuthSessionInvalid,
        ErrorCodes.AuthInvalidCredentials,
        // 500 家族（2026-09-21）。前三個是**收斂進來的**——它們原本是站點內嵌的字面值，
        // 現在與 `server.internalError` 一樣由 `ApiResults.InternalError`／
        // `WriteInternalErrorAsync` 產生，所以值集中在訊息表（與 404／401 同一個理由）。
        // 後者是目前唯一一個不帶參數的入口產生的碼（見 `ApiResults`）。
        ErrorCodes.ServerInternalError,
        ErrorCodes.UserUpdateFailed,
        ErrorCodes.UserDeleteFailed,
        ErrorCodes.AuthAdminGrantFailed,
        // 429 家族（2026-09-24）。唯一的入口是 `ApiResults.WriteTooManyRequestsAsync`
        // （限流器的 OnRejected 是中介層，沒有 IResult 可回），而那一族**刻意只有一個碼**
        // ⇒ 這一列就是整族。它的守門員是 `RateLimitTests` 的 body 斷言（走真的請求）
        // 與閘門 B／C（措辭）。
        ErrorCodes.RequestTooManyRequests,
        // 400 家族的兩條例外（2026-10-08）。它們不屬於上面任何一個「唯一產生點」家族
        // ——產生點是各站點內嵌的字面值（六處共用）——2026-10-08 起也收進訊息表
        // （理由見 `ErrorMessages.cs` 的檔頭）。列在這裡讓「逐 code 都有值」罩到它們。
        ErrorCodes.TimeZoneInvalid,
        ErrorCodes.EffortLocalDateInFuture,
    ];

    [Fact]
    public void AllCodes_HaveNonEmptyMessage()
    {
        foreach (var code in AllCodes)
        {
            var message = ErrorMessages.For(code);
            Assert.False(string.IsNullOrWhiteSpace(message), $"code {code} 的訊息是空的");
        }
    }

    [Fact]
    public void UnknownCode_Throws()
    {
        var ex = Assert.Throws<ArgumentException>(() => ErrorMessages.For("card.noSuchCode"));
        Assert.Contains("card.noSuchCode", ex.Message);
    }
}
