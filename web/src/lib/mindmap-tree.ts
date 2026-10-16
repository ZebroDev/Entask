import type { MindMapNodeResponse } from "./board-types";

export interface NodeTreeItem {
  id: string;
  title: string;
  note: string | null;
  position: string;
  cardId: string | null;
  card: MindMapNodeResponse["card"];
  children: NodeTreeItem[];
}

// 扁平清單 → 巢狀樹：未知 parentId（資料防呆）歸為根；
// 同層依 Position 字串比較排序（base62 為 ASCII 子集，JS 碼元序 == ordinal，與後端 COLLATE "C" 一致）
export function buildTree(nodes: MindMapNodeResponse[]): NodeTreeItem[] {
  const byId = new Map<string, NodeTreeItem>();
  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id, title: n.title, note: n.note, position: n.position,
      cardId: n.cardId, card: n.card, children: [],
    });
  }
  const roots: NodeTreeItem[] = [];
  for (const n of nodes) {
    const item = byId.get(n.id)!;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) parent.children.push(item);
    else roots.push(item);
  }
  const sortRec = (items: NodeTreeItem[]) => {
    items.sort((a, b) => (a.position < b.position ? -1 : 1));
    items.forEach((i) => sortRec(i.children));
  };
  sortRec(roots);
  return roots;
}

// 沿 parentId 鏈上溯：nodeId 是否在 ancestorId 子樹中（含自身）；未知鏈防呆回 false
export function isDescendantOf(nodes: MindMapNodeResponse[], ancestorId: string, nodeId: string): boolean {
  const parentById = new Map(nodes.map((n) => [n.id, n.parentId]));
  let cursor: string | null = nodeId;
  const visited = new Set<string>();
  while (cursor !== null) {
    if (cursor === ancestorId) return true;
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
}
