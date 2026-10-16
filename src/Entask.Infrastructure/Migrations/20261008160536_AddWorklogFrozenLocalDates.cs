using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddWorklogFrozenLocalDates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 四個新欄位一律 NOT NULL ⇒ 先帶**暫時預設**加欄位（既有列才填得進去）→ 回填 → 移除預設。
            migrationBuilder.AddColumn<DateOnly>(
                name: "LocalDate",
                table: "EffortLogs",
                type: "date",
                nullable: false,
                defaultValue: new DateOnly(1, 1, 1));

            // 型別是 `timestamp without time zone`：這一欄存的是**本地牆鐘**（`Kind=Unspecified`），
            // 寫進 `timestamp with time zone` 會被 Npgsql 拒收（見 `EntaskDbContext` 的對映設定）。
            migrationBuilder.AddColumn<DateTime>(
                name: "LoggedAtLocal",
                table: "EffortLogs",
                type: "timestamp without time zone",
                nullable: false,
                defaultValue: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            migrationBuilder.AddColumn<DateOnly>(
                name: "JoinedLocalDate",
                table: "TeamMembers",
                type: "date",
                nullable: false,
                defaultValue: new DateOnly(1, 1, 1));

            migrationBuilder.AddColumn<DateOnly>(
                name: "JoinedLocalDate",
                table: "ProjectMembers",
                type: "date",
                nullable: false,
                defaultValue: new DateOnly(1, 1, 1));

            // 一次性轉換（R7）：既有列沒有時區資訊 ⇒ 一律以 UTC 日／UTC 牆鐘回填。
            // 逐句 review、無自動測試（Review Focus 4：MigrateAsync 只在空庫上跑，造不出舊列的形狀）。
            migrationBuilder.Sql("""
                UPDATE "EffortLogs" SET "LocalDate" = ("LoggedAt" AT TIME ZONE 'UTC')::date,
                                       "LoggedAtLocal" = "LoggedAt" AT TIME ZONE 'UTC';
                UPDATE "TeamMembers" SET "JoinedLocalDate" = ("JoinedAt" AT TIME ZONE 'UTC')::date;
                UPDATE "ProjectMembers" SET "JoinedLocalDate" = ("JoinedAt" AT TIME ZONE 'UTC')::date;
                """);

            // 暫時預設用完即丟（裸 DDL，不經 EF 的 AlterColumn：DROP DEFAULT 的 SQL 直接看得見，
            // 逐句 review 時不必再推 EF 會生成什麼）。模型／快照裡沒有 `HasDefaultValue`，
            // 移除預設才與模型一致（也是 brief 指定的形狀）。
            migrationBuilder.Sql("""
                ALTER TABLE "EffortLogs" ALTER COLUMN "LocalDate" DROP DEFAULT;
                ALTER TABLE "EffortLogs" ALTER COLUMN "LoggedAtLocal" DROP DEFAULT;
                ALTER TABLE "TeamMembers" ALTER COLUMN "JoinedLocalDate" DROP DEFAULT;
                ALTER TABLE "ProjectMembers" ALTER COLUMN "JoinedLocalDate" DROP DEFAULT;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // 回不去：回填只寫進 UTC 日的近似值，原始時區資訊沒有留下來 ⇒ 這裡只移除欄位。
            migrationBuilder.DropColumn(
                name: "LocalDate",
                table: "EffortLogs");

            migrationBuilder.DropColumn(
                name: "LoggedAtLocal",
                table: "EffortLogs");

            migrationBuilder.DropColumn(
                name: "JoinedLocalDate",
                table: "TeamMembers");

            migrationBuilder.DropColumn(
                name: "JoinedLocalDate",
                table: "ProjectMembers");
        }
    }
}
