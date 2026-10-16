using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <summary>
    /// 將 MindMapNodes.Position 固定為 C collation（ASCII 位元組序），
    /// 確保 FractionalPosition 的 ordinal 排序契約（CompareOrdinal）與資料庫 ORDER BY 一致；
    /// 僅 DB 層變更，EF model 快照不變（20260815130000_PinPositionCollation 同型）。
    /// </summary>
    /// <inheritdoc />
    public partial class PinMindMapNodePositionCollation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER TABLE \"MindMapNodes\" ALTER COLUMN \"Position\" TYPE text COLLATE \"C\"");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER TABLE \"MindMapNodes\" ALTER COLUMN \"Position\" TYPE text");
        }
    }
}
