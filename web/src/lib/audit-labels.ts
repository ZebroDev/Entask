// 稽核動作標籤表：**活動牆與系統活動頁共用**。`web/scripts/check-label-tables.mjs`
// 的第五張表 `table:` 指的就是本檔——它原本長在 `pages/team/TeamActivityTab.tsx` 裡，
// 抽出來是因為同一個後端動作集合接下來有第二個消費端，兩份 switch 會各自腐爛。
import i18n from "@/i18n";

export interface AuditDto { id: string; action: string; entityType: string; entityTitle?: string | null; createdAt: string; userDisplayName?: string | null; }

/**
 * 稽核端點的分頁信封（**兩個端點共用**，對應後端 `AuditLogPage`）。
 * `nextCursor` 非 null ⟺ 還有更多；它是不透明字串，前端只負責原樣回送。
 */
export interface AuditPageResponse { items: AuditDto[]; nextCursor: string | null }

/**
 * 稽核動作 → 標籤。
 *
 * **寫成 switch 而不是查表，是被 i18next-parser 逼的**——與 `CardActivityTab` 的
 * `typeLabel`、`lib/custom-fields.ts` 的 `typeLabel` 同一形狀（設計 §6.1）。查表
 * （key 放資料表、取出來才傳給 i18n 實例）的引數不是字面值，parser 掃不到，而
 * `keepRemoved: false` 會把「原始碼裡找不到」的 key 直接從語系檔刪掉——畫面只顯示
 * key 本身，沒有錯誤、沒有警告、測試也不會紅。
 *
 * 每次呼叫才求值，所以切換語系一定拿得到新值；寫成模組層級的常值會在 import 時
 * 就把文案凍結在當下的語系。
 *
 * 這張表同時是**後端 `AuditActions` 的契約鎖**（`web/scripts/check-label-tables.mjs`
 * 的第五張表）：後端加了動作而這裡沒加 case，閘門會紅。沒有閘門時的症狀是活動牆
 * 直接印出識別碼（zh-TW 使用者看到 `team.created：核心研發團隊`），
 * 而 `tsc`、測試、parity 全都不會紅——那是 2026-09-14 B2-6a 之前的實況。
 *
 * 認不得的動作原樣顯示，與 `typeLabel` 同一個判準：**看得出來比猜一個標籤好**。
 */
export const auditActionLabel = (action: string) => {
  switch (action) {
    case "team.created":
      return i18n.t("team:audit.team.created");
    case "team.updated":
      return i18n.t("team:audit.team.updated");
    case "member.assigned":
      return i18n.t("team:audit.member.assigned");
    case "member.removed":
      return i18n.t("team:audit.member.removed");
    // 這一條在活動牆上不可達：`user.created` 的 TeamId 是 null，而端點以
    // `Where(l => l.TeamId == teamId)` 過濾。留著是因為閘門比的是「後端常數集合
    // 與前端 case 集合相等」，少一條就會紅——一條死 case 比在閘門裡造排除機制便宜。
    // ★ 2026-10-10：以上的「不可達」只對**活動牆**成立——`user.created` 在**系統活動頁**
    // （`/system-activity`，後端 `GET /api/audit-logs/system`）看得到。
    case "user.created":
      return i18n.t("team:audit.user.created");
    case "user.deactivated":
      return i18n.t("team:audit.user.deactivated");
    case "user.reactivated":
      return i18n.t("team:audit.user.reactivated");
    case "user.deleted":
      return i18n.t("team:audit.user.deleted");
    case "user.password_reset":
      return i18n.t("team:audit.user.passwordReset");
    case "board.created":
      return i18n.t("team:audit.board.created");
    case "board.updated":
      return i18n.t("team:audit.board.updated");
    case "board.deleted":
      return i18n.t("team:audit.board.deleted");
    case "card.created":
      return i18n.t("team:audit.card.created");
    case "card.deleted":
      return i18n.t("team:audit.card.deleted");
    case "project.created":
      return i18n.t("team:audit.project.created");
    case "project.updated":
      return i18n.t("team:audit.project.updated");
    case "project.deleted":
      return i18n.t("team:audit.project.deleted");
    case "project.member.added":
      return i18n.t("team:audit.projectMember.added");
    case "project.member.updated":
      return i18n.t("team:audit.projectMember.updated");
    case "project.member.removed":
      return i18n.t("team:audit.projectMember.removed");
    case "custom_field.created":
      return i18n.t("team:audit.customField.created");
    case "custom_field.updated":
      return i18n.t("team:audit.customField.updated");
    case "custom_field.deleted":
      return i18n.t("team:audit.customField.deleted");
    case "role.created":
      return i18n.t("team:audit.role.created");
    case "role.updated":
      return i18n.t("team:audit.role.updated");
    case "role.deleted":
      return i18n.t("team:audit.role.deleted");
    case "work_calendar.updated":
      return i18n.t("team:audit.workCalendar.updated");
    case "work_calendar.deleted":
      return i18n.t("team:audit.workCalendar.deleted");
    default:
      return action;
  }
};
