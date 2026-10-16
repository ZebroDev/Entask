import { useState } from "react";
import type { WorkLogDay, WorkLogEntry, WorkLogMember } from "@/lib/board-types";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";
import { CardDialog } from "@/pages/board/CardDialog";
import type { WorkLogMode } from "./worklog-range";
import { formatDay, formatDecimal, formatHours, formatPercent } from "@/lib/format";
import { useTranslation } from "react-i18next";

interface Props {
  member: WorkLogMember;
  mode: WorkLogMode;
  workdays: string[];
}

function EntryRow({ entry, onOpen }: { entry: WorkLogEntry; onOpen: (e: WorkLogEntry) => void }) {
  const { t } = useTranslation(["common"]);
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{entry.cardTitle}</span>
          {entry.cardCompletedAt && (
            <Badge variant="secondary" className="shrink-0 gap-1 bg-green-500/10 text-[10px] text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-3 w-3" />
              {t("common:state.completed")}
            </Badge>
          )}
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{formatHours(entry.hours)}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {entry.projectName} › {entry.boardName} › {entry.listName}
        {entry.note ? ` · ${entry.note}` : ""}
      </span>
    </button>
  );
}

function DayEntries({ day, onOpen }: { day: WorkLogMember["days"][number]; onOpen: (e: WorkLogEntry) => void }) {
  return (
    <div className="space-y-0.5 pl-2">
      <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">
        {formatDay(day.date)} · {formatHours(day.totalHours)}
      </div>
      {day.entries.map((e) => (
        <EntryRow key={e.logId} entry={e} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** 週模式一日一列：預設收合為單列摘要，展開才 render 該日明細列（同「日模式」）。 */
function WeekDayRow({ day, onOpen }: { day: WorkLogDay; onOpen: (e: WorkLogEntry) => void }) {
  const [open, setOpen] = useState(false);
  const summary = day.entries.map((e) => `${e.cardTitle} ${formatDecimal(e.hours)}`).join(" · ");

  return (
    <div>
      <button
        type="button"
        data-testid="worklog-day-row"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="shrink-0 text-xs font-medium">{formatDay(day.date)}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatHours(day.totalHours)}</span>
        {!open && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
      </button>
      {open && (
        <div className="space-y-0.5 pl-6" data-testid="worklog-day-detail">
          {day.entries.map((e) => (
            <EntryRow key={e.logId} entry={e} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkLogMemberCard({ member, mode, workdays }: Props) {
  const { t } = useTranslation(["worklog"]);
  const [expanded, setExpanded] = useState(mode === "day");
  const [openEntry, setOpenEntry] = useState<WorkLogEntry | null>(null);
  const dayMap = new Map(member.days.map((d) => [d.date, d]));
  const maxDayHours = Math.max(1, ...member.days.map((d) => d.totalHours));
  const name = member.displayName || member.username;

  // 成員摘要列的三個數量各自是一條複數族。**先算成變數**再傳進外層訊息——
  // 一個 key 只有一個複數維度，而 zh-TW 看不到這一類（中文無複數）。
  // 不可寫成巢狀的呼叫：內層那幾條 `i18next-parser` 抽不到，
  // `keepRemoved: false` 會把它們從語系檔刪掉、畫面直接印出 key（B2-5b 的陷阱）。
  const entriesLabel = t("worklog:member.entries", { count: member.entryCount });
  const cardsLabel = t("worklog:member.cards", { count: member.cardCount });
  // 複數跟的是**分母**（該員應填報的工作日數——已夾到職日）：`1/1 workday reported` vs
  // `1/3 workdays reported`。分母是**成員的** expectedWorkdays，不是範圍級的 workdays.length
  // （那是整個窗；期中到職者會被記成 1/5——R17 修掉的那個症狀）。分子不變：reportedWorkdays。
  const workdaysLabel = t("worklog:member.workdays", {
    count: member.expectedWorkdays,
    reported: member.reportedWorkdays,
    total: member.expectedWorkdays,
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar className="h-8 w-8">
            {member.avatarUrl ? <AvatarImage src={member.avatarUrl} alt={name} /> : null}
            <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{name}</p>
            {/* 整行收斂成一句：原本是 6 個運算式（含 `{" "}`）交錯的文字節點，
                逐節點抽會把「筆 ·」「張卡 · 已回報」這種句子零件留在原地。 */}
            <p className="text-xs text-muted-foreground">
              {t("worklog:member.summary", {
                hours: formatHours(member.totalHours),
                entries: entriesLabel,
                cards: cardsLabel,
                workdays: workdaysLabel,
              })}
            </p>
          </div>
          {/* 卡片層級展開鈕僅月模式需要：週模式的展開是逐日（WeekDayRow），
              日模式則全數展開、無需切換。 */}
          {mode === "month" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              aria-label={expanded ? t("worklog:member.collapse.action") : t("worklog:member.expand.action")}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {expanded ? t("worklog:member.collapse.action") : t("worklog:member.expand.action")}
            </Button>
          )}
        </div>

        {mode === "day" &&
          (member.days.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">{t("worklog:member.empty")}</p>
          ) : (
            member.days.map((d) => <DayEntries key={d.date} day={d} onOpen={setOpenEntry} />)
          ))}

        {mode === "week" && (
          <div className="space-y-0.5">
            {/* 只畫**該成員的**工作日＝窗內 ∩（該員已回報日 ∪ 後端給的漏報日），維持
                workdays 的升冪順序。到職前的工作日兩邊都不屬於 ⇒ 既不是 day row、
                也不是 missing row（完全不出現）——「期中到職者在每個工作日都被記一筆
                未填報」就是這裡修的（R17）。 */}
            {workdays
              .filter((date) => dayMap.has(date) || member.missingDays.includes(date))
              .map((date) => {
                const day = dayMap.get(date);
                return day ? (
                  <WeekDayRow key={date} day={day} onOpen={setOpenEntry} />
                ) : (
                  <div
                    key={date}
                    data-testid="worklog-missing-row"
                    className="flex items-center justify-between px-2 py-1.5"
                  >
                    <span className="text-xs text-muted-foreground">{formatDay(date)}</span>
                    <span className="text-xs text-muted-foreground">{t("worklog:member.missing")}</span>
                  </div>
                );
              })}
            {/* 不在 workdays 內的日子（週末加班）與工作日同樣可展開 */}
            {member.days
              .filter((d) => !workdays.includes(d.date))
              .map((d) => (
                <WeekDayRow key={d.date} day={d} onOpen={setOpenEntry} />
              ))}
          </div>
        )}

        {mode === "month" && (
          <>
            <div className="space-y-1.5">
              {member.projects.map((p) => {
                const pct = member.totalHours > 0 ? Math.round((p.hours / member.totalHours) * 100) : 0;
                return (
                  <div key={p.projectId} className="flex items-center gap-2" data-testid="worklog-project-slice">
                    <span className="w-28 shrink-0 truncate text-xs">{p.projectName}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                      <div className="h-2 rounded bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {formatHours(p.hours)} ({formatPercent(pct / 100)})
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex h-10 items-end gap-0.5" data-testid="worklog-spark">
              {workdays.map((date) => {
                const h = dayMap.get(date)?.totalHours ?? 0;
                return (
                  <div
                    key={date}
                    title={t("worklog:member.spark.tooltip", { day: formatDay(date), hours: formatHours(h) })}
                    className={`flex-1 rounded-t ${h > 0 ? "bg-primary" : "bg-muted"}`}
                    style={{ height: `${Math.max(4, (h / maxDayHours) * 100)}%` }}
                  />
                );
              })}
            </div>
            {expanded && member.days.map((d) => <DayEntries key={d.date} day={d} onOpen={setOpenEntry} />)}
          </>
        )}
      </CardContent>

      {openEntry && (
        <CardDialog
          cardId={openEntry.cardId}
          projectId={openEntry.projectId}
          open={!!openEntry}
          onOpenChange={(open) => { if (!open) setOpenEntry(null); }}
        />
      )}
    </Card>
  );
}
