// 系統角色名的顯示端：有 `Code` 就用 `Code` 查語系，查不到（自訂角色、`null`、
// 或後端已加但語系還沒跟上的新 code）退回資料庫裡的 `Name`。
//
// **為什麼需要**：`RoleSeed` 的六個系統角色名是**建立當下的預設顯示名稱**，寫進 DB 之後
// 就是使用者的資料（`SystemRoleCodes` 的檔頭：「第一次寫入是文案，之後就是使用者的資料」）。
// 種子的值是中文 ⇒ 在此之前，en 使用者在成員名冊、角色清單、指派／編輯角色的四個對話框裡
// 看到的全部是中文徽章。`Code` 才是穩定的身分（與 `PermissionCodes` 同型），語系檔才是文案。
//
// **不動編輯表單**：`RoleEditDialog` 的 `useState(role?.name ?? "")` 預填的是**要寫回 DB 的
// 值**——在那裡在地化的話，編輯一次系統角色就會把譯文寫進資料庫（名稱從此釘在某個語系）。
import i18n from "@/i18n";

/**
 * 六個系統角色 code → 語系標籤；其餘（自訂角色、`null`）退回 DB 裡的名字。
 *
 * **寫成 switch 是被 i18next-parser 逼的**（`keepRemoved: false` 會刪掉它掃不到的字面值 key），
 * 與 `lib/custom-fields.ts` 的 typeLabel 同一個理由；查表（key 放在資料表裡、取出來才傳給
 * i18n）的引數不是字面值，parser 掃不到，而畫面只會顯示 key 本身——沒有錯誤、沒有警告、
 * 測試也不會紅。
 *
 * 函式（而不是模組層級的常數）是 `custom-fields.ts` 對 `format.ts` 的同一個例外：
 * 模組可以呼叫 i18n 組訊息，只是不得把值凍結在模組層級（模組層級的值在 import 時就算完，
 * 切換語系不會更新）。**這個要點在這裡更容易踩到**——呼叫端把回傳值當字串用，
 * 看不出它是「當場算的」還是「匯入時算好的」。
 *
 * `code` 允許 `null | undefined`：`ProjectMemberRoleDto.Code` 在後端是 `string?`，
 * 而自訂角色的 `Code` 本來就是 `null`。
 */
export const roleNameLabel = (code: string | null | undefined, name: string) => {
  switch (code) {
    case "team_manager":
      return i18n.t("team:roleName.team_manager");
    case "project_manager":
      return i18n.t("team:roleName.project_manager");
    case "project_assistant":
      return i18n.t("team:roleName.project_assistant");
    case "eng_lead":
      return i18n.t("team:roleName.eng_lead");
    case "engineer":
      return i18n.t("team:roleName.engineer");
    case "qa_engineer":
      return i18n.t("team:roleName.qa_engineer");
    // 自訂角色（code 為 null）與後端已加、語系還沒跟上的新 code 走這裡。
    // 後者刻意不是「顯示 key」：一條未來的系統角色在畫面上仍然是它的 DB 名，
    // 與改動前的行為一致（這正是 default 分支要保住的那一半語意）。
    default:
      return name;
  }
};
