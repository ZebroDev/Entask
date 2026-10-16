import { after, between } from "./position";
import type { ListResponse } from "./board-types";

const byPosition = (a: { position: string }, b: { position: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

// 卡片移動的樂觀更新：自所有列表移除卡片後插入目標列表並依 position 排序。
// 同列表重排（source === target）時卡片仍會保留（Fix 1 回歸）。
export function applyCardMove(
  lists: ListResponse[],
  sourceListId: string,
  targetListId: string,
  cardId: string,
  position: string,
): ListResponse[] {
  const card =
    lists.find((l) => l.id === sourceListId)?.cards.find((c) => c.id === cardId) ??
    lists.flatMap((l) => l.cards).find((c) => c.id === cardId);
  if (!card) return lists;
  const moved = { ...card, listId: targetListId, position };
  return lists.map((l) => {
    if (l.id === targetListId) {
      const rest = l.cards.filter((c) => c.id !== moved.id);
      return { ...l, cards: [...rest, moved].sort(byPosition) };
    }
    return { ...l, cards: l.cards.filter((c) => c.id !== moved.id) };
  });
}

export interface ListMoveResult {
  lists: ListResponse[];
  position: string;
}

// 建卡樂觀插入的暫定 position（R4）：列表尾卡片之後的 append 位置，
// 最終以 onSuccess 之 board invalidate 由伺服器序校正。
export function appendPosition(lists: ListResponse[], listId: string): string {
  const target = lists.find((l) => l.id === listId);
  const last = target?.cards.slice().sort(byPosition).at(-1);
  return after(last?.position ?? null);
}

// checklist 樂觀勾選後 patch 看板 cache：更新該卡 checklistDone/checklistTotal
// （BoardCard 徽章消費處）。僅重建含目標卡的列表身分、其餘列表維持原引用——
// 否則每次勾選全部 BoardListColumn 列表 prop 身分皆變、memo 失效（#22）。
export function applyChecklistProgress(
  lists: ListResponse[],
  cardId: string,
  checklistDone: number,
  checklistTotal: number,
): ListResponse[] {
  const target = lists.find((l) => l.cards.some((c) => c.id === cardId));
  if (!target) return lists;
  return lists.map((l) =>
    l === target
      ? { ...l, cards: l.cards.map((c) => (c.id === cardId ? { ...c, checklistDone, checklistTotal } : c)) }
      : l,
  );
}

// 列表移動的樂觀更新：依可見（未封存）列表排序計算新 position，
// 封存列表原樣保留；同列表或找不到目標時回傳 null（no-op）。
export function applyListMove(
  lists: ListResponse[],
  listId: string,
  overListId: string,
): ListMoveResult | null {
  if (listId === overListId) return null;
  const sortedVisible = lists.filter((l) => !l.isArchived).slice().sort(byPosition);
  const from = sortedVisible.findIndex((l) => l.id === listId);
  const to = sortedVisible.findIndex((l) => l.id === overListId);
  if (from < 0 || to < 0) return null;
  const reordered = sortedVisible.slice();
  const [item] = reordered.splice(from, 1);
  reordered.splice(to, 0, item);
  const prev = reordered[to - 1];
  const next = reordered[to + 1];
  const position =
    prev && next
      ? between(prev.position, next.position)
      : prev
        ? after(prev.position)
        : between(null, next?.position ?? null);
  const moved = lists.find((l) => l.id === listId);
  if (!moved) return null;
  return {
    lists: [...lists.filter((l) => l.id !== listId), { ...moved, position }].sort(byPosition),
    position,
  };
}
