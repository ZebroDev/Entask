import { formatFullDay, formatMonthDay, formatMonthYear, formatWeekdayNarrow, formatWeekOfYear } from "@/lib/format";
import i18n from "@/i18n";

export type WorkLogMode = "day" | "week" | "month";

export interface WorkLogRange {
  from: Date;
  to: Date;
  label: string;
}

/** 本地午夜 */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 該週的週一（本地）。週日歸屬前一個週一起始的週。 */
export function startOfLocalWeek(d: Date): Date {
  const day = startOfLocalDay(d);
  const dow = day.getDay();                 // 0=日, 1=一, ..., 6=六
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + diff);
}

function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** ISO 8601 週次 */
export function isoWeekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** to 為排他上界（與後端 LoggedAt < to 一致） */
export function buildRange(mode: WorkLogMode, anchor: Date): WorkLogRange {
  if (mode === "day") {
    const from = startOfLocalDay(anchor);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    // 日模式用完整日期（2026/09/10（四）），與月模式的「09/10」層次不同
    return { from, to, label: i18n.t("common:date.dayWithWeekday", { day: formatFullDay(from), weekday: formatWeekdayNarrow(from) }) };
  }
  if (mode === "week") {
    const from = startOfLocalWeek(anchor);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
    const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1);
    return {
      from,
      to,
      label: i18n.t("common:date.rangeWithWeek", { from: formatMonthDay(from), to: formatMonthDay(last), week: formatWeekOfYear(isoWeekNumber(from)) }),
    };
  }
  const from = startOfLocalMonth(anchor);
  const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  return { from, to, label: formatMonthYear(from) };
}

export function shiftAnchor(mode: WorkLogMode, anchor: Date, delta: number): Date {
  if (mode === "day") return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + delta);
  if (mode === "week") return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + delta * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
}
