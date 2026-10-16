using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddMindMaps : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MindMaps",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: true),
                    CreatedById = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MindMaps", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MindMaps_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "MindMapNodes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MindMapId = table.Column<Guid>(type: "uuid", nullable: false),
                    ParentId = table.Column<Guid>(type: "uuid", nullable: true),
                    Title = table.Column<string>(type: "text", nullable: false),
                    Note = table.Column<string>(type: "text", nullable: true),
                    Position = table.Column<string>(type: "text", nullable: false),
                    CardId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedById = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MindMapNodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MindMapNodes_Cards_CardId",
                        column: x => x.CardId,
                        principalTable: "Cards",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_MindMapNodes_MindMapNodes_ParentId",
                        column: x => x.ParentId,
                        principalTable: "MindMapNodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MindMapNodes_MindMaps_MindMapId",
                        column: x => x.MindMapId,
                        principalTable: "MindMaps",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MindMapNodes_CardId",
                table: "MindMapNodes",
                column: "CardId");

            migrationBuilder.CreateIndex(
                name: "IX_MindMapNodes_MindMapId",
                table: "MindMapNodes",
                column: "MindMapId");

            migrationBuilder.CreateIndex(
                name: "IX_MindMapNodes_ParentId",
                table: "MindMapNodes",
                column: "ParentId");

            migrationBuilder.CreateIndex(
                name: "IX_MindMaps_ProjectId",
                table: "MindMaps",
                column: "ProjectId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MindMapNodes");

            migrationBuilder.DropTable(
                name: "MindMaps");
        }
    }
}
