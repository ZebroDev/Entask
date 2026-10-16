import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WINDOW_ALL,
  WINDOW_CUSTOM,
  rangeOfYear,
  withFrom,
  withTo,
  yearOptions,
  type ReportWindowValue,
} from "@/lib/report-window";

interface Props {
  /** select 與兩個日期欄位的 id 前綴（`htmlFor` 指過來，無障礙名稱因此來自可見文字）。 */
  id: string;
  value: ReportWindowValue;
  onChange: (next: ReportWindowValue) => void;
  /** 後端回的資料涵蓋年份（由大到小、**不含今年**）。缺席時退化為「今年 ∪ 選定年」。 */
  availableYears?: number[];
  /**
   * **已經翻好的字串**，不是 key——傳 key 進來會讓這裡變成 `t(labelKey)`，那是非字面值
   * 引數，`i18next-parser` 抽不到、`keepRemoved: false` 再把它從語系檔刪掉，畫面直接
   * 印出 key 本身而**所有測試照綠**（AGENTS.md 的 i18n 節）。所以本元件**完全沒有 `t()`**。
   */
  labels: { period: string; all: string; custom: string; from: string; to: string };
}

/**
 * 報表期間的選擇器（年份下拉 ＋ 自訂日期區間），團隊與專案兩頁共用。
 *
 * **自訂區間是同一顆 `<select>` 的一個 option**（`value="custom"`），不是第二顆控件：
 * `TeamReportTab.test.tsx` 有十處 `getByRole("combobox")` 的單數呼叫，多一顆控件會讓
 * 它們全部歧義（`getByRole` 在多個命中時直接拋）。
 *
 * `value` 一律是**哨兵值或數字**，永遠不是譯文——見 `lib/report-window.ts` 的檔頭。
 * 這裡的 `Number(raw)` 只在兩個哨兵都被擋掉之後才走得到，所以 `Number("custom")` 是 `NaN`
 * 這條路不存在。
 *
 * 用**原生 `<select>`**（先例是 `TableTab.tsx` 的看板篩選）：這裡是頁內篩選、不是對話框，
 * shadcn 的 `Select` 要 portal 互動而換不到任何東西。無障礙名稱來自**可見的 `<Label>`**
 * （`htmlFor` 指向同一顆），不另寫 `aria-label`——那會覆蓋可見文字，違反 WCAG 2.5.3。
 */
export function ReportWindowPicker({ id, value, onChange, availableYears, labels }: Props) {
  const years = yearOptions(value, availableYears);
  const selected =
    value.kind === "year" ? String(value.year) : value.kind === "range" ? WINDOW_CUSTOM : WINDOW_ALL;

  const handleSelect = (raw: string) => {
    if (raw === WINDOW_ALL) {
      onChange({ kind: "all" });
      return;
    }
    if (raw === WINDOW_CUSTOM) {
      // 播種：從目前選的年份帶出一個完整區間（全期或已是區間時退回今年），使用者再改
      // 兩個欄位。不播種的話會出現一個兩個欄位都是空的區間，而它送不出任何請求。
      onChange(rangeOfYear(value.kind === "year" ? value.year : new Date().getFullYear()));
      return;
    }
    onChange({ kind: "year", year: Number(raw) });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {labels.period}
        </Label>
        <select
          id={id}
          className="border rounded px-2 py-1 text-sm bg-background"
          value={selected}
          onChange={(e) => handleSelect(e.target.value)}
        >
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
          <option value={WINDOW_ALL}>{labels.all}</option>
          <option value={WINDOW_CUSTOM}>{labels.custom}</option>
        </select>
      </div>

      {value.kind === "range" && (
        <>
          <div className="flex items-center gap-1">
            <Label htmlFor={`${id}-from`} className="text-xs text-muted-foreground">
              {labels.from}
            </Label>
            <Input
              id={`${id}-from`}
              type="date"
              className="h-8 w-auto px-2 py-1 text-sm"
              value={value.from}
              onChange={(e) => onChange(withFrom(value, e.target.value))}
            />
          </div>
          <div className="flex items-center gap-1">
            <Label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">
              {labels.to}
            </Label>
            <Input
              id={`${id}-to`}
              type="date"
              className="h-8 w-auto px-2 py-1 text-sm"
              value={value.to}
              onChange={(e) => onChange(withTo(value, e.target.value))}
            />
          </div>
        </>
      )}
    </div>
  );
}
