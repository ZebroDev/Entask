import { describe, expect, it } from "vitest";
import { appendPosition, applyCardMove, applyChecklistProgress, applyListMove } from "./board-reorder";
import { after, between } from "./position";
import type { BoardCardResponse, ListResponse } from "./board-types";

function card(id: string, position: string): BoardCardResponse {
  return {
    id, listId: "", title: id, position, isArchived: false, dueAt: null, coverAttachmentId: null,
    labels: [], members: [], checklistDone: 0, checklistTotal: 0, loggedHours: 0, remainingHours: null,
    reviewState: null,
  };
}

function list(id: string, position: string, cards: BoardCardResponse[], isArchived = false): ListResponse {
  return { id, name: id, position, isArchived, cards };
}

describe("applyCardMove", () => {
  it("同列表重排保留卡片且依 position 排序（Fix 1 回歸）", () => {
    const a = card("a", "a");
    const b = card("b", "c");
    const c = card("c", "e");
    const lists = [list("l1", "h", [a, b, c])];
    const position = between(b.position, c.position);
    const result = applyCardMove(lists, "l1", "l1", "a", position);
    expect(result[0].cards.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(result[0].cards[1].position).toBe(position);
    expect(result[0].cards[1].listId).toBe("l1");
  });

  it("跨列表移動：自來源移除並插入目標列表", () => {
    const a = card("a", "a");
    const b = card("b", "c");
    const lists = [list("l1", "h", [a, b]), list("l2", "i", [])];
    const result = applyCardMove(lists, "l1", "l2", "a", after(null));
    const source = result.find((l) => l.id === "l1")!;
    const target = result.find((l) => l.id === "l2")!;
    expect(source.cards.map((c) => c.id)).toEqual(["b"]);
    expect(target.cards.map((c) => c.id)).toEqual(["a"]);
    expect(target.cards[0].listId).toBe("l2");
  });

  it("空目標列表以 after() 附加至末尾", () => {
    const a = card("a", "a");
    const lists = [list("l1", "h", [a]), list("l2", "i", [])];
    const position = after(null);
    const result = applyCardMove(lists, "l1", "l2", "a", position);
    const target = result.find((l) => l.id === "l2")!;
    expect(target.cards.map((c) => c.id)).toEqual(["a"]);
    expect(target.cards[0].position).toBe(position);
  });

  it("找不到卡片時回傳原陣列（不改動）", () => {
    const a = card("a", "a");
    const lists = [list("l1", "h", [a])];
    expect(applyCardMove(lists, "l1", "l2", "missing", "z")).toBe(lists);
  });
});

describe("applyListMove", () => {
  it("移動列表並保留封存列表", () => {
    const l1 = list("l1", "a", []);
    const l2 = list("l2", "b", []);
    const archived = list("l3", "c", [], true);
    const result = applyListMove([l1, l2, archived], "l1", "l2");
    expect(result).not.toBeNull();
    expect(result!.lists.map((l) => l.id).sort()).toEqual(["l1", "l2", "l3"]);
    const moved = result!.lists.find((l) => l.id === "l1")!;
    expect(moved.position).toBe(result!.position);
    expect(moved.position > "b").toBe(true);
    expect(result!.lists.find((l) => l.id === "l3")!.position).toBe("c");
  });

  it("同列表 no-op 回傳 null", () => {
    const l1 = list("l1", "a", []);
    expect(applyListMove([l1], "l1", "l1")).toBeNull();
  });

  it("applyListMove returns null when over target is a card id", () => {
    const l1 = list("l1", "a", [card("c1", "h")]);
    expect(applyListMove([l1], "l1", "c1")).toBeNull();
  });

  it("目標不存在時回傳 null", () => {
    const l1 = list("l1", "a", []);
    expect(applyListMove([l1], "l1", "missing")).toBeNull();
  });

  it("移到最前時 position 小於原第一位", () => {
    const l1 = list("l1", "b", []);
    const l2 = list("l2", "d", []);
    const result = applyListMove([l1, l2], "l2", "l1");
    expect(result).not.toBeNull();
    expect(result!.position < "b").toBe(true);
  });
});

describe("appendPosition", () => {
  it("以列表尾卡片位置計算 after() 暫定位置", () => {
    const a = card("a", "a");
    const b = card("b", "c");
    expect(appendPosition([list("l1", "h", [a, b])], "l1")).toBe(after("c"));
  });

  it("空列表以 after(null) 起始位置", () => {
    expect(appendPosition([list("l1", "h", [])], "l1")).toBe(after(null));
  });

  it("列表不存在時回傳 after(null)", () => {
    expect(appendPosition([list("l1", "h", [])], "missing")).toBe(after(null));
  });
});

describe("applyChecklistProgress", () => {
  it("patch 目標卡 checklistDone/checklistTotal，其餘卡與列表不變", () => {
    const a = card("a", "a");
    const b = card("b", "c");
    const result = applyChecklistProgress([list("l1", "h", [a, b])], "b", 2, 3);
    expect(result[0].cards[0].checklistDone).toBe(0);
    expect(result[0].cards[0].checklistTotal).toBe(0);
    expect(result[0].cards[1].checklistDone).toBe(2);
    expect(result[0].cards[1].checklistTotal).toBe(3);
  });

  it("僅重建含目標卡的列表身分，其餘列表維持原引用（I-2）", () => {
    const a = card("a", "a");
    const b = card("b", "c");
    const l1 = list("l1", "h", [a]);
    const l2 = list("l2", "i", [b]);
    const result = applyChecklistProgress([l1, l2], "b", 2, 3);
    // 非目標列表維持原物件引用——BoardListColumn memo 不被無效化（#22）
    expect(result[0]).toBe(l1);
    // 目標列表與目標卡為新身分
    expect(result[1]).not.toBe(l2);
    expect(result[1].cards[0]).not.toBe(b);
    expect(result[1].cards[0].checklistDone).toBe(2);
    expect(result[1].cards[0].checklistTotal).toBe(3);
    // 原陣列不被 mutate
    expect(l2.cards[0].checklistDone).toBe(0);
  });
});
