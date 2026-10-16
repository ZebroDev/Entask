import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clock } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { useAttachmentImage } from "@/hooks/use-attachment-image";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { BoardCardResponse, LabelResponse, ProjectMemberResponse } from "@/lib/board-types";
import { useTranslation } from "react-i18next";
import { REVIEW_BADGE_CLASS, REVIEW_BADGE_SHELL, reviewStateLabel } from "@/lib/review-badge";

function labelTextColor(bgColor: string): string {
  const hex = bgColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? 'text-gray-900' : 'text-white';
}

// 卡片視覺（無 dnd hooks）——同時用於列表內卡片與 DragOverlay，
// 避免 overlay 再次註冊同 id 的 useSortable
function CardFace({ card, onToggleCompletion }: { card: BoardCardResponse; onToggleCompletion?: (cardId: string, isCompleted: boolean) => void }) {
  const { boardId, projectId } = useParams();
  // 完成鈕的 tooltip 在 CardFace（BoardCard 與 BoardCardOverlay 共用），t 要在這一層拿
  const { t } = useTranslation(["card", "common"]);

  const coverUrl = useAttachmentImage(card.coverAttachmentId);

  const labels = useQuery({
    queryKey: ["board-labels", boardId],
    queryFn: async () => (await api.get(`/boards/${boardId}/labels`)).data as LabelResponse[],
    enabled: card.labels.length > 0,
  });
  const labelItems = (labels.data ?? []).filter((l) => card.labels.includes(l.id));

  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/members`)).data as ProjectMemberResponse[],
    enabled: card.members.length > 0,
  });
  // 已停用的成員**仍然顯示頭像**（名冊刻意不過濾——見設計 D7），只是淡化，
  // 讓「他還在指派上、但不能再被指派」看得出來。過濾掉的話：`card.members` 是裸 GUID，
  // 交集少一邊 ⇒ 頭像靜默消失，而且他的 GUID 從此沒有 UI 可以發出去（卡片成員是全量替換）。
  const memberItems = (members.data ?? []).filter((m) => card.members.includes(m.userId));

  return (
    <>
      {coverUrl && <img src={coverUrl} alt="" className="mb-2 h-24 w-full rounded object-cover" />}
      {labelItems.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {labelItems.map((l) => (
            <span key={l.id} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${labelTextColor(l.color)}`} style={{ backgroundColor: l.color }}>
              {l.name}
            </span>
          ))}
        </div>
      )}
      {card.reviewState && (
        <div className="mb-1">
          <span className={`${REVIEW_BADGE_SHELL} ${REVIEW_BADGE_CLASS[card.reviewState]}`}>
            {reviewStateLabel(t, card.reviewState)}
          </span>
        </div>
      )}
      <div className="flex items-start justify-between gap-1.5">
        <p className={`text-sm flex-1 ${card.completedAt ? 'line-through text-muted-foreground' : ''}`}>
          {card.title}
        </p>
        <div
          className={`shrink-0 h-4 w-4 mt-0.5 rounded border flex items-center justify-center transition-all ${
            card.completedAt
              ? "bg-green-600 border-green-600 text-white opacity-100"
              : "border-muted-foreground/40 hover:border-primary opacity-100"
          }`}
          title={card.completedAt ? t("card:completion.unmark.tooltip") : t("card:completion.shortcut.tooltip")}
          onClick={(e) => { e.stopPropagation(); onToggleCompletion?.(card.id, !card.completedAt); }}
          role="checkbox"
          aria-checked={!!card.completedAt}
        >
          {card.completedAt && <Check className="h-2.5 w-2.5 stroke-[3]" />}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {card.checklistTotal > 0 && (
            <span className="flex items-center gap-0.5">
              <Check className="h-3 w-3" /> {card.checklistDone}/{card.checklistTotal}
            </span>
          )}
          {card.dueAt && (
            <span className={`flex items-center gap-0.5 ${!card.completedAt && card.isOverdue ? "text-destructive font-medium" : ""}`}>
              <Clock className="h-3 w-3" /> {formatDate(card.dueAt)}
            </span>
          )}
        </div>
        
        {memberItems.length > 0 && (
          <div className="flex -space-x-2">
              {memberItems.map(m => (
                <Avatar
                  key={m.userId}
                  className={`h-5 w-5 border border-background ${m.deactivated ? "opacity-40" : ""}`}
                  title={m.deactivated ? t("common:state.deactivated") : undefined}
                >
                  {m.avatarUrl ? (
                    <AvatarImage src={m.avatarUrl} alt={m.displayName} />
                  ) : (
                    <AvatarFallback className="text-[9px]">{m.displayName?.charAt(0) || m.username?.charAt(0).toUpperCase()}</AvatarFallback>
                  )}
                </Avatar>
              ))}
          </div>
        )}
      </div>
    </>
  );
}

// #22：React.memo——board cache 更新僅 patch 受影響列表時，其餘卡不重繪。
// dnd props（attributes/listeners）在元件內經 hooks 取得，不受 memo 影響（ref 已外掛）
export const BoardCard = memo(function BoardCard({ card, disabled }: { card: BoardCardResponse; disabled?: boolean }) {
  const { t } = useTranslation(["common"]);
  const { projectId, boardId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const toggleCompletion = useMutation({
    mutationFn: ({ cardId, isCompleted }: { cardId: string; isCompleted: boolean }) =>
      api.put(`/cards/${cardId}/completion`, { isCompleted }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board", boardId] });
      queryClient.invalidateQueries({ queryKey: ["project-cards"] });
      queryClient.invalidateQueries({ queryKey: ["my-work"] });
    },
    onError: (err: any) => {
      toast.error(apiErrorMessage(err, t("common:error.toggleCompletion")));
    },
  });
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: card.id, disabled });

  const openCard = () => navigate(`/projects/${projectId}/boards/${boardId}/cards/${card.id}`);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="group cursor-pointer rounded-lg border border-border/80 bg-card p-2.5 shadow-2xs hover:shadow-xs hover:border-border hover:-translate-y-0.5 transition-all duration-150"
      onClick={openCard}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        // 拖曳中全轉交 dnd（含 drop 的 Space/Enter）
        if (isDragging) {
          listeners?.onKeyDown?.(e);
          return;
        }
        // 修飾鍵組合（Shift/Alt/Ctrl/Meta）轉交 dnd，啟動鍵盤拖曳
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
          listeners?.onKeyDown?.(e);
          return;
        }
        if (e.key === "x" || e.key === "X") {
          e.preventDefault();
          toggleCompletion.mutate({ cardId: card.id, isCompleted: !card.completedAt });
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.key === " ") e.preventDefault();
        openCard();
      }}
    >
      {/* 置於 {...listeners} 之後：dnd 預設 KeyboardSensor 以 onKeyDown 啟動鍵盤拖曳，
          純 Enter/Space 開卡；修飾鍵組合或拖曳中轉交 dnd，鍵盤開啟與鍵盤拖曳並存 */}
      <CardFace card={card} onToggleCompletion={(cardId, isCompleted) => toggleCompletion.mutate({ cardId, isCompleted })} />
    </div>
  );
});

export function BoardCardOverlay({ card }: { card: BoardCardResponse }) {
  return (
    <div className="w-72 p-2">
      <div className="rounded-lg border bg-card p-2.5 shadow-xl ring-2 ring-primary/20 rotate-1">
        <CardFace card={card} />
      </div>
    </div>
  );
}
