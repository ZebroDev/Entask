using Entask.Api.Authorization;

namespace Entask.Tests;

/// <summary>
/// `RequirePermissionAttribute` 與 `RequireProjectPermissionAttribute` 是**死的**——
/// 全庫沒有任何程式碼在讀它們，Minimal API 也不會自動消費具名方法上的屬性。
/// 把它們寫在具名 handler 方法上是**編譯得過、執行期毫無作用**的守衛：那個端點等於
/// 完全沒有守衛，而四道閘門與所有測試都不會響。
///
/// <para>
/// 唯一的防線是編譯器——兩個類別都掛了 `[Obsolete(..., error: true)]`，
/// 所以真的有人去用它時會是 **CS0619**，不是靜默通過。
/// </para>
///
/// <para>
/// **這支測試守的是那道防線本身。** 少了它，下一個做死碼清理的人（或 agent）會看到
/// 兩個「零引用」的類別，順手刪掉——而刪掉之後**不會有任何測試變紅**，
/// 陷阱卻回來了。判準：`[Obsolete]` 是編譯期性質，只有反射看得見它還在不在。
/// </para>
///
/// <para>
/// 使用者 2026-09-23 裁定：保留類別並讓它大聲（**不**直接刪除），理由是刪除版的錯誤訊息
/// 只給 `CS0246: 找不到類型`，而 `[Obsolete]` 版的訊息直接指向正解
/// （同檔的擴充方法 `.RequirePermission(...)` / `.RequireProjectPermission(...)`）。
/// </para>
///
/// <para>
/// **這一檔只守這兩個名字**（清單就是下面那兩個 `InlineData`）——它**不是**「所有死掉的
/// attribute 都被守著」的保證。**新增一個同型的 inert attribute 時，這裡要跟著長一列**；
/// 而那一類錯誤（端點看起來有守衛、其實是匿名的）的一般性後盾是
/// `EndpointAuthorizationGuardTests.EveryRouteEndpoint_IsGuardedOrDeclared`
/// ——端點圖上沒有守衛 metadata 就會紅。兩者互補：這一支守「這兩個類別沒有被清掉」，
/// 那一支守「沒有任何一個端點是裸的」。
/// </para>
///
/// <para>
/// **它不守 obsolete 的訊息文字**（訊息是保留類別的理由，但文案會改、不該焊進測試——
/// 同 `JwtTokenService` 的日誌守門員斷言結構化欄位而不斷言訊息）。它守的是
/// 「那個編譯期防線還在，而且還是 error」。
/// </para>
/// </summary>
public class DeadAttributeGuardTests
{
    // 用**名字**取得型別，不是 `typeof`。原因是實測出來的：`[Obsolete(error: true)]`
    // 一加上去，本檔初版的兩行 `typeof(...)` **當場編譯失敗**
    // （`CS0619: 'RequirePermissionAttribute' 已經過時`）——那是那道防線有效的最直接證據
    // （連測試自己都引用不了），但也意味著測試只能繞過去引用它。
    // `GetType` 找不到時回 null，下面的斷言會紅，所以「改名」與「刪除」同樣接得住。
    private static Type? ByName(string typeName) =>
        typeof(RequirePermissionExtensions).Assembly.GetType($"Entask.Api.Authorization.{typeName}");

    [Theory]
    [InlineData("RequirePermissionAttribute")]
    [InlineData("RequireProjectPermissionAttribute")]
    public void DeadPermissionAttributes_MustStayLoud(string typeName)
    {
        var attributeType = ByName(typeName);
        Assert.True(attributeType is not null,
            $"找不到 `Entask.Api.Authorization.{typeName}`。這個類別是刻意留著的（見本檔摘要）"
            + "——若它真的被刪掉了，請一併更新 `docs/STATE.md` 的那一條，不要只讓這支測試消失。");

        var obsolete = attributeType!
            .GetCustomAttributes(typeof(ObsoleteAttribute), inherit: false)
            .Cast<ObsoleteAttribute>()
            .SingleOrDefault();

        Assert.True(obsolete is not null,
            $"{typeName} 的 `[Obsolete]` 不見了。這個類別沒有任何程式碼在讀它——"
            + "少了 `[Obsolete]`，把它套在具名 handler 方法上會**編譯得過、執行期毫無作用**，"
            + "而沒有任何測試會發現。要嘛把它加回來，要嘛連類別一起刪掉並確認"
            + "`docs/STATE.md` 的那一條一併更新（見本檔的摘要）。");

        // **必須是 `System.ObsoleteAttribute` 本身，不能是它的衍生類別。**
        // 少了這一條，下面那個 `GetCustomAttributes(typeof(ObsoleteAttribute))` 會連衍生類別
        // 一起回傳 ⇒ 有人把類別改掛 `class QuietAttribute : ObsoleteAttribute` 時這支照樣綠，
        // 而**編譯器不認衍生類別**（它比對的是 `System.ObsoleteAttribute` 這個型別本身）
        // ⇒ 防線沒了、測試卻是綠的。這正是本檔要消滅的那種「看起來守著、其實沒有」。
        Assert.True(obsolete!.GetType() == typeof(ObsoleteAttribute),
            $"{typeName} 掛的是 `{obsolete.GetType().FullName}`，不是 `System.ObsoleteAttribute` "
            + "本身——編譯器不認衍生類別，等於沒有這道防線（而這支測試若只比對型別聯集會照樣綠）。");

        // `error: true` 才是重點：警告會被忽略、也會被 `#pragma` 關掉，錯誤不會。
        // （`!` 留著：這一格的流程分析靠 xUnit 的 `DoesNotReturnIf` 註解，不必倚賴它
        //   ——Release 建置的 0 警告是硬要求，多一個 `!` 沒有代價。）
        Assert.True(obsolete!.IsError,
            $"{typeName} 的 `[Obsolete]` 必須是 `error: true`——非錯誤的版本只是警告，"
            + "而這個陷阱的代價是「一個端點靜默地沒有任何守衛」。");
    }
}
