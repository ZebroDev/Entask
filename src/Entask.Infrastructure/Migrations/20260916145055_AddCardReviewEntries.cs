using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddCardReviewEntries : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CardReviewEntries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CardId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReviewerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    Score = table.Column<int>(type: "integer", nullable: true),
                    Comment = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CardReviewEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CardReviewEntries_Cards_CardId",
                        column: x => x.CardId,
                        principalTable: "Cards",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CardReviewEntries_CardId",
                table: "CardReviewEntries",
                column: "CardId");

            // 回填：既有 CardReview 中已經有結論的列，各補一筆 entry。
            // CreatedAt 取 UpdatedAt——那是當時最後一次寫入的時間。單輪情境下與提交時間相同；
            // 多輪情境下它已被覆寫而不可考，這是這批資料的已知限制（設計 §5.4）。
            // pending 的列不回填：它們沒有提交過任何東西。
            migrationBuilder.Sql("""
                INSERT INTO "CardReviewEntries" ("Id", "CardId", "ReviewerUserId", "Status", "Score", "Comment", "CreatedAt")
                SELECT gen_random_uuid(), "CardId", "ReviewerUserId", "Status", "Score", "Comment", "UpdatedAt"
                FROM "CardReviews"
                WHERE "Status" <> 'pending';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CardReviewEntries");
        }
    }
}
