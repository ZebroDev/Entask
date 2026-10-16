using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class CompositeCardReviewEntryIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_CardReviewEntries_CardId",
                table: "CardReviewEntries");

            migrationBuilder.CreateIndex(
                name: "IX_CardReviewEntries_CardId_CreatedAt",
                table: "CardReviewEntries",
                columns: new[] { "CardId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_CardReviewEntries_CardId_CreatedAt",
                table: "CardReviewEntries");

            migrationBuilder.CreateIndex(
                name: "IX_CardReviewEntries_CardId",
                table: "CardReviewEntries",
                column: "CardId");
        }
    }
}
