import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { TouchSensorOptions } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

// 拖曳感應器的單一來源（看板與心智圖大綱共用）。
//
// 觸控不能用位移門檻（2026-10-14 實測）：`PointerSensor` ＋ `{ distance: 5 }` 在手機上，
// 手指一移動就先滿足 5px 的啟動門檻，**早於瀏覽器承認這是一段捲動**（瀏覽器約 8–10px），
// 於是拖曳先啟動、DragOverlay 掛上（卡片浮起），接著瀏覽器接手捲動並送出 `pointercancel`，
// 拖曳當場被取消 ⇒ 卡片「浮起、閃一下、消失」。實測時間軸：
// `pointerdown 471 → dragstart 497 → overlay-mount 534 → pointercancel 548 → dragcancel 548
// → overlay-unmount 563`（overlay 只存在 29ms），捲動本身照常發生。
// 同一個設定下**長按拖曳也一樣被取消**（實測兩跑 dragstart → 取消各為 36ms／44ms）⇒ 觸控拖曳形同全壞。
//
// 觸控改用「延遲 ＋ 容忍位移」：按住不動 TOUCH_DRAG_DELAY_MS 才啟動；期間位移超過容忍值即判定為捲動。
// ★ 不可寫成 `{ delay, tolerance, distance }`——`AbstractPointerSensor.handleMove` 先檢查
// `isDistanceConstraint`，只要物件裡有 `distance` 就會在該距離直接 `handleStart()`，delay 形同虛設
// （`@dnd-kit/core@6.3.1` dist/core.cjs.development.js 的 handleMove／handleStart）。
// 這條由 `dnd-sensors.test.tsx` 以形狀鎖住（有 delay、沒有 distance）。
export const TOUCH_DRAG_DELAY_MS = 250;
export const TOUCH_DRAG_TOLERANCE_PX = 5;
export const MOUSE_DRAG_DISTANCE_PX = 5;

// 例外：**握把**（`BoardListColumn` 清單列的拖曳把手）在觸控上不等延遲、立即拖曳。
// 它自己帶 `touch-action: none` ⇒ 從它開始的手勢本來就捲不動，沒有「拖曳與捲動搶同一個手勢」
// 的問題；延遲在那裡只剩壞處——16px 的目標要按住 250ms 更難按，而「按住不動」正好是
// 瀏覽器長按選字的觸發條件（2026-10-15 使用者實機回報：「握把比較難點，點太久會變成
// 選擇文字的樣子」）。
// 判準：**帶 `touch-action: none` 的啟動器才可以用這個標記**——沒有的話，手指一碰就拖，
// 捲動會被搶走（那正是這一整支模組在防的事）。
// 標記寫在 `BoardListColumn.tsx` 的握把上；兩端的連接是**字串**，所以
// `dnd-sensors.test.tsx` 讀 `BoardListColumn.tsx` 的原始碼把這個字面值釘住（改名不會靜默失效）。
export const INSTANT_DRAG_SELECTOR = "[data-dnd-instant]";

// 啟動器節點（`setActivatorNodeRef` 那個；沒有設就是 draggable 自己）是否帶即時拖曳標記。
//
// ★ 參數是 dnd-kit 的**呼叫合約**，不是節點本身：`AbstractPointerSensor.attach()` 傳的是
// **一個物件** `{event, activeNode, options}`（實查 `@dnd-kit/core@6.3.1`
// `dist/core.cjs.development.js:1456-1460`；型別見 `dist/sensors/pointer/AbstractPointerSensor.d.ts:23`
// 的 `bypassActivationConstraint?(props: Pick<AbstractPointerSensorProps, 'activeNode'|'event'|'options'>)`）。
// 這裡的參數型別直接**由 dnd-kit 的型別推導**（不自己手寫一份），所以合約變了就是 `tsc -b` 紅。
//
// 2026-10-15 實錄：第一版把參數當成節點本身（`activeNode.activatorNode.current`），
// 於是 `args.activatorNode` 是 undefined ⇒ 在 **TouchSensor 建構子裡**丟 TypeError ⇒
// **感應器實例根本沒建起來** ⇒ 觸控拖曳全死（瀏覽器 harness 實測：`shipping` 模式每個
// touchstart 都噴同一個 TypeError、dragStarts 一律 0）。單元測試沒抓到，因為它的 fixture
// 是**自己捏的節點形狀**——實作與測試一起錯、一起綠；抓到它的是 `tsc -b`（TS2322）。
type TouchActivationBypassProps = Parameters<NonNullable<TouchSensorOptions["bypassActivationConstraint"]>>[0];

export function isInstantDragActivator({ activeNode }: TouchActivationBypassProps): boolean {
  // 型別說 `activeNode` 非空，但這是第三方的執行期合約：形狀猜錯的代價是整支觸控感應器
  // 建不起來，所以寧可退回 `false`（握把退回長按）也不要炸。
  if (!activeNode) return false;
  const activator = activeNode.activatorNode?.current ?? activeNode.node?.current;
  return activator?.closest(INSTANT_DRAG_SELECTOR) != null;
}

// 滑鼠不需要延遲：指標精準，沒有「拖曳與捲動搶同一個手勢」的問題，
// 位移門檻只是為了讓點擊不被當成拖曳。MouseSensor 而非 PointerSensor——後者
// 會在觸控裝置上一併攔下 touch，把上面那段延遲又蓋回位移門檻。
// `keyboard` 預設開——看板卡片有自己的 Enter/Space 分派（`BoardCard` 的 onKeyDown），
// 需要鍵盤拖曳。心智圖大綱列**刻意不裝**：`KeyboardSensor` 的啟動鍵是 Space/Enter，
// 而該列沒有 `setActivatorNodeRef`（啟動器為 null ⇒ 不檢查 event.target），
// 於是列內任何控制項按 Space/Enter 都會被 preventDefault 並開始拖曳——
// 那會推翻 2026-09-27 訂下的列鍵盤規則（見 `MindMapTab.tsx` 的 handleRowKeyDown）。
export function useDndSensors({ keyboard = true }: { keyboard?: boolean } = {}) {
  // 三個 useSensor 一律呼叫（hook 數量不隨參數改變），再依參數挑選要註冊的
  const mouse = useSensor(MouseSensor, {
    activationConstraint: { distance: MOUSE_DRAG_DISTANCE_PX },
  });
  const touch = useSensor(TouchSensor, {
    activationConstraint: { delay: TOUCH_DRAG_DELAY_MS, tolerance: TOUCH_DRAG_TOLERANCE_PX },
    // 這個指派就是型別鎖：簽名與 dnd-kit 的呼叫合約不符時，`tsc -b`（第 13 道閘門）紅在這裡
    bypassActivationConstraint: isInstantDragActivator,
  });
  const key = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  return useSensors(...(keyboard ? [mouse, touch, key] : [mouse, touch]));
}
