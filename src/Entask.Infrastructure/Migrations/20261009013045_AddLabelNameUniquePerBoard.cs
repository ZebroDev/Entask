using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddLabelNameUniquePerBoard : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Labels_BoardId",
                table: "Labels");

            migrationBuilder.CreateIndex(
                name: "IX_Labels_BoardId_Name",
                table: "Labels",
                columns: new[] { "BoardId", "Name" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Labels_BoardId_Name",
                table: "Labels");

            migrationBuilder.CreateIndex(
                name: "IX_Labels_BoardId",
                table: "Labels",
                column: "BoardId");
        }
    }
}
