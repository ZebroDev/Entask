import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { CheckCircle2, ChevronDown, ChevronRight, Plus, X, Network, ListTree } from "lucide-react";
import { MindMapCanvas } from "../mindmap/MindMapCanvas";
import { CardDialog } from "../../board/CardDialog";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { MINDMAP_COLLAPSED_PREFIX } from "@/lib/storage-keys";
import { apiErrorMessage } from "@/lib/utils";
import { useDndSensors } from "@/lib/dnd-sensors";
import { after, between } from "@/lib/position";
import { buildTree, isDescendantOf, type NodeTreeItem } from "@/lib/mindmap-tree";
import type { BoardDetailResponse, BoardSummaryResponse, MindMapResponse } from "@/lib/board-types";
import { ReviewStateIcon } from "@/components/ReviewStateIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "react-i18next";

interface Props { projectId: string; canEdit: boolean; focusNodeId?: string | null; }

const collapsedKey = (projectId: string) => `${MINDMAP_COLLAPSED_PREFIX}${projectId}`;

// 子節點空白區 droppable id 帶 `-body` 後綴（BoardPage stripBodySuffix 同型慣例）
const stripBodySuffix = (id: string) => (id.endsWith("-body") ? id.slice(0, -5) : id);

// 綁定選取器：搜尋專案內未封存卡片（複用既有 ["boards", projectId]/["board", id] 查詢鍵）
function BindCardDialog({ projectId, node, onClose, onBind, onUnbind }: {
  projectId: string;
  node: NodeTreeItem;
  onClose: () => void;
  onBind: (cardId: string) => void;
  onUnbind: () => void;
}) {
  const { t } = useTranslation(["project"]);
  const [query, setQuery] = useState("");
  const boards = useQuery({
    queryKey: ["boards", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/boards`)).data as BoardSummaryResponse[],
  });
  const details = useQueries({
    queries: (boards.data ?? []).map((b) => ({
      queryKey: ["board", b.id],
      queryFn: async () => (await api.get(`/boards/${b.id}`)).data as BoardDetailResponse,
    })),
  });
  const cards = details
    .flatMap((d) => d.data?.lists.flatMap((l) => l.cards.map((c) => ({ ...c, listName: l.name }))) ?? [])
    .filter((c) => !c.isArchived)
    .filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("project:mindMap.bind.title", { title: node.title })}</DialogTitle>
        </DialogHeader>
        {node.card && (
          <div className="flex items-center justify-between rounded border p-2 text-sm">
            <span>{t("project:mindMap.bind.bound", { title: node.card.title })}</span>
            <Button size="sm" variant="outline" onClick={() => { onUnbind(); onClose(); }}>{t("project:mindMap.bind.unbind")}</Button>
          </div>
        )}
        <Input placeholder={t("project:mindMap.bind.search.placeholder")} aria-label={t("project:mindMap.bind.search.aria")} value={query}
          onChange={(e) => setQuery(e.target.value)} />
        <div className="max-h-56 overflow-y-auto">
          {boards.isLoading || details.some((d) => d.isLoading) ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">{t("project:mindMap.bind.loading")}</p>
          ) : (
            <>
              {cards.map((c) => (
                <button key={c.id} type="button"
                  className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => { onBind(c.id); onClose(); }}>
                  {c.title}<span className="text-muted-foreground">{t("project:mindMap.bind.list.suffix", { name: c.listName })}</span>
                </button>
              ))}
              {cards.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">{t("project:mindMap.bind.noMatch")}</p>}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


// 取代原生 window.prompt 的小型輸入對話框（套用主題、焦點可控、Enter 送出）
function PromptDialog({ title, initial, onSubmit, onCancel }: {
  title: string;
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common"]);
  const [value, setValue] = useState(initial);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={initial}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (value.trim()) {
                onSubmit(value.trim());
                onCancel();
              }
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>{t("common:action.cancel")}</Button>
          <Button
            size="sm"
            disabled={!value.trim()}
            onClick={() => {
              onSubmit(value.trim());
              onCancel();
            }}
          >
            {t("common:action.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface NodeRowProps {
  item: NodeTreeItem;
  depth: number;
  canEdit: boolean;
  collapsedMap: Record<string, boolean>;
  editingTitleOf: string | null;
  addingChildOf: string | null;
  focused: boolean;
  focusedId: string | null;
  onToggleCollapsed: (id: string) => void;
  onAddChild: (id: string | null) => void;
  onEditTitle: (id: string | null) => void;
  onDelete: (item: NodeTreeItem) => void;
  onOpenBind: (item: NodeTreeItem) => void;
  onSaveNote: (id: string, note: string) => void;
  onSaveTitle: (id: string, title: string) => void;
  onCreateChild: (parentId: string, title: string) => void;
}

// 大綱列的鍵盤（2026-09-27）：對 Tab 而言，一列只有**一個**停留點——列本身那個
// `tabIndex` 來自 `@dnd-kit` 的 `attributes`（本檔的感應器不含 `KeyboardSensor`
// ⇒ 沒有鍵盤拖曳會跟方向鍵打架；2026-10-14 起由 `useDndSensors({ keyboard: false })` 保證）。列內控制項與備註欄靠 `→` 進來、
// `←` 出去，它們的 `tabIndex={-1}` 就是「收斂」本身。
//
// ★ 控制項用 `[data-row-widget="<列id>"]` **全域**找，不是從列的子樹找：備註 `<Input>`
//   是列的**兄弟**（它渲染在列 div 收尾之後），只找子樹會漏掉它——而它也是一個停留點。
function handleRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const rowId = e.currentTarget.dataset.outlineRow;
  const widgets = Array.from(document.querySelectorAll<HTMLElement>(`[data-row-widget="${rowId}"]`));
  const index = widgets.indexOf(e.target as HTMLElement);

  if (e.key === "ArrowRight") {
    e.preventDefault();
    widgets[index < 0 ? 0 : Math.min(index + 1, widgets.length - 1)]?.focus();
    return;
  }
  if (e.key === "ArrowLeft" && index <= 0) {
    e.preventDefault();
    e.currentTarget.focus();
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    widgets[index - 1]?.focus();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.currentTarget.focus();
  }
}

function NodeRow({ item, depth, canEdit, collapsedMap, editingTitleOf, addingChildOf, focused, focusedId, onToggleCollapsed,
  onAddChild, onEditTitle, onDelete, onOpenBind, onSaveNote, onSaveTitle, onCreateChild }: NodeRowProps) {
  const { t } = useTranslation(["common", "project"]);
  const collapsed = collapsedMap[item.id] === true;
  const editing = editingTitleOf === item.id;
  const addingChild = addingChildOf === item.id;
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } =
    useDraggable({ id: item.id, disabled: !canEdit });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: item.id, disabled: !canEdit });
  const { setNodeRef: setBodyDropRef, isOver: isBodyOver } =
    useDroppable({ id: `${item.id}-body`, disabled: !canEdit });

  return (
    <div id={`mm-node-${item.id}`} data-testid={`mm-node-${item.id}`}>
      <div
        ref={(el) => { setDragRef(el); setDropRef(el); }}
        className={`flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted ${isOver ? "bg-muted" : ""} ${isDragging ? "opacity-40" : ""} ${focused ? "ring-2 ring-ring" : ""}`}
        style={{ paddingLeft: depth * 20 }}
        data-outline-row={item.id}
        onKeyDown={handleRowKeyDown}
        {...attributes}
        {...listeners}
      >
        {item.children.length > 0 ? (
          <button type="button" aria-label={collapsed ? t("project:mindMap.node.expand") : t("project:mindMap.node.collapse")} className="w-4 text-muted-foreground"
            data-row-widget={item.id} tabIndex={-1}
            onClick={() => onToggleCollapsed(item.id)}>
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        {editing ? (
          <Input
            className="h-7 flex-1"
            defaultValue={item.title}
            data-row-widget={item.id}
            tabIndex={-1}
            autoFocus
            onBlur={(e) => {
              onEditTitle(null);
              // 不可命名為 `t`——同一個 scope 裡 `t` 是 useTranslation 的翻譯函式，
              // 區域變數遮蔽它之後，這個區塊裡就再也抽不了字串（B2-5b 一併改名）。
              const next = e.target.value.trim();
              if (next && next !== item.title) onSaveTitle(item.id, next);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <button
            type="button"
            className={`flex-1 truncate text-left ${canEdit ? "" : "opacity-50 cursor-not-allowed"}`}
            data-row-widget={item.id}
            tabIndex={-1}
            onClick={() => canEdit && onEditTitle(item.id)}
            aria-disabled={canEdit ? undefined : true}
            title={canEdit ? item.title : t("project:mindMap.node.noPermission")}
          >
            {item.title}
          </button>
        )}
        {item.card?.isArchived && <Badge variant="outline" className="text-xs">{t("common:state.archived")}</Badge>}
        {/* 綁定卡片的完成狀態：唯讀也可見，免點開卡片 */}
        {item.card?.completedAt && (
          <Badge variant="outline" className="shrink-0 gap-1 border-green-500/30 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" />{t("common:state.completed")}
          </Badge>
        )}
        {/* 綁定卡片的審查狀態：與完成狀態同一組理由（唯讀也可見、免點開卡片），
            呈現走 lib/review-badge.ts 與其他四個視圖同源——2026-09-18 使用者裁定補上 */}
        {item.card?.reviewState && <ReviewStateIcon state={item.card.reviewState} />}
        {!canEdit && item.card && (
          <span className={`text-xs text-muted-foreground ${item.card.completedAt ? "line-through" : ""}`}>
            {item.card.title}
          </span>
        )}
        {canEdit && (
          <>
            <button type="button"
              className={`max-w-28 truncate text-xs text-muted-foreground hover:text-foreground ${
                item.card?.completedAt ? "line-through" : ""
              }`}
              data-row-widget={item.id}
              tabIndex={-1}
              onClick={() => onOpenBind(item)}>
              {item.card ? item.card.title : t("project:mindMap.bind.action")}
            </button>
            <button type="button" aria-label={t("project:mindMap.node.addChild")}
              className="text-muted-foreground hover:text-foreground"
              data-row-widget={item.id} tabIndex={-1}
              onClick={() => onAddChild(item.id)}>
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label={t("project:mindMap.node.delete")}
              className="text-muted-foreground hover:text-destructive"
              data-row-widget={item.id} tabIndex={-1}
              onClick={() => onDelete(item)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {item.note !== null ? (
        <p className="text-xs text-muted-foreground" style={{ paddingLeft: depth * 20 + 16 }}>{item.note}</p>
      ) : canEdit ? (
        <Input
          key={item.note ?? ""}
          className="ml-6 h-6 w-3/4 text-xs"
          defaultValue=""
          data-row-widget={item.id}
          tabIndex={-1}
          placeholder={t("project:mindMap.node.note.placeholder")}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (item.note ?? "")) onSaveNote(item.id, v);
          }}
        />
      ) : null}
      {addingChild && (
        <NewNodeInput
          placeholder={t("project:mindMap.node.child.placeholder")}
          style={{ paddingLeft: depth * 20 + 16 }}
          onSubmit={(title) => onCreateChild(item.id, title)}
          onCancel={() => onAddChild(null)}
        />
      )}
      {!collapsed && item.children.map((c) => (
        <NodeRow key={c.id} item={c} depth={depth + 1} canEdit={canEdit} focused={c.id === focusedId} focusedId={focusedId}
          collapsedMap={collapsedMap} editingTitleOf={editingTitleOf} addingChildOf={addingChildOf}
          onToggleCollapsed={onToggleCollapsed} onAddChild={onAddChild} onEditTitle={onEditTitle}
          onDelete={onDelete} onOpenBind={onOpenBind} onSaveNote={onSaveNote} onSaveTitle={onSaveTitle}
          onCreateChild={onCreateChild}
        />
      ))}
      {!collapsed && (
        <div
          ref={setBodyDropRef}
          className={`mx-6 h-2 rounded ${isBodyOver ? "bg-primary/30" : ""}`}
          data-testid={`mm-body-${item.id}`}
        />
      )}
    </div>
  );
}

export function MindMapTab({ projectId, canEdit, focusNodeId }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(collapsedKey(projectId)) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [addingChildOf, setAddingChildOf] = useState<string | null>(null);
  const [editingTitleOf, setEditingTitleOf] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NodeTreeItem | null>(null);
  const [bindTarget, setBindTarget] = useState<NodeTreeItem | null>(null);
  const [promptState, setPromptState] = useState<{ title: string; initial: string; onSubmit: (value: string) => void } | null>(null);
  const isTestEnv = import.meta.env?.MODE === "test";
  const [viewMode, setViewMode] = useState<"canvas" | "tree">(isTestEnv ? "tree" : "canvas");
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  // 與看板共用觸控設定（長按才拖曳、滑動即捲動；實測與理由見 `@/lib/dnd-sensors`），
  // 但不裝 KeyboardSensor——理由見 `dnd-sensors.ts` 與本檔 handleRowKeyDown 的註解。
  const sensors = useDndSensors({ keyboard: false });

  const mindmap = useQuery({
    queryKey: ["mindmap", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/mindmap`)).data as MindMapResponse,
  });

  // 伺服器全樹回應直接替換 cache（後端 PUT/POST/DELETE 皆回全樹）
  const applyTree = (updated: MindMapResponse) => {
    queryClient.setQueryData(["mindmap", projectId], updated);
  };

  const createNode = useMutation({
    mutationFn: async (vars: { title: string; parentId: string | null; cardId?: string | null }) =>
      (await api.post(`/projects/${projectId}/mindmap/nodes`, vars)).data as MindMapResponse,
    onSuccess: (updated) => applyTree(updated),
    onError: (error) => toast.error(apiErrorMessage(error, t("project:mindMap.error.create"))),
  });

  const updateNode = useMutation({
    mutationFn: async (vars: { id: string; patch: Record<string, unknown> }) =>
      (await api.put(`/projects/${projectId}/mindmap/nodes/${vars.id}`, vars.patch)).data as MindMapResponse,
    onSuccess: (updated) => applyTree(updated),
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.save"))),
  });

  const deleteNode = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/projects/${projectId}/mindmap/nodes/${id}`)).data as MindMapResponse,
    onSuccess: (updated) => applyTree(updated),
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.delete"))),
  });

  const moveNode = useMutation({
    mutationFn: async (vars: { id: string; parentId: string | null; position: string }) =>
      (await api.put(`/projects/${projectId}/mindmap/nodes/${vars.id}/position`,
        { parentId: vars.parentId, position: vars.position })).data as MindMapResponse,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["mindmap", projectId] });
      const prev = queryClient.getQueryData<MindMapResponse>(["mindmap", projectId]);
      queryClient.setQueryData<MindMapResponse>(["mindmap", projectId], (old) =>
        old
          ? {
              ...old,
              nodes: old.nodes.map((n) =>
                n.id === vars.id ? { ...n, parentId: vars.parentId, position: vars.position } : n),
            }
          : old);
      return { prev };
    },
    onSuccess: (updated) => applyTree(updated),
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["mindmap", projectId], ctx.prev);
      queryClient.invalidateQueries({ queryKey: ["mindmap", projectId] });
      toast.error(apiErrorMessage(error, t("common:error.move")));
    },
  });

  const updateCoordinates = useMutation({
    mutationFn: async (coords: { id: string; x: number; y: number }[]) => {
      await api.put(`/projects/${projectId}/mindmap/nodes/coordinates`, { nodes: coords });
    },
    onMutate: async (coords) => {
      await queryClient.cancelQueries({ queryKey: ["mindmap", projectId] });
      const prev = queryClient.getQueryData<MindMapResponse>(["mindmap", projectId]);
      if (prev) {
        const coordMap = new Map(coords.map((c) => [c.id, c]));
        queryClient.setQueryData<MindMapResponse>(["mindmap", projectId], {
          ...prev,
          nodes: prev.nodes.map((n) => {
            const hit = coordMap.get(n.id);
            return hit ? { ...n, positionX: hit.x, positionY: hit.y } : n;
          }),
        });
      }
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["mindmap", projectId], ctx.prev);
      toast.error(apiErrorMessage(error, t("project:mindMap.error.savePosition")));
    },
  });

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // 摺疊狀態持久化：localStorage 寫入抽離 setState updater（不可有 side effect），
  // 改於 state 變化後統一落盤；儲存不可用時靜默降級為 session 內存
  useEffect(() => {
    try {
      localStorage.setItem(collapsedKey(projectId), JSON.stringify(collapsed));
    } catch {
      // 隱私模式/配額滿：僅影響跨 session 記憶
    }
  }, [collapsed, projectId]);

  // 深連結聚焦（Task 17）：ProjectPage 解析 node 參數後以 focusNodeId 傳入。
  // hooks 規則：state/effect 須置於條件 early-return 之前（nodes 於下方定義）。
  // deps 含 collapsed：目標在摺疊祖先下時（localStorage 跨 session 持久化）首次無元素可聚焦，
  // 展開祖先後 collapsed 變化重觸發聚焦
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusNodeId || (mindmap.data?.nodes.length ?? 0) === 0) return;
    if (focusedId === focusNodeId) return;
    const el = document.getElementById(`mm-node-${focusNodeId}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      setFocusedId(focusNodeId);
    }
  }, [focusNodeId, mindmap.data, focusedId, collapsed]);

  if (mindmap.isLoading) return <Skeleton className="h-40 w-full" data-testid="mindmap-skeleton" />;
  if (mindmap.isError) {
    const loadErrorDetail = apiErrorMessage(mindmap.error, t("common:error.load"));
    return (
      <div className="text-destructive">
        {t("common:error.loadDetail", { detail: loadErrorDetail })}
        <Button size="sm" variant="outline" className="ml-2" onClick={() => mindmap.refetch()}>{t("common:action.retry")}</Button>
      </div>
    );
  }

  const tree = buildTree(mindmap.data?.nodes ?? []);
  const nodes = mindmap.data?.nodes ?? [];
  // 刪除確認的後代數量：統一以扁平 nodes 計數（deleteTarget 在樹檢視為 NodeTreeItem、
  // 畫布為扁平節點——後者無 children，countSubtree 不可用）
  const deleteSubtreeCount = deleteTarget
    ? nodes.filter((n) => n.id !== deleteTarget.id && isDescendantOf(nodes, deleteTarget.id, n.id)).length
    : 0;

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const overRaw = String(over.id);
    const isBody = overRaw.endsWith("-body");
    const overId = stripBodySuffix(overRaw);
    const activeId = String(active.id);

    // 拖至自身子孫 → 拒絕（伺服器環檢測 400 的 UX 前置攔截）
    if (isDescendantOf(nodes, activeId, overId)) {
      toast.error(t("project:mindMap.error.moveIntoDescendant"));
      return;
    }

    const target = nodes.find((n) => n.id === overId);
    if (!target) return;

    if (isBody) {
      const siblings = nodes
        .filter((n) => n.parentId === target.id)
        .sort((a, b) => (a.position < b.position ? -1 : 1));
      moveNode.mutate({ id: activeId, parentId: target.id, position: after(siblings.at(-1)?.position ?? null) });
      return;
    }

    const siblings = nodes
      .filter((n) => n.parentId === target.parentId)
      .sort((a, b) => (a.position < b.position ? -1 : 1));
    const idx = siblings.findIndex((n) => n.id === target.id);
    const prev = siblings[idx - 1];
    const position = prev ? between(prev.position, target.position) : between(null, target.position);
    const current = nodes.find((n) => n.id === activeId)!;
    // 同父同位置 → 無位移，不送冗餘 PUT
    if (current.parentId === target.parentId && current.position === position) return;
    moveNode.mutate({ id: activeId, parentId: target.parentId, position });
  };

  return (
    <div className="space-y-4">
      {/* 視圖切換頂部工具列 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b pb-3 gap-3">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar whitespace-nowrap">
          <Button
            size="sm"
            variant={viewMode === "canvas" ? "default" : "outline"}
            onClick={() => setViewMode("canvas")}
            className="flex items-center gap-1.5 h-8 shrink-0"
          >
            <Network className="h-4 w-4" />
            {t("project:mindMap.view.canvas")}
          </Button>
          <Button
            size="sm"
            variant={viewMode === "tree" ? "default" : "outline"}
            onClick={() => setViewMode("tree")}
            className="flex items-center gap-1.5 h-8 shrink-0"
          >
            <ListTree className="h-4 w-4" />
            {t("project:mindMap.view.tree")}
          </Button>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setPromptState({
                title: t("project:mindMap.addRoot"),
                initial: t("project:mindMap.prompt.rootInitial"),
                onSubmit: (v) => createNode.mutate({ title: v, parentId: null }),
              })}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("project:mindMap.addRoot")}
            </Button>
          </div>
        )}
      </div>

      {viewMode === "canvas" ? (
        <MindMapCanvas
          projectId={projectId}
          rawNodes={nodes}
          canEdit={canEdit}
          onAddChild={(parentId) => setPromptState({
            title: t("project:mindMap.node.addChild"),
            initial: t("project:mindMap.prompt.childInitial"),
            onSubmit: (v) => createNode.mutate({ title: v, parentId }),
          })}
          onBindCard={(nodeId) => {
            const node = nodes.find((n) => n.id === nodeId);
            if (node) setBindTarget(node as any);
          }}
          onEdit={(id, title, note) => updateNode.mutate({ id, patch: { title, note } })}
          onDelete={(id) => {
            const node = nodes.find((n) => n.id === id);
            if (node) setDeleteTarget(node as any);
          }}
          onOpenCard={(cardId) => setOpenCardId(cardId)}
          onCreateNodeFromCard={(cardId, title) => {
            createNode.mutate({ title, parentId: null, cardId });
          }}
          onMoveNode={(nodeId, newParentId) => {
            if (newParentId !== null && isDescendantOf(nodes, nodeId, newParentId)) {
              toast.error(t("project:mindMap.error.moveIntoDescendant"));
              return;
            }
            const siblings = nodes.filter((n) => (n.parentId ?? null) === newParentId);
            const pos = siblings.length > 0 ? after(siblings[siblings.length - 1].position) : "h";
            moveNode.mutate({ id: nodeId, parentId: newParentId, position: pos });
          }}
          onUpdateCoordinates={(coords) => updateCoordinates.mutate(coords)}
        />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {canEdit && (
        <NewNodeInput
          placeholder={t("project:mindMap.root.placeholder")}
          onSubmit={(title) => createNode.mutate({ title, parentId: null })}
        />
      )}
      {tree.length === 0 && <p className="text-sm text-muted-foreground">{t("project:mindMap.empty")}</p>}
      {tree.map((root) => (
        <NodeRow key={root.id} item={root} depth={0} canEdit={canEdit} focused={root.id === focusedId} focusedId={focusedId}
          collapsedMap={collapsed} editingTitleOf={editingTitleOf} addingChildOf={addingChildOf}
          onToggleCollapsed={toggleCollapsed}
          onAddChild={(id) => setAddingChildOf(id === addingChildOf ? null : id)}
          onEditTitle={setEditingTitleOf}
          onDelete={setDeleteTarget}
          onOpenBind={setBindTarget}
          onSaveNote={(id, note) => updateNode.mutate({ id, patch: { note } })}
          onSaveTitle={(id, title) => updateNode.mutate({ id, patch: { title } })}
          onCreateChild={(parentId, title) => {
            createNode.mutate({ title, parentId });
            setAddingChildOf(null);
          }}
        />
      ))}
    </DndContext>
      )}

      {/* 三對話框於兩種檢視共用：曾置於大綱分支內，畫布模式點按鈕只設 state 無對話框可渲染 */}
      {bindTarget && (
        <BindCardDialog
          projectId={projectId}
          node={bindTarget}
          onClose={() => setBindTarget(null)}
          onBind={(cardId) => updateNode.mutate({ id: bindTarget.id, patch: { cardId } })}
          onUnbind={() => updateNode.mutate({ id: bindTarget.id, patch: { cardId: null } })}
        />
      )}
      {promptState && (
        <PromptDialog
          title={promptState.title}
          initial={promptState.initial}
          onSubmit={promptState.onSubmit}
          onCancel={() => setPromptState(null)}
        />
      )}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project:mindMap.node.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("project:mindMap.delete.confirm", { title: deleteTarget?.title, count: deleteSubtreeCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteTarget) deleteNode.mutate(deleteTarget.id); }}>
              {t("common:action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {openCardId && (
        <CardDialog
          cardId={openCardId}
          projectId={projectId}
          open={true}
          onOpenChange={(open) => !open && setOpenCardId(null)}
        />
      )}
    </div>
  );
}

function NewNodeInput({ placeholder, style, onSubmit, onCancel }: {
  placeholder: string;
  style?: CSSProperties;
  onSubmit: (title: string) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation(["common"]);
  const [value, setValue] = useState("");
  // 「取消」mousedown 旗標：瀏覽器事件序為 mousedown → blur → click，
  // blur-commit 若在此時送出，取消就失去意義
  const cancelPressed = useRef(false);
  const submit = () => {
    // 同上：`t` 留給 useTranslation（此檔的 `aria-label` 與 placeholder 都是譯文）。
    const next = value.trim();
    if (!next) return;
    onSubmit(next);
    setValue("");
  };
  return (
    <div className="flex items-center gap-1 py-1" style={style}>
      <Input
        className="h-7"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (cancelPressed.current) {
            cancelPressed.current = false;
            return;
          }
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") { setValue(""); onCancel?.(); }
        }}
      />
      <Button size="sm" onClick={submit} disabled={!value.trim()}>{t("common:action.add")}</Button>
      {onCancel && (
        <Button size="sm" variant="ghost"
          onMouseDown={() => { cancelPressed.current = true; }}
          onClick={onCancel}>
          {t("common:action.cancel")}
        </Button>
      )}
    </div>
  );
}
