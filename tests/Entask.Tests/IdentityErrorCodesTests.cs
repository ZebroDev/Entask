using Entask.Core;

namespace Entask.Tests;

public class IdentityErrorCodesTests
{
    [Theory]
    [InlineData("PasswordTooShort", "identity.passwordTooShort")]
    [InlineData("PasswordRequiresDigit", "identity.passwordRequiresDigit")]
    [InlineData("PasswordRequiresLower", "identity.passwordRequiresLower")]
    [InlineData("PasswordRequiresUpper", "identity.passwordRequiresUpper")]
    [InlineData("PasswordRequiresNonAlphanumeric", "identity.passwordRequiresNonAlphanumeric")]
    [InlineData("PasswordRequiresUniqueChars", "identity.passwordRequiresUniqueChars")]
    [InlineData("PasswordMismatch", "identity.passwordMismatch")]
    [InlineData("DuplicateUserName", "identity.duplicateUserName")]
    [InlineData("InvalidUserName", "identity.invalidUserName")]
    public void Map_KnownIdentityCode_ReturnsItsOwnCode(string identityCode, string expected)
    {
        Assert.Equal(expected, IdentityErrorCodes.Map(identityCode));
    }

    [Theory]
    [InlineData("SomeFutureIdentityCode")]
    [InlineData("")]
    public void Map_UnknownIdentityCode_FallsBackToUnknown(string identityCode)
    {
        Assert.Equal(ErrorCodes.IdentityUnknown, IdentityErrorCodes.Map(identityCode));
    }

    /// <summary>
    /// 映射表的每個值都必須是 <see cref="ErrorCodes"/> 的宣告之一——不然前端會拿到
    /// 一個永遠認不得的 code，而閘門一只比前端與後端「有沒有這條」，比不到「這條的值
    /// 是不是真的存在」。
    /// </summary>
    [Fact]
    public void Map_EveryValue_IsADeclaredErrorCode()
    {
        var declared = typeof(ErrorCodes)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Select(f => (string)f.GetValue(null)!)
            .ToHashSet();

        // 9 個已知碼 + 1 個 unknown：逐一走過每一個 Identity code，確認落點都在宣告集內。
        string[] identityCodes =
        [
            "PasswordTooShort", "PasswordRequiresDigit", "PasswordRequiresLower",
            "PasswordRequiresUpper", "PasswordRequiresNonAlphanumeric",
            "PasswordRequiresUniqueChars", "PasswordMismatch", "DuplicateUserName",
            "InvalidUserName", "SomeFutureIdentityCode",
        ];
        foreach (var c in identityCodes)
            Assert.Contains(IdentityErrorCodes.Map(c), declared);
    }
}
