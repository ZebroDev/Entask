using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddNotificationPayload : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<string>(
                name: "Title",
                table: "Notifications",
                type: "text",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "text");

            migrationBuilder.AlterColumn<string>(
                name: "Message",
                table: "Notifications",
                type: "text",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "text");

            migrationBuilder.AddColumn<string>(
                name: "Kind",
                table: "Notifications",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Payload",
                table: "Notifications",
                type: "jsonb",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Kind",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "Payload",
                table: "Notifications");

            migrationBuilder.AlterColumn<string>(
                name: "Title",
                table: "Notifications",
                type: "text",
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "text",
                oldNullable: true);

            migrationBuilder.AlterColumn<string>(
                name: "Message",
                table: "Notifications",
                type: "text",
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "text",
                oldNullable: true);
        }
    }
}
