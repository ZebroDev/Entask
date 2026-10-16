using Entask.Core;

namespace Entask.Tests;

/// <summary>
/// 通知的兩組詞彙常數（設計 §4.1）。**沒有 DB fixture**——它們是編譯期常數。
///
/// 為何是兩組而不是一組：`Type` 是**偏好維度**（`NotificationPreference.Type` 用的就是它，
/// 使用者要的是「審查相關通知」開關，不是「審查請求」與「審查結果」兩個開關）；
/// `Kind` 是**訊息變體維度**（前端 switch 的依據）。合成一組會讓偏好的顆粒度跟著句子走。
///
/// 這一支同時釘住「值不可以改」——它們已經寫進 DB（`Notification.Type`）與
/// `NotificationPreference.Type`，改字面值等於讓既有偏好列全部失效。
/// </summary>
public class NotificationVocabularyTests
{
    [Fact]
    public void NotificationTypes_是偏好維度的四個值()
    {
        Assert.Equal(["comment", "assigned", "review", "system"], NotificationTypes.All);
    }

    [Fact]
    public void NotificationKinds_是五個訊息變體()
    {
        Assert.Equal(
            ["comment_created", "card_assigned", "review_requested", "review_approved", "review_rejected"],
            NotificationKinds.All);
    }

    [Fact]
    public void 兩個維度的常數值不重疊()
    {
        // kind 是句子、type 是偏好。撞值代表有人把兩個維度混用了
        // （前端第十張表與偏好清單會同時認得同一個字串，症狀是偏好開關跟著句子跑）。
        Assert.Empty(NotificationTypes.All.Intersect(NotificationKinds.All));
    }
}
