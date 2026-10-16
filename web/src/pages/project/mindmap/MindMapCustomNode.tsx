import React, { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Plus, Link as LinkIcon, Trash2, Edit3, CheckCircle2, FileText } from "lucide-react";
import { ReviewStateIcon } from "@/components/ReviewStateIcon";
import type { ReviewState } from "@/lib/review-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

export interface MindMapNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  note: string | null;
  // completedAt 由 MindMapCardSummary 而來（非 optional——欄位名不符會在此編譯失敗）
  card: { id: string; title: string; completedAt: string | null; reviewState: ReviewState } | null;
  isRoot: boolean;
  depth: number;
  branchColor: string;
  canEdit: boolean;
  onAddChild: (parentId: string) => void;
  onBindCard: (nodeId: string) => void;
  onEdit: (nodeId: string, title: string, note: string | null) => void;
  onDelete: (nodeId: string) => void;
  onOpenCard: (cardId: string) => void;
}

// 操作列的鍵盤（2026-09-27）：對 Tab 而言，一個節點只有**一個**停留點——React Flow 的
// 節點 wrapper（`nodesFocusable` 預設 true 時它自己帶 `tabIndex=0`）。底下這 4 顆靠 `→`
// 進來、`←` 出去；它們的 `tabIndex={-1}` 就是「收斂」本身。
//
// ★ `stopPropagation()` 是必要的，不是保險：React Flow 對**已選取**節點上的方向鍵會
//   `preventDefault()` 並移動該節點（`@xyflow/react/dist/esm/index.js:2317-2330`），
//   而它的處理器掛在節點 wrapper（本容器的祖先）⇒ 不放行才輪得到我們的列內移動。
function handleActionBarKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  e.stopPropagation();
  const widgets = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-node-widget]"));
  const index = widgets.indexOf(e.target as HTMLElement);
  const backToNode = () => e.currentTarget.closest<HTMLElement>(".react-flow__node")?.focus();

  if (e.key === "Escape" || (e.key === "ArrowLeft" && index <= 0)) {
    e.preventDefault();
    backToNode();
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    widgets[index < 0 ? 0 : Math.min(index + 1, widgets.length - 1)]?.focus();
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    widgets[index - 1]?.focus();
  }
}

export const MindMapCustomNode = memo(({ data }: NodeProps<any>) => {
  const { t } = useTranslation(["project"]);
  const nodeData = data as MindMapNodeData;
  // **`t()` 不能巢狀寫在另一個 `t()` 的選項物件裡**（B2-5b 實測）。
  //
  // `i18next-parser` 不會把巢狀的呼叫抽成獨立的 key，而 `keepRemoved: false`
  // 會把「原始碼裡找不到」的 key 從語系檔刪掉——tooltip 於是把
  // `project:mindMap.node.card.completed` 這個字串本身印出來，而 zh-TW 的測試、
  // `tsc -b`、parity **全都不會紅**（唯一會響的是 CI 的 `--fail-on-update`，
  // 而它的訊息指向語系檔、不指向肇因）。提到外面就沒事了。
  const cardCompletedLabel = t("project:mindMap.node.card.completed");
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(nodeData.title);

  const handleSave = () => {
    if (editTitle.trim() && editTitle !== nodeData.title) {
      nodeData.onEdit(nodeData.id, editTitle.trim(), nodeData.note);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      // ★ `preventDefault()` 是必要的，不是防禦性寫法：全螢幕浮層在 document 上聽 Escape，
      //   判別式是 `event.defaultPrevented`（Radix 處理巢狀對話框用的同一個協定）。
      //   少了這一行，這顆按鍵冒泡上去會被當成「沒有人處理過」⇒ 取消編輯的**同一次**
      //   按鍵也退出全螢幕（2026-09-25 複閱以瀏覽器探針實測；守門員是
      //   `mindmap-tab.test.tsx` 的「節點內嵌編輯中的 Escape 只取消編輯、不退全螢幕」）。
      e.preventDefault();
      setEditTitle(nodeData.title);
      setIsEditing(false);
    }
  };

  return (
    <div className="relative group">
      {/* Target handle on the left (only if not root) */}
      {!nodeData.isRoot && (
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2 !h-2 !bg-muted-foreground !border-background"
        />
      )}

      {/* Main Node Card */}
      <div
        className={`rounded-xl px-4 py-2.5 shadow-md border transition-all duration-200 min-w-[140px] max-w-[260px] ${
          nodeData.isRoot
            ? "bg-gradient-to-r from-primary to-primary/80 text-primary-foreground font-bold shadow-lg ring-2 ring-primary/20"
            : "bg-card text-card-foreground hover:shadow-lg hover:border-primary/50"
        }`}
        style={!nodeData.isRoot ? { borderLeftWidth: "4px", borderLeftColor: nodeData.branchColor } : {}}
      >
        {isEditing ? (
          <div className="flex items-center gap-1">
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSave}
              autoFocus
              className="h-7 text-xs bg-background text-foreground"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div
              className={`text-sm font-semibold truncate cursor-pointer select-none ${
                nodeData.isRoot ? "text-primary-foreground text-base" : "text-foreground"
              }`}
              onDoubleClick={() => nodeData.canEdit && setIsEditing(true)}
              title={nodeData.title}
            >
              {nodeData.title}
            </div>

            {nodeData.note && (
              <p className="text-[11px] text-muted-foreground line-clamp-1 italic">
                {nodeData.note}
              </p>
            )}

            {/* Bound Card Badge */}
            {/* 節點卡片的 tooltip 由兩條譯文拼成：外層是句子，內層是完成狀態的
                括號後綴。內層的空字串是「未完成」那一支，不是漏譯——`{{status}}`
                在那一支就該是空的。 */}
            {nodeData.card && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  nodeData.onOpenCard(nodeData.card!.id);
                }}
                className="mt-1 flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/80 hover:bg-secondary text-secondary-foreground text-xs cursor-pointer border border-border transition-colors truncate"
                title={t("project:mindMap.node.card.tooltip", {
                  title: nodeData.card.title,
                  status: nodeData.card.completedAt ? cardCompletedLabel : "",
                })}
              >
                {nodeData.card.completedAt ? (
                  <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400 shrink-0" />
                ) : (
                  <FileText className="h-3 w-3 text-primary shrink-0" />
                )}
                <span className={`truncate font-medium ${nodeData.card.completedAt ? "line-through text-muted-foreground" : ""}`}>
                  {nodeData.card.title}
                </span>
                {nodeData.card.reviewState && <ReviewStateIcon state={nodeData.card.reviewState} />}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hover Action Floating Bar */}
      {nodeData.canEdit && (
        <div
          onKeyDown={handleActionBarKeyDown}
          className="absolute -top-3 right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity duration-150 flex items-center gap-0.5 bg-background/90 backdrop-blur border rounded-full px-1.5 py-0.5 shadow-sm z-10">
          <Button
            size="icon"
            variant="ghost"
            data-node-widget=""
            tabIndex={-1}
            className="h-6 w-6 rounded-full hover:bg-primary/10 hover:text-primary"
            onClick={(e) => {
              e.stopPropagation();
              nodeData.onAddChild(nodeData.id);
            }}
            title={t("project:mindMap.node.addChild")}
          >
            <Plus className="h-3 w-3" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            data-node-widget=""
            tabIndex={-1}
            className="h-6 w-6 rounded-full hover:bg-primary/10 hover:text-primary"
            onClick={(e) => {
              e.stopPropagation();
              nodeData.onBindCard(nodeData.id);
            }}
            title={nodeData.card ? t("project:mindMap.bind.change") : t("project:mindMap.bind.action")}
          >
            <LinkIcon className="h-3 w-3" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            data-node-widget=""
            tabIndex={-1}
            className="h-5 w-5 rounded-full hover:bg-primary/10 hover:text-primary"
            onClick={(e) => {
              e.stopPropagation();
              setIsEditing(true);
            }}
            title={t("project:mindMap.node.edit")}
          >
            <Edit3 className="h-2.5 w-2.5" />
          </Button>

          {!nodeData.isRoot && (
            <Button
              size="icon"
              variant="ghost"
              data-node-widget=""
              tabIndex={-1}
              className="h-5 w-5 rounded-full hover:bg-destructive/10 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                nodeData.onDelete(nodeData.id);
              }}
              title={t("project:mindMap.node.delete")}
            >
              <Trash2 className="h-2.5 w-2.5" />
            </Button>
          )}
        </div>
      )}

      {/* Source handle on the right */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-primary !border-background"
      />
    </div>
  );
});

MindMapCustomNode.displayName = "MindMapCustomNode";
