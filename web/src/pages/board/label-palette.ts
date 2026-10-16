import i18n from "@/i18n";

// 與 spec 固定的 10 色 hex 色盤一致
export const LABEL_PALETTE = [
  "#B60205", "#D93F0B", "#F2D600", "#519839", "#0079BF",
  "#89609E", "#CD5A91", "#4BBED6", "#AEC57D", "#6C547B",
];

/**
 * 色碼 → 色名（a11y：色板按鈕的 `aria-label`，spec #27）。
 *
 * **這個模組不匯出文案**（P-B2 設計 §6.1）——原本匯出的 `LABEL_COLOR_NAMES` 是一張
 * 值在 import 時就算完的資料表，換語系不會更新，而且與 P-A 修掉的三處
 * （`ProjectReportQueries` 的「優先級」、`ProjectEndpoints` 的「團隊經理」、
 * `RoleSeed` 的角色名）是同一個錯誤：拿顯示文字當識別碼。
 *
 * **寫成 switch 而不是查表，是被 i18next-parser 逼的，不是風格偏好。**
 * 查表（key 放在資料表裡、取出來才傳給 i18n.t）的引數不是字面值，parser 掃不到，而
 * `i18next-parser.config.js` 的 `keepRemoved: false` 會把「原始碼裡找不到」的 key
 * 直接從語系檔刪掉——畫面只會顯示 key 本身，沒有錯誤、沒有警告、測試也不會紅。
 * 範本是 `lib/custom-fields.ts` 的 `typeLabel`（同一個形狀，那個檔有完整說明）。
 *
 * 直接呼叫 i18n 實例而不是 `useTranslation()`：本模組沒有 React context（設計 §6.1）。
 * 函式每次呼叫才求值，所以也沒有「模組層級凍結語系」的問題。
 */
export function colorName(hex: string): string {
  switch (hex) {
    case "#B60205":
      return i18n.t("board:labelColor.red");
    case "#D93F0B":
      return i18n.t("board:labelColor.orange");
    case "#F2D600":
      return i18n.t("board:labelColor.yellow");
    case "#519839":
      return i18n.t("board:labelColor.green");
    case "#0079BF":
      return i18n.t("board:labelColor.blue");
    case "#89609E":
      return i18n.t("board:labelColor.purple");
    case "#CD5A91":
      return i18n.t("board:labelColor.pink");
    case "#4BBED6":
      return i18n.t("board:labelColor.cyan");
    case "#AEC57D":
      return i18n.t("board:labelColor.lightGreen");
    case "#6C547B":
      return i18n.t("board:labelColor.grayPurple");
    // 色盤外的色碼退回 hex 本身，與改動前（`LABEL_COLOR_NAMES[c] ?? c`）一致
    default:
      return hex;
  }
}
