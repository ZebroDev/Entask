import { lazy, type ComponentType } from "react";

/**
 * `React.lazy` 要的是模組的 `default` 匯出，而本專案的頁面一律是具名匯出
 * （`export function LoginPage`）。少了這層轉接的症狀是**執行期**
 * 「Element type is invalid」：fallback 不會出現（lazy 根本沒拿到元件）、
 * 畫面整片空白，而 `tsc -b` 與既有的每一支測試都不會紅。
 *
 * `name` 有型別約束——模組裡沒有那個名字時**編譯**就失敗，所以字串打錯
 * 不是執行期的事。這是把這個字形集中在一處的理由。
 */
export function lazyPage<K extends string, P extends object>(
  loader: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  return lazy(() => loader().then((m) => ({ default: m[name] })));
}

/**
 * CardDialog 的載入器有兩個消費端：路由定義（`App.tsx`）與看板的閒置預取。
 * 抽出來是為了讓兩邊**指向同一條路徑**——分開寫的話，改了一邊而沒改另一邊
 * 不會有任何紅燈（預取失敗是靜默的）。
 */
export const loadCardDialog = () => import("@/pages/board/CardDialog");

/**
 * 看板掛載後在閒置時預取卡片對話框的 chunk。
 *
 * 這是 `BoardPage` 的 Suspense 邊界可以留 `null` 的前提：使用者點卡片時它
 * 通常已經到了，所以不必為了「點了沒反應」而另外做一個遮罩。
 * jsdom 沒有 `requestIdleCallback`，故留 setTimeout 後備。
 */
export function prefetchCardDialog() {
  const run = () => void loadCardDialog();
  if (typeof requestIdleCallback === "function") requestIdleCallback(run);
  else setTimeout(run, 0);
}
