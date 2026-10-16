namespace Entask.Core.Entities;

public class CustomFieldDefinition
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ScopeType { get; set; } = "";   // "project" 或 "board"
    public Guid ScopeId { get; set; }             // Projects.Id 或 Boards.Id
    public string Name { get; set; } = "";

    /// <summary>
    /// 系統植入的預設欄位識別碼（見 <see cref="SystemFieldKeys"/>）；使用者自建欄位為 null。
    /// Name 可被使用者自由更改，任何以 Name 查找此類欄位的查詢都會在改名後靜默失效
    /// （ProjectReportQueries 的「優先級」曾是如此）。
    /// </summary>
    public string? SystemKey { get; set; }

    public string Type { get; set; } = CustomFieldTypes.Text;
    public string? Options { get; set; }          // JSON 字串陣列，僅 Select 使用
    public string Position { get; set; } = "m";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
