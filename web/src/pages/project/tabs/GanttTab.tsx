import { useState, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  AlertCircle,
  CheckCircle2,
  Layers,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatHours, formatMonthYear, monthLabelCandidates, pickMonthLabel } from "@/lib/format";
import { CARD_PAGE_SIZE } from "@/lib/card-paging";
import { ReviewStateIcon } from "@/components/ReviewStateIcon";
import type { ReviewState } from "@/lib/review-badge";
import { measureTextWidth } from "@/lib/text-measure";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CardDialog } from "../../board/CardDialog";
import { useTranslation } from "react-i18next";

export interface ProjectCardItem {
  id: string;
  title: string;
  boardId: string;
  boardName: string;
  listId: string;
  listName: string;
  startAt: string | null;
  dueAt: string | null;
  completedAt?: string | null;
  isOverdue: boolean;
  isArchived: boolean;
  assignees: { userId: string; username: string; displayName: string }[];
  labelNames: string[];
  estimatedHours: number | null;
  loggedHours: number;
  checklistProgress: { total: number; completed: number };
  reviewState: ReviewState;
}

/**
 * 分組的**識別碼**。`groupTitle` 只在標題是**資料**（看板名、成員名）時才有值；
 * 需要翻譯的那一組留空，由 render 端決定（切換語系才會跟著變）。
 */
interface GanttGroup {
  groupKey: string;
  groupTitle?: string;
  cards: ProjectCardItem[];
}

/**
 * 「未指派」那一組的 Map 鍵。**刻意不是顯示字**：同一個字串若同時當鍵與顯示字，
 * 把顯示字換成譯文就會讓鍵也跟著語系跑（切一次語系就多一組分組）。
 * 值本身不對外——它只活在 `groupedCards` 的內部，`groupKey` 也用它，但沒有任何
 * 顯示路徑會把它印出來。
 */
const UNASSIGNED = "__unassigned__";

interface GanttTabProps {
  projectId: string;
  canEdit: boolean;
  onOpenCard?: (cardId: string) => void;
}

type ViewMode = "day" | "week" | "month";
type GroupBy = "none" | "board" | "assignee";

// 月份標頭的量測基準。font 必須與下方月份列的 className（text-xs font-semibold）一致，
// 否則量測到的字寬與實際渲染不符，退級時機會不準。
const MONTH_LABEL_FONT = "600 12px ui-sans-serif, system-ui, sans-serif";
// 該列 class 的 px-2：左右各 8px，需自 spanDays * dayWidth 中扣除
const MONTH_LABEL_PADDING_PX = 16;

function monthStart(seg: { year: number; month: number }): Date {
  return new Date(seg.year, seg.month - 1, 1);
}

function measureMonthLabel(text: string): number {
  return measureTextWidth(text, MONTH_LABEL_FONT);
}

export function GanttTab({ projectId }: GanttTabProps) {
  const { t } = useTranslation(["project"]);
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [groupBy, setGroupBy] = useState<GroupBy>("board");
  const [boardFilter, setBoardFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [includeArchived, setIncludeArchived] = useState<boolean>(false);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [showUnscheduled, setShowUnscheduled] = useState<boolean>(true);

  // Timeline base anchor (default start: 7 days before today)
  const [baseDate, setBaseDate] = useState<Date>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 5);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const leftPanelRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const isSyncing = useRef(false);

  const handleLeftScroll = () => {
    if (isSyncing.current) return;
    isSyncing.current = true;
    if (timelineContainerRef.current && leftPanelRef.current) {
      timelineContainerRef.current.scrollTop = leftPanelRef.current.scrollTop;
    }
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  };

  const handleRightScroll = () => {
    if (isSyncing.current) return;
    isSyncing.current = true;
    if (leftPanelRef.current && timelineContainerRef.current) {
      leftPanelRef.current.scrollTop = timelineContainerRef.current.scrollTop;
    }
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  };

  // Fetch project cards
  const { data, isLoading } = useQuery({
    queryKey: ["project-cards-table", projectId, includeArchived],
    queryFn: () =>
      api
        .get<{ items: ProjectCardItem[]; total: number }>(
          `/projects/${projectId}/cards?pageSize=${CARD_PAGE_SIZE}&includeArchived=${includeArchived}`
        )
        .then((r) => r.data),
  });

  // 靜默截斷：伺服器端的 pageSize 上限就是 500（`ProjectCardEndpoints` 硬擋 >500），
  // 而甘特圖沒有分頁 UI ⇒ 超過 500 張的專案只拿得到前 500 張，畫面卻讀起來像「全部」。
  const loadedCount = data?.items?.length ?? 0;
  const totalCount = data?.total ?? 0;
  const truncated = totalCount > loadedCount;

  const allCards = useMemo(() => data?.items ?? [], [data?.items]);

  // Options for filtering
  const boards = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of allCards) map.set(c.boardId, c.boardName);
    return [...map.entries()];
  }, [allCards]);

  const assignees = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of allCards) {
      for (const a of c.assignees) map.set(a.userId, a.displayName || a.username);
    }
    return [...map.entries()];
  }, [allCards]);

  // Filtered cards
  const filteredCards = useMemo(() => {
    let list = allCards;
    if (boardFilter !== "all") list = list.filter((c) => c.boardId === boardFilter);
    if (assigneeFilter !== "all") {
      list = list.filter((c) => c.assignees.some((a) => a.userId === assigneeFilter));
    }
    return list;
  }, [allCards, boardFilter, assigneeFilter]);

  const scheduledCards = useMemo(
    () => filteredCards.filter((c) => !!c.dueAt),
    [filteredCards]
  );
  const unscheduledCards = useMemo(
    () => filteredCards.filter((c) => !c.dueAt),
    [filteredCards]
  );

  // Determine timeline span & cell width
  const totalDays = viewMode === "day" ? 45 : viewMode === "week" ? 90 : 180;
  const dayWidth = viewMode === "day" ? 44 : viewMode === "week" ? 22 : 12;
  const totalWidth = totalDays * dayWidth;

  // Generate calendar columns
  const calendarDays = useMemo(() => {
    const days: { date: Date; isToday: boolean; isWeekend: boolean; label: string }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(baseDate);
      d.setDate(baseDate.getDate() + i);
      const isToday = d.getTime() === today.getTime();
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;

      days.push({
        date: d,
        isToday,
        isWeekend,
        label: `${d.getDate()}`,
      });
    }
    return days;
  }, [baseDate, totalDays]);

  // Compute month segments for header
  const monthSegments = useMemo(() => {
    const segments: { year: number; month: number; startIdx: number; spanDays: number }[] = [];
    if (calendarDays.length === 0) return segments;
    let current = {
      year: calendarDays[0].date.getFullYear(),
      month: calendarDays[0].date.getMonth() + 1,
      startIdx: 0,
      spanDays: 1,
    };
    for (let i = 1; i < calendarDays.length; i++) {
      const d = calendarDays[i].date;
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (y === current.year && m === current.month) {
        current.spanDays++;
      } else {
        segments.push(current);
        current = { year: y, month: m, startIdx: i, spanDays: 1 };
      }
    }
    segments.push(current);
    return segments;
  }, [calendarDays]);

  // Today indicator offset
  const todayOffset = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = (today.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0 || diffDays > totalDays) return null;
    return diffDays * dayWidth + dayWidth / 2;
  }, [baseDate, totalDays, dayWidth]);

  // Navigation handlers
  const handlePrev = () => {
    setBaseDate((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() - (viewMode === "day" ? 14 : 30));
      return next;
    });
  };

  const handleNext = () => {
    setBaseDate((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + (viewMode === "day" ? 14 : 30));
      return next;
    });
  };

  const handleToday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 5);
    d.setHours(0, 0, 0, 0);
    setBaseDate(d);
  };

  // Calculate card bar coordinates
  const getCardBarCoords = (card: ProjectCardItem) => {
    if (!card.dueAt) return null;
    const dueDate = new Date(card.dueAt);
    dueDate.setHours(0, 0, 0, 0);

    // 未設開工時間：於截止日畫單日標記，不畫假跨度
    if (!card.startAt) {
      const dueDiff = (dueDate.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24);
      const isVisible = dueDiff >= 0 && dueDiff <= totalDays;
      return { left: Math.max(0, dueDiff * dayWidth), width: dayWidth * 0.8, isVisible, startDate: null, dueDate };
    }

    const startDate = new Date(card.startAt);
    startDate.setHours(0, 0, 0, 0);

    const startDiff = (startDate.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24);
    const endDiff = (dueDate.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24);

    const left = Math.max(0, startDiff * dayWidth);
    const width = Math.max(dayWidth * 0.8, (endDiff - startDiff + 1) * dayWidth);

    const isVisible = endDiff >= 0 && startDiff <= totalDays;
    return { left, width, isVisible, startDate, dueDate };
  };

  // Grouping cards
  //
  // **memo 裡只放識別碼，譯文留到 render**：`groupedCards` 的 deps 是資料，切換語系
  // 不會讓它重算，把 `t()` 放進來會讓標題凍結在切換當下的語系。
  // `未指派` 更麻煩一點——它同時是 Map 的**鍵**與顯示字，換成譯文的話鍵也會跟著
  // 語系跑，切一次語系就多出一組分組。所以鍵用哨兵值（`UNASSIGNED`），顯示時才分辨。
  const groupedCards = useMemo<GanttGroup[]>(() => {
    if (groupBy === "none") {
      // 這一支不需要標題：標題列只在 `groupBy !== "none"` 時渲染（見 render 端）。
      // 原本這裡有一個「所有時程任務」的字面值，從來沒有顯示過——抽成 key 只是把
      // 死碼換成死 key，所以直接刪掉（P-B2-5a）。
      return [{ groupKey: "all", cards: scheduledCards }];
    }
    if (groupBy === "board") {
      const groups: GanttGroup[] = [];
      const boardMap = new Map<string, ProjectCardItem[]>();
      for (const c of scheduledCards) {
        const arr = boardMap.get(c.boardName) || [];
        arr.push(c);
        boardMap.set(c.boardName, arr);
      }
      for (const [name, cards] of boardMap.entries()) {
        groups.push({ groupKey: name, groupTitle: name, cards });
      }
      return groups;
    }
    if (groupBy === "assignee") {
      const groups: GanttGroup[] = [];
      const assigneeMap = new Map<string, ProjectCardItem[]>();
      for (const c of scheduledCards) {
        if (c.assignees.length === 0) {
          const arr = assigneeMap.get(UNASSIGNED) || [];
          arr.push(c);
          assigneeMap.set(UNASSIGNED, arr);
        } else {
          for (const a of c.assignees) {
            const name = a.displayName || a.username;
            const arr = assigneeMap.get(name) || [];
            arr.push(c);
            assigneeMap.set(name, arr);
          }
        }
      }
      for (const [name, cards] of assigneeMap.entries()) {
        // 哨兵值那一組沒有標題——它的顯示字要留到 render 才決定語系。
        groups.push(name === UNASSIGNED ? { groupKey: name, cards } : { groupKey: name, groupTitle: name, cards });
      }
      return groups;
    }
    return [];
  }, [groupBy, scheduledCards]);

  const activeCardDetails = useMemo(() => {
    if (!openCardId) return null;
    return allCards.find((c) => c.id === openCardId);
  }, [openCardId, allCards]);

  return (
    <div className="flex flex-col flex-1 space-y-4">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3 bg-card p-3 sm:p-3.5 rounded-lg border shadow-sm">
        {/* Left: View Modes & Nav */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center border rounded-md p-0.5 bg-muted/40">
            <Button
              variant={viewMode === "day" ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2.5 whitespace-nowrap"
              onClick={() => setViewMode("day")}
            >
              {t("project:gantt.view.day")}
            </Button>
            <Button
              variant={viewMode === "week" ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2.5 whitespace-nowrap"
              onClick={() => setViewMode("week")}
            >
              {t("project:gantt.view.week")}
            </Button>
            <Button
              variant={viewMode === "month" ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2.5 whitespace-nowrap"
              onClick={() => setViewMode("month")}
            >
              {t("project:gantt.view.month")}
            </Button>
          </div>

          <div className="flex items-center gap-1 border rounded-md px-1 bg-background">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handlePrev} title={t("project:gantt.scrollBack")}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs px-2 whitespace-nowrap" onClick={handleToday}>
              {t("project:gantt.today")}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleNext} title={t("project:gantt.scrollForward")}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="text-xs font-semibold text-muted-foreground ml-1 whitespace-nowrap">
            {formatMonthYear(baseDate)}
          </div>
        </div>

        {/* Right: Group & Filter Controls */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* Group By */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            <span>{t("project:gantt.groupBy.label")}</span>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="board">{t("project:gantt.groupBy.board")}</SelectItem>
                <SelectItem value="assignee">{t("project:gantt.groupBy.assignee")}</SelectItem>
                <SelectItem value="none">{t("project:gantt.groupBy.none")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Board Filter */}
          <Select value={boardFilter} onValueChange={setBoardFilter}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder={t("project:gantt.filter.board")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("project:filter.allBoards")}</SelectItem>
              {boards.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Assignee Filter */}
          <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder={t("project:gantt.filter.member")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("project:filter.allMembers")}</SelectItem>
              {assignees.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Toggle Unscheduled */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 whitespace-nowrap"
            onClick={() => setShowUnscheduled((v) => !v)}
          >
            <Clock className="h-3.5 w-3.5 text-amber-500" />
            <span>{t("project:gantt.unscheduled.toggle", { n: unscheduledCards.length })}</span>
          </Button>

          <Button
            variant={includeArchived ? "secondary" : "outline"}
            size="sm"
            className="h-8 text-xs whitespace-nowrap"
            onClick={() => setIncludeArchived((v) => !v)}
          >
            {includeArchived ? t("project:gantt.includeArchived") : t("project:gantt.excludeArchived")}
          </Button>

          {truncated && (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
              {t("project:cards.truncated", { shown: loadedCount, total: totalCount })}
            </span>
          )}
        </div>
      </div>

      {/* Main Gantt Canvas Layout */}
      <div className="flex flex-1 border rounded-lg overflow-hidden bg-card shadow-sm min-h-[500px]">
        {/* Left Task Hierarchy List (300px) */}
        <div className="w-36 sm:w-80 border-r flex flex-col shrink-0 bg-background/50 select-none">
          {/* List Header */}
          <div className="h-14 border-b flex items-center justify-between px-3 text-xs font-semibold text-muted-foreground bg-muted/40">
            <span>{t("project:gantt.column.task")}</span>
            <span className="hidden sm:inline text-[11px]">{t("project:gantt.column.progressHours")}</span>
          </div>

          {/* List Rows */}
          <div
            ref={leftPanelRef}
            onScroll={handleLeftScroll}
            className="flex-1 overflow-y-auto divide-y"
          >
            {isLoading && (
              <div className="p-4 text-xs text-muted-foreground text-center">{t("project:gantt.loading")}</div>
            )}

            {!isLoading && scheduledCards.length === 0 && (
              <div className="p-8 text-xs text-muted-foreground text-center">
                {t("project:gantt.empty")}
              </div>
            )}

            {groupedCards.map((group) => (
              <div key={group.groupKey} className="flex flex-col">
                {groupBy !== "none" && (
                  <div className="bg-muted/60 px-3 py-1.5 text-xs font-bold text-foreground flex items-center justify-between border-y">
                    {/* 沒有標題的那一組＝未指派（見 memo 的 UNASSIGNED）。譯文在
                        這裡才決定，memo 不碰語系。 */}
                    <span>{group.groupTitle ?? t("project:gantt.unassigned")}</span>
                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                      {group.cards.length}
                    </Badge>
                  </div>
                )}
                {group.cards.map((card) => {
                  const isCompleted = !!card.completedAt;
                  const totalChecklist = card.checklistProgress.total;
                  const doneChecklist = card.checklistProgress.completed;
                  const percent = totalChecklist > 0 ? Math.round((doneChecklist / totalChecklist) * 100) : isCompleted ? 100 : 0;

                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setOpenCardId(card.id)}
                      className="w-full text-left h-10 px-3 flex items-center justify-between hover:bg-muted/40 focus:outline-none focus:bg-muted/40 cursor-pointer transition-colors text-xs"
                    >
                      <div className="flex items-center gap-1.5 min-w-0 pr-2">
                        {isCompleted ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        ) : card.isOverdue ? (
                          <AlertCircle className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                        ) : (
                          <div className="h-2 w-2 rounded-full bg-primary/60 shrink-0" />
                        )}
                        <span
                          className={`truncate font-medium ${
                            isCompleted ? "line-through text-muted-foreground" : "text-foreground"
                          }`}
                        >
                          {card.title}
                        </span>
                        {card.reviewState && <ReviewStateIcon state={card.reviewState} className="h-3.5 w-3.5" />}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-muted-foreground">
                        {percent > 0 && <span className="font-semibold text-primary">{percent}%</span>}
                        {card.estimatedHours && <span>{formatHours(card.estimatedHours)}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Right Scrollable Timeline View */}
        <div
          ref={timelineContainerRef}
          onScroll={handleRightScroll}
          className="flex-1 overflow-x-auto overflow-y-auto relative bg-background"
        >
          <div style={{ width: totalWidth }} className="relative min-h-full">
            {/* Timeline Header (Months & Days) */}
            <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b select-none">
              {/* Month Bar */}
              <div className="h-7 border-b flex items-center bg-muted/20 relative overflow-hidden">
                {monthSegments.map((seg, sIdx) => {
                  const segWidth = seg.spanDays * dayWidth;
                  return (
                    <div
                      key={`mseg-${sIdx}`}
                      style={{
                        position: "absolute",
                        left: seg.startIdx * dayWidth,
                        width: segWidth,
                      }}
                      className="h-full flex items-center px-2 font-semibold text-foreground text-xs truncate border-r border-border/60"
                      title={formatMonthYear(monthStart(seg))}
                    >
                      {pickMonthLabel(
                        monthLabelCandidates(monthStart(seg)),
                        segWidth - MONTH_LABEL_PADDING_PX,
                        measureMonthLabel,
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Day Bar */}
              <div className="h-7 flex items-center">
                {calendarDays.map((cd, idx) => (
                  <div
                    key={idx}
                    style={{ width: dayWidth }}
                    className={`h-full flex items-center justify-center text-[11px] shrink-0 border-r border-muted/50 ${
                      cd.isToday
                        ? "bg-primary/15 font-bold text-primary"
                        : cd.isWeekend
                        ? "bg-muted/30 text-muted-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {cd.label}
                  </div>
                ))}
              </div>
            </div>

            {/* Today Line */}
            {todayOffset !== null && (
              <div
                style={{ left: todayOffset }}
                className="absolute top-0 bottom-0 w-[2px] bg-rose-500 z-10 pointer-events-none shadow-sm"
              >
                <div className="absolute top-1 -left-4 bg-rose-500 text-white text-[9px] px-1 rounded-sm font-semibold">
                  {t("project:gantt.todayLine")}
                </div>
              </div>
            )}

            {/* Grid Background Lines */}
            <div className="absolute top-14 bottom-0 left-0 right-0 flex pointer-events-none">
              {calendarDays.map((cd, idx) => (
                <div
                  key={`grid-${idx}`}
                  style={{ width: dayWidth }}
                  className={`h-full shrink-0 border-r border-muted/30 ${
                    cd.isWeekend ? "bg-muted/10" : ""
                  }`}
                />
              ))}
            </div>

            {/* Task Bars Content */}
            <div className="relative pt-0">
              {groupedCards.map((group) => (
                <div key={`timeline-group-${group.groupKey}`}>
                  {groupBy !== "none" && <div className="h-[33px]" />}
                  {group.cards.map((card) => {
                    const coords = getCardBarCoords(card);
                    if (!coords) return <div key={`ph-${card.id}`} className="h-10" />;

                    const isCompleted = !!card.completedAt;
                    const percent =
                      card.checklistProgress.total > 0
                        ? Math.round(
                            (card.checklistProgress.completed / card.checklistProgress.total) * 100
                          )
                        : isCompleted
                        ? 100
                        : 0;

                    return (
                      <div
                        key={`bar-row-${card.id}`}
                        className="h-10 relative flex items-center hover:bg-muted/20 transition-colors"
                      >
                        {coords.isVisible && (
                          <button
                            type="button"
                            onClick={() => setOpenCardId(card.id)}
                            style={{
                              left: coords.left,
                              width: coords.width,
                            }}
                            className={`absolute h-7 rounded-md cursor-pointer shadow-sm flex items-center px-2 text-left text-xs transition-all hover:scale-[1.01] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring focus:z-10 select-none group border ${
                              isCompleted
                                ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-900 dark:text-emerald-100"
                                : card.isOverdue
                                ? "bg-rose-500/25 border-rose-500/70 text-rose-900 dark:text-rose-100"
                                : "bg-primary/20 border-primary/50 text-foreground"
                            }`}
                          >
                            {/* Inner Progress Bar */}
                            {percent > 0 && (
                              <div
                                style={{ width: `${percent}%` }}
                                className={`absolute left-0 top-0 bottom-0 rounded-l-md opacity-30 ${
                                  isCompleted
                                    ? "bg-emerald-500"
                                    : card.isOverdue
                                    ? "bg-rose-500"
                                    : "bg-primary"
                                }`}
                              />
                            )}

                            {/* Task Content */}
                            <div className="relative z-10 flex items-center justify-between w-full overflow-hidden gap-1">
                              <span
                                className={`truncate font-medium text-[11px] ${
                                  isCompleted ? "line-through opacity-80" : ""
                                }`}
                              >
                                {card.title}
                              </span>

                              {/* Assignees avatars in task bar */}
                              {card.assignees.length > 0 && (
                                <div className="flex -space-x-1 shrink-0 ml-1">
                                  {card.assignees.slice(0, 2).map((a) => (
                                    <div
                                      key={a.userId}
                                      title={a.displayName || a.username}
                                      className="h-4 w-4 rounded-full ring-1 ring-background bg-primary/30 text-[9px] flex items-center justify-center font-bold"
                                    >
                                      {(a.displayName || a.username).slice(0, 1).toUpperCase()}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Unscheduled Tasks Section (Collapsible) */}
      {showUnscheduled && unscheduledCards.length > 0 && (
        <div className="border rounded-lg p-4 bg-card shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" />
              <h3 className="font-semibold text-sm">{t("project:gantt.unscheduled.title", { n: unscheduledCards.length })}</h3>
            </div>
            <span className="text-xs text-muted-foreground">{t("project:gantt.unscheduled.hint")}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
            {unscheduledCards.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setOpenCardId(c.id)}
                className="w-full text-left focus:outline-none focus:ring-2 focus:ring-ring p-2.5 border rounded-md hover:border-primary/50 hover:bg-muted/40 cursor-pointer transition-all text-xs flex items-center justify-between bg-background shadow-none"
              >
                <div className="flex flex-col gap-0.5 truncate pr-2">
                  <span className="font-medium text-foreground truncate">{c.title}</span>
                  <span className="text-[10px] text-muted-foreground">{c.boardName} · {c.listName}</span>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {t("project:gantt.schedule.action")}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Card Details Dialog */}
      {openCardId && activeCardDetails && (
        <CardDialog
          cardId={openCardId}
          boardId={activeCardDetails.boardId}
          projectId={projectId}
          open={!!openCardId}
          onOpenChange={(open) => !open && setOpenCardId(null)}
        />
      )}
    </div>
  );
}
