import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { currentLocale, formatDayRange, formatDecimal, formatHours, formatPercent } from "@/lib/format";
import { ReportWindowPicker } from "@/components/ReportWindowPicker";
import {
  reportWindowLabel,
  windowKey,
  windowParams,
  windowQuery,
  windowSuffix,
  type ReportWindowValue,
} from "@/lib/report-window";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Trophy, Target, Clock, CheckCircle2, Award, ChevronRight, Download, UserCheck, FileSpreadsheet, Printer } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { RatingExplanation } from "./RatingExplanation";
import { ReportDrilldownDialog } from "./ReportDrilldownDialog";
import type { DrilldownMetric, MemberPerformance } from "./report-types";

interface Props { teamId: string; }

interface TeamReportResponse {
  members: MemberPerformance[];
  summary?: {
    totalCompleted: number;
    totalCards: number;
    overallCompletionRate: number;
    totalHours: number;
  };
  // 資料涵蓋的年份（由大到小）。**後端刻意不含今年**：判定「今年是哪一年」要讀時鐘，
  // 而後端不得隱式判定年份（設計 D3——窗框由前端傳入）。使用者的本地年由前端併進來，
  // 見下面的 `yearOptions`。
  availableYears?: number[];
}

/**
 * 評級 → 標籤。寫成 switch 而不是查表，是被 `i18next-parser` 逼的——與 `CardActivityTab`
 * 的 `typeLabel`、`lib/audit-labels.ts` 的 `auditActionLabel` 同一形狀（設計 §6.1）。這張表同時是
 * 後端 `RatingCodes` 的契約鎖（`web/scripts/check-label-tables.mjs` 的第六張表）。
 *
 * 認不得的評級**原樣顯示**、缺席**留白**，兩者都不猜一個「C 待加強」給它：後端新增等級
 * 而前端沒跟上時，改版前的症狀是顯示一個看起來完全正常的標籤，沒有人會發現。
 *
 * 每次呼叫才求值，切換語系一定拿得到新值（模組層級的常值會在 import 時把文案凍結）。
 */
const ratingLabel = (rating: string) => {
  switch (rating) {
    case "S":
      return i18n.t("team:report.rating.s");
    case "A":
      return i18n.t("team:report.rating.a");
    case "B":
      return i18n.t("team:report.rating.b");
    case "C":
      return i18n.t("team:report.rating.c");
    default:
      return rating;
  }
};

/**
 * 評級 → 徽章樣式。**只放 class 與 emoji，不放文案**——模組層級的表在 import 時求值，
 * 放了文案就會凍結在載入當下的語系（B2-5a 的形狀）。emoji 是產品內容、與譯文無關。
 */
const RATING_BADGE: Record<string, { outline?: boolean; className: string; icon: string }> = {
  S: { className: "bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/30 font-bold", icon: "🏆 " },
  A: { className: "bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/30 font-medium", icon: "⭐ " },
  B: { className: "bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/30", icon: "" },
  C: { outline: true, className: "text-muted-foreground", icon: "" },
};

/**
 * dossier 裡可 drill-down 的統計磚（2026-10-21 使用者實測回報「看不出可以點」）。
 *
 * **靜止時就要說得出自己是按鈕**：右上角的 chevron 是唯一的靜態提示——hover 變色只有在
 * 滑鼠已經移上去之後才發生，幫不了「一開始不知道要點哪裡」的人。`hover:border-primary/40`
 * 與 chevron 的位移是第二層回饋。
 *
 * 標籤與數值維持**直接子節點**：`TeamReportTab.dossier.test.tsx` 的 `dialogStat` 以
 * 「標籤的 parentElement 裡找 `.text-xl`」取值，多包一層 flex 會讓它找不到值。
 */
function DrilldownStatButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className="group relative p-3 rounded-lg border text-left transition-colors hover:bg-muted/50 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring print:hidden"
    >
      <ChevronRight
        aria-hidden="true"
        className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
      />
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
    </button>
  );
}

export function TeamReportTab({ teamId }: Props) {
  const { t } = useTranslation(["common", "team"]);
  const [selectedMember, setSelectedMember] = useState<MemberPerformance | null>(null);
  // drill-down 的 metric（Task 5）。與 `selectedMember` 一樣是「開啟中」的狀態：
  // 非 null ⇒ `ReportDrilldownDialog` 掛載；關閉即卸載，所以頁碼等內部狀態不會殘留。
  const [drilldownMetric, setDrilldownMetric] = useState<DrilldownMetric | null>(null);
  // 報表窗框：預設**今年**（設計 D5），全期與自訂區間是另外兩個**明確**的選擇。
  // 型別是三個變體而不是 `number | "all" | null`：`null` 在這裡讀起來像「還沒選」。
  // 窗框語意（上界排他、本地日轉 UTC、選項來源）全在 `lib/report-window.ts`，
  // 與專案報表共用同一份——這一頁不再自己寫第二條算式。
  const [win, setWin] = useState<ReportWindowValue>(() => ({ kind: "year", year: new Date().getFullYear() }));

  // 窗框參數。**刻意不含前導的 `?`／`&`**：報表與 CSV 是路徑後的第一個參數，而 xls
  // 那顆自己已經帶著 `?locale=`（要接 `&`）——把分隔符留給各呼叫端，就不會在那裡生出
  // 第二個 `?`。全期＝空字串，兩個界線都不送（後端把「兩個都 null」讀成全期）。
  const reportQuery = windowQuery(win);
  // xls 那顆的 URL 自己已經帶著 `?locale=` ⇒ 窗框要接 `&`。`windowParams` 刻意不帶前導
  // 分隔符就是為了這個（`TeamReportTab.test.tsx` 逐字斷言那個 URL）。
  const windowParamString = windowParams(win);
  const reportQueryAmp = windowParamString ? `&${windowParamString}` : "";
  // drill-down 與報表用**同一段窗框**：`windowParams` 是唯一的窗框語意出口（本地日轉
  // UTC、上界排他），這裡只把它拆回兩個 ISO 界線。各寫一份的話，drill-down 的數字會
  // 對不上上面那張表，而畫面上沒有任何異狀。
  const drilldownWindow = new URLSearchParams(windowParamString);
  const drilldownFrom = drilldownWindow.get("from") ?? undefined;
  const drilldownTo = drilldownWindow.get("to") ?? undefined;

  // 匯出檔名由**前端**決定：`a.download` 會覆蓋伺服器的 `Content-Disposition`，
  // 後端 `YearSuffix` 的年份後綴因此到不了 SPA 使用者。期間取**使用者選的本地值**，
  // 不是由窗框的 UTC 界線推導——UTC 以東的使用者選 2026 時，後端從窗框左界看到的會是
  // 2025（設計 §5.4 已記載的已知誤差）。全期＝不帶後綴，與後端 `YearSuffix` 同一個語意。
  const yearSuffix = windowSuffix(win);

  // 考評表上的考核期間。全期沿用年份下拉的同一個字串（`report.year.all`），不另寫一份
  // 同義詞；年份直接印那一年（它是識別碼不是數量，加了千分位會變成「2,026」）。
  // **不進 `useMemo`**：那會把當下語系凍結住，切換語系之後考評表還是舊的。
  const periodLabel = reportWindowLabel(win, {
    all: t("team:report.year.all"),
    range: formatDayRange,
  });

  const handleExport = async () => {
    try {
      const res = await api.get(`/teams/${teamId}/report/export${reportQuery}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      // 檔名**不自稱 annual**（2026-09-22，final review 的 M-4）：全期時 `yearSuffix` 是空的，
      // 而「全期的匯出檔」叫 annual 正是這一批在文案上修掉的那種名實不符。
      a.download = `team-performance-${teamId}${yearSuffix}.csv`;
      document.body.appendChild(a);
      a.click();
      // 延後到事件迴圈再釋放——同步 revoke 可能中斷部分瀏覽器的下載
      setTimeout(() => window.URL.revokeObjectURL(url), 0);
      a.remove();
    } catch (err) {
      console.error(err);
      toast.error(t("common:error.export"));
    }
  };

  const handleExportExcel = async () => {
    try {
      const res = await api.get(
        `/teams/${teamId}/report/export-excel?locale=${encodeURIComponent(currentLocale())}${reportQueryAmp}`,
        { responseType: 'blob' },
      );
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.ms-excel' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `team-performance-${teamId}${yearSuffix}.xls`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => window.URL.revokeObjectURL(url), 0);
      a.remove();
    } catch (err) {
      console.error(err);
      toast.error(t("common:error.export"));
    }
  };

  const report = useQuery({
    // **窗框必須進 query key**：少了它，切換期間會拿到上一格的快取，
    // 而畫面只會「數字不變」——沒有任何紅燈。
    queryKey: ["team-report", teamId, windowKey(win)],
    queryFn: async () => (await api.get(`/teams/${teamId}/report${reportQuery}`)).data as TeamReportResponse,
  });

  // 錯誤文字的值**必須先提成陳述式**（與 `WorkLogReport` 同一個形狀）：`t()` 不得巢狀在
  // 另一個 `t()` 的引數子樹裡——那會讓內層的 key 抽不出來，`keepRemoved: false` 再把它從
  // 語系檔刪掉，畫面直接印出 key 本身（閘門 `check:error-paths` 的第二條規則；在工具列
  // 搬上來時，這個算式一度被折進 JSX 的單一運算式而當場變紅）。
  const loadErrorDetail = apiErrorMessage(report.error, t("common:error.tryLater"));

  // 取數中／取數失敗時 `report.data` 是 undefined（本檔**刻意不加** `placeholderData`：
  // 那會讓畫面短暫出現「新年份的標籤 ＋ 舊年份的數字」，正是這一批在消滅的那種報告）。
  // 下面這些推導因此走選擇性鏈——工具列要活在沒有資料的時候（見 return 裡的 I-1 註解）。
  const data = report.data;
  const members = data?.members ?? [];
  const totalCompleted = data?.summary?.totalCompleted ?? members.reduce((acc, m) => acc + m.completedCards, 0);
  const totalCards = data?.summary?.totalCards ?? members.reduce((acc, m) => acc + m.totalCards, 0);
  const overallRate = totalCards > 0 ? totalCompleted / totalCards : 0;
  const topPerformers = members.filter(m => m.rating === "S" || m.rating === "A").length;
  const totalHours = data?.summary?.totalHours ?? members.reduce((acc, m) => acc + (m.loggedHours ?? 0), 0);

  // 年份選項的推導搬進 `lib/report-window.ts` 的 `yearOptions`（三個來源各自擋掉一種
  // **沒有紅燈**的失敗：今年必須由前端併入、選定年必須永遠在選項裡、UTC 曆年與本地年
  // 的差一年——理由逐條跟著函式走）。這一頁只把資料餵進去。

  const getRatingBadge = (rating?: string | null) => {
    if (!rating) {
      // 後端沒給評級——留白。補一個「C 待加強」是把缺席講成一個具體的評價。
      // 2026-09-21 起「一張卡片都沒有」的成員走的就是這一條（`RatingFor` 回 null），
      // 所以 `rating` 的型別多了 `| null`——`!rating` 本來就涵蓋它，這裡只是把型別說出來。
      return <Badge variant="outline" className="text-muted-foreground" />;
    }
    const style = RATING_BADGE[rating];
    if (!style) {
      // 給了但我們不認識：原樣擺出來，並用醒目的外框讓它「看起來就不對」。
      return <Badge variant="outline" className="border-destructive text-destructive">{ratingLabel(rating)}</Badge>;
    }
    return (
      <Badge variant={style.outline ? "outline" : "default"} className={style.className}>
        {style.icon}{ratingLabel(rating)}
      </Badge>
    );
  };

  // dossier 的平均分：**null ＝樣本不足**（含舊回應沒有 averageScore 的缺值，寬鬆等於
  // 涵蓋 undefined）。樣本門檻取**payload 的** `sampleThreshold`（設計 §4.4：門檻由伺服器
  // 帶、前端不得再寫一份 3）；舊回應沒有分解時退回「有沒有分數」——那正是舊後端唯一能給的
  // 資訊，不猜一個門檻。
  //
  // 這裡先把「能不能顯示」收斂成一個值再進 JSX：留一個 `?? 0` 在格式化那側的話，
  // 讀起來正是下一個分支已經排除掉的「null 當 0」——它走不到，但會騙人。
  const dossierSampleThreshold = selectedMember?.ratingBreakdown?.adjustment.sampleThreshold;
  const dossierAverageScore =
    selectedMember?.averageScore == null ||
    (dossierSampleThreshold != null && (selectedMember.scoreSamples ?? 0) < dossierSampleThreshold)
      ? null
      : selectedMember.averageScore;

  return (
    <div className="space-y-6">
      {/* 年度績效結算清單 */}
      <section className="space-y-4">
        {/*
          工具列：標題 ＋ 年份下拉 ＋ 兩顆匯出鈕。

          **它必須活在取數狀態之上**（2026-09-22，final review 的 I-1）。取數失敗時，年份
          下拉是**唯一**能救回這個畫面的控件（換一個年份就是換一個 query key），而它原本
          在 skeleton／error 兩個 early return 的**下面**——失敗時整頁只剩一段錯誤文字，
          出路是重新載入（載入後還落回預設年份，不是他正在看的那一年）。所以只有它**下面**
          的內容在 skeleton／error／正常之間換，工具列本身永遠在。
        */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Award className="h-5 w-5 text-primary" />
              {t("team:report.ranking.title")}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t("team:report.ranking.description")}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/*
              期間選擇器（年份 ＋ 自訂區間）。共用元件，專案報表走同一顆
              ——`ReportWindowPicker` 的檔頭記著它的兩個硬規則（哨兵值當 option value、
              自訂區間是同一顆 `<select>` 的 option 而不是第二顆控件）。

              `labels` 傳的是**已經翻好的字串**而不是 key：傳 key 會讓元件裡變成
              `t(labelKey)`，那是非字面值引數、`i18next-parser` 抽不到。
            */}
            <ReportWindowPicker
              id="team-report-window"
              value={win}
              onChange={setWin}
              availableYears={data?.availableYears}
              labels={{
                period: t("team:report.year.label"),
                all: t("team:report.year.all"),
                custom: t("common:period.custom"),
                from: t("common:period.from"),
                to: t("common:period.to"),
              }}
            />
            <Button variant="outline" size="sm" onClick={() => handleExportExcel()} className="w-full sm:w-auto gap-1.5 border-primary/30 text-primary hover:bg-primary/5">
              <FileSpreadsheet className="h-4 w-4" />
              {t("team:report.export.excel.action")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleExport()} className="w-full sm:w-auto gap-1.5">
              <Download className="h-4 w-4" />
              {t("team:report.export.csv.action")}
            </Button>
          </div>
        </div>

        {report.isLoading ? (
          <Skeleton className="h-40 w-full" data-testid="team-report-skeleton" />
        ) : report.isError ? (
          <p className="text-destructive">{t("common:error.loadDetail", { detail: loadErrorDetail })}</p>
        ) : (
          <>
            {/* 頂部年度績效 KPI 總覽 */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("team:report.kpi.completion.title")}</CardTitle>
                  <Target className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatPercent(overallRate)}</div>
                  <p className="text-xs text-muted-foreground">{t("team:report.kpi.completion.hint", { done: totalCompleted, count: totalCards })}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("team:report.kpi.delivered.title")}</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{t("team:report.kpi.delivered.value", { count: totalCompleted })}</div>
                  <p className="text-xs text-muted-foreground">{t("team:report.kpi.delivered.hint")}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("team:report.kpi.topPerformers.title")}</CardTitle>
                  <Trophy className="h-4 w-4 text-amber-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{t("team:report.kpi.topPerformers.value", { count: topPerformers })}</div>
                  <p className="text-xs text-muted-foreground">{t("team:report.kpi.topPerformers.hint")}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t("team:report.kpi.hours.title")}</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatHours(Number(totalHours))}</div>
                  <p className="text-xs text-muted-foreground">{t("team:report.kpi.hours.hint")}</p>
                </CardContent>
              </Card>
            </div>

            <Card className="overflow-x-auto">
              <Table className="whitespace-nowrap">
                <TableHeader>
                  {/*
                    **檢視檔案的動作欄在最前面**（2026-10-21 使用者實測回報）：它原本是第 9 欄，
                    而這一頁的容器只有 `max-w-3xl` ⇒ 1909px 的螢幕上表格仍要橫向捲動，
                    動作欄**永遠在第一屏之外**，使用者不知道右邊還有東西可看。
                    容器已同時放寬（`TeamPage` 的 `max-w-6xl`），但動作欄留在最後的話，
                    筆電寬度下同一個症狀會回來；放第一欄是最寬容的解法。
                    排名欄因此退到第二欄——名次仍然是列的身分，只是不再是**第一個**看到的東西。
                  */}
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-28">{t("team:report.column.profile")}</TableHead>
                    <TableHead className="w-16 text-center">{t("team:report.column.rank")}</TableHead>
                    <TableHead>{t("team:report.column.member")}</TableHead>
                    <TableHead className="text-center">{t("team:report.column.rating")}</TableHead>
                    <TableHead>{t("team:report.column.completed")}</TableHead>
                    <TableHead>{t("team:report.metric.completion")}</TableHead>
                    <TableHead>{t("team:report.metric.onTime")}</TableHead>
                    <TableHead>{t("team:report.column.firstPassYield")}</TableHead>
                    <TableHead>{t("team:report.column.averageScore")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m, idx) => (
                    <TableRow key={m.userId} className="hover:bg-muted/40 transition-colors">
                      {/* 動作欄跟著表頭移到第一欄；`outline` 比原本的 `ghost` 更像一顆按鈕
                          （ghost 在列裡與純文字幾乎同一個重量，這也是「看不出可以點」的一半）。 */}
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs gap-1"
                          onClick={() => setSelectedMember(m)}
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                          {t("team:report.dossier.action")}
                        </Button>
                      </TableCell>
                      <TableCell className="text-center font-bold text-muted-foreground">
                        {idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "#" + (idx + 1)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <Avatar className="h-8 w-8">
                            {m.avatarUrl ? (
                              <AvatarImage src={m.avatarUrl} alt={m.displayName} />
                            ) : (
                              <AvatarFallback className="text-xs font-semibold">
                                {m.displayName?.charAt(0) || m.username?.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            )}
                          </Avatar>
                          <div>
                            <div className="font-medium text-sm">{m.displayName || m.username}</div>
                            <div className="text-xs text-muted-foreground">@{m.username}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {getRatingBadge(m.rating)}
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{m.completedCards}</span>
                        <span className="text-muted-foreground text-xs"> / {m.totalCards}</span>
                      </TableCell>
                      {/*
                        達成率。**沒有卡片依據時是 null ＝「樣本不足」**，不畫進度條也不印 0.0%
                        （2026-09-21，使用者回報）。

                        為什麼非擋不可：`Intl` 的百分比格式化把 `null` 當成 **0** ⇒ 壞掉的實作
                        印出的是**一個看起來完全正常的 `0.0%`**（不是 NaN、不是空白），而 0.0%
                        在這裡的意思剛好相反——那是「有卡片、一張都沒完成」的結論，等於把
                        「沒有依據」寫成「做得不好」。寬鬆 `== null` 同時涵蓋 `undefined`。
                      */}
                      <TableCell>
                        {m.completionRate == null ? (
                          <span className="text-xs text-muted-foreground">{t("team:report.sampleInsufficient")}</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-16 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-2 rounded-full bg-primary"
                                style={{ width: Math.min(100, m.completionRate * 100) + "%" }}
                              />
                            </div>
                            <span className="text-xs font-medium">{formatPercent(m.completionRate, 1)}</span>
                          </div>
                        )}
                      </TableCell>
                      {/*
                        準時交付率。**這是使用者回報的那一格**：舊制在這裡寫 `m.onTimeRate ?? 1`
                        ——欄位為 null 時落回 **1**，於是「一張完成的卡片都沒有」的人顯示 100.0%，
                        而同一列的一次交付通過率顯示「樣本不足」。`?? 1` 是**舊後端的後備值
                        （`completed > 0 ? … : 1.0`）在前端的第二份**，兩邊一起移除才不會漂移。

                        顏色的門檻 0.8 **不是後端任何常數的第二份**：`RatingFor` 的準時率條件是
                        **0.85**（`TeamReportEndpoints.cs`），改那一條時不必動這裡。會誤認是因為
                        隔壁 fpy 那一格的顏色門檻也是 0.8，而**它才是** `fpy >= 0.80` 的副本。
                      */}
                      <TableCell>
                        {m.onTimeRate == null ? (
                          <span className="text-xs text-muted-foreground">{t("team:report.sampleInsufficient")}</span>
                        ) : (
                          <span className={'text-xs font-medium ' + (m.onTimeRate >= 0.8 ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400")}>
                            {formatPercent(m.onTimeRate, 1)}
                          </span>
                        )}
                      </TableCell>
                      {/*
                        一次交付通過率（Task 10）。樣本不足時後端回 null 而不是 0——0 與 null
                        在畫面上是兩件事：「一次都沒通過」與「還不足以判斷」。

                        **判斷用寬鬆等於而不是嚴格等於**：欄位缺席時是 undefined，
                        它嚴格等於 null 為 false ⇒ 會拿 undefined 進百分比格式化，畫面是
                        壞掉的數字（實測 zh-TW 的 `Intl` 把它印成「非數值%」，不是字面上的
                        `NaN`——所以「不含 NaN」這種斷言在 zh-TW 下擋不住任何東西）。
                        舊回應與這個檔既有的 fixture 都走這一格。

                        **下面那個顏色的門檻 0.8 是後端那一份的第二份**：唯一的出處是後端的
                        `RatingFor`（S 的第三個條件，設計 §13.2），這一格只是重複它來決定文字的
                        顏色。設計 §13.7 明白把那個門檻列為最可能在真實資料上要調的參數——調的時候
                        這一格要一起改，否則顏色會照著舊門檻上色，而**四道閘門都不會響**
                        （這裡的顏色沒有任何測試斷言）。不改成「由後端回傳門檻」是刻意的：
                        那是契約的擴大，已記為本階段的殘餘。
                      */}
                      <TableCell>
                        {m.fpy == null ? (
                          <span className="text-xs text-muted-foreground">{t("team:report.sampleInsufficient")}</span>
                        ) : (
                          <span className={'text-xs font-medium ' + (m.fpy >= 0.8 ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400")}>
                            {formatPercent(m.fpy, 1)}
                          </span>
                        )}
                      </TableCell>
                      {/*
                        平均評分與樣本數（Task 11）。S／A／B／C 的門檻是後端的事，這裡只顯示原料。

                        **樣本門檻要先補零再比**：欄位缺席時是 undefined，而 undefined 與數字
                        比大小一律為 false ⇒ 會直接跳過「樣本不足」去渲染一個不存在的平均分。
                        `?? 0` 讓缺席落回「0 筆 = 樣本不足」那一邊。

                        括號裡的筆數走計數句（基名，尾綴只存在於語系檔），不把數字拼進譯文。
                        平均分只在樣本足夠時才可能為 null（後端兩個值來自同一個字典的同一格），
                        這裡的 `?? 0` 是型別上的收尾，不是一條可達分支。
                      */}
                      <TableCell>
                        {(m.scoreSamples ?? 0) < 3 ? (
                          <span className="text-xs text-muted-foreground">{t("team:report.sampleInsufficient")}</span>
                        ) : (
                          <span className="text-xs font-medium">
                            {formatDecimal(m.averageScore ?? 0)}
                            <span className="text-muted-foreground font-normal">
                              {" (" + t("team:report.sampleCount", { count: m.scoreSamples ?? 0 }) + ")"}
                            </span>
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {members.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        {/*
                          **空狀態要分兩種**（2026-09-22，final review 的 M-5）：預設是「今年」
                          （設計 D5）⇒ 團隊在**其他年份**資料很多時也會走到這一格。舊制一律說
                          「目前沒有任何績效數據」——那是這一批要消滅的那種假話（2027-01-01
                          首次進入、交付全在 2026）。全期仍用原來那一條。
                        */}
                        {win.kind === "all" ? t("team:report.empty") : t("team:report.year.empty")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </>
        )}
      </section>

      {/* 成員個人年度檔案對話框 (Member Performance Dossier) */}
      {selectedMember && (
        <Dialog
          open
          onOpenChange={() => {
            // 關閉 dossier 時把 drill-down 的 metric 一起收掉：否則下一個成員的 dossier
            // 一開，上一輪的 drill-down 會**自動**跟著開起來（它只檢查 metric 非 null）。
            setSelectedMember(null);
            setDrilldownMetric(null);
          }}
        >
          {/*
            列印隔離（2026-10-21，使用者實測「預覽兩頁、內容一樣」）：Radix 的
            `DialogContent` 基底是 `position: fixed`；列印時固定定位的元素會畫在
            **每一頁**上（當場量：報表頁 2 頁 ⇒ 考核表也印了 2 份）。`data-dossier-print`
            讓 `index.css` 的列印規則把背後的 `#root` 收掉，`print:static` 讓對話框
            回到文件流——只印這一張表，不再跟著底下的頁數重複。關閉鈕與頭像同理：
            紙上不需要叉叉，頭像只剩一個姓氏字首。
          */}
          <DialogContent
            data-dossier-print=""
            className="max-w-md max-h-[84vh] overflow-y-auto print:static print:transform-none print:w-full print:max-w-none print:max-h-none print:overflow-visible print:rounded-none print:border-none print:shadow-none print:p-6"
          >
            <DialogHeader>
              {/*
                右上角留給關閉鈕：`dialog.tsx` 把它釘在 `right-4 top-4`（16px 圖示 ⇒ 佔到距
                右緣 32px），而列印鈕是標題列的最後一個元素——沒有這 40px，列印鈕的右上角
                會和叉叉疊在一起，就是使用者回報的「叉叉有點跑版」。
              */}
              <div className="flex items-center justify-between pr-10">
                <DialogTitle className="flex items-center gap-2 text-lg">
                  <Avatar className="h-8 w-8 print:hidden">
                    {selectedMember.avatarUrl ? (
                      <AvatarImage src={selectedMember.avatarUrl} alt={selectedMember.displayName} />
                    ) : (
                      <AvatarFallback>{selectedMember.displayName?.charAt(0) || selectedMember.username.charAt(0).toUpperCase()}</AvatarFallback>
                    )}
                  </Avatar>
                  {t("team:report.dossier.title", { name: selectedMember.displayName })}
                </DialogTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.print()}
                  className="h-8 text-xs gap-1.5 print:hidden"
                >
                  <Printer className="h-3.5 w-3.5" />
                  {t("team:report.dossier.print.action")}
                </Button>
              </div>
              <DialogDescription>
                {t("team:report.dossier.account", { username: selectedMember.username })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
                <span className="text-sm font-medium">{t("team:report.dossier.rating")}</span>
                {getRatingBadge(selectedMember.rating)}
              </div>

              {/* grade 分解（Task 4）：只渲染伺服器算好的 `ratingBreakdown`，舊回應沒有這個
                  鍵時整個區塊不渲染。放在評級列的正下方——「為什麼是這個等級」是那一列的註腳。 */}
              <RatingExplanation member={selectedMember} />

              {/* 考核期間：考評表上的數字都是**選定窗框**內的（螢幕與列印都是同一組），
                  少了這一列，列印出來的主管簽核檔案就沒有寫是哪一年。 */}
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <span className="text-sm font-medium">{t("team:report.dossier.period")}</span>
                <span className="text-sm font-semibold">{periodLabel}</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg border">
                  <div className="text-xs text-muted-foreground">{t("team:report.stat.completed")}</div>
                  <div className="text-xl font-bold mt-1">{selectedMember.completedCards} / {selectedMember.totalCards}</div>
                </div>
                {/* 與表格那一格同一個分支（寬鬆 `== null`，涵蓋 undefined）——兩處都必須擋，
                    否則列印出來的主管簽核檔案上會是一個 0.0% 與一個 100.0%。 */}
                <DrilldownStatButton
                  label={t("team:report.stat.completion")}
                  value={selectedMember.completionRate == null
                    ? t("team:report.sampleInsufficient")
                    : formatPercent(selectedMember.completionRate, 1)}
                  onClick={() => setDrilldownMetric("completion")}
                />
                <DrilldownStatButton
                  label={t("team:report.metric.onTime")}
                  value={selectedMember.onTimeRate == null
                    ? t("team:report.sampleInsufficient")
                    : formatPercent(selectedMember.onTimeRate, 1)}
                  onClick={() => setDrilldownMetric("onTime")}
                />
                {/* Task 4：dossier 原本沒有這兩個數字，grade 分解卻靠它們解釋 S 的資格。
                    `null` ＝樣本不足（後端刻意不回 0），與表格那兩欄同一個語意。 */}
                <DrilldownStatButton
                  label={t("team:report.column.firstPassYield")}
                  value={selectedMember.fpy == null
                    ? t("team:report.sampleInsufficient")
                    : formatPercent(selectedMember.fpy, 1)}
                  onClick={() => setDrilldownMetric("firstPassYield")}
                />
                <DrilldownStatButton
                  label={t("team:report.dossier.explanation.averageScore")}
                  value={dossierAverageScore == null
                    ? t("team:report.sampleInsufficient")
                    : formatDecimal(dossierAverageScore)}
                  onClick={() => setDrilldownMetric("averageScore")}
                />
                <div className="p-3 rounded-lg border">
                  <div className="text-xs text-muted-foreground">{t("team:report.stat.hours")}</div>
                  <div className="text-xl font-bold mt-1">{formatHours(selectedMember.loggedHours ?? 0)}</div>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 text-xs text-muted-foreground leading-relaxed">
                💡 {t("team:report.dossier.criteria")}
              </div>

              {/* 專供列印之主管簽核考評欄位 */}
              <div className="hidden print:block border-t pt-4 mt-6 text-xs text-foreground space-y-4">
                <div className="font-semibold text-sm">{t("team:report.dossier.supervisor.label")}</div>
                <div className="border border-dashed rounded p-3 h-24 text-muted-foreground">
                  {t("team:report.dossier.supervisor.hint")}
                </div>
                <div className="flex justify-between pt-6 text-xs font-medium">
                  <div>{t("team:report.dossier.signature")}</div>
                  <div>{t("team:report.dossier.signDate")}</div>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* drill-down：疊在 dossier 上的一層，dossier 本身不跟著關。條件掛載 ⇒ 關閉即卸載，
          內部的頁碼與選取列不會跨成員／metric 殘留。窗框與報表同源（見上面的
          `drilldownWindow`）。 */}
      {selectedMember && drilldownMetric && (
        <ReportDrilldownDialog
          open
          onOpenChange={(open) => {
            if (!open) setDrilldownMetric(null);
          }}
          teamId={teamId}
          member={selectedMember}
          metric={drilldownMetric}
          from={drilldownFrom}
          to={drilldownTo}
        />
      )}
    </div>
  );
}
