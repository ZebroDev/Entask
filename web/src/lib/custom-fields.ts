// 自訂欄位型態與範疇的標籤：對話框與列表共用，避免兩處各留一份而走樣。
//
// **這個模組不匯出文案**（P-B2 設計 §6.1）——與 P-A 修掉的三處
// （`ProjectReportQueries` 的「優先級」、`ProjectEndpoints` 的「團隊經理」、
// `RoleSeed` 的角色名）是同一個原則：拿顯示文字當查詢鍵，換一個語系就斷。
import i18n from "@/i18n";

/** 六個型態的**值**（送給後端的識別碼）。對話框用它產生下拉選單。 */
export const FIELD_TYPES = ["text", "number", "select", "date", "member", "checkbox"] as const;

/**
 * 型態 → 標籤。
 *
 * **寫成 switch 而不是查表，是被 i18next-parser 逼的，不是風格偏好。**
 * 查表（key 放在資料表裡、取出來才傳給 i18n.t）的引數不是字面值，parser 掃不到，
 * 而 `i18next-parser.config.js` 的 `keepRemoved: false` 會把「原始碼裡找不到」
 * 的 key 直接從語系檔刪掉——畫面只會顯示 key 本身，沒有錯誤、沒有警告、測試也不會紅。
 * B2-2b 實測到的（設計 §6.1 寫的「匯出 key、由呼叫端 t()」在 parser 面前不成立）。
 */
export const typeLabel = (type: string) => {
  switch (type) {
    case "text":
      return i18n.t("common:fieldType.text");
    case "number":
      return i18n.t("common:fieldType.number");
    case "select":
      return i18n.t("common:fieldType.select");
    case "date":
      return i18n.t("common:fieldType.date");
    case "member":
      return i18n.t("common:fieldType.member");
    case "checkbox":
      return i18n.t("common:fieldType.checkbox");
    // 型態不認得時退回原字串，與改動前（`TYPE_LABELS[type] ?? type`）一致
    default:
      return type;
  }
};

/**
 * 範疇 → 標籤。同樣是函式，所以 `i18n.t()` 在每次呼叫時求值——
 * 這是設計 §6.2 對 `format.ts` 的同一個例外：模組可以呼叫 i18n 組訊息，
 * 只是不得把值凍結在模組層級（模組層級的值在 import 時就算完，切換語系不會更新）。
 *
 * 非 `project` 一律當看板，與改動前 `scopeType === "project" ? 專案 : 看板` 語意相同。
 */
export const scopeLabel = (scopeType: string) =>
  scopeType === "project" ? i18n.t("common:fieldScope.project") : i18n.t("common:fieldScope.board");
