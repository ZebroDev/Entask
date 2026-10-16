using System.Reflection;
using Entask.Core;

namespace Entask.Tests;

// `RevokedReasons.All` 在 2026-10-07 之前**沒有任何消費者**（實查：src/、tests/、
// web/scripts/ 對它零命中）⇒ 漏加一個常數不會有任何紅燈。這支測試就是它的守門員。
// 突變：從 `All` 拿掉任一個元素 ⇒ 紅。
public class RevokedReasonsTests
{
    [Fact]
    public void All_ContainsExactlyTheDeclaredConstants()
    {
        var declared = typeof(RevokedReasons)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral && f.FieldType == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!)
            .OrderBy(v => v)
            .ToList();

        // 前提：真的撈到了東西——否則這支測試在「反射寫錯」時也是綠的。
        Assert.Contains(RevokedReasons.ReplayDetected, declared);

        Assert.Equal(declared, RevokedReasons.All.OrderBy(v => v).ToList());
    }
}
