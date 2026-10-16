// 全站日期／數字格式化的唯一出口。
//
// 語系來源單一化：整個前端只有 currentLocale() 決定格式化語系，而它只讀 i18n。
// 呼叫點一律不傳 locale（P-B0 建立的形狀，P-B1 只換了這個函式的內容）。
//
// 明文禁令（R11）：不得使用 i18next 自帶的格式化（`t("{{d, datetime}}")`）。
// 不守住這條線，就會回到「同一件事兩個出口」——那正是 P-B0 才剛修掉的問題。
//
// 語系由 R6 的偵測鏈決定（localStorage 明確指定 → navigator.languages → 預設），
// 所以輸出「會」隨使用者環境改變；這與 P-B0 時期的固定 zh-TW 是刻意的差異。

import i18n from "@/i18n";

/** 唯一的語系來源。解析中的偽語系（en-XA）由 Intl 自行解析為 en。 */
export function currentLocale(): string {
  return i18n.resolvedLanguage ?? "zh-TW";
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, f);
  }
  return f;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, f);
  }
  return f;
}

// --- 日期 ---

// 與改動前的 toLocaleDateString("zh-TW", ...) 逐字元相同（實測六語系亦然）
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

// toLocaleString() 的預設是「六個 numeric 欄位全上」，與 Intl.DateTimeFormat()
// 的預設（只有年月日）不同——必須明列，否則會少掉時間。
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dateFormat(currentLocale(), DATE_OPTIONS).format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dateFormat(currentLocale(), DATE_TIME_OPTIONS).format(new Date(iso));
}

/** 2026 年 9 月 → 2026年9月（zh-TW）。 */
export function formatMonthYear(date: Date): string {
  return dateFormat(currentLocale(), { year: "numeric", month: "long" }).format(date);
}

/** 09/10 */
export function formatMonthDay(date: Date): string {
  return dateFormat(currentLocale(), { month: "2-digit", day: "2-digit" }).format(date);
}

/** 2026/09/10 */
export function formatFullDay(date: Date): string {
  return dateFormat(currentLocale(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** 四（Intl 的 narrow weekday，zh-TW 與既有 WEEKDAY_LABELS 逐字元相同） */
export function formatWeekdayNarrow(date: Date): string {
  return dateFormat(currentLocale(), { weekday: "narrow" }).format(date);
}

/**
 * 一週七天的窄名，**從週日起**（月曆表頭那一列）。
 *
 * 由 Intl 產生而不是放進語系檔：這七個字是**語系資料**不是文案——日文的一週
 * 不是同樣七個漢字，英文是 `S M T W T F S`（還重複）。基準日 2024-01-07 是星期日。
 *
 * 與甘特圖的月份標頭（`text-measure.ts`）同一條路：標籤的來源是 Intl。
 * **呼叫端要在 render 裡叫它**，寫成模組層級的常數會凍結在 import 當下的語系。
 */
export function weekdayNarrowLabels(): string[] {
  return Array.from({ length: 7 }, (_, i) => formatWeekdayNarrow(new Date(2024, 0, 7 + i)));
}

/** "2026-09-10" → 本地 Date。刻意不走 Date.parse：UTC 解析會在負時區位移一日。 */
function parseIsoDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "2026-09-10" → "09/10（四）"。收 Date 亦可（工作日誌的區間標題用）。 */
export function formatDay(date: string | Date): string {
  const d = typeof date === "string" ? parseIsoDay(date) : date;
  return i18n.t("common:date.dayWithWeekday", { day: formatMonthDay(d), weekday: formatWeekdayNarrow(d) });
}

/**
 * 兩個**本地日**（`yyyy-MM-dd`）→ 「2026/3/1 – 2026/6/30」（`common:date.range`）。
 * 報表窗框的「自訂期間」與考評表的考核期間共用。
 *
 * 走 `parseIsoDay` 而不是 `formatDate`：後者吃 ISO **時間**字串、內部是 `new Date(iso)`，
 * 對 `"2026-03-01"` 會解成 UTC 午夜——UTC 以西的時區因此顯示前一天（同 `parseIsoDay`
 * 存在的那個理由）。呼叫端傳進來的日已由 `report-window` 的 `parseDay` 驗過，
 * 這裡不再驗一次。
 */
export function formatDayRange(from: string, to: string): string {
  const label = (day: string) => dateFormat(currentLocale(), DATE_OPTIONS).format(parseIsoDay(day));
  return i18n.t("common:date.range", { from: label(from), to: label(to) });
}

/** 第 38 週 */
export function formatWeekOfYear(week: number): string {
  return i18n.t("common:date.weekOfYear", { week });
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormat(locale: string): Intl.RelativeTimeFormat {
  let f = relativeFormats.get(locale);
  if (!f) {
    // numeric: "always"——"auto" 在 zh-TW 會給「昨天」「上週」這種詞，
    // 而通知的時間是「多久以前」不是「哪一天」。一天以上改用天數，七天以上回絕對日期。
    f = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" });
    relativeFormats.set(locale, f);
  }
  return f;
}

/**
 * 相對時間（一分鐘以上）。
 *
 * **門檻的下界不含「剛剛」**：那是 `me:notification.time.justNow` 的譯文，
 * 由 `notification-text.ts` 在 60 秒內攔下——`Intl` 沒有「剛剛」這個詞
 * （`numeric:"auto"` 的 zh-TW 是「現在」），而它必須是文案、進語系檔。
 * 這一支因此只處理「使用者真的需要知道是多久以前」的區間。
 *
 * 未來時間（兩部機器的時鐘差幾秒是常態）以 `Math.max(1, …)` 收斂，不印負數。
 * 七天以上回 `formatDate`——「37 天前」不比日期好讀。
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const ms = Date.now() - then;
  const fmt = relativeFormat(currentLocale());
  if (ms < 3_600_000) return fmt.format(-Math.max(1, Math.floor(ms / 60_000)), "minute");
  if (ms < 86_400_000) return fmt.format(-Math.max(1, Math.floor(ms / 3_600_000)), "hour");
  if (ms < 604_800_000) return fmt.format(-Math.max(1, Math.floor(ms / 86_400_000)), "day");
  return formatDate(iso);
}

// --- 數字 ---

export function formatHours(hours: number): string {
  return numberFormat(currentLocale(), hoursOptions()).format(hours);
}

/** 裸單位（例如「小時」），供數字與單位分屬不同元素的版面使用。 */
export function hourUnit(): string {
  return numberFormat(currentLocale(), hoursOptions())
    .formatToParts(0)
    .filter((p) => p.type === "unit")
    .map((p) => p.value)
    .join("");
}

function hoursOptions(): Intl.NumberFormatOptions {
  return {
    style: "unit",
    unit: "hour",
    // 與改動前的 toFixed(1) 一致：固定一位小數，不因整數而消失
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  };
}

/** 固定一位小數的純數字（不含單位）。 */
export function formatDecimal(value: number): string {
  return numberFormat(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

/** rate 為 0..1 的比例。預設零位小數（等同 Math.round(rate*100)+'%'）。 */
export function formatPercent(rate: number, fractionDigits = 0): string {
  return numberFormat(currentLocale(), {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(rate);
}

// --- 月份標籤（甘特圖時間軸的寬度自適應） ---

/**
 * 由長到短的三段候選並去重。去重是必要的：ja 的 narrow 就是 long（"9月"），
 * 不去重會多量一次註定放不下的字串。
 *
 * locale 可選且預設為 currentLocale()——這是純函式測試的縫，不是「locale 逐層傳」：
 * 呼叫點一律不傳，多語系行為（去重後的段數）才驗得動。
 */
export function monthLabelCandidates(date: Date, locale: string = currentLocale()): string[] {
  const candidates = [
    dateFormat(locale, { year: "numeric", month: "long" }).format(date),
    dateFormat(locale, { month: "long" }).format(date),
    dateFormat(locale, { month: "narrow" }).format(date),
  ];
  return candidates.filter((c, i) => candidates.indexOf(c) === i);
}

/**
 * 由長到短挑第一個量測後放得進 width 的候選；全放不下則回最短的那個
 * （寧可略窄也不裁切、不空白）。candidates 需已由長到短排序。
 *
 * measure 只在需要時呼叫——最長候選放得下就不量其餘。
 */
export function pickMonthLabel(
  candidates: string[],
  width: number,
  measure: (text: string) => number,
): string {
  for (const candidate of candidates) {
    if (measure(candidate) <= width) return candidate;
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : "";
}
