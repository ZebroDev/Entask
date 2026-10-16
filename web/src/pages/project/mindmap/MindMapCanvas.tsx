import React, { useMemo, useCallback, useEffect, useState, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MindMapCustomNode, type MindMapNodeData } from "./MindMapCustomNode";
import type { MindMapNodeResponse } from "@/lib/board-types";
import { MINDMAP_CASCADE_DRAG_KEY } from "@/lib/storage-keys";
import { hideOutside } from "@/lib/hide-outside";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CARD_SIDE_LIST_PAGE_SIZE } from "@/lib/card-paging";
import { toast } from "sonner";
import {
  Sparkles,
  Maximize2,
  Minimize2,
  PanelRight,
  Search,
  X,
  FileText,
  CheckCircle2,
  Download,
  Image as ImageIcon,
  Plus,
  GitFork,
} from "lucide-react";
import { exportMindMapAsPng, exportMindMapAsSvg } from "./mindmap-export";
import { useTranslation } from "react-i18next";

const BRANCH_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#8b5cf6", // purple
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
];

interface MindMapCanvasProps {
  projectId: string;
  rawNodes: MindMapNodeResponse[];
  canEdit: boolean;
  onAddChild: (parentId: string) => void;
  onCreateNodeFromCard?: (cardId: string, title: string) => void;
  onBindCard: (nodeId: string) => void;
  onEdit: (nodeId: string, title: string, note: string | null) => void;
  onDelete: (nodeId: string) => void;
  onOpenCard: (cardId: string) => void;
  onMoveNode?: (nodeId: string, newParentId: string | null) => void;
  onDirectBindCard?: (nodeId: string, cardId: string) => void;
  onUpdateCoordinates?: (nodes: { id: string; x: number; y: number }[]) => void;
}

const nodeTypes = {
  mindmapNode: MindMapCustomNode as any,
};

function getDescendantIds(rootId: string, rawNodes: MindMapNodeResponse[]): Set<string> {
  const childrenMap = new Map<string, string[]>();
  for (const node of rawNodes) {
    if (node.parentId) {
      if (!childrenMap.has(node.parentId)) childrenMap.set(node.parentId, []);
      childrenMap.get(node.parentId)!.push(node.id);
    }
  }
  const result = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const children = childrenMap.get(curr);
    if (children) {
      for (const cid of children) {
        if (!result.has(cid)) {
          result.add(cid);
          queue.push(cid);
        }
      }
    }
  }
  return result;
}

function computeTreeLayout(
  rawNodes: MindMapNodeResponse[],
  canEdit: boolean,
  callbacks: {
    onAddChild: (id: string) => void;
    onBindCard: (id: string) => void;
    onEdit: (id: string, title: string, note: string | null) => void;
    onDelete: (id: string) => void;
    onOpenCard: (cardId: string) => void;
  },
  forceAutoLayout = false
) {
  const childrenMap = new Map<string | null, MindMapNodeResponse[]>();
  for (const node of rawNodes) {
    const p = node.parentId ?? null;
    if (!childrenMap.has(p)) childrenMap.set(p, []);
    childrenMap.get(p)!.push(node);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const rootNodes = childrenMap.get(null) ?? [];

  let currentY = 100;
  const HORIZONTAL_SPACING = 300;
  const VERTICAL_SPACING = 90;

  function layoutSubtree(
    node: MindMapNodeResponse,
    depth: number,
    branchIndex: number
  ): { yMin: number; yMax: number; yCenter: number } {
    const children = childrenMap.get(node.id) ?? [];
    const branchColor = depth === 0 ? "#6366f1" : BRANCH_COLORS[branchIndex % BRANCH_COLORS.length];
    const defaultX = depth * HORIZONTAL_SPACING + 100;

    if (children.length === 0) {
      const calculatedY = currentY;
      currentY += VERTICAL_SPACING;

      const finalX = !forceAutoLayout && node.positionX != null ? node.positionX : defaultX;
      const finalY = !forceAutoLayout && node.positionY != null ? node.positionY : calculatedY;

      nodes.push({
        id: node.id,
        type: "mindmapNode",
        position: { x: finalX, y: finalY },
        data: {
          id: node.id,
          title: node.title,
          note: node.note,
          card: node.card,
          isRoot: depth === 0,
          depth,
          branchColor,
          canEdit,
          ...callbacks,
        } as MindMapNodeData,
      });

      return { yMin: calculatedY, yMax: calculatedY, yCenter: calculatedY };
    }

    const childCenters: number[] = [];
    let minChildY = Infinity;
    let maxChildY = -Infinity;

    children.forEach((child, idx) => {
      const childBranchIdx = depth === 0 ? idx : branchIndex;
      const result = layoutSubtree(child, depth + 1, childBranchIdx);
      childCenters.push(result.yCenter);
      if (result.yMin < minChildY) minChildY = result.yMin;
      if (result.yMax > maxChildY) maxChildY = result.yMax;

      edges.push({
        id: 'e-' + node.id + '-' + child.id,
        source: node.id,
        target: child.id,
        type: "bezier",
        animated: false,
        style: {
          stroke: depth === 0 ? BRANCH_COLORS[idx % BRANCH_COLORS.length] : branchColor,
          strokeWidth: 2.5,
        },
      });
    });

    const calculatedYCenter = (minChildY + maxChildY) / 2;
    const finalX = !forceAutoLayout && node.positionX != null ? node.positionX : defaultX;
    const finalY = !forceAutoLayout && node.positionY != null ? node.positionY : calculatedYCenter;

    nodes.push({
      id: node.id,
      type: "mindmapNode",
      position: { x: finalX, y: finalY },
      data: {
        id: node.id,
        title: node.title,
        note: node.note,
        card: node.card,
        isRoot: depth === 0,
        depth,
        branchColor,
        canEdit,
        ...callbacks,
      } as MindMapNodeData,
    });

    return { yMin: minChildY, yMax: maxChildY, yCenter: calculatedYCenter };
  }

  rootNodes.forEach((root, idx) => {
    layoutSubtree(root, 0, idx);
    currentY += 60;
  });

  return { nodes, edges };
}

// 畫布上的 `→`：從節點本身進入它的操作列（2026-09-27）。對 Tab 而言一個節點只有一個
// 停留點（React Flow 的節點 wrapper），操作列那 4 顆是 `tabIndex={-1}`，這是進去的那條路。
//
// ★ `e.defaultPrevented` 這一格是**契約**，不是保險：React Flow 對**已選取**節點上的
//   方向鍵會 `preventDefault()` 並移動該節點（`@xyflow/react/dist/esm/index.js:2317-2330`）。
//   它的處理器在節點 wrapper（比這裡內層）⇒ 它先跑；它認領了那顆鍵，我們就不搶。
//   代價是「同一顆鍵有兩種行為」，而分界線就是「節點有沒有被選取」——刻意的。
function handleCanvasKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.defaultPrevented || e.key !== "ArrowRight") return;
  const target = e.target as HTMLElement;
  const node = target.closest<HTMLElement>(".react-flow__node");
  if (!node || target !== node) return;
  const first = node.querySelector<HTMLElement>("[data-node-widget]");
  if (!first) return;
  e.preventDefault();
  first.focus();
}

// 浮層內的「可聚焦」尺：與第九批的探針／測試同一把（`tabindex="-1"` 與 disabled 不計）
// ⇒ 節點操作列那 4 顆、控制列刻意 `-1` 的控制項都不算停留點。
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("tabindex") !== "-1",
  );
}

function InnerCanvas({
  projectId,
  rawNodes,
  canEdit,
  onAddChild,
  onCreateNodeFromCard,
  onBindCard,
  onEdit,
  onDelete,
  onOpenCard,
  onMoveNode,
  onDirectBindCard: _onDirectBindCard,
  onUpdateCoordinates,
}: MindMapCanvasProps) {
  const { t } = useTranslation(["project"]);
  const { fitView } = useReactFlow();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [cardSearchQuery, setCardSearchQuery] = useState("");

  // 退出時把焦點還給按鈕。刻意**不放進 effect 的 cleanup**：那裡讀 `ref.current` 會被
  // `react-hooks(exhaustive-deps)` 判為「cleanup 跑的時候 ref 可能已經變了」，而退出的
  // 時機本來就只有明確的兩個（按鈕、Escape）——放這裡行為相同且少一個 lint 警告。
  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
    fullscreenButtonRef.current?.focus();
  }, []);

  // 全螢幕浮層的三件事都掛在同一個 effect 的生命週期上：進入時鎖住背景滾動、把焦點
  // 移進浮層、掛上 Escape；離開時（含卸載）逐項還原。AppLayout 是**整頁滾動**（`min-h-screen`，
  // 沒有內部滾動容器）⇒ 鎖 `document.body.style.overflow` 就是唯一的槓桿。
  // 留著舊值是刻意的：`overflow` 可能是別處設的，退出時要回到那個值而不是清空。
  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const overlay = fullscreenRef.current;
    overlay?.focus();
    // 背景惰性化（2026-09-28）：`aria-modal` 是**宣告**，這一半才是實作——把浮層
    // **外面**的內容從無障礙樹與 Tab 順序裡拿掉。環繞（下面 `onKeyDown` 的 Tab 分支）
    // 只擋得住鍵盤焦點，擋不住螢幕閱讀器的瀏覽模式虛擬游標。
    // 走多高、為什麼在 body 那一層停、還原成什麼，都在 `lib/hide-outside.ts` 的檔頭。
    const restoreOutside = overlay ? hideOutside(overlay) : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      // 焦點環繞（2026-09-28）。這顆浮層是**純 div、不是 Radix 模態** ⇒ 沒有 focus
      // scope，Tab 會走到浮層**後面**去。Chromium 探針實測（N=30、1440×900、罐頭 API）：
      // 開著浮層按 Tab，**第 71 步**離開浮層（先 BODY、再到「畫布模式／大綱樹狀／
      // 新增根節點」），而那三顆在**自己矩形中心**做 `elementFromPoint` 全部回
      // 「被蓋住」（3/3）⇒ **看不見的焦點**。★ 那兩個數字是**環繞加上去之前**量的
      // ——它們回答的是「這個 effect 為什麼存在」，不是「現在按 Tab 會怎樣」。
      // ★ `role="dialog"`／`aria-modal`／`aria-label` 掛在**外框**上（見下面 return 的
      //   那個 `div`）；宣告的另一半（浮層**外**的內容真的惰性）是這個 effect 開頭那行
      //   `hideOutside`。環繞擋得住 Tab、擋不住螢幕閱讀器的**瀏覽模式虛擬游標**，
      //   兩者一起才是完整的「模態」。
      // ★ 環繞只在**邊界**上動手，判別式就是下面那兩個 `active !== first/last`
      //   ——**不另寫**「焦點在不在這棵子樹裡」的守衛（`root.contains`）：焦點在浮層
      //   外時，它既不可能是 `first`／`last`（兩者是 root 的後代）也不可能是 `root`
      //   自己 ⇒ 那兩格本來就不成立，這裡自然讓給它。Radix 的抽屜是 portal 到
      //   body，開著時它的焦點正是這種情形 ⇒ 不必去猜 Radix 的 focus scope 內部行為。
      //   （2026-09-28 實測：那個守衛**加回去或拿掉，測試一模一樣綠**——守衛與邊界
      //     條件行為等價，而它卻帶著一句沒有守門員的宣稱 ⇒ 拿掉。）
      // ★ 缺口在 `items` **之外**的焦點上：節點操作列那 4 顆是 `tabindex="-1"`（由
      //   `→` 進入），兩個邊界條件都不成立 ⇒ 放行給瀏覽器。實測不會漏出去——4 條
      //   路徑 × 120 步（最前／最後節點的操作列，兩個方向）**一步都沒離開浮層**：
      //   自然順序在浮層內是連續的一段，從段內任何位置出發都會先經過段的端點。
      // ★ jsdom 沒有順序焦點導覽，驗不到上面那個現象本身；那半邊的證據是探針
      //   （ledger 的 `tmp/probe/probe_canvas_focus.cjs` 與 `probe_canvas_ab.cjs`），
      //   測試釘的是這個處理器。
      if (event.key === "Tab") {
        const root = fullscreenRef.current;
        if (!root) return;
        const active = document.activeElement as HTMLElement | null;
        const items = focusableWithin(root);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey) {
          if (active !== first && active !== root) return;
          event.preventDefault();
          last.focus();
          return;
        }
        if (active !== last && active !== root) return;
        event.preventDefault();
        first.focus();
        return;
      }

      if (event.key !== "Escape") return;
      // 上層浮層已經處理掉的 Escape 就讓給它——否則一次 Escape 會同時關對話框
      // **與**退出全螢幕（2026-09-25 探針實測）。
      // ★ 判別式是 `defaultPrevented`、**不是**「現在有沒有 `[role="dialog"]`」：
      //   Radix 的 `useEscapeKeydown` 掛在 document 的 **capture 階段**，它處理完
      //   對話框的 DOM 在那一刻**已經不在了**（探針在 capture 階段量到 `dialogs: 0`、
      //   `defaultPrevented: true`；沒有對話框時是 `false`）⇒ DOM 查詢版本攔不到
      //   任何一次，而那正好是它看起來「寫了但沒生效」的原因。
      exitFullscreen();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreOutside?.();
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen, exitFullscreen]);

  const [cascadeDrag, setCascadeDrag] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MINDMAP_CASCADE_DRAG_KEY) === "true";
    } catch {
      return false;
    }
  });

  const handleToggleCascadeDrag = (checked: boolean) => {
    setCascadeDrag(checked);
    try {
      localStorage.setItem(MINDMAP_CASCADE_DRAG_KEY, String(checked));
    } catch {
      // ignore
    }
  };

  const callbacks = useMemo(
    () => ({ onAddChild, onBindCard, onEdit, onDelete, onOpenCard }),
    [onAddChild, onBindCard, onEdit, onDelete, onOpenCard]
  );

  const { initialNodes, initialEdges } = useMemo(() => {
    const layout = computeTreeLayout(rawNodes, canEdit, callbacks);
    return { initialNodes: layout.nodes, initialEdges: layout.edges };
  }, [rawNodes, canEdit, callbacks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  React.useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // 記錄拖曳開始時的各節點位置快照
  const dragStartPositions = useRef<Map<string, { x: number; y: number }>>(new Map());

  const onNodeDragStart = useCallback((_event: any, _node: Node) => {
    const posMap = new Map<string, { x: number; y: number }>();
    nodes.forEach((n) => {
      posMap.set(n.id, { x: n.position.x, y: n.position.y });
    });
    dragStartPositions.current = posMap;
  }, [nodes]);

  const onNodeDrag = useCallback((_event: any, node: Node) => {
    if (!cascadeDrag) return;
    const startPos = dragStartPositions.current.get(node.id);
    if (!startPos) return;

    const dx = node.position.x - startPos.x;
    const dy = node.position.y - startPos.y;
    const descendantIds = getDescendantIds(node.id, rawNodes);
    if (descendantIds.size === 0) return;

    setNodes((currentNodes) =>
      currentNodes.map((n) => {
        if (descendantIds.has(n.id)) {
          const initial = dragStartPositions.current.get(n.id);
          if (initial) {
            return {
              ...n,
              position: { x: initial.x + dx, y: initial.y + dy },
            };
          }
        }
        return n;
      })
    );
  }, [cascadeDrag, rawNodes, setNodes]);

  const onNodeDragStop = useCallback((_event: any, node: Node) => {
    if (!canEdit || !onUpdateCoordinates) return;

    if (cascadeDrag) {
      const affectedIds = new Set([node.id, ...getDescendantIds(node.id, rawNodes)]);
      const updates = nodes
        .filter((n) => affectedIds.has(n.id))
        .map((n) => ({
          id: n.id,
          x: Math.round(n.position.x),
          y: Math.round(n.position.y),
        }));
      if (updates.length > 0) {
        onUpdateCoordinates(updates);
      }
    } else {
      onUpdateCoordinates([
        {
          id: node.id,
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        },
      ]);
    }
    dragStartPositions.current.clear();
  }, [canEdit, cascadeDrag, rawNodes, nodes, onUpdateCoordinates]);

  // 一鍵自動智慧排版 (Auto-Layout) 並持久化
  const handleAutoLayout = useCallback(() => {
    const layout = computeTreeLayout(rawNodes, canEdit, callbacks, true);
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setTimeout(() => {
      fitView({ duration: 400, padding: 0.3 });
    }, 50);

    if (canEdit && onUpdateCoordinates) {
      const updates = layout.nodes.map((n) => ({
        id: n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      }));
      onUpdateCoordinates(updates);
      toast.success(t("project:mindMap.layout.success"));
    }
    // `t` 必須進依賴陣列：`useTranslation` 的 `t` 綁著「當下的語系」，
    // 漏掉它這個 memo 化的回呼會一直用第一次 render 的那個語系發 toast
    // （B2-5a 的 `useMemo` 陷阱的同源版本——差別在這個產出的是行為不是值）。
  }, [rawNodes, canEdit, callbacks, setNodes, setEdges, fitView, onUpdateCoordinates, t]);

  // 查詢專案所有卡片供抽屜展示
  const projectCards = useQuery({
    queryKey: ["project-cards-drawer", projectId],
    queryFn: async () =>
      (await api.get(`/projects/${projectId}/cards?pageSize=${CARD_SIDE_LIST_PAGE_SIZE}`)).data as {
        items: any[];
        total: number;
      },
    enabled: isDrawerOpen,
  });

  // 卡片庫抽屜只載入固定筆數（上限見 `ProjectCardEndpoints`）。少了這一段，抽屜讀起來像
  // 「專案就這些卡」；搜尋不到時更像「沒有這張卡」，而不是「它不在載入的那一段裡」。
  const drawerLoadedCount = projectCards.data?.items?.length ?? 0;
  const drawerTotalCount = projectCards.data?.total ?? 0;
  const drawerTruncated = drawerTotalCount > drawerLoadedCount;

  const filteredCards = (projectCards.data?.items ?? []).filter((c: any) =>
    !cardSearchQuery || c.title.toLowerCase().includes(cardSearchQuery.toLowerCase())
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!canEdit || !onMoveNode || !params.source || !params.target) return;
      if (params.source === params.target) return;
      onMoveNode(params.target, params.source);
    },
    [canEdit, onMoveNode]
  );

  return (
    // ★ `relative` 只能待在**非全螢幕**那一支。它與 `fixed` 同時出現時，
    //   Tailwind 依 `static, fixed, absolute, relative, sticky` 輸出 ⇒ `.relative`
    //   排在後面 ⇒ computed position 是 `relative`，浮層從未成立（2026-09-25 修）。
    // ★ `!m-0` 同理是必要的：外框是 `MindMapTab.tsx:483` 那個 `space-y-4` 容器的
    //   子元素 ⇒ 拿到 `margin-top: 16px`，而 `fixed` 元素照樣被 margin 推移
    //   （computed `top` 是 `0px`、rect 卻從 16 起算）⇒ 浮層上緣留一條 16px 的縫、
    //   下緣再被推出視窗 16px。那條規則編譯成
    //   `.space-y-4 > :not([hidden]) ~ :not([hidden])`（特異度 0,3,0），
    //   不帶 important 的 `m-0`（0,1,0）贏不了它——這與 class 順序無關。
    <div
      ref={fullscreenRef}
      tabIndex={isFullscreen ? -1 : undefined}
      // 對 AT 宣告它是模態（Tab 環繞那一半在下面 effect 的 `onKeyDown` 裡）。
      // 名稱沿用鈕的**可見文字**那個 key：不新增語系鍵、也不另外寫一份名稱。
      role={isFullscreen ? "dialog" : undefined}
      aria-modal={isFullscreen ? true : undefined}
      aria-label={isFullscreen ? t("project:mindMap.fullscreen.label") : undefined}
      onKeyDown={handleCanvasKeyDown}
      className={'overflow-hidden transition-all ' + (
        isFullscreen
          ? "fixed inset-0 z-50 bg-background w-screen h-screen flex flex-col !m-0"
          : "relative w-full h-[680px] border rounded-xl bg-background shadow-inner"
      )}
    >
      {/* 畫布頂部懸浮控制列 (Floating Top Toolbar) */}
      <div className="absolute top-3 left-3 z-10 flex w-fit max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5 bg-background/85 backdrop-blur border rounded-lg px-2 py-1.5 shadow-sm">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleAutoLayout}
          className="h-7 text-xs gap-1.5 whitespace-nowrap text-primary hover:bg-primary/10"
          title={t("project:mindMap.layout.tooltip")}
        >
          <Sparkles className="h-3.5 w-3.5 text-amber-500" />
          {t("project:mindMap.layout.action")}
        </Button>

        <div className="hidden sm:block h-4 w-px bg-border" />

        {/* 分支連動切換開關 */}
        <label
          className={`flex items-center gap-1.5 whitespace-nowrap text-xs select-none px-1.5 py-1 rounded transition-colors ${
            canEdit ? "cursor-pointer hover:bg-muted/50 text-muted-foreground hover:text-foreground" : "opacity-50 cursor-not-allowed text-muted-foreground"
          }`}
          title={cascadeDrag ? t("project:mindMap.cascade.on") : t("project:mindMap.cascade.off")}
        >
          <Checkbox
            checked={cascadeDrag}
            onCheckedChange={(checked) => handleToggleCascadeDrag(!!checked)}
            disabled={!canEdit}
            className="h-3.5 w-3.5"
            aria-label={t("project:mindMap.cascade.aria")}
          />
          <span className="flex items-center gap-1 font-medium">
            <GitFork className={`h-3.5 w-3.5 ${cascadeDrag ? "text-primary" : "text-muted-foreground"}`} />
            {t("project:mindMap.cascade.label")}
          </span>
        </label>

        <div className="hidden sm:block h-4 w-px bg-border" />

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setIsDrawerOpen(!isDrawerOpen)}
          className={'h-7 text-xs gap-1.5 whitespace-nowrap ' + (isDrawerOpen ? "bg-muted text-primary" : "")}
          title={t("project:mindMap.library.tooltip")}
        >
          <PanelRight className="h-3.5 w-3.5" />
          {t("project:mindMap.library.toggle", { n: rawNodes.filter((n) => n.cardId).length })}
        </Button>

        <div className="hidden sm:block h-4 w-px bg-border" />

        <Button
          ref={fullscreenButtonRef}
          size="sm"
          variant="ghost"
          onClick={() => {
            if (isFullscreen) exitFullscreen();
            else setIsFullscreen(true);
            setTimeout(() => fitView({ padding: 0.3 }), 100);
          }}
          className="h-7 text-xs gap-1 whitespace-nowrap"
          title={isFullscreen ? t("project:mindMap.fullscreen.exit") : t("project:mindMap.fullscreen.enter")}
        >
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {isFullscreen ? t("project:mindMap.fullscreen.exit") : t("project:mindMap.fullscreen.label")}
        </Button>

        <div className="hidden sm:block h-4 w-px bg-border" />

        <Button
          size="sm"
          variant="ghost"
          onClick={() => exportMindMapAsPng(nodes as any, edges, `mindmap-${projectId}.png`)}
          className="h-7 text-xs gap-1 whitespace-nowrap text-muted-foreground hover:text-foreground"
          title={t("project:mindMap.export.png.tooltip")}
        >
          <ImageIcon className="h-3.5 w-3.5" />
          PNG
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => exportMindMapAsSvg(nodes as any, edges, `mindmap-${projectId}.svg`)}
          className="h-7 text-xs gap-1 whitespace-nowrap text-muted-foreground hover:text-foreground"
          title={t("project:mindMap.export.svg.tooltip")}
        >
          <Download className="h-3.5 w-3.5" />
          SVG
        </Button>
      </div>

      {/* 核心畫布 */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={2.0}
        attributionPosition="bottom-left"
        defaultEdgeOptions={{ type: "bezier" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} className="opacity-40" />
        <Controls className="bg-background/80 backdrop-blur border shadow-md rounded-lg" />
        <MiniMap
          // 縮圖的方塊依分支上色：內建的 MiniMap **不畫邊也不畫字**（@xyflow/react 12 的
          // MiniMap 只渲染節點矩形與視埠遮罩，`MiniMapProps` 沒有任何 edge 相關 prop），
          // 預設的單色方塊看不出結構；`branchColor` 是畫布節點本來就有的欄位（根為靛藍、
          // 其餘依分支序取自 BRANCH_COLORS）。原本傳的 `nodeStrokeWidth={3}` 是空轉的
          // ——`nodeStrokeColor` 預設 transparent，沒有顏色就沒有可見的邊框。
          nodeColor={(n) => (n.data as MindMapNodeData).branchColor}
          zoomable
          pannable
          className="bg-background/80 backdrop-blur border shadow-md rounded-lg"
        />
      </ReactFlow>

      {/* 右側卡片庫抽屜 (Card Library Drawer) */}
      {isDrawerOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-80 bg-background/95 backdrop-blur-md border-l shadow-2xl z-20 flex flex-col animate-in slide-in-from-right duration-200">
          <div className="p-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <PanelRight className="h-4 w-4 text-primary" />
              <span className="font-semibold text-sm">{t("project:mindMap.library.title")}</span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 rounded-full"
              aria-label={t("project:mindMap.library.close")}
              onClick={() => setIsDrawerOpen(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {drawerTruncated && (
            <div className="px-3 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 border-b bg-amber-500/5">
              {t("project:cards.truncated", { shown: drawerLoadedCount, total: drawerTotalCount })}
            </div>
          )}

          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t("project:mindMap.library.search.placeholder")}
                value={cardSearchQuery}
                onChange={(e) => setCardSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {filteredCards.map((card: any) => {
              const boundNode = rawNodes.find((n) => n.cardId === card.id);
              return (
                <div
                  key={card.id}
                  className="p-2.5 rounded-lg border bg-card hover:border-primary/50 transition-all text-xs space-y-1.5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-1">
                    <span className={'font-medium ' + (card.completedAt ? "line-through text-muted-foreground" : "text-foreground")}>
                      {card.title}
                    </span>
                    {card.completedAt ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                    )}
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t">
                    <span>{card.boardName} / {card.listName}</span>
                    {boundNode ? (
                      <Badge variant="secondary" className="text-[10px] h-4 px-1">
                        {t("project:mindMap.library.bound", { title: boundNode.title })}
                      </Badge>
                    ) : canEdit && onCreateNodeFromCard ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-5 text-[10px] px-1.5 py-0 gap-0.5 hover:bg-primary hover:text-primary-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCreateNodeFromCard(card.id, card.title);
                        }}
                      >
                        <Plus className="h-2.5 w-2.5" />
                        {t("project:mindMap.library.convert")}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground/60">{t("project:mindMap.library.unbound")}</span>
                    )}
                  </div>
                </div>
              );
            })}
            {filteredCards.length === 0 && (
              <div className="p-6 text-center text-xs text-muted-foreground">
                {t("project:mindMap.library.noMatch")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function MindMapCanvas(props: MindMapCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}
