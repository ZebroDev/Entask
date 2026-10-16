namespace Entask.Core;

/// <summary>
/// ASP.NET Identity 的 <c>IdentityError.Code</c> → 本專案的錯誤碼。
///
/// 為什麼需要：Identity 的 <c>Description</c> 是**英文**（`Passwords must be at least
/// 8 characters.`），而它今天被原樣送到前端陣列、由 <c>UserSettingsDialog</c> 取第一筆
/// 顯示——所以繁中使用者改密碼失敗時看到的是英文（設計 §2.4 的現行缺陷一）。
/// 這個映射同時解掉那個缺陷與「後端送顯示文字」的根因。
///
/// 可產生的 code 是封閉的：`Program.cs` 只調整 `RequiredLength`，其餘用 Identity 預設。
/// 認不得的一律落 <see cref="ErrorCodes.IdentityUnknown"/>——**不猜**。
/// </summary>
public static class IdentityErrorCodes
{
    public static string Map(string identityCode) => identityCode switch
    {
        "PasswordTooShort" => ErrorCodes.IdentityPasswordTooShort,
        "PasswordRequiresDigit" => ErrorCodes.IdentityPasswordRequiresDigit,
        "PasswordRequiresLower" => ErrorCodes.IdentityPasswordRequiresLower,
        "PasswordRequiresUpper" => ErrorCodes.IdentityPasswordRequiresUpper,
        "PasswordRequiresNonAlphanumeric" => ErrorCodes.IdentityPasswordRequiresNonAlphanumeric,
        "PasswordRequiresUniqueChars" => ErrorCodes.IdentityPasswordRequiresUniqueChars,
        "PasswordMismatch" => ErrorCodes.IdentityPasswordMismatch,
        "DuplicateUserName" => ErrorCodes.IdentityDuplicateUserName,
        "InvalidUserName" => ErrorCodes.IdentityInvalidUserName,
        _ => ErrorCodes.IdentityUnknown,
    };
}
