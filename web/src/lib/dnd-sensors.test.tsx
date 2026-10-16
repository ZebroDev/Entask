import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { KeyboardSensor, MouseSensor, TouchSensor } from "@dnd-kit/core";
import type { TouchSensorOptions } from "@dnd-kit/core";
import type { SensorDescriptor } from "@dnd-kit/core";
import {
  INSTANT_DRAG_SELECTOR, MOUSE_DRAG_DISTANCE_PX, TOUCH_DRAG_DELAY_MS, TOUCH_DRAG_TOLERANCE_PX,
  isInstantDragActivator, useDndSensors,
} from "./dnd-sensors";
import boardListColumnSource from "../pages/board/BoardListColumn.tsx?raw";

// 這一支是**形狀鎖**，不是行為測試：jsdom 沒有瀏覽器的捲動／pointercancel 語意，
// 真實手指的判別實驗在瀏覽器裡做（2026-10-14，見 docs/history）。
// 它守的是兩件「寫錯也照樣全綠」的事：
//   ① 觸控若用位移門檻，滑動會先啟動拖曳再被瀏覽器取消（卡片浮起、閃一下、消失）；
//   ② 觸控約束**同時**帶 `distance` 時，dnd-kit 的 handleMove 先看 distance ⇒ delay 形同虛設。
type Options = {
  activationConstraint?: Record<string, number>;
  bypassActivationConstraint?: unknown;
};
type Descriptor = SensorDescriptor<Options>;

let captured: Descriptor[] = [];
function Probe({ keyboard }: { keyboard?: boolean }) {
  captured = useDndSensors(keyboard === undefined ? undefined : { keyboard }) as Descriptor[];
  return null;
}

const constraintOf = (sensor: unknown) =>
  captured.find((d) => d.sensor === sensor)?.options?.activationConstraint;
const sensors = () => captured.map((d) => d.sensor);

describe("useDndSensors", () => {
  it("觸控用延遲＋容忍位移，且不可同時帶 distance（後者會讓 delay 失效）", () => {
    render(<Probe />);
    const touch = constraintOf(TouchSensor);
    expect(touch).toBeDefined();
    expect(touch!.delay).toBe(TOUCH_DRAG_DELAY_MS);
    expect(touch!.tolerance).toBe(TOUCH_DRAG_TOLERANCE_PX);
    // ★ 這一條是重點：物件裡只要出現 distance，handleMove 會在該距離直接 handleStart()
    expect(touch!).not.toHaveProperty("distance");
    // 延遲必須長到「來得及被判定為捲動」，0 或極短等於沒有延遲
    expect(touch!.delay).toBeGreaterThanOrEqual(150);
    expect(touch!.tolerance).toBeLessThanOrEqual(10);
  });

  it("滑鼠用位移門檻、不用延遲（桌機拖曳不該被長按門檻拖慢）", () => {
    render(<Probe />);
    const mouse = constraintOf(MouseSensor);
    expect(mouse).toEqual({ distance: MOUSE_DRAG_DISTANCE_PX });
    expect(mouse!).not.toHaveProperty("delay");
  });

  it("不再註冊 PointerSensor：它會在觸控裝置上一併攔下 touch，把延遲蓋回位移門檻", () => {
    render(<Probe />);
    expect(sensors()).toEqual([MouseSensor, TouchSensor, KeyboardSensor]);
  });

  it("keyboard:false 時不裝 KeyboardSensor（心智圖大綱列的鍵盤規則）", () => {
    render(<Probe keyboard={false} />);
    expect(sensors()).toEqual([MouseSensor, TouchSensor]);
  });
});

// 握把的即時拖曳（2026-10-15 使用者實機回報「握把比較難點、點太久會變成選字」）
describe("觸控的即時拖曳例外", () => {
  // ★ fixture 一律**由 dnd-kit 的型別推導**：dnd-kit 傳進來的是**一個物件**
  // `{event, activeNode, options}`，不是節點本身。第一版測試自己捏了一份節點形狀的 fixture
  // ⇒ 實作與測試一起錯、一起綠，而真正的紅燈在瀏覽器裡（感應器在 dnd-kit 的建構子就丟例外、
  // 觸控拖曳全死）。型別推導讓「合約變了」變成 `tsc -b` 的紅，而不是使用者的紅。
  type BypassProps = Parameters<NonNullable<TouchSensorOptions["bypassActivationConstraint"]>>[0];

  const withAttribute = (has: boolean) => {
    const el = document.createElement("span");
    if (has) el.setAttribute(INSTANT_DRAG_SELECTOR.slice(1, -1), "");
    return el;
  };

  const bypassProps = (
    { activator = null, node = null }: { activator?: HTMLElement | null; node?: HTMLElement | null } = {},
  ): BypassProps => ({
    event: new Event("touchstart"),
    options: { activationConstraint: { delay: TOUCH_DRAG_DELAY_MS, tolerance: TOUCH_DRAG_TOLERANCE_PX } },
    activeNode: {
      id: "list-1",
      key: "list-1",
      node: { current: node },
      activatorNode: { current: activator },
      data: { current: undefined },
    },
  });

  it("帶標記的啟動器＝放行；沒帶的（卡片）＝不放行", () => {
    expect(isInstantDragActivator(bypassProps({ activator: withAttribute(true), node: withAttribute(false) }))).toBe(true);
    expect(isInstantDragActivator(bypassProps({ activator: withAttribute(false), node: withAttribute(true) }))).toBe(false);
  });

  it("沒有 setActivatorNodeRef 時退回 draggable 自己的節點（卡片就是這一種）", () => {
    expect(isInstantDragActivator(bypassProps({ node: withAttribute(true) }))).toBe(true);
    expect(isInstantDragActivator(bypassProps())).toBe(false);
  });

  it("activeNode 不在時退回 false——不炸（炸掉的會是整支觸控感應器）", () => {
    // 型別說 `activeNode` 非空，這裡刻意送一個型別不允許的形狀：這一條守的是**執行期合約**
    // （第三方套件說變就變），而它的失效模式是「靜默不放行」而不是「例外」。
    const malformed = { ...bypassProps(), activeNode: undefined } as unknown as BypassProps;
    expect(isInstantDragActivator(malformed)).toBe(false);
  });

  it("只有觸控裝這個例外——滑鼠維持位移門檻（握把在桌機不該一點就拖）", () => {
    render(<Probe />);
    expect(captured.find((d) => d.sensor === TouchSensor)?.options?.bypassActivationConstraint)
      .toBe(isInstantDragActivator);
    expect(captured.find((d) => d.sensor === MouseSensor)?.options).not.toHaveProperty("bypassActivationConstraint");
  });

  // 兩端的連接是字串：改了握把的屬性名而沒改這裡，放行會**靜默**失效
  // （握把退回「要長按」，沒有任何測試會紅）。這一條是本檔唯一讀別的檔案原始碼的地方，
  // 理由與 `review-badge.test.ts` 讀 `index.css` 同型。
  it("BoardListColumn 的握把真的帶那個標記", () => {
    expect(boardListColumnSource).toContain("data-dnd-instant");
  });
});
