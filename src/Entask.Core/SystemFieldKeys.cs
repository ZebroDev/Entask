namespace Entask.Core;

/// <summary>
/// 建立專案時由系統植入的預設自訂欄位識別碼（CustomFieldDefinition.SystemKey）。
///
/// 為何需要：ProjectReportQueries 一度以 Name == "優先級" 查找該欄位。Name 可由使用者
/// 透過 CustomFieldDialog 自由更改（CustomFieldEndpoints PUT），改名後報表的優先級欄位
/// 會靜默變空、無任何錯誤訊息。識別碼不受改名影響。
///
/// 對應的 Name 僅為建立當下的預設顯示名稱；既有資料列的欄位名不會被改寫。
/// </summary>
public static class SystemFieldKeys
{
    public const string Priority = "priority";
    public const string Requester = "requester";
}
