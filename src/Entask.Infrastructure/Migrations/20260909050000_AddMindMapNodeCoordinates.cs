using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddMindMapNodeCoordinates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "PositionX",
                table: "MindMapNodes",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "PositionY",
                table: "MindMapNodes",
                type: "double precision",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PositionX",
                table: "MindMapNodes");

            migrationBuilder.DropColumn(
                name: "PositionY",
                table: "MindMapNodes");
        }
    }
}
