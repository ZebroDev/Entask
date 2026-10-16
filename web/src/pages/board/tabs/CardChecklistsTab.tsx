import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { applyChecklistProgress } from "@/lib/board-reorder";
import { between } from "@/lib/position";
import type { BoardDetailResponse, CardResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "react-i18next";

interface Props { card: CardResponse; boardId: string; canEdit: boolean; onRefresh: () => void; }

export function CardChecklistsTab({ card, boardId, canEdit, onRefresh }: Props) {
  const { t } = useTranslation(["common", "card"]);
  const [newTitle, setNewTitle] = useState("");
  const queryClient = useQueryClient();

  const addChecklist = useMutation({
    mutationFn: async () => api.post(`/cards/${card.id}/checklists`, { title: newTitle }),
    onSuccess: () => { onRefresh(); setNewTitle(""); },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.create"))),
  });

  const addItem = useMutation({
    mutationFn: async ({ checklistId, text }: { checklistId: string; text: string }) =>
      api.post(`/cards/${card.id}/checklists/${checklistId}/items`, { text }),
    onSuccess: onRefresh,
    onError: (error) => toast.error(apiErrorMessage(error, t("card:checklist.addItem.error"))),
  });

  // 樂觀勾選（spec #11）：onMutate 就地切換 card cache 的 item isChecked（checkbox 立即翻動）、
  // onError 回滾＋toast；成功後 patch 看板 cache 該卡 checklistDone/checklistTotal（BoardCard 徽章），
  // 並保留 board invalidate 為背景同步
  const toggleItem = useMutation({
    mutationFn: async ({ checklistId, itemId, isChecked }: { checklistId: string; itemId: string; isChecked: boolean }) =>
      api.put(`/cards/${card.id}/checklists/${checklistId}/items/${itemId}`, { isChecked }),
    onMutate: async ({ checklistId, itemId, isChecked }) => {
      await queryClient.cancelQueries({ queryKey: ["card", card.id] });
      const previous = queryClient.getQueryData<CardResponse>(["card", card.id]);
      queryClient.setQueryData<CardResponse>(["card", card.id], (old) =>
        old
          ? {
              ...old,
              checklists: old.checklists.map((cl) =>
                cl.id === checklistId
                  ? { ...cl, items: cl.items.map((it) => (it.id === itemId ? { ...it, isChecked } : it)) }
                  : cl,
              ),
            }
          : old,
      );
      return { previous };
    },
    onSuccess: () => {
      const current = queryClient.getQueryData<CardResponse>(["card", card.id]);
      if (current) {
        const done = current.checklists.reduce((sum, cl) => sum + cl.items.filter((i) => i.isChecked).length, 0);
        const total = current.checklists.reduce((sum, cl) => sum + cl.items.length, 0);
        queryClient.setQueryData<BoardDetailResponse>(["board", boardId], (b) =>
          b ? { ...b, lists: applyChecklistProgress(b.lists, card.id, done, total) } : b,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["board", boardId] });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["card", card.id], context.previous);
      toast.error(apiErrorMessage(error, t("card:checklist.toggleItem.error")));
    },
  });

  const removeChecklist = useMutation({
    mutationFn: async (checklistId: string) =>
      api.delete(`/cards/${card.id}/checklists/${checklistId}`),
    onSuccess: onRefresh,
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.delete"))),
  });

  const removeItem = useMutation({
    mutationFn: async ({ checklistId, itemId }: { checklistId: string; itemId: string }) =>
      api.delete(`/cards/${card.id}/checklists/${checklistId}/items/${itemId}`),
    onSuccess: onRefresh,
    onError: (error) => toast.error(apiErrorMessage(error, t("card:checklist.deleteItem.error"))),
  });

  const renameItem = useMutation({
    mutationFn: async ({ checklistId, itemId, text }: { checklistId: string; itemId: string; text: string }) =>
      api.put(`/cards/${card.id}/checklists/${checklistId}/items/${itemId}`, { text }),
    onSuccess: onRefresh,
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.rename"))),
  });

  // 重排一律呼叫 PUT position（與後端 base62 PositionValidator 相容）；
  // 新位置的計算見下方上／下移按鈕
  const moveItem = useMutation({
    mutationFn: async ({ checklistId, itemId, position }: { checklistId: string; itemId: string; position: string }) =>
      api.put(`/cards/${card.id}/checklists/${checklistId}/items/${itemId}`, { position }),
    onSuccess: onRefresh,
    onError: (error) => toast.error(apiErrorMessage(error, t("card:checklist.moveItem.error"))),
  });

  const [removeTarget, setRemoveTarget] = useState<{ kind: "checklist" | "item"; checklistId?: string; id: string; title: string } | null>(null);
  const [editingItem, setEditingItem] = useState<{ checklistId: string; itemId: string; original: string; text: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Escape 取消後輸入框卸載，仍可能補送一次 blur——以旗標擋掉該次過期儲存
  const renameCancelledRef = useRef(false);

  const startRename = (checklistId: string, itemId: string, original: string) => {
    renameCancelledRef.current = false;
    setEditingItem({ checklistId, itemId, original, text: original });
  };

  const cancelRename = () => {
    renameCancelledRef.current = true;
    setEditingItem(null);
  };

  const commitRename = () => {
    if (!editingItem || renameCancelledRef.current) return;
    const { checklistId, itemId, original, text } = editingItem;
    setEditingItem(null);
    const trimmed = text.trim();
    if (!trimmed || trimmed === original) return;
    renameItem.mutate({ checklistId, itemId, text: trimmed });
  };

  // CardDialog 的 Radix Dialog 以 document 的「capture」階段攔 Escape 並關閉整張卡片，
  // 因此必須掛在更外層的 window capture（window → document → … → target）才能先攔下
  useEffect(() => {
    if (!editingItem) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return; // 組字中的 Enter/Escape 屬輸入法，不攔
      if (e.key !== "Enter" && e.key !== "Escape") return;
      if (e.target !== renameInputRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter") commitRename();
      else cancelRename();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  });

  return (
    <div className="space-y-4">
      {card.checklists.map((cl) => {
        const done = cl.items.filter((i) => i.isChecked).length;
        return (
          <div key={cl.id} className="rounded border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold">{cl.title}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{done}/{cl.items.length}</span>
                {canEdit && (
                  <Button variant="ghost" size="sm" onClick={() => setRemoveTarget({ kind: "checklist", id: cl.id, title: cl.title })}>{t("common:action.delete")}</Button>
                )}
              </div>
            </div>
            <div
              className="h-1 w-full rounded bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={cl.items.length ? Math.round((done / cl.items.length) * 100) : 0}
            >
              <div className="h-1 rounded bg-primary" style={{ width: cl.items.length ? `${(done / cl.items.length) * 100}%` : "0%" }} />
            </div>
            <ul className="mt-2 space-y-1">
              {[...cl.items]
                .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
                .map((item, idx, sorted) => {
                  const isEditing = editingItem?.itemId === item.id;
                  return (
                    <li key={item.id} className="group flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={item.isChecked}
                        disabled={!canEdit}
                        onChange={(e) => toggleItem.mutate({ checklistId: cl.id, itemId: item.id, isChecked: e.target.checked })}
                      />
                      {isEditing ? (
                        <Input
                          ref={renameInputRef}
                          autoFocus
                          className="h-7 flex-1"
                          value={editingItem.text}
                          onChange={(e) => setEditingItem({ ...editingItem, text: e.target.value })}
                          onBlur={commitRename}
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => startRename(cl.id, item.id, item.text)}
                          className={`flex-1 truncate text-left disabled:cursor-default ${item.isChecked ? "text-muted-foreground line-through" : ""}`}
                        >
                          {item.text}
                        </button>
                      )}
                      {canEdit && (
                        <span className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            type="button"
                            aria-label={t("card:checklist.moveUp.aria", { title: item.text })}
                            disabled={idx === 0}
                            onClick={() =>
                              // 必須排到前項「之前」：between(再前一項, 前一項)，否則新位置仍夾在原位與前項之間
                              moveItem.mutate({
                                checklistId: cl.id,
                                itemId: item.id,
                                position: between(sorted[idx - 2]?.position ?? null, sorted[idx - 1]!.position),
                              })
                            }
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={t("card:checklist.moveDown.aria", { title: item.text })}
                            disabled={idx === sorted.length - 1}
                            onClick={() =>
                              // 對稱地排到後項「之後」：between(後一項, 再後一項)
                              moveItem.mutate({
                                checklistId: cl.id,
                                itemId: item.id,
                                position: between(sorted[idx + 1]!.position, sorted[idx + 2]?.position ?? null),
                              })
                            }
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={t("card:checklist.deleteItem.aria", { title: item.text })}
                            onClick={() => setRemoveTarget({ kind: "item", checklistId: cl.id, id: item.id, title: item.text })}
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
            {canEdit && (
              <NewItemInput onAdd={(text) => addItem.mutate({ checklistId: cl.id, text })} />
            )}
          </div>
        );
      })}
      {canEdit && (
        <div className="flex gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t("card:checklist.name.placeholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newTitle.trim() && !addChecklist.isPending) {
                e.preventDefault();
                addChecklist.mutate();
              }
            }}
          />
          <Button disabled={!newTitle.trim() || addChecklist.isPending} onClick={() => addChecklist.mutate()}>
            {t("common:action.add")}
          </Button>
        </div>
      )}
      {/* 刪除 checklist/item 確認（spec #20）：明示後果，確認才呼叫 API */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{removeTarget?.kind === "item" ? t("card:checklist.deleteItem.title") : t("card:checklist.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.kind === "item"
                ? t("card:checklist.deleteItem.confirm", { title: removeTarget.title })
                : t("card:checklist.delete.confirm", { title: removeTarget?.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (!removeTarget) return;
              if (removeTarget.kind === "item" && removeTarget.checklistId)
                removeItem.mutate({ checklistId: removeTarget.checklistId, itemId: removeTarget.id });
              else
                removeChecklist.mutate(removeTarget.id);
            }}>
              {t("common:action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NewItemInput({ onAdd }: { onAdd: (text: string) => void }) {
  const { t } = useTranslation(["card"]);
  const [text, setText] = useState("");
  const handleAdd = () => {
    if (text.trim()) {
      onAdd(text.trim());
      setText("");
    }
  };
  return (
    <div className="mt-1 flex gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("card:checklist.item.placeholder")}
        onKeyDown={(e) => {
          // 中文輸入法組字中的 Enter 為確認候選字，不觸發新增
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleAdd();
          }
        }}
      />
      <Button size="sm" disabled={!text.trim()} onClick={handleAdd}>{t("card:checklist.addItem.action")}</Button>
    </div>
  );
}
