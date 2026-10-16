using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <summary>
    /// 將七個 Position 欄位固定為 C collation（ASCII 位元組序），
    /// 確保 FractionalPosition 的 ordinal 排序契約（CompareOrdinal）與資料庫 ORDER BY 一致；
    /// 預設資料庫 collation（ICU 類）會反轉大小寫混合的 position 字串（"j" &lt; "U"）。
    /// 僅 DB 層變更，EF model 快照不變。
    /// </summary>
    /// <inheritdoc />
    public partial class PinPositionCollation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER TABLE \"Boards\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
            migrationBuilder.Sql("ALTER TABLE \"Lists\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
            migrationBuilder.Sql("ALTER TABLE \"Cards\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
            migrationBuilder.Sql("ALTER TABLE \"Labels\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
            migrationBuilder.Sql("ALTER TABLE \"Checklists\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
            migrationBuilder.Sql("ALTER TABLE \"ChecklistItems\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
            migrationBuilder.Sql("ALTER TABLE \"CustomFieldDefinitions\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER TABLE \"Boards\" ALTER COLUMN \"Position\" TYPE text");
            migrationBuilder.Sql("ALTER TABLE \"Lists\" ALTER COLUMN \"Position\" TYPE text");
            migrationBuilder.Sql("ALTER TABLE \"Cards\" ALTER COLUMN \"Position\" TYPE text");
            migrationBuilder.Sql("ALTER TABLE \"Labels\" ALTER COLUMN \"Position\" TYPE text");
            migrationBuilder.Sql("ALTER TABLE \"Checklists\" ALTER COLUMN \"Position\" TYPE text");
            migrationBuilder.Sql("ALTER TABLE \"ChecklistItems\" ALTER COLUMN \"Position\" TYPE text");
            migrationBuilder.Sql("ALTER TABLE \"CustomFieldDefinitions\" ALTER COLUMN \"Position\" TYPE text");
        }
    }
}
