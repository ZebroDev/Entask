import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { isAxiosError } from "axios";
import {
  DndContext, DragOverlay, closestCorners,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { prefetchCardDialog } from "@/lib/lazy-route";
import { apiErrorMessage } from "@/lib/utils";
import { invalidateProjectViews } from "@/lib/invalidate-views";
import { currentLocale } from "@/lib/format";
import { after, between } from "@/lib/position";
import { appendPosition, applyCardMove, applyListMove } from "@/lib/board-reorder";
import type { BoardCardResponse, BoardDetailResponse, BoardSummaryResponse, ListResponse } from "@/lib/board-types";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import { useDndSensors } from "@/lib/dnd-sensors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LazyBoundary } from "@/components/LazyBoundary";
import { BoardListColumn } from "./BoardListColumn";
import { BoardCardOverlay } from "./BoardCard";
import { useCollaboration } from "@/lib/collaboration";
import { useAuth } from "@/stores/auth";
import { QuickFilter, type FilterType } from "@/components/QuickFilter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pencil, Settings, Trash2 } from "lucide-react";
import { EditBoardDialog } from "./EditBoardDialog";
import { DeleteBoardDialog } from "./DeleteBoardDialog";
import { CopyBoardDialog, type CopyBoardTarget } from "./CopyBoardDialog";
import { CopyListDialog, type CopyListTarget } from "./CopyListDialog";
import { useTranslation } from "react-i18next";

// 空白列表區域的 droppable id 帶 `list-` 前綴，查找列表前先剝除
const stripListPrefix = (id: string) => (id.startsWith("list-") ? id.slice(5) : id);

// 列表 body droppable（最末卡之後的 drop 區）id 為 `{listId}-body`（R6），剝除後綴得列表 id
const stripBodySuffix = (id: string) => (id.endsWith("-body") ? id.slice(0, -5) : id);

// 新列表輸入框（#22）：state 內聚於獨立元件，打字僅重繪自身，不連帶重繪看板列與卡片
function NewListInput({ boardId, onCreated }: { boardId: string; onCreated: (list: ListResponse) => void }) {
  const { t } = useTranslation(["common", "board"]);
  const [name, setName] = useState("");
  const addList = useMutation({
    mutationFn: async () =>
      (await api.post(`/boards/${boardId}/lists`, { name })).data as ListResponse,
    onSuccess: (created) => {
      onCreated(created);
      setName("");
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.create"))),
  });

  return (
    <div className="w-72 shrink-0">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("board:list.name.placeholder")}
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !addList.isPending) addList.mutate(); }}
      />
      <Button className="mt-2" disabled={!name.trim() || addList.isPending} onClick={() => addList.mutate()}>
        {t("board:list.create.action")}
      </Button>
    </div>
  );
}

export function BoardPage() {
  const { t } = useTranslation(["common", "board"]);
  const { projectId, boardId } = useParams<{ projectId: string; boardId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const permissions = useProjectPermissions(projectId);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");
  const [activeCard, setActiveCard] = useState<BoardCardResponse | null>(null);
  const [editingOpen, setEditingOpen] = useState(false);
  const [deletingOpen, setDeletingOpen] = useState(false);
  const [copyingOpen, setCopyingOpen] = useState(false);
  // 清單複製的目標清單：一次只有一個對話框（單一實例掛在頁尾），不是每一列各自持有
  const [copyListTarget, setCopyListTarget] = useState<ListResponse | null>(null);
  const { presenceUsers } = useCollaboration({ boardId, projectId });

  // 卡片對話框是巢狀路由（`cards/:cardId`），有自己的 chunk。看板掛載後在閒置時預取它，
  // 於是下面那個 `fallback={null}` 不會讓「點卡片」出現空窗——使用者點的時候它通常已經到了。
  useEffect(() => {
    prefetchCardDialog();
  }, []);

  // Support ?cardId= from notification links — redirect to /cards/:cardId child route
  useEffect(() => {
    const cardId = searchParams.get("cardId");
    if (cardId && projectId && boardId) {
      navigate(`/projects/${projectId}/boards/${boardId}/cards/${cardId}`, { replace: true });
    }
  }, [searchParams, projectId, boardId, navigate]);

  // 觸控長按才拖曳、滑動即捲動（理由與實測見 `@/lib/dnd-sensors`）
  const sensors = useDndSensors();

  const board = useQuery({
    queryKey: ["board", boardId],
    queryFn: async () => (await api.get(`/boards/${boardId}`)).data as BoardDetailResponse,
  });

  const can = (code: string) => (permissions.data ?? []).includes(code);

  const update = (updater: (old: BoardDetailResponse) => BoardDetailResponse) => {
    queryClient.setQueryData(["board", boardId], updater);
  };

  const moveCard = useMutation({
    mutationFn: async (card: BoardCardResponse) =>
      api.put(`/cards/${card.id}/position`, { listId: card.listId, position: card.position }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", boardId] }),
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["board", boardId] });
      toast.error(apiErrorMessage(error, t("common:error.move")));
    },
  });

  const renameList = useMutation({
    mutationFn: async (list: { id: string; name: string }) =>
      api.put(`/lists/${list.id}`, { name: list.name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.rename"))),
  });

  const moveList = useMutation({
    mutationFn: async (list: { id: string; position: string }) =>
      api.put(`/lists/${list.id}`, { position: list.position }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", boardId] }),
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["board", boardId] });
      toast.error(apiErrorMessage(error, t("common:error.move")));
    },
  });

  const copyBoard = useMutation({
    // `?locale=` 決定複製出來的名稱後綴（後端寫入時就決定了，之後改語系不會跟著變）；
    // body 一律帶上使用者選的目標專案與名稱——不帶目標的話後端退回**來源專案**，
    // 而畫面照樣 toast 成功（那正是 2026-09-22 之前送 `{}` 時的行為）。
    mutationFn: async (target: CopyBoardTarget) =>
      (await api.post(`/boards/${boardId}/copy?locale=${encodeURIComponent(currentLocale())}`, {
        targetProjectId: target.projectId,
        name: target.name,
      })).data as BoardSummaryResponse,
    onSuccess: (_created, target) => {
      // 副本在**目標**專案：失效目標的檢視（含其看板清單）。來源端不動——複製沒有改到
      // 來源的任何一列。少了這裡，跨專案複製出來的看板與卡片在目標專案完全不會現形。
      invalidateProjectViews(queryClient, { projectId: target.projectId });
      queryClient.invalidateQueries({ queryKey: ["boards", target.projectId] });
      toast.success(t("board:copy.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.copy"))),
  });

  const copyList = useMutation({
    // body 只帶 `targetBoardId`——清單複製沒有名稱參數，名稱一律由後端的樣板產生。
    mutationFn: async ({ list, target }: { list: ListResponse; target: CopyListTarget }) =>
      (await api.post(`/lists/${list.id}/copy?locale=${encodeURIComponent(currentLocale())}`, {
        targetBoardId: target.boardId,
      })).data as ListResponse,
    onSuccess: (_created, { target }) => {
      // 同上：失效**目標**看板與其專案，來源端不動。目標看板另加自己那一格
      // （清單的副本會出現在那裡，而 `["board", id]` 只有帶著 id 才會命中）。
      invalidateProjectViews(queryClient, { projectId: target.projectId, boardId: target.boardId });
      setCopyListTarget(null);
      toast.success(t("board:list.copy.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.copy"))),
  });

  // #22：傳入 memo 子元件之回呼以 useCallback 穩定化（tanstack v5 的 mutate 為穩定參照，
  // 解構後直接入 deps——lint 與 memo 語意兼顧）
  const { mutate: renameListMutate } = renameList;
  const handleRename = useCallback(
    (listId: string, name: string) => renameListMutate({ id: listId, name }),
    [renameListMutate],
  );
  // 清單複製的入口回呼：同樣要穩定化（`BoardListColumn` 是 memo 元件）。
  // 它只開啟對話框——真正送出的是頁尾那一顆 `copyList`，由對話框的確認鈕觸發。
  const handleCopyList = useCallback((list: ListResponse) => setCopyListTarget(list), []);
  const handleListCreated = useCallback(
    (created: ListResponse) => {
      queryClient.setQueryData<BoardDetailResponse>(["board", boardId], (old) =>
        old ? { ...old, lists: [...old.lists, created] } : old);
    },
    [queryClient, boardId],
  );

  const visibleLists = useMemo(
    () => (board.data?.lists ?? []).filter((l) => !l.isArchived || showArchived),
    [board.data, showArchived],
  );

  const isCardMatchingFilter = useCallback(
    (card: BoardCardResponse) => {
      if (filter === "all") return true;
      if (filter === "my") {
        return user ? card.members.includes(user.userId) : true;
      }
      if (filter === "dueToday") {
        if (!card.dueAt || card.completedAt) return false;
        const today = new Date();
        const dueDate = new Date(card.dueAt);
        return (
          dueDate.getFullYear() === today.getFullYear() &&
          dueDate.getMonth() === today.getMonth() &&
          dueDate.getDate() === today.getDate()
        );
      }
      if (filter === "overdue") {
        if (!card.dueAt || card.completedAt) return false;
        return new Date(card.dueAt) < new Date();
      }
      return true;
    },
    [filter, user],
  );

  const filterCounts = useMemo(() => {
    if (!board.data?.lists) return undefined;
    let all = 0;
    let my = 0;
    let dueToday = 0;
    let overdue = 0;
    const now = new Date();

    for (const list of board.data.lists) {
      if (list.isArchived && !showArchived) continue;
      for (const card of list.cards) {
        if (card.isArchived && !showArchived) continue;
        all++;
        if (user && card.members.includes(user.userId)) {
          my++;
        }
        if (card.dueAt && !card.completedAt) {
          const dueDate = new Date(card.dueAt);
          if (
            dueDate.getFullYear() === now.getFullYear() &&
            dueDate.getMonth() === now.getMonth() &&
            dueDate.getDate() === now.getDate()
          ) {
            dueToday++;
          }
          if (dueDate < now) overdue++;
        }
      }
    }
    return { all, my, dueToday, overdue };
  }, [board.data, showArchived, user]);

  const displayedLists = useMemo(() => {
    return visibleLists.map((list) => {
      if (filter === "all") return list;
      return {
        ...list,
        cards: list.cards.filter(isCardMatchingFilter),
      };
    });
  }, [visibleLists, filter, isCardMatchingFilter]);

  if (board.isLoading)
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col">
        <div className="flex items-center justify-between border-b p-3">
          <Skeleton className="h-6 w-48" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        <div className="flex flex-1 gap-3 overflow-x-auto p-4" data-testid="board-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-muted p-2">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  if (board.isError) {
    const detail = apiErrorMessage(board.error, t("common:error.tryLater"));
    return (
      <>
        <div className="p-6 text-destructive">
          {isAxiosError(board.error) && board.error.response?.status === 403
            ? t("board:permission.denied")
            : t("common:error.loadDetail", { detail })}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => board.refetch()}>
            {t("common:action.retry")}
          </Button>
        </div>
        {/* 深連結（#18）：error 狀態亦渲染 Outlet，CardDialog 可掛載顯示自身錯誤 */}
        <LazyBoundary fallback={null}>
          <Outlet />
        </LazyBoundary>
      </>
    );
  }

  const findCard = (cardId: string): { card: BoardCardResponse; list: ListResponse } | null => {
    for (const list of board.data!.lists) {
      const card = list.cards.find((c) => c.id === cardId);
      if (card) return { card, list };
    }
    return null;
  };

  const moveTo = (source: { card: BoardCardResponse; list: ListResponse }, targetList: ListResponse, position: string) => {
    const moved = { ...source.card, listId: targetList.id, position };
    update((old) => ({ ...old, lists: applyCardMove(old.lists, source.list.id, targetList.id, moved.id, position) }));
    moveCard.mutate(moved);
  };

  const onDragEndList = (listId: string, overListId: string) => {
    const result = applyListMove(board.data!.lists, listId, overListId);
    if (!result) return;
    update((old) => ({ ...old, lists: result.lists }));
    moveList.mutate({ id: listId, position: result.position });
  };

  const onDragStart = (event: DragStartEvent) => {
    const found = findCard(String(event.active.id));
    setActiveCard(found?.card ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveCard(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const source = findCard(String(active.id));
    if (!source) {
      // 列表拖曳（active.id 為列表 id）；body 後綴亦剝除以利碰撞解析（R6）
      if (board.data!.lists.some((l) => l.id === String(active.id))) {
        onDragEndList(String(active.id), stripListPrefix(stripBodySuffix(String(over.id))));
      }
      return;
    }

    const overId = String(over.id);
    const isBody = overId.endsWith("-body");
    const overCard = isBody ? null : findCard(overId);
    const targetList = overCard
      ? overCard.list
      : board.data!.lists.find((l) => l.id === (isBody ? stripBodySuffix(overId) : stripListPrefix(overId)));

    // 封存列表不可作為卡片 drop 目標（spec #41）；拖出封存列表不受限（#21：補提示）
    if (targetList?.isArchived) {
      toast.error(t("board:list.archived.dropBlocked"));
      return;
    }

    if (isBody && targetList) {
      // M-3：同列表且已為末位卡 → drop 無位移，不送冗餘 PUT（同空白區分支之同列表 guard）
      const lastCard = targetList.cards.slice().sort((a, b) => (a.position < b.position ? -1 : 1)).at(-1);
      if (targetList.id === source.list.id && lastCard?.id === source.card.id) return;
      // drop 至列表 body（最末卡下方）→ 尾端 append（#21；Position 採 board-reorder helper 末位）
      moveTo(source, targetList, appendPosition(board.data!.lists, targetList.id));
      return;
    }

    if (overCard) {
      // 卡片插入目標列表 overCard 之前
      const siblings = targetList!.cards.filter((c) => !c.isArchived || showArchived);
      const overIndex = siblings.findIndex((c) => c.id === overCard.card.id);
      const prev = siblings[overIndex - 1];
      const position = prev ? between(prev.position, overCard.card.position) : between(null, overCard.card.position);
      moveTo(source, targetList!, position);
    } else if (targetList && targetList.id !== source.list.id) {
      // 拖到空白列表區域 → 列表末尾
      const last = targetList.cards.slice().sort((a, b) => (a.position < b.position ? -1 : 1)).at(-1);
      moveTo(source, targetList, after(last?.position ?? null));
    }
  };

  return (
    <>
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between border-b p-3 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>{t("board:backToProject.action")}</Button>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <h1 className="text-xl font-bold">{board.data!.name}</h1>
              {can("board.edit") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                  title={t("board:edit.aria")}
                  onClick={() => setEditingOpen(true)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="sr-only">{t("board:edit.aria")}</span>
                </Button>
              )}
            </div>
            {board.data!.description && (
              <p
                className="text-xs text-muted-foreground truncate max-w-xs sm:max-w-md"
                title={board.data!.description}
              >
                {board.data!.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 ml-2 bg-muted/60 px-2.5 py-1 rounded-full text-xs text-muted-foreground border">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span>{presenceUsers.length > 0 ? t("board:presence.online", { count: presenceUsers.length }) : t("board:presence.live")}</span>
            {presenceUsers.length > 0 && (
              <div className="flex -space-x-1.5 ml-1 overflow-hidden">
                {presenceUsers.map((u) => (
                  <div
                    key={u.userId}
                    title={u.displayName}
                    className="inline-flex h-5 w-5 rounded-full ring-1 ring-background bg-primary/20 text-primary items-center justify-center text-[10px] font-medium"
                  >
                    {u.displayName.slice(0, 1).toUpperCase()}
                  </div>
                ))}
              </div>
            )}
          </div>
          <QuickFilter value={filter} onChange={setFilter} counts={filterCounts} className="ml-2" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can("board.create") && (
            <Button variant="outline" size="sm" disabled={copyBoard.isPending} onClick={() => setCopyingOpen(true)}>
              {t("board:copy.action")}
            </Button>
          )}
          {(can("board.edit") || can("board.delete")) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings className="mr-1.5 h-3.5 w-3.5" />
                  {t("board:settings.action")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {can("board.edit") && (
                  <DropdownMenuItem onClick={() => setEditingOpen(true)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t("board:edit.title")}
                  </DropdownMenuItem>
                )}
                {can("board.delete") && (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setDeletingOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("board:delete.action")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? t("board:archive.hide") : t("board:archive.show")}
          </Button>
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <SortableContext items={visibleLists.map((l) => l.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {displayedLists.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                {can("board.edit") ? t("board:list.empty.canEdit") : t("board:list.empty.readonly")}
              </div>
            )}
            {displayedLists.map((list) => (
              <BoardListColumn
                key={list.id}
                list={list}
                showArchived={showArchived}
                canEdit={can("board.edit")}
                canCreateCard={can("card.create")}
                canDragList={can("board.edit")}
                canDragCards={can("card.edit")}
                onRename={handleRename}
                onCopy={handleCopyList}
              />
            ))}
            {can("board.edit") && <NewListInput boardId={boardId!} onCreated={handleListCreated} />}
          </div>
        </SortableContext>
        <DragOverlay>{activeCard && <BoardCardOverlay card={activeCard} />}</DragOverlay>
      </DndContext>
    </div>
    {board.data && (
      <>
        <EditBoardDialog
          board={{
            id: board.data.id,
            name: board.data.name,
            description: board.data.description,
            projectId: board.data.projectId,
          }}
          open={editingOpen}
          onOpenChange={setEditingOpen}
        />
        <DeleteBoardDialog
          board={{
            id: board.data.id,
            name: board.data.name,
            projectId: board.data.projectId,
          }}
          open={deletingOpen}
          onOpenChange={setDeletingOpen}
          onSuccess={() => navigate(`/projects/${projectId}`)}
        />
        {copyingOpen && (
          <CopyBoardDialog
            board={{ id: board.data.id, name: board.data.name }}
            defaults={{ projectId: board.data.projectId }}
            onOpenChange={setCopyingOpen}
            onConfirm={(target) =>
              copyBoard.mutate(target, { onSuccess: () => setCopyingOpen(false) })
            }
            pending={copyBoard.isPending}
          />
        )}
        {/* 清單複製：單一實例（目標清單存在 state 裡），條件掛載 ⇒ 關閉即卸載 */}
        {copyListTarget && (
          <CopyListDialog
            list={{ id: copyListTarget.id, name: copyListTarget.name }}
            // 與 `EditBoardDialog`／`DeleteBoardDialog` 同源：預設值取**看板自己**的資料，
            // 不取路由參數——手改 URL 讓兩者不一致時，路由參數會預選到錯的專案
            // （`targetIsVisible` 讓它送不出去，但畫面上會是一個不存在的落點）。
            defaults={{ projectId: board.data.projectId, boardId: board.data.id }}
            onOpenChange={(open) => {
              if (!open) setCopyListTarget(null);
            }}
            onConfirm={(target) => copyList.mutate({ list: copyListTarget, target })}
            pending={copyList.isPending}
          />
        )}
      </>
    )}
    {/* 巢狀路由的邊界必須在 BoardPage 自己身上：最近的祖先邊界是 AppLayout 那個，
        少了這一層，開一張卡片會讓**整個看板**被 fallback 換掉。fallback 留 null 的理由
        見上面預取那一段。 */}
    <LazyBoundary fallback={null}>
      <Outlet />
    </LazyBoundary>
    </>
  );
}
