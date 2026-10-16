import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { formatMonthYear, weekdayNarrowLabels } from '@/lib/format'
import { CARD_PAGE_SIZE, CARD_SIDE_LIST_PAGE_SIZE } from '@/lib/card-paging'
import { ReviewStateIcon } from "@/components/ReviewStateIcon";
import type { ReviewState } from "@/lib/review-badge";
import { CardDialog } from '../../board/CardDialog'
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Loader2 } from 'lucide-react'
import { useTranslation } from "react-i18next";

// 匯出給 `.test.tsx` 的卡片 fixture 標型別用（`tsc -b` 因此成為「fixture 有沒有補齊
// 必填欄位」的閘門——`reviewState` 是非 optional，而 `(api.get as Mock).mockResolvedValue`
// 讓 mock 走 `any`，缺欄位不會有任何型別錯誤）。仍然只有型別，沒有執行期影響。
export interface ProjectCardItem {
  id: string
  title: string
  boardId: string
  boardName: string
  listId: string
  listName: string
  dueAt: string | null
  completedAt?: string | null
  isOverdue: boolean
  isArchived: boolean
  assignees: { userId: string; username: string; displayName: string }[]
  labelNames: string[]
  estimatedHours: number | null
  loggedHours: number
  checklistProgress: { total: number; completed: number }
  reviewState: ReviewState
}

function toLocalDateString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 日格卡片晶片與 popover 列表共用的語意色（逾期紅／完成線）
const chipClass = (card: ProjectCardItem) =>
  card.completedAt
    ? 'border-green-500/30 bg-green-500/10 text-muted-foreground line-through'
    : card.isOverdue
    ? 'border-destructive/40 bg-destructive/10 text-destructive font-medium'
    : 'border-border bg-background hover:bg-muted'

function getMonthGrid(year: number, month: number) {
  const firstDay = new Date(year, month - 1, 1)
  const lastDay = new Date(year, month, 0)
  const startOffset = firstDay.getDay()
  const days: Array<Date | null> = []
  for (let i = 0; i < startOffset; i++) days.push(null)
  for (let d = 1; d <= lastDay.getDate(); d++) days.push(new Date(year, month - 1, d))
  while (days.length % 7 !== 0) days.push(null)
  return days
}

interface CalendarTabProps {
  projectId: string
  canEdit: boolean
  onOpenCard?: (cardId: string) => void
}

export function CalendarTab({ projectId, canEdit: _canEdit, onOpenCard: _onOpenCard }: CalendarTabProps) {
  const { t } = useTranslation(["common", "project"])
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  // 展開「+N 更多」popover 的日期格（以日期 key 識別；null = 全關）
  const [moreDayKey, setMoreDayKey] = useState<string | null>(null)

  const dueFrom = new Date(year, month - 1, 1).toISOString()
  // 月曆結尾跨週，抓到下個月 6 號以涵蓋重疊區域，同樣轉 UTC
  const dueTo = new Date(year, month, 6).toISOString()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['project-cards', projectId, year, month],
    queryFn: () =>
      api.get<{ items: ProjectCardItem[]; total: number; page: number; pageSize: number }>(
        `/projects/${projectId}/cards?dueFrom=${dueFrom}&dueTo=${dueTo}&pageSize=${CARD_PAGE_SIZE}`
      ).then(r => r.data),
  })

  // 靜默截斷：這是月視圖的查詢，pageSize 上限 500（`ProjectCardEndpoints` 硬擋 >500）而沒有分頁 UI。
  // 一個月內超過 500 張到期卡時，格線上看起來就是「這個月只有這些」。
  const loadedCount = data?.items?.length ?? 0
  const totalCount = data?.total ?? 0
  const truncated = totalCount > loadedCount

  const grid = useMemo(() => getMonthGrid(year, month), [year, month])
  const cardsByDate = useMemo(() => {
    const map = new Map<string, ProjectCardItem[]>()
    for (const card of data?.items ?? []) {
      if (!card.dueAt) continue
      const key = toLocalDateString(new Date(card.dueAt))
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(card)
    }
    return map
  }, [data])

  // 篩選在**伺服器端**做（`hasDue=false`），不是在這裡過濾。原本的寫法是抓未篩選的前 100 筆
  // 再 `.filter(c => !c.dueAt)`，而後端的排序是 **null 排最後**（`ProjectCardEndpoints` 的
  // `OrderBy(c => c.DueAt == null)`）⇒ 專案裡有 100 張以上已排到期日的卡片時，那一窗裡
  // 一張無到期日的都沒有：面板標題寫著「無到期日」而內容空無一物，且**沒有任何紅燈**。
  // 前端的過濾刻意不留——留著會讓伺服器哪天退化時靜默地繼續正確。
  const noDueCardsQuery = useQuery({
    queryKey: ['project-cards-nodue', projectId],
    queryFn: () =>
      api.get<{ items: ProjectCardItem[]; total: number }>(
        `/projects/${projectId}/cards?hasDue=false&pageSize=${CARD_SIDE_LIST_PAGE_SIZE}`
      ).then(r => r.data),
  })

  const noDueCards = noDueCardsQuery.data?.items ?? []

  // 側欄同樣只有一窗（上限見 `card-paging.ts`）。`total` 現在是**篩選後**的數量
  // ⇒ 這一條提示到這一批才成立：先前那支回應的 total 是未篩選的專案總數，
  // 掛在「無到期日」面板上會印出與該面板無關的數字，那比不印更糟。
  const noDueTotalCount = noDueCardsQuery.data?.total ?? 0
  const noDueTruncated = noDueTotalCount > noDueCards.length

  const selectedCard = useMemo(
    () => (data?.items ?? []).find(c => c.id === openCardId) || noDueCards.find(c => c.id === openCardId),
    [data, noDueCards, openCardId]
  )

  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12) }
    else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1) }
    else setMonth(m => m + 1)
  }

  const todayKey = toLocalDateString(today)

  return (
    <div className="flex flex-col md:flex-row gap-4">
      <div className="flex-1 overflow-x-auto">
        <div className="flex items-center gap-4 mb-4 whitespace-nowrap overflow-x-auto no-scrollbar">
          <button onClick={prevMonth} className="px-2 py-1 rounded hover:bg-muted transition-colors shrink-0">
            {t("project:calendar.prevMonth")}
          </button>
          <h2 className="text-lg font-semibold shrink-0">{formatMonthYear(new Date(year, month - 1, 1))}</h2>
          <button onClick={nextMonth} className="px-2 py-1 rounded hover:bg-muted transition-colors shrink-0">
            {t("project:calendar.nextMonth")}
          </button>

          {truncated && (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0">
              {t("project:cards.truncated", { shown: loadedCount, total: totalCount })}
            </span>
          )}
        </div>

        {isLoading && (
          <div className="text-center text-muted-foreground mt-8">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            {t("common:state.loading")}
          </div>
        )}
        {!isLoading && isError && (
          <div className="text-center text-destructive mt-8">
            {t("common:error.load")}
            <Button size="sm" variant="outline" className="ml-2 h-6" onClick={() => refetch()}>
              {t("common:action.retry")}
            </Button>
          </div>
        )}
        {!isLoading && !isError && (
          <div className="min-w-[500px]">
            <div className="grid grid-cols-7 gap-1 mb-1">
              {/* 七個星期字由 Intl 產生（`format.ts`），不進語系檔——與甘特圖的
                  月份標頭同一條路。**在 render 裡求值**：寫成模組層級的常數會把
                  標籤凍結在 import 當下的語系（切語系不會重算）。
                  key 用索引而不是標籤：英文的窄名是 `S M T W T F S`，有重複。 */}
              {weekdayNarrowLabels().map((d, i) => (
                <div key={i} className="text-center text-sm text-muted-foreground py-1">{d}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {grid.map((day, idx) => {
                const key = day ? toLocalDateString(day) : null
                const isToday = key === todayKey
                const dayCards = key ? (cardsByDate.get(key) ?? []) : []
                return (
                  <div
                    key={idx}
                    className={`min-h-[6rem] p-1 border rounded ${
                      isToday ? 'border-primary bg-primary/10' : 'border-border'
                    } ${!day ? 'bg-muted' : ''}`}
                  >
                    {day && (
                      <>
                        <div className={`text-sm font-medium mb-1 ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>
                          {day.getDate()}
                        </div>
                        {dayCards.slice(0, 3).map(card => (
                          <button
                            key={card.id}
                            type="button"
                            data-overdue={card.isOverdue ? 'true' : 'false'}
                            onClick={() => setOpenCardId(card.id)}
                            className={`w-full text-left focus:outline-none focus:ring-2 focus:ring-ring text-xs px-1 py-0.5 mb-0.5 rounded border flex items-center gap-1 cursor-pointer ${chipClass(card)}`}
                          >
                            {card.completedAt && <span className="shrink-0 text-green-600">✓</span>}
                            <span className="truncate">{card.title}</span>
                            {card.reviewState && <ReviewStateIcon state={card.reviewState} className="ml-auto h-3 w-3" />}
                          </button>
                        ))}
                        {dayCards.length > 3 && (
                          <Popover
                            open={moreDayKey === key}
                            onOpenChange={(open) => setMoreDayKey(open ? key : null)}
                          >
                            <PopoverTrigger asChild>
                              <button type="button" className="text-xs text-muted-foreground cursor-pointer hover:underline">
                                {t("project:calendar.more", { n: dayCards.length - 3 })}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent align="start" className="w-56 p-1">
                              <div className="space-y-0.5 max-h-64 overflow-y-auto">
                                {dayCards.slice(3).map(card => (
                                  <button
                                    key={card.id}
                                    type="button"
                                    onClick={() => { setOpenCardId(card.id); setMoreDayKey(null); }}
                                    className={`w-full text-left text-xs px-2 py-1 rounded border flex items-center gap-1 cursor-pointer ${chipClass(card)}`}
                                  >
                                    {card.completedAt && <span className="shrink-0 text-green-600">✓</span>}
                                    <span className="truncate">{card.title}</span>
                                    {card.reviewState && <ReviewStateIcon state={card.reviewState} className="ml-auto h-3 w-3" />}
                                  </button>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            {(data?.items.filter(c => c.dueAt).length ?? 0) === 0 && (
              <div className="text-center text-muted-foreground mt-8">{t("project:calendar.empty.month")}</div>
            )}
          </div>
        )}
      </div>

      <div className="w-full md:w-48 shrink-0">
        <div className="font-medium text-sm text-muted-foreground mb-2">{t("project:calendar.noDue.title")}</div>
        {noDueTruncated && (
          // 這一欄只有 w-48 ⇒ 讓它自然斷行，不掛 `whitespace-nowrap`
          // （那是甘特／表格那種橫向工具列才需要的，掛在這裡會撐破側欄）。
          <div className="text-xs font-medium leading-tight text-amber-600 dark:text-amber-400 mb-2">
            {t("project:cards.truncated", { shown: noDueCards.length, total: noDueTotalCount })}
          </div>
        )}
        {noDueCardsQuery.isLoading ? (
          <div className="text-xs text-muted-foreground">{t("common:state.loading")}</div>
        ) : noDueCardsQuery.isError ? (
          <div className="text-xs text-destructive">{t("common:error.load")}</div>
        ) : noDueCards.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t("project:calendar.noDue.empty")}</div>
        ) : (
          noDueCards.map(card => (
            <button
              key={card.id}
              onClick={() => setOpenCardId(card.id)}
              className="w-full text-left focus:outline-none focus:ring-2 focus:ring-ring text-xs px-2 py-1 mb-1 rounded border border-border bg-background cursor-pointer hover:bg-muted truncate"
            >
              {card.title}
            </button>
          ))
        )}
      </div>

      {openCardId && (
        <CardDialog
          cardId={openCardId}
          boardId={selectedCard?.boardId}
          projectId={projectId}
          open={true}
          onOpenChange={() => setOpenCardId(null)}
        />
      )}
    </div>
  )
}

