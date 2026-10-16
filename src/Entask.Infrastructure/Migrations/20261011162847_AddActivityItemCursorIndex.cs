using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddActivityItemCursorIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ActivityItems_CardId_CreatedAt",
                table: "ActivityItems");

            migrationBuilder.CreateIndex(
                name: "IX_ActivityItems_CardId_CreatedAt_Id",
                table: "ActivityItems",
                columns: new[] { "CardId", "CreatedAt", "Id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ActivityItems_CardId_CreatedAt_Id",
                table: "ActivityItems");

            migrationBuilder.CreateIndex(
                name: "IX_ActivityItems_CardId_CreatedAt",
                table: "ActivityItems",
                columns: new[] { "CardId", "CreatedAt" });
        }
    }
}
