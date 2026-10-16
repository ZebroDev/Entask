// localStorage 的鍵名集中在這裡。
//
// 為何要集中：`taskify-auth` 原本在 api.ts 與 auth.ts 各自寫死。請求攔截器讀它、
// auth store 寫它，只改一處會靜默失去憑證——store 寫得進去，但攔截器讀不到，
// 每個請求都無憑證送出。抽成單一常數後這種不一致無法再發生。
//
// 改名為 entask-* 是一次破壞性變更：所有使用者被登出一次，主題與心智圖偏好重置。
// 刻意不做舊鍵的 fallback——fallback 需要同時修 logout() 清掉舊鍵，否則登出後舊鍵
// 仍在，下次啟動會把已登出的 session 復活。詳見 AGENTS.md 的改名章節。
export const AUTH_STORAGE_KEY = "entask-auth";
export const THEME_STORAGE_KEY = "entask-ui-theme";
export const MINDMAP_COLLAPSED_PREFIX = "entask-mindmap-collapsed-";
export const MINDMAP_CASCADE_DRAG_KEY = "entask-mindmap-cascade-drag";

// 語系鍵（P-B1）。以「鍵存不存在」編碼兩個狀態：
// 沒有這個鍵 = 跟隨瀏覽器（R6 的偵測鏈），有這個鍵 = 使用者明確指定。
// 改回「跟隨瀏覽器」時必須刪除鍵，不可寫入 "null" 字串——見 i18n/index.ts 的 setLocale。
export const LOCALE_STORAGE_KEY = "entask-locale";
