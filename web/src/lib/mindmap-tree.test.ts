import { describe, expect, it } from "vitest";
import { buildTree, isDescendantOf } from "./mindmap-tree";
import type { MindMapNodeResponse } from "./board-types";

const node = (id: string, parentId: string | null, position: string): MindMapNodeResponse => ({
  id, parentId, title: `節點${id}`, note: null, position, cardId: null, card: null,
});

describe("buildTree", () => {
  it("由扁平清單組出巢狀樹", () => {
    const tree = buildTree([node("n1", null, "h"), node("n2", "n1", "h"), node("n3", null, "n")]);
    expect(tree.map((r) => r.id)).toEqual(["n1", "n3"]);
    expect(tree[0]!.children.map((c) => c.id)).toEqual(["n2"]);
    expect(tree[0]!.children[0]!.title).toBe("節點n2");
  });

  it("同層依 Position ordinal 排序（ASCII：大寫先於小寫）", () => {
    const tree = buildTree([node("a", null, "j"), node("b", null, "U")]);
    expect(tree.map((r) => r.id)).toEqual(["b", "a"]);   // "U"(85) < "j"(106)
  });

  it("未知 parentId 歸為根（資料防呆）", () => {
    const tree = buildTree([node("n1", null, "h"), node("n2", "missing", "h")]);
    expect(tree.map((r) => r.id)).toEqual(["n1", "n2"]);
  });

  it("空清單回空樹", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("保留節點欄位與綁定卡摘要", () => {
    const bound: MindMapNodeResponse = {
      id: "n1", parentId: null, title: "綁", note: "註", position: "h", cardId: "c1",
      card: { id: "c1", title: "卡A", isArchived: false, completedAt: null, reviewState: null },
    };
    const tree = buildTree([bound]);
    expect(tree[0]).toMatchObject({ id: "n1", note: "註", cardId: "c1" });
    expect(tree[0]!.card?.title).toBe("卡A");
  });
});

describe("isDescendantOf", () => {
  const nodes = [node("a", null, "h"), node("b", "a", "h"), node("c", "b", "h"), node("d", null, "n")];

  it("自身/直接子孫/間接子孫為真", () => {
    expect(isDescendantOf(nodes, "a", "a")).toBe(true);
    expect(isDescendantOf(nodes, "a", "b")).toBe(true);
    expect(isDescendantOf(nodes, "a", "c")).toBe(true);
  });

  it("非子孫為假", () => {
    expect(isDescendantOf(nodes, "a", "d")).toBe(false);
    expect(isDescendantOf(nodes, "b", "a")).toBe(false);
  });

  it("未知節點為假（防呆）", () => {
    expect(isDescendantOf(nodes, "a", "missing")).toBe(false);
  });
});
