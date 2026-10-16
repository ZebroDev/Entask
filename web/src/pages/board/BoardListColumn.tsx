import { memo, useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage, cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { after } from "@/lib/position";
import { appendPosition } from "@/lib/board-reorder";
import type { BoardCardResponse, BoardDetailResponse, ListResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BoardCard } from "./BoardCard";
import { useTranslation } from "react-i18next";

interface Props {
  list: ListResponse;
  showArchived: boolean;
  canEdit: boolean;
  canCreateCard: boolean;
  canDragList: boolean;
  canDragCards: boolean;
  onRename: (listId: string, name: string) => void;
  onCopy: (list: ListResponse) => void;
}

// #22：React.memo——父層重繪（拖曳 overlay、顯示封存切換）不再連帶重繪整列；
// 回呼 onRename 與 onCopy 由 BoardPage 以 useCallback 穩定化
export const BoardListColumn = memo(function BoardListColumn({ list, showArchived, canEdit, canCreateCard, canDragList, canDragCards, onRename, onCopy }: Props) {
  const { t } = useTranslation(["common", "board"]);
  const [newTitle, setNewTitle] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const queryClient = useQueryClient();
  // 封存列表：欄身不可作為 drop 目標（spec #41），列表本身仍可拖曳移動
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: list.id,
    disabled: { draggable: !canDragList, droppable: !canDragList || list.isArchived },
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: `list-${list.id}`, disabled: !canDragCards || list.isArchived });
  // 尾端 body drop 區（#21/R6）：id `{listId}-body`，drop 至最末卡之後 = append 至列表尾
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: `${list.id}-body`,
    disabled: !canDragCards || list.isArchived,
    data: { type: "list-body" },
  });

  // 改名輸入框（spec #7）：受控 local state，非焦點中才同步外部 list.name；
  // 焦點追蹤採 ref（fix round 1）：blur（含存檔後）即釋放，後續他端改名可正常同步
  const [editingName, setEditingName] = useState(list.name);
  const nameFocusedRef = useRef(false);
  // Escape 還原後立刻 blur——以 ref 標記跳過該次 blur 的存檔判定
  const cancelNameSave = useRef(false);
  useEffect(() => {
    if (nameFocusedRef.current) return;
    setEditingName(list.name);
  }, [list.name]);

  const newCardRef = useRef<HTMLInputElement>(null);
  // 同 tick 連按守護（Enter/按鈕）：isPending 於下一 render 才可見
  const creatingRef = useRef(false);

  // 建卡樂觀插入（spec #12）：onMutate 以「列表尾 append 位置」暫定值插入 board cache
  // （R4；appendPosition 採 board-reorder helper），onError 回滾、onSuccess 以 invalidate 校正＋焦點回輸入框
  const addCard = useMutation({
    mutationFn: async () =>
      (await api.post(`/lists/${list.id}/cards`, { title: newTitle })).data as BoardCardResponse,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["board"] });
      const entries = queryClient.getQueriesData<BoardDetailResponse>({ queryKey: ["board"] });
      // 多板 cache 情境下須取「含目標 list 的 entry」作位置基準（review Minor 2）
      const source = entries.find(([, data]) => data?.lists.some((l) => l.id === list.id))?.[1];
      const position = source ? appendPosition(source.lists, list.id) : after(null);
      const optimistic: BoardCardResponse = {
        id: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        listId: list.id,
        title: newTitle.trim(),
        position,
        isArchived: false,
        dueAt: null,
        coverAttachmentId: null,
        labels: [],
        members: [],
        checklistDone: 0,
        checklistTotal: 0,
        loggedHours: 0,
        remainingHours: null,
        // 新建的卡片必然沒有審查者
        reviewState: null,
      };
      entries.forEach(([key, data]) => {
        if (!data) return;
        queryClient.setQueryData<BoardDetailResponse>(key, {
          ...data,
          lists: data.lists.map((l) =>
            l.id === list.id ? { ...l, cards: [...l.cards, optimistic] } : l,
          ),
        });
      });
      return { prev: entries };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board"] });
      setNewTitle("");
      newCardRef.current?.focus();
    },
    onSettled: () => { creatingRef.current = false; },
    onError: (error, _vars, ctx) => {
      ctx?.prev?.forEach(([key, data]) => {
        if (data) queryClient.setQueryData(key, data);
      });
      toast.error(apiErrorMessage(error, t("common:error.create")));
    },
  });

  const createCard = () => {
    if (creatingRef.current || !newTitle.trim() || addCard.isPending) return;
    creatingRef.current = true;
    addCard.mutate();
  };

  const setArchived = useMutation({
    mutationFn: async () => api.put(`/lists/${list.id}`, { isArchived: !list.isArchived }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board"] });
      toast.success(list.isArchived ? t("board:list.restore.success") : t("board:list.archive.success"));
    },
    onError: (error) =>
      toast.error(apiErrorMessage(error, list.isArchived ? t("common:error.restore") : t("common:error.archive"))),
  });

  const deleteList = useMutation({
    mutationFn: async () => api.delete(`/lists/${list.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board"] });
      setDeleteOpen(false);
      toast.success(t("board:list.delete.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.delete"))),
  });

  const visibleCards = list.cards.filter((c) => !c.isArchived || showArchived);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl bg-muted/60 border p-2.5 shadow-2xs max-h-full",
        // 拖曳中：整欄抬起——與卡片 overlay 的 `shadow-xl ring-2 ring-primary/20` 同一套語彙。
        // 清單**沒有** DragOverlay（`BoardPage.tsx:506` 的 overlay 只給卡片），欄身自己跟著手指走，
        // 所以「抓到了」只能畫在欄身與握把上（2026-10-15 使用者：手機用戶不知道有沒有被選中）。
        isDragging && "shadow-xl ring-2 ring-primary/20",
        // 封存列表禁入視覺（spec #21）：顯示封存列表時欄身虛線邊框＋降透明
        list.isArchived && "border border-dashed opacity-60",
      )}
    >
      <div ref={setDropRef} className="mb-2 flex items-center gap-2">
        {canDragList && (
          // 握把：觸控上**立即**拖曳（`data-dnd-instant`，它帶 touch-action: none ⇒ 沒有捲動
          // 手勢可搶），滑鼠維持位移門檻——見 `@/lib/dnd-sensors`。
          // 命中區擴大：原本是**光禿的 16×16**（＝只有那個圖示，實測；2026-10-15 使用者回報
          // 「握把比較難點」）。現在 40×48：外距把 padding 吃掉 ⇒ 版面零位移（實測圖示與
          // 清單名稱的座標與舊版**逐點相同**），而**版面格仍是 16px**。
          // 左右刻意不對稱：右緣受限於旁邊的名稱輸入框（版面起點 +24px），
          // 超過就會蓋到輸入框的左緣而搶走它的點擊；左／上下沒有鄰居，可以吃滿。
          // `select-none`：長按不再出現選字——那也是 2026-10-15 的實機回報。
          <span
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            data-dnd-instant
            aria-label={t("board:list.drag.aria", { name: list.name })}
            // `inline-flex items-center justify-center` 別刪（2026-10-15 harness 實測）：
            // 回饋層是 inline-flex 的原子盒，握把維持預設的 inline 時行盒高度就由它決定 ⇒
            // 握把 48 → **56**、圖示 (27,31) → **(27,29)**（＝與 v7 量到的幾何不符）。
            // 改成 flex 容器後，子項的**外距盒**（16px）才是握把的內容高 ⇒ 逐點回到 40×48／(27,31)。
            className={cn(
              "inline-flex shrink-0 items-center justify-center -my-4 -ml-4 -mr-2 cursor-grab touch-none select-none py-4 pl-4 pr-2 text-muted-foreground",
              isDragging && "cursor-grabbing",
            )}
          >
            {/* 抓握回饋畫在**這一層**、不是外圈：外圈的命中區有 6px 落在欄身左緣之外
                （實測：命中區左緣 x=11、欄的左框 x=17）⇒ 在那裡填色會露到欄外像破圖。
                這一層是 32×32（`p-2 -m-2`：padding 8 ＋ 負外距 8 ⇒ 版面格仍是 16px、
                圖示座標不動），整個在欄身內（實測著色範圍 x 19→51）。
                文字色一併轉深，圖示才看得出來。
                `ring-inset` 不是裝飾（實測）：這一層的右緣正好落在名稱輸入框的左緣 x=51，
                外環會多畫 2px 疊到鄰居身上（實測著色到 x=53）；inset 讓環畫在框內，止於 51。
                `aria-pressed` 由 dnd-kit 的 `attributes` 給（拖曳中為 true），視覺與語意同步。

                ★ **調深淺／粗細就是改下面這一行**（三個旋鈕，其餘別動）：
                  `bg-primary/15` 填色深淺 → `/5`（幾乎看不出）～ `/30`（很重）
                  `ring-2` 環的粗細 → `ring-1`／`ring-4`；`ring-primary/40` 是環的深淺
                  欄身的抬起是上一層的 `shadow-xl ring-2 ring-primary/20`，要一起調就改那裡
                兩條規矩：① `ring-inset` 留著（拿掉會多畫 2px 疊到名稱輸入框）；
                ② 改了值要同步改 `BoardListColumn-drag.test.tsx` 的斷言——那幾條把值寫死了，
                它們是「有回饋／沒回饋」的判別力所在，**不要為了讓它綠而放寬成模糊條件**。 */}
            <span
              className={cn(
                "-m-2 inline-flex rounded-md p-2 transition-colors",
                isDragging && "bg-primary/15 text-foreground ring-2 ring-inset ring-primary/40",
              )}
            >
              <GripVertical className="h-4 w-4" />
            </span>
          </span>
        )}
        {canEdit ? (
          <Input
            value={editingName}
            className="h-8 flex-1 bg-transparent font-semibold"
            onChange={(e) => setEditingName(e.target.value)}
            onFocus={() => { nameFocusedRef.current = true; }}
            onBlur={(e) => {
              nameFocusedRef.current = false;
              if (cancelNameSave.current) {
                cancelNameSave.current = false;
                setEditingName(list.name);
                return;
              }
              // 不要把這個區域變數命名為 `t`：本檔的 `t` 是 useTranslation 的翻譯函式
              // （B2-3 起），同名會讓「在這個區塊裡抽字串」變成一個要看編譯器才發現的陷阱。
              const next = e.target.value.trim();
              if (next && next !== list.name) {
                onRename(list.id, next);
              } else {
                setEditingName(list.name);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // IME 組字中 Enter 為候選字確認，不觸發提交（fix round 1）
                if (e.nativeEvent.isComposing) return;
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                cancelNameSave.current = true;
                setEditingName(list.name);
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="font-semibold">{list.name}</span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-background/80 font-mono text-[11px] font-semibold text-muted-foreground shadow-2xs">
            {visibleCards.length}
          </span>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t("board:list.menu.aria")}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setArchived.mutate()}>
                  {list.isArchived ? t("board:list.restore.action") : t("board:list.archive.action")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCopy(list)}>
                  {t("board:list.copy.action")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteOpen(true)}>
                  {t("board:list.delete.action")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      <SortableContext items={visibleCards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
          {visibleCards.map((card) => <BoardCard key={card.id} card={card} disabled={!canDragCards} />)}
          {/* 尾端 drop 區（#21）：最末卡之後、flex-1 填滿剩餘空間，drop 至此 = append */}
          {canDragCards && <div ref={setBodyDropRef} data-type="list-body" className="min-h-4 flex-1" />}
        </div>
      </SortableContext>
      {canCreateCard && (
        <div className="mt-2">
          <Input
            ref={newCardRef}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t("board:card.create.placeholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // IME 組字中 Enter 為候選字確認，不觸發新增（fix round 1 慣例）
                if (e.nativeEvent.isComposing) return;
                createCard();
              } else if (e.key === "Escape") {
                setNewTitle("");
              }
            }}
          />
          {newTitle.trim() && (
            <Button className="mt-1" size="sm" disabled={addCard.isPending} onClick={createCard}>
              {t("common:action.add")}
            </Button>
          )}
        </div>
      )}
      {canEdit && (
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("board:list.delete.action")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("board:list.delete.confirm", { name: list.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteList.mutate()}>{t("common:action.delete")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
});
