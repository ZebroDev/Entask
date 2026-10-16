using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Entask.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddSystemIdentifiers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Code",
                table: "Roles",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SystemKey",
                table: "CustomFieldDefinitions",
                type: "text",
                nullable: true);

            // 一次性回填：把本次改動之前由 seed 建立、因而沒有識別碼的資料列補上。
            //
            // 這裡是 UPDATE，與本專案「additive 優先」的慣例看似衝突，但對滾動部署是安全的：
            // 舊映像完全不知道這兩個欄位的存在，它的查詢與寫入都不受影響，回滾亦然。
            // （對比之下，AdminClaimSeed 之所以不能 UPDATE 是它改的是「既有欄位的值」，
            //   而這裡只是填一個舊程式碼從不讀取的新欄位。）
            //
            // 使用者若已自行改過名稱，比對不到，該列維持 null——讀取端的 fallback 會沿用
            // 改動前的行為（找不到就是找不到），不會比現在更糟。
            migrationBuilder.Sql("""
                UPDATE "Roles" SET "Code" = 'team_manager'
                    WHERE "TeamId" IS NULL AND "Code" IS NULL AND "Name" = '團隊經理';
                UPDATE "Roles" SET "Code" = 'project_manager'
                    WHERE "TeamId" IS NULL AND "Code" IS NULL AND "Name" = '專案經理';
                UPDATE "Roles" SET "Code" = 'project_assistant'
                    WHERE "TeamId" IS NULL AND "Code" IS NULL AND "Name" = '專案助理';
                UPDATE "Roles" SET "Code" = 'eng_lead'
                    WHERE "TeamId" IS NULL AND "Code" IS NULL AND "Name" = '工程組長';
                UPDATE "Roles" SET "Code" = 'engineer'
                    WHERE "TeamId" IS NULL AND "Code" IS NULL AND "Name" = '工程師';
                UPDATE "Roles" SET "Code" = 'qa_engineer'
                    WHERE "TeamId" IS NULL AND "Code" IS NULL AND "Name" = '測試工程師';

                UPDATE "CustomFieldDefinitions" SET "SystemKey" = 'priority'
                    WHERE "ScopeType" = 'project' AND "SystemKey" IS NULL AND "Name" = '優先級';
                UPDATE "CustomFieldDefinitions" SET "SystemKey" = 'requester'
                    WHERE "ScopeType" = 'project' AND "SystemKey" IS NULL AND "Name" = '提出需求者';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Code",
                table: "Roles");

            migrationBuilder.DropColumn(
                name: "SystemKey",
                table: "CustomFieldDefinitions");
        }
    }
}
