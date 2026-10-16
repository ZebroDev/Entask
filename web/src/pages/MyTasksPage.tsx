import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { CardDialog } from "./board/CardDialog";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Calendar,
  AlertTriangle,
  Clock,
  ShieldCheck,
  CheckSquare,
  Sparkles,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { formatDate } from "@/lib/format";
import { useTranslation } from "react-i18next";

interface MyWorkCardItem {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  boardId: string;
  boardName: string;
  listId: string;
  listName: string;
  dueAt: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  labels: string[];
  checklistTotal: number;
  checklistCompleted: number;
}

interface MyPendingReviewItem {
  cardId: string;
  cardTitle: string;
  projectId: string;
  projectName: string;
  boardId: string;
  boardName: string;
  dueAt: string | null;
  status: string;
}

interface MyWorkResponse {
  assignedCards: MyWorkCardItem[];
  pendingReviews: MyPendingReviewItem[];
  stats: {
    totalAssigned: number;
    dueToday: number;
    overdue: number;
    inProgress: number;
    completed: number;
    pendingReviews: number;
  };
}

type TabType = "all" | "today" | "overdue" | "reviews" | "completed";

export function MyTasksPage() {
  const { t } = useTranslation(["common", "me"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["my-work"],
    queryFn: async () => (await api.get("/me/work")).data as MyWorkResponse,
  });

  // 抽成一個陳述式而不是就地寫在下面那個 t() 的 options 裡——**i18next-parser
  // 看不到巢狀的 t()**（外層 options 物件裡的第二次呼叫會被漏掉），而
  // `keepRemoved: false` 會因此把 `common:error.tryLater` 從語系檔刪掉，
  // 畫面只顯示 key 本身。B2-2b 實測到的。
  const loadErrorDetail = apiErrorMessage(error, t("common:error.tryLater"));

  const toggleCompletion = useMutation({
    mutationFn: ({ cardId, isCompleted }: { cardId: string; isCompleted: boolean }) =>
      api.put(`/cards/${cardId}/completion`, { isCompleted }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-work"] });
      queryClient.invalidateQueries({ queryKey: ["board"] });
      queryClient.invalidateQueries({ queryKey: ["cards"] });
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err, t("common:error.operation")));
    },
  });

  const stats = data?.stats ?? {
    totalAssigned: 0,
    dueToday: 0,
    overdue: 0,
    inProgress: 0,
    completed: 0,
    pendingReviews: 0,
  };

  const cards = data?.assignedCards ?? [];
  const reviews = data?.pendingReviews ?? [];

  const filteredCards = cards.filter((c) => {
    if (activeTab === "all") return !c.completedAt;
    if (activeTab === "today") {
      if (!c.dueAt || c.completedAt) return false;
      const today = new Date();
      const dueDate = new Date(c.dueAt);
      return (
        dueDate.getFullYear() === today.getFullYear() &&
        dueDate.getMonth() === today.getMonth() &&
        dueDate.getDate() === today.getDate()
      );
    }
    if (activeTab === "overdue") return c.isOverdue;
    if (activeTab === "completed") return !!c.completedAt;
    return true;
  });

  return (
    <div className="container max-w-6xl py-6 px-4 md:px-6 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            {t("common:nav.myTasks")}
            <Sparkles className="h-5 w-5 text-primary animate-pulse" />
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            {t("me:page.description")}
          </p>
        </div>
      </div>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => setActiveTab("today")}
          className={`w-full text-left focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer rounded-xl border p-4 transition-all hover:shadow-xs ${
            activeTab === "today" ? "bg-primary/5 ring-1 ring-primary" : "bg-card hover:bg-muted/40"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t("common:filter.dueToday")}</span>
            <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Calendar className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">{stats.dueToday}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t("me:stat.dueToday.hint")}</p>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("overdue")}
          className={`w-full text-left focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer rounded-xl border p-4 transition-all hover:shadow-xs ${
            activeTab === "overdue" ? "bg-destructive/5 ring-1 ring-destructive" : "bg-card hover:bg-muted/40"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t("common:state.overdue")}</span>
            <div className="p-1.5 rounded-lg bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-destructive">{stats.overdue}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t("me:stat.overdue.hint")}</p>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("reviews")}
          className={`w-full text-left focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer rounded-xl border p-4 transition-all hover:shadow-xs ${
            activeTab === "reviews" ? "bg-amber-500/10 ring-1 ring-amber-500" : "bg-card hover:bg-muted/40"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t("me:filter.reviews")}</span>
            <div className="p-1.5 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <ShieldCheck className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">{stats.pendingReviews}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t("me:stat.reviews.hint")}</p>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("all")}
          className={`w-full text-left focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer rounded-xl border p-4 transition-all hover:shadow-xs ${
            activeTab === "all" ? "bg-primary/5 ring-1 ring-primary" : "bg-card hover:bg-muted/40"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t("me:stat.inProgress.label")}</span>
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
              <Clock className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">{stats.inProgress}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t("me:stat.inProgress.hint")}</p>
        </button>
      </div>

      {/* Tabs Filter Bar */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-3">
        <Button
          size="sm"
          variant={activeTab === "all" ? "default" : "ghost"}
          className="h-8 text-xs rounded-full"
          onClick={() => setActiveTab("all")}
        >
          {t("me:tab.inProgress", { count: stats.inProgress })}
        </Button>
        <Button
          size="sm"
          variant={activeTab === "today" ? "default" : "ghost"}
          className="h-8 text-xs rounded-full"
          onClick={() => setActiveTab("today")}
        >
          {t("me:tab.dueToday", { count: stats.dueToday })}
        </Button>
        <Button
          size="sm"
          variant={activeTab === "overdue" ? "default" : "ghost"}
          className="h-8 text-xs rounded-full text-destructive hover:text-destructive"
          onClick={() => setActiveTab("overdue")}
        >
          {t("me:tab.overdue", { count: stats.overdue })}
        </Button>
        <Button
          size="sm"
          variant={activeTab === "reviews" ? "default" : "ghost"}
          className="h-8 text-xs rounded-full gap-1.5"
          onClick={() => setActiveTab("reviews")}
        >
          {t("me:filter.reviews")}
          {stats.pendingReviews > 0 && (
            <span className="h-4 px-1.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-bold flex items-center justify-center ring-1 ring-inset ring-amber-500/20">
              {stats.pendingReviews}
            </span>
          )}
        </Button>
        <Button
          size="sm"
          variant={activeTab === "completed" ? "default" : "ghost"}
          className="h-8 text-xs rounded-full text-muted-foreground"
          onClick={() => setActiveTab("completed")}
        >
          {t("me:tab.completed", { count: stats.completed })}
        </Button>
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-xl border bg-muted/20 animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <div className="p-6 rounded-xl border border-destructive/30 bg-destructive/5 text-destructive flex items-center justify-between">
          <span>{t("me:error.loadDetail", { detail: loadErrorDetail })}</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {t("common:action.retry")}
          </Button>
        </div>
      ) : activeTab === "reviews" ? (
        // Pending Reviews Tab
        reviews.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-8 w-8 text-emerald-500" />}
            title={t("me:reviews.empty.title")}
            description={t("me:reviews.empty.description")}
          />
        ) : (
          <div className="space-y-2">
            {/* 與卡片列一致：外框是滑鼠的點擊範圍，鍵盤與螢幕閱讀器則由列內的
                「進入審核」按鈕取得語意與焦點。外框不再掛 role="button"，
                避免 button 內含 button 的無效巢狀。 */}
            {reviews.map((r) => (
              <div
                key={r.cardId}
                className="w-full text-left group flex items-center justify-between p-3.5 rounded-xl border bg-card hover:bg-muted/40 transition-all cursor-pointer shadow-2xs"
                onClick={() => setOpenCardId(r.cardId)}
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                        {r.cardTitle}
                      </span>
                      <Badge variant="outline" className="text-[10px] text-amber-600 bg-amber-500/10 border-amber-500/20">
                        {t("me:review.pending.badge")}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{r.projectName}</span>
                      <span>/</span>
                      <span>{r.boardName}</span>
                    </div>
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs gap-1 opacity-80 group-hover:opacity-100"
                  onClick={() => setOpenCardId(r.cardId)}
                >
                  {t("me:review.open.action")} <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )
      ) : (
        // Cards Tab (All, Today, Overdue, Completed)
        filteredCards.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-8 w-8 text-emerald-500" />}
            title={t("me:cards.empty.title")}
            description={
              activeTab === "completed"
                ? t("me:cards.empty.completed")
                : t("me:cards.empty.all")
            }
          />
        ) : (
          <div className="space-y-2">
            {/* 卡片列內含「完成勾選」與「開啟看板」兩顆真正的按鈕，外框因此不可再是
                button（巢狀互動元素會讓螢幕閱讀器不暴露內層控制項）。滑鼠點列任一處
                仍可開啟詳情；鍵盤與螢幕閱讀器改用標題按鈕取得語意與焦點。 */}
            {filteredCards.map((c) => {
              const isCompleted = !!c.completedAt;
              return (
                <div
                  key={c.id}
                  className={`group flex items-center justify-between p-3.5 rounded-xl border bg-card hover:bg-muted/40 transition-all cursor-pointer shadow-2xs ${
                    isCompleted ? "opacity-60 bg-muted/20" : ""
                  }`}
                  onClick={() => setOpenCardId(c.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Completion Checkbox */}
                    <button
                      type="button"
                      className={`h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                        isCompleted
                          ? "bg-green-600 border-green-600 text-white"
                          : "border-muted-foreground/30 hover:border-primary hover:bg-primary/5"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCompletion.mutate({ cardId: c.id, isCompleted: !isCompleted });
                      }}
                      title={isCompleted ? t("me:card.markIncomplete") : t("me:card.markComplete")}
                    >
                      {isCompleted && <CheckCircle2 className="h-3.5 w-3.5 stroke-[3]" />}
                    </button>

                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {/* 不掛 onClick：按下後冒泡至外框的 onClick 開啟卡片，避免重複處理 */}
                        <button
                          type="button"
                          className={`text-left rounded text-sm font-medium text-foreground truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            isCompleted ? "line-through text-muted-foreground" : "group-hover:text-primary"
                          }`}
                        >
                          {c.title}
                        </button>

                        {c.labels.map((l) => (
                          <span
                            key={l}
                            className="hidden sm:inline-block px-1.5 py-0.2 text-[10px] rounded bg-muted text-muted-foreground font-medium"
                          >
                            {l}
                          </span>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate max-w-[120px] sm:max-w-[200px]">
                          {c.projectName} / {c.boardName} ({c.listName})
                        </span>

                        {c.dueAt && (
                          <span
                            className={`flex items-center gap-1 text-[11px] font-medium ${
                              c.isOverdue ? "text-destructive font-bold" : ""
                            }`}
                          >
                            <Calendar className="h-3 w-3" />
                            {formatDate(c.dueAt)}
                            {c.isOverdue && t("me:card.overdue.suffix")}
                          </span>
                        )}

                        {c.checklistTotal > 0 && (
                          <span className="flex items-center gap-1 text-[11px]">
                            <CheckSquare className="h-3 w-3" />
                            {c.checklistCompleted}/{c.checklistTotal}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      aria-label={t("me:card.openBoard.aria")}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/projects/${c.projectId}/boards/${c.boardId}/cards/${c.id}`);
                      }}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Card Detail Dialog */}
      {openCardId && (
        <CardDialog
          cardId={openCardId}
          projectId={
            cards.find((c) => c.id === openCardId)?.projectId ??
            reviews.find((r) => r.cardId === openCardId)?.projectId
          }
          open={!!openCardId}
          onOpenChange={(open) => {
            if (!open) {
              setOpenCardId(null);
              queryClient.invalidateQueries({ queryKey: ["my-work"] });
            }
          }}
        />
      )}
    </div>
  );
}
