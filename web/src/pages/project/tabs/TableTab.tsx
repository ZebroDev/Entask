import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api';
import { formatDate, formatHours } from '@/lib/format';
import { REVIEW_BADGE_CLASS, REVIEW_BADGE_SHELL, reviewStateLabel, type ReviewState } from "@/lib/review-badge";
import { apiErrorMessage } from "@/lib/utils";
import { CARD_PAGE_SIZE } from "@/lib/card-paging";
import { CardDialog } from '../../board/CardDialog';
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, Calendar, Archive, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

// 匯出給 `.test.tsx` 的卡片 fixture 標型別用（`tsc -b` 因此成為「fixture 有沒有補齊
// 必填欄位」的閘門——`reviewState` 是非 optional，而 `(api.get as Mock).mockResolvedValue`
// 讓 mock 走 `any`，缺欄位不會有任何型別錯誤）。仍然只有型別，沒有執行期影響。
export interface ProjectCardItem {
  id: string; title: string
  boardId: string; boardName: string
  listId: string; listName: string
  dueAt: string | null; completedAt?: string | null; isOverdue: boolean; isArchived: boolean
  assignees: { userId: string; username: string; displayName: string }[]
  labelNames: string[]
  estimatedHours: number | null; loggedHours: number
  checklistProgress: { total: number; completed: number }
  reviewState: ReviewState
}

type SortKey = 'title' | 'boardName' | 'dueAt' | 'loggedHours'
type SortDir = 'asc' | 'desc'

interface TableTabProps {
  projectId: string
  canEdit: boolean
  onOpenCard?: (cardId: string) => void
}

export function TableTab({ projectId, canEdit, onOpenCard }: TableTabProps) {
  const { t } = useTranslation(["common", "project", "card"]);
  const queryClient = useQueryClient();
  const toggleCompletion = useMutation({
    mutationFn: ({ cardId, isCompleted }: { cardId: string; isCompleted: boolean }) =>
      api.put(`/cards/${cardId}/completion`, { isCompleted }),
    onMutate: async ({ cardId, isCompleted }) => {
      await queryClient.cancelQueries({ queryKey: ['project-cards-table', projectId] });
      const prev = queryClient.getQueryData<any>(['project-cards-table', projectId, includeArchived]);
      queryClient.setQueryData<any>(['project-cards-table', projectId, includeArchived], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((c: any) =>
            c.id === cardId
              ? { ...c, completedAt: isCompleted ? new Date().toISOString() : null, isOverdue: false }
              : c
          ),
        };
      });
      return { prev };
    },
    onError: (err, _vars, ctx: any) => {
      if (ctx?.prev) {
        queryClient.setQueryData(['project-cards-table', projectId, includeArchived], ctx.prev);
      }
      toast.error(apiErrorMessage(err, t("common:error.toggleCompletion")));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['project-cards-table', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards-nodue', projectId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
      queryClient.invalidateQueries({ queryKey: ['mindmap', projectId] });
      queryClient.invalidateQueries({ queryKey: ['report', projectId] });
      queryClient.invalidateQueries({ queryKey: ['my-work'] });
    },
  });
  const [sortKey, setSortKey] = useState<SortKey>('dueAt')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [boardFilter, setBoardFilter] = useState<string>('all')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);

  // 開啟卡片詳情的唯一入口：內嵌於專案頁時交由外部控制，獨立使用時開自己的對話框。
  // 抽成具名函式而非行內三元運算式，避免運算式敘述（no-unused-expressions）。
  const openCard = (cardId: string) => {
    if (onOpenCard) onOpenCard(cardId);
    else setOpenCardId(cardId);
  };

  // 2026-09-27：表格 body 是 **composite grid**——只有一個 Tab 停留點（當前列），其餘靠方向鍵。
  // 修改前每一列有 **3 個**停留點（`<tr>` ＋ checkbox ＋ 完成鈕，後兩者是原生 `<button>`），
  // 500 列的專案要按約 1,500 次 Tab 才穿得過去（實測見
  // `docs/history/2026-09-27-tabletab-composite-grid.md`，那兩支測試會當場印出前後數量）。
  //
  // ★ 兩處**刻意**與 WAI-ARIA 的 grid pattern 不同，不要「順手對齊」：
  //   ① **表頭沒有收進來**：全選 ＋ 4 個可排序 `<th>` 仍是普通停留點。它們是**常數**、
  //      不隨列數成長，收進來要多一套異質的 2D 模型，換到的只是固定 5 次 ⇒ 已知殘餘。
  //   ② **Space 仍然是開卡片**，不是 APG 的「切換選取」。選取走 checkbox 本身
  //      （`→` 進得去、Space 切換）⇒ 這一版是**純加法**：只減少停留點、只新增方向鍵，
  //      **沒有任何既有行為被改掉**。守門員是「Enter 與 Space 在列上仍然開啟卡片」那一支。
  const [activeRowIndex, setActiveRowIndex] = useState(0);

  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    const target = e.target as HTMLElement;
    // 表頭的 `<tr>` 沒有 `data-grid-row` ⇒ 這裡天然把它排除掉（見上面①）。
    const row = target.closest<HTMLElement>('tr[data-grid-row]');
    if (!row) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('tbody > tr[data-grid-row]'));
    const index = rows.indexOf(row);
    if (index < 0) return;
    const widgets = Array.from(row.querySelectorAll<HTMLElement>('[data-row-widget]'));
    const widgetIndex = widgets.indexOf(target);

    const focusRow = (next: HTMLElement | undefined) => {
      // 邊界：不搬 tabIndex、也不 preventDefault（讓方向鍵照常捲動頁面）。
      if (!next) return;
      e.preventDefault();
      setActiveRowIndex(Number(next.dataset.gridRow));
      next.focus();
    };
    const focusWidget = (el: HTMLElement | undefined) => {
      if (!el) return;
      e.preventDefault();
      el.focus();
    };

    switch (e.key) {
      case 'ArrowDown':
        focusRow(rows[index + 1]);
        break;
      case 'ArrowUp':
        focusRow(rows[index - 1]);
        break;
      case 'Home':
        focusRow(rows[0]);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        // 列 → 第一個控制項 → … → 最後一個 → 繞回列
        focusWidget(widgetIndex < 0 ? widgets[0] : widgets[widgetIndex + 1] ?? row);
        break;
      case 'ArrowLeft':
        // 控制項 → 前一個 → … → 列；在列上按 ← 不動
        focusWidget(widgetIndex > 0 ? widgets[widgetIndex - 1] : widgetIndex === 0 ? row : undefined);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    setSelectedIds([]);
  }, [boardFilter, includeArchived]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['project-cards-table', projectId, includeArchived],
    queryFn: () =>
      api.get<{ items: ProjectCardItem[]; total: number }>(
        `/projects/${projectId}/cards?pageSize=${CARD_PAGE_SIZE}&includeArchived=${includeArchived}`
      ).then(r => r.data),
  })

  const boards = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of data?.items ?? []) map.set(c.boardId, c.boardName)
    return [...map.entries()]
  }, [data])

  const sorted = useMemo(() => {
    let items = [...(data?.items ?? [])]
    if (boardFilter !== 'all') items = items.filter(c => c.boardId === boardFilter)
    items.sort((a, b) => {
      let av: string | number | null, bv: string | number | null
      if (sortKey === 'dueAt') {
        av = a.dueAt ?? '9999'; bv = b.dueAt ?? '9999'
      } else if (sortKey === 'loggedHours') {
        av = a.loggedHours; bv = b.loggedHours
      } else {
        av = (a as unknown as Record<string, string>)[sortKey]
        bv = (b as unknown as Record<string, string>)[sortKey]
      }
      if (av === bv) return 0
      const cmp = av < bv ? -1 : 1
      return sortDir === 'asc' ? cmp : -cmp
    })
    return items
  }, [data, sortKey, sortDir, boardFilter])

  // 伺服器端的 pageSize 上限是 500（`ProjectCardEndpoints` 硬擋 >500），而這個檢視沒有
  // 分頁 UI ⇒ 超過 500 張的專案只拿得到前 500 張。少了下面那個提示，`rowCount` 會把
  // 「已載入的」講成「全部的」：表格不完整，而畫面上沒有任何異狀。
  // 用 optional chaining 先取值而不是讓 `truncated` 去縮窄 `data`
  // ——別名條件的縮窄在本檔的 JSX 巢狀深度下不值得賭。
  const loadedCount = data?.items?.length ?? 0
  const totalCount = data?.total ?? 0
  const truncated = totalCount > loadedCount

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const handleBatchToggle = async (isCompleted: boolean) => {
    setIsBatchProcessing(true);
    try {
      await Promise.all(
        selectedIds.map((id) => api.put('/cards/' + id + '/completion', { isCompleted }))
      );
      queryClient.invalidateQueries({ queryKey: ['project-cards-table', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards-nodue', projectId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
      queryClient.invalidateQueries({ queryKey: ['mindmap', projectId] });
      queryClient.invalidateQueries({ queryKey: ['report', projectId] });
      queryClient.invalidateQueries({ queryKey: ['my-work'] });
      // 兩個分支各自是一句完整的話（zh 是「已將 N 張卡片標記為已完成／未完成」）。
      // 樣板常值的洞只裝得下一個運算式，裝不了三元式——所以這裡拆成兩個 t()。
      toast.success(
        isCompleted
          ? t("project:table.batch.marked.complete", { count: selectedIds.length })
          : t("project:table.batch.marked.incomplete", { count: selectedIds.length }),
      );
      setSelectedIds([]);
    } catch (e) {
      toast.error(apiErrorMessage(e, t("project:table.batch.mark.error")));
    } finally {
      setIsBatchProcessing(false);
    }
  };

  const handleBatchDue = async (daysOffset: number | null) => {
    setIsBatchProcessing(true);
    try {
      let targetIso: string | null = null;
      if (daysOffset !== null) {
        const d = new Date();
        d.setDate(d.getDate() + daysOffset);
        d.setHours(18, 0, 0, 0);
        targetIso = d.toISOString();
      }
      await Promise.all(
        selectedIds.map((id) => api.put('/cards/' + id, { dueAt: targetIso }))
      );
      queryClient.invalidateQueries({ queryKey: ['project-cards-table', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards-nodue', projectId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
      queryClient.invalidateQueries({ queryKey: ['report', projectId] });
      queryClient.invalidateQueries({ queryKey: ['my-work'] });
      toast.success(targetIso ? t("project:table.batch.due.set", { count: selectedIds.length }) : t("project:table.batch.due.clear", { count: selectedIds.length }));
      setSelectedIds([]);
    } catch (e) {
      toast.error(apiErrorMessage(e, t("project:table.batch.due.error")));
    } finally {
      setIsBatchProcessing(false);
    }
  };

  const handleBatchArchive = async () => {
    setIsBatchProcessing(true);
    try {
      await Promise.all(
        selectedIds.map((id) => api.put('/cards/' + id, { isArchived: true }))
      );
      queryClient.invalidateQueries({ queryKey: ['project-cards-table', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-cards-nodue', projectId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
      queryClient.invalidateQueries({ queryKey: ['report', projectId] });
      queryClient.invalidateQueries({ queryKey: ['my-work'] });
      toast.success(t("project:table.batch.archive.success", { count: selectedIds.length }));
      setSelectedIds([]);
    } catch (e) {
      toast.error(apiErrorMessage(e, t("project:table.batch.archive.error")));
    } finally {
      setIsBatchProcessing(false);
    }
  };

  // 篩選／排序之後筆數可能變少 ⇒ 夾住，否則 `tabIndex` 會全部是 -1（整張表沒有停留點）。
  const activeRow = sorted.length === 0 ? -1 : Math.min(activeRowIndex, sorted.length - 1);
  const isAllSelected = sorted.length > 0 && selectedIds.length === sorted.length;
  const toggleSelectAll = () => {
    if (isAllSelected) setSelectedIds([]);
    else setSelectedIds(sorted.map((c) => c.id));
  };

  return (
    <div>
      <div className="flex gap-4 mb-4 items-center">
        <select
          className="border rounded px-2 py-1 text-sm bg-background"
          value={boardFilter}
          onChange={e => setBoardFilter(e.target.value)}
        >
          <option value="all">{t("project:filter.allBoards")}</option>
          {boards.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={e => setIncludeArchived(e.target.checked)}
          />
          {t("project:table.filter.includeArchived")}
        </label>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t("project:table.rowCount", { count: sorted.length })}</span>
          {truncated && (
            <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
              {t("project:cards.truncated", { shown: loadedCount, total: totalCount })}
            </span>
          )}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table
          role="grid"
          aria-multiselectable="true"
          onKeyDown={handleGridKeyDown}
          className="w-full text-sm border-collapse whitespace-nowrap"
        >
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={() => toggleSelectAll()}
                  aria-label={t("project:table.selectAll")}
                />
              </th>
              {([['title', t("project:table.column.title")], ['boardName', t("project:table.column.board")], ['listId', t("project:table.column.list")],
                 ['dueAt', t("project:table.column.due")], ['loggedHours', t("project:table.column.hours")], ['checklistProgress', t("project:table.column.progress")]] as const).map(
                ([key, label]) => (
                  <th
                    key={key}
                    tabIndex={key !== 'checklistProgress' && key !== 'listId' ? 0 : undefined}
                    onClick={key !== 'checklistProgress' && key !== 'listId'
                      ? () => handleSort(key as SortKey) : undefined}
                    onKeyDown={key !== 'checklistProgress' && key !== 'listId'
                      ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(key as SortKey); } } : undefined}
                    className={`px-3 py-2 text-left font-medium text-muted-foreground ${
                      key !== 'checklistProgress' && key !== 'listId' ? 'cursor-pointer hover:text-muted-foreground select-none focus:outline-none focus:ring-2 focus:ring-ring' : ''
                    }`}
                  >
                    {label}
                    {sortKey === key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((card, index) => (
              <tr
                key={card.id}
                data-grid-row={index}
                // roving tabindex：只有當前列進得了 Tab 順序（`activeRow` 在下面夾過邊界）
                tabIndex={index === activeRow ? 0 : -1}
                aria-selected={selectedIds.includes(card.id)}
                className="border-b hover:bg-muted/50 cursor-pointer focus:outline-none focus:bg-muted/50"
                onClick={() => openCard(card.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(card.id); } }}
              >
                <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    data-row-widget=""
                    tabIndex={-1}
                    checked={selectedIds.includes(card.id)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedIds(prev => [...prev, card.id]);
                      } else {
                        setSelectedIds(prev => prev.filter(id => id !== card.id));
                      }
                    }}
                  />
                </td>
                <td className={`px-3 py-2 font-medium ${card.completedAt ? 'line-through text-muted-foreground' : ''}`}>
                  <div className="flex items-center gap-2 max-w-[200px] sm:max-w-xs md:max-w-md lg:max-w-none">
                    {canEdit && (
                      <button
                        type="button"
                        data-row-widget=""
                        tabIndex={-1}
                        className={`shrink-0 h-4 w-4 rounded border flex items-center justify-center transition-all ${
                          card.completedAt
                            ? "bg-green-600 border-green-600 text-white"
                            : "border-muted-foreground/40 hover:border-primary"
                        }`}
                        title={card.completedAt ? t("card:completion.unmark.tooltip") : t("card:completion.mark.tooltip")}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCompletion.mutate({
                            cardId: card.id,
                            isCompleted: !card.completedAt,
                          });
                        }}
                      >
                        {card.completedAt && <Check className="h-2.5 w-2.5 stroke-[3]" />}
                      </button>
                    )}
                    <span className="truncate" title={card.title}>{card.title}</span>
                    {card.completedAt && <span className="inline-flex shrink-0 items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400 ring-1 ring-inset ring-green-500/20">{t("common:state.completed")}</span>}
                    {card.reviewState && (
                      <span className={`shrink-0 ${REVIEW_BADGE_SHELL} ${REVIEW_BADGE_CLASS[card.reviewState]}`}>
                        {reviewStateLabel(t, card.reviewState)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{card.boardName}</td>
                <td className="px-3 py-2 text-muted-foreground">{card.listName}</td>
                <td
                  className={`px-3 py-2 ${card.isOverdue ? 'text-destructive font-medium' : 'text-muted-foreground'}`}
                  data-overdue={card.isOverdue ? 'true' : 'false'}
                >
                  {formatDate(card.dueAt)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatHours(card.loggedHours)} / {card.estimatedHours != null ? formatHours(card.estimatedHours) : '—'}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {card.checklistProgress.total > 0
                    ? `${card.checklistProgress.completed}/${card.checklistProgress.total}`
                    : '—'}
                </td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  {t("common:state.loading")}
                </td>
              </tr>
            )}
            {!isLoading && isError && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-destructive">
                  {t("common:error.load")}
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-2 h-6"
                    onClick={() => refetch()}
                  >
                    {t("common:action.retry")}
                  </Button>
                </td>
              </tr>
            )}
            {!isLoading && !isError && sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  {boardFilter !== 'all' ? t("project:table.empty.filtered") : t("project:table.empty.all")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      
      {canEdit && selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex flex-wrap items-center gap-2.5 px-4 py-2 rounded-full bg-popover/95 backdrop-blur text-popover-foreground border shadow-2xl animate-in slide-in-from-bottom duration-200">
          <span className="text-xs font-semibold px-1">
            {t("project:table.batch.selected", { n: selectedIds.length })}
          </span>
          <div className="h-4 w-px bg-border" />

          {/* Mark completed */}
          <Button
            size="sm"
            variant="default"
            disabled={isBatchProcessing}
            onClick={() => handleBatchToggle(true)}
            className="h-7 px-3 text-xs rounded-full bg-green-600 hover:bg-green-700 text-white gap-1"
          >
            <Check className="h-3 w-3 stroke-[3]" />
            {t("project:table.batch.markComplete")}
          </Button>

          {/* Mark incomplete */}
          <Button
            size="sm"
            variant="outline"
            disabled={isBatchProcessing}
            onClick={() => handleBatchToggle(false)}
            className="h-7 px-3 text-xs rounded-full"
          >
            {t("project:table.batch.markIncomplete")}
          </Button>

          {/* Due date dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={isBatchProcessing}
                className="h-7 px-3 text-xs rounded-full gap-1"
              >
                <Calendar className="h-3 w-3" />
                {t("project:table.batch.setDue")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="text-xs">
              <DropdownMenuItem onClick={() => handleBatchDue(0)}>{t("project:table.batch.today")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBatchDue(1)}>{t("project:table.batch.tomorrow")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBatchDue(7)}>{t("project:table.batch.nextWeek")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBatchDue(null)} className="text-destructive">
                {t("project:table.batch.clearDue")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Archive */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isBatchProcessing}
            onClick={handleBatchArchive}
            className="h-7 px-2.5 text-xs text-destructive hover:bg-destructive/10 rounded-full gap-1"
          >
            <Archive className="h-3 w-3" />
            {t("common:action.archive")}
          </Button>

          <div className="h-4 w-px bg-border" />

          {/* Clear selection */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isBatchProcessing}
            onClick={() => setSelectedIds([])}
            className="h-7 w-7 p-0 rounded-full text-muted-foreground hover:text-foreground"
            title={t("project:table.clearSelection")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>

          {isBatchProcessing && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary ml-1" />}
        </div>
      )}

      {openCardId && !onOpenCard && (
        <CardDialog
          cardId={openCardId}
          boardId={data?.items.find(c => c.id === openCardId)?.boardId}
          projectId={projectId}
          open={true}
          onOpenChange={() => setOpenCardId(null)}
        />
      )}
    </div>
  )
}

