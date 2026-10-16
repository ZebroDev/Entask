import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import type { ListResponse } from "@/lib/board-types";
import { BoardListColumn } from "./BoardListColumn";

// 拖曳中的樣式是**受控輸入的輸出**：把 useSortable 換成可切換 isDragging 的版本，
// 其餘（BoardListColumn 的 class 字串）都是真的——這支鎖的是「isDragging ⇒ 這些 class」，
// 以及它們**沒拖曳時不存在**（單向斷言會讓「永遠套用」的退化恆綠）。
// 2026-10-15 使用者：「最好是能夠有明顯的讓用戶知道手把有被選中可以拖曳的效果」。
const dragState = vi.hoisted(() => ({ dragging: false }));

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: () => ({
      setNodeRef: () => {},
      setActivatorNodeRef: () => {},
      // attributes 給**假值**：真品的 `aria-pressed` 由 dnd-kit 自己算
      // （`core.cjs.development.js:3433`，`isDragging && role === defaultRole`），
      // 這裡只證明 attributes 有被攤到握把上——那才是視覺與語意同步的前提。
      attributes: { role: "button", tabIndex: 0 },
      listeners: {},
      transform: null,
      transition: null,
      isDragging: dragState.dragging,
    }),
  };
});

const list: ListResponse = { id: "l1", name: "待辦", position: "h", isArchived: false, cards: [] };

function renderColumn(dragging: boolean) {
  dragState.dragging = dragging;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DndContext>
        <BoardListColumn
          list={list}
          showArchived={false}
          canEdit
          canCreateCard={false}
          canDragList
          canDragCards
          onRename={() => {}}
          onCopy={() => {}}
        />
      </DndContext>
    </QueryClientProvider>,
  );
}

const columnOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const gripOf = (container: HTMLElement) => container.querySelector("[data-dnd-instant]") as HTMLElement;
const markOf = (container: HTMLElement) => gripOf(container).firstElementChild as HTMLElement;

const SIDES = ["t", "r", "b", "l"] as const;
type Side = (typeof SIDES)[number];

// 「版面零位移」的機制：padding 撐開命中區、負外距**逐邊**吃回去 ⇒ 版面格不變。
// 這一條會腐爛的方式很安靜——只改 padding 不改負外距，命中區與版面一起長大，
// 畫面只是「稍微跑掉」，沒有紅燈。所以逐邊比對，而不是比對寫死的 class 字串
// （後者會讓「p-3 -m-3」這種一樣零位移的改法誤紅）。
function frameOf(el: HTMLElement) {
  const pad: Record<Side, number> = { t: 0, r: 0, b: 0, l: 0 };
  const mar: Record<Side, number> = { t: 0, r: 0, b: 0, l: 0 };
  const sidesOf = (axis: string): Side[] =>
    axis === "" ? [...SIDES] : axis === "x" ? ["l", "r"] : axis === "y" ? ["t", "b"] : [axis as Side];
  // 兩趟：先簡寫（p-2／m-2）再逐邊（pl-4／-mr-2），與 CSS 的覆蓋直覺一致
  for (const shorthand of [true, false]) {
    for (const cls of el.classList) {
      const m = /^(-?)([pm])([xytrbl]?)-(\d+(?:\.\d+)?)$/.exec(cls);
      if (!m) continue;
      const [, neg, kind, axis, value] = m;
      if ((axis === "") !== shorthand) continue;
      for (const s of sidesOf(axis)) {
        (kind === "p" ? pad : mar)[s] = Number(value) * (neg ? -1 : 1);
      }
    }
  }
  return SIDES.reduce(
    (acc, s) => ({ ...acc, [s]: pad[s] + mar[s] }),
    {} as Record<Side, number>,
  );
}

describe("BoardListColumn 拖曳回饋", () => {
  it("拖曳中：欄身抬起，且與卡片 overlay 同一套語彙", () => {
    const { container } = renderColumn(true);
    const column = columnOf(container);
    expect(column).toHaveClass("ring-2", "ring-primary/20");
    // 陰影只能有一個：cn() 的 twMerge 要把 base 的 shadow-2xs 換掉，
    // 不能兩個都留著讓 CSS 檔次決定誰贏（那就變成看不到原始碼的勝負）
    expect([...column.classList].filter((c) => c.startsWith("shadow-"))).toEqual(["shadow-xl"]);
  });

  it("拖曳中：握把亮起、游標改為抓住中、attributes 仍在", () => {
    const { container } = renderColumn(true);
    expect(markOf(container)).toHaveClass(
      "bg-primary/15", "text-foreground", "ring-2", "ring-inset", "ring-primary/40",
    );
    expect(gripOf(container)).toHaveClass("cursor-grabbing");
    expect(gripOf(container)).toHaveAttribute("role", "button");
  });

  it("沒拖曳時三個回饋都不存在", () => {
    const { container } = renderColumn(false);
    expect(columnOf(container)).not.toHaveClass("ring-primary/20");
    expect(columnOf(container)).toHaveClass("shadow-2xs");
    expect(markOf(container)).not.toHaveClass("bg-primary/15", "ring-primary/40");
    expect(gripOf(container)).not.toHaveClass("cursor-grabbing");
  });

  it("命中區與回饋層的 padding／負外距逐邊成對（版面零位移）", () => {
    const { container } = renderColumn(false);
    expect(frameOf(gripOf(container))).toEqual({ t: 0, r: 0, b: 0, l: 0 });
    expect(frameOf(markOf(container))).toEqual({ t: 0, r: 0, b: 0, l: 0 });
    // 反面：外圈若把負外距刪掉，上面會是 0/0/0/0 而「看起來」通過——
    // 加上這條，padding 必須真的存在，命中區才是撐開的
    expect(gripOf(container)).toHaveClass("py-4", "pl-4", "pr-2");
    expect(markOf(container)).toHaveClass("p-2");
  });

  // 這一條鎖的兩件事 jsdom 都**量不到**幾何，它們是靠 harness（390×844、dsf 2）量出來的：
  //   ① 握把若不是 flex 容器，回饋層這個 inline-flex 原子盒會決定行盒高度 ⇒
  //      握把 40×48 → 40×56、圖示 (27,31) → (27,29)（v7 的幾何是前者）。
  //   ② 回饋層的右緣正好是名稱輸入框的左緣（x=51）：外環會多畫 2px 疊上去（實測到 x=53），
  //      inset 環止於 51。
  // 兩者都是「拿掉之後畫面只是稍微跑掉」的那一類，jsdom 不會紅、人眼也未必看得出來。
  it("握把是 flex 容器、回饋層用 inset 環（兩條都是量出來的形狀）", () => {
    const { container } = renderColumn(true);
    expect(gripOf(container)).toHaveClass("inline-flex", "items-center", "justify-center");
    expect(markOf(container)).toHaveClass("ring-inset");
  });
});
