import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { formatDecimal, formatHours, formatPercent } from "@/lib/format";
import type { ProjectReportResponse } from "@/lib/board-types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Clock, CheckCircle2, AlertCircle, FileText, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { ReportWindowPicker } from "@/components/ReportWindowPicker";
import { windowKey, windowQuery, windowSuffix, type ReportWindowValue } from "@/lib/report-window";

interface Props { projectId: string; }

/**
 * 審查結果的顯示文字。值是後端 `ReviewStatuses` 的三個常數，走 switch ＋ 字面值
 * （設計 §6.1：查表的引數不是字面值，`i18next-parser` 掃不到，`keepRemoved: false`
 * 會把那些 key 從語系檔刪掉）。
 *
 * 三條 key 走 `common:state.*`：`approved`／`rejected` 在 `ItemDetailsTab` 的審查結果
 * 下拉選單裡本來就是這兩條，**`pending` 不是**——那裡用的是 `card:review.status.pending`
 * （「待審」），本批是 `common:state.pending`（「待審查」）。
 *
 * 也就是說同一個後端值 `pending` 有兩份譯文、兩個畫面文字，而**這在 B2-5b 之前就是
 * 如此**（`REVIEW_LABELS` 寫死「待審查」），本批的驗收訊號是「可見輸出不變」，所以
 * 兩處都逐字保留。要不要收斂成一條 key（代價：下拉選單的文字由「待審」變「待審查」）
 * 是產品文案決定，未裁定；兩處都已進 `scripts/check-label-tables.mjs` 的契約鎖，
 * 後端加狀態時兩邊都會紅。
 *
 * 這一組是 `scripts/check-label-tables.mjs` 的第三張表：後端 `ReviewStatuses.cs`
 * 加了新的狀態而這裡沒加 case 時，畫面會直接印出原始識別碼，而 tsc（有 default）、
 * 測試、parser、parity 都不會紅。
 */
function reviewLabel(status: string): string {
  switch (status) {
    case "pending":
      return i18n.t("common:state.pending");
    case "approved":
      return i18n.t("common:state.approved");
    case "rejected":
      return i18n.t("common:state.rejected");
    default:
      return status;
  }
}

function ProgressBar({ logged, estimated }: { logged: number; estimated: number | null }) {
  if (estimated === null || estimated <= 0) return <span className="text-muted-foreground">—</span>;
  const pct = Math.min(100, Math.round((logged / estimated) * 100));
  return (
    <div className="flex items-center gap-1">
      <div className="h-2 w-20 rounded bg-muted overflow-hidden">
        <div className="h-2 rounded bg-primary transition-all" style={{ width: `${pct}%` }} data-testid="progress-fill" />
      </div>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}

export function ReportTab({ projectId }: Props) {
  const { t } = useTranslation(["common", "project"]);
  // 報表窗框：預設**今年**（與團隊報表一致；2026-09-22 的裁定 2，是已出貨畫面的行為變更
  // ——「全期」是退回今日視圖的出口）。窗框語意（上界排他、本地日轉 UTC、選項來源）
  // 全在 `lib/report-window.ts`，兩頁共用同一份。
  const [win, setWin] = useState<ReportWindowValue>(() => ({ kind: "year", year: new Date().getFullYear() }));
  const reportQuery = windowQuery(win);

  const handleExport = async () => {
    try {
      // 匯出**帶著畫面上同一個窗框**：兩者分道揚鑣的話，使用者下載到的檔案與他正在看的
      // 數字不同，而兩邊都不會報錯（後端對兩條路徑各有自己的窗框語意，見 `ReportEndpoints`）。
      const res = await api.get(`/projects/${projectId}/report/export${reportQuery}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      // 檔名帶上期間：`a.download` 會覆蓋伺服器的 `Content-Disposition`，後端的後綴到不了
      // SPA 使用者，所以期間由前端決定（與團隊報表同一個規則）。
      a.download = `project-report-${projectId}${windowSuffix(win)}.csv`;
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

  const report = useQuery({
    // **窗框必須進 query key**：少了它，切換期間只會拿到前一格的快取，而畫面只會
    // 「數字不變」——沒有任何紅燈。既有的失效站點用 2 元素前綴（`["report", projectId]`），
    // react-query 5 是**前綴比對**（`partialMatchKey`）⇒ 它們仍然命中這個 3 元素 key。
    queryKey: ["report", projectId, windowKey(win)],
    queryFn: async () => (await api.get(`/projects/${projectId}/report${reportQuery}`)).data as ProjectReportResponse,
  });

  // 錯誤文字的值**必須先提成陳述式**：`t()` 不得巢狀在另一個 `t()` 的引數子樹裡——那會讓
  // 內層的 key 抽不出來，`keepRemoved: false` 再把它從語系檔刪掉，畫面直接印出 key 本身
  // （閘門 `check:error-paths` 的第二條規則）。
  const loadErrorDetail = apiErrorMessage(report.error, t("common:error.tryLater"));

  // 取數中／取數失敗時 `data` 是 undefined（**刻意不加** `placeholderData`：那會讓畫面
  // 短暫出現「新期間的標籤 ＋ 舊期間的數字」）。所以只有 `data` **在**的時候才渲染本體，
  // 而工具列與兩個狀態訊息活在它之外——取數失敗時那顆選擇器是唯一能救回畫面的控件。
  const data = report.data;

  return (
    <div className="space-y-6">
      {/*
        工具列：期間選擇器 ＋ 匯出鈕。

        **它必須活在取數狀態之上**（形狀同 `WorkLogReport`／`TeamReportTab`）。取數失敗時，
        期間選擇器是**唯一**能救回這個畫面的控件（換一個期間就是換一個 query key）；
        而匯出鈕緊鄰決定它窗框的那顆選擇器——兩者分開擺就會出現「按了匯出、檔案卻是
        另一個期間」，而兩邊都不會報錯。

        `labels` 傳的是**已經翻好的字串**而不是 key：傳 key 會讓元件裡變成 `t(labelKey)`，
        那是非字面值引數、`i18next-parser` 抽不到（`keepRemoved: false` 再把它刪掉，
        畫面直接印出 key 本身而所有測試照綠）。
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ReportWindowPicker
          id="project-report-window"
          value={win}
          onChange={setWin}
          availableYears={data?.availableYears}
          labels={{
            period: t("project:report.year.label"),
            all: t("project:report.year.all"),
            custom: t("common:period.custom"),
            from: t("common:period.from"),
            to: t("common:period.to"),
          }}
        />
        <Button variant="outline" size="sm" onClick={() => handleExport()} className="w-full sm:w-auto gap-1.5">
          <Download className="h-4 w-4" />
          {t("project:report.export.action")}
        </Button>
      </div>

      {report.isLoading && <Skeleton className="h-40 w-full" data-testid="report-skeleton" />}
      {report.isError && <p className="text-destructive">{t("common:error.loadDetail", { detail: loadErrorDetail })}</p>}

      {data && <ReportBody data={data} hasWindow={win.kind !== "all"} />}
    </div>
  );
}

/**
 * 報表主體。抽成獨立元件而不是就地包一個 fragment，是為了**不動既有 JSX 的縮排**
 * ——那 180 行的排版變更會把這個批次真正改的東西（窗框接線）埋掉。
 *
 * `data` 在這裡是**非空**的：取數中／失敗的兩格由外層的 `ReportTab` 負責，這樣本體就不必
 * 到處寫選擇性鏈（那正是「少一個 `?` 就白畫面」的來源）。
 */
function ReportBody({ data, hasWindow }: { data: ProjectReportResponse; hasWindow: boolean }) {
  const { t } = useTranslation(["common", "project"]);

  // 平均分是後端算出來的 double，原樣插進 JSX 會印出 `4.666666666666667`（實際拍到過）。
  // 走 `format.ts` 的固定一位小數——它是全站唯一的格式化出口（R11），
  // 自己寫 `toFixed(1)` 會把「幾位小數」與「小數點長什麼樣」寫死在這裡。
  const averageScore = data.reviewStats.averageScore == null ? "—" : formatDecimal(data.reviewStats.averageScore);

  const totalLogged = data.memberHours.reduce((acc, m) => acc + m.hours, 0);
  // **全期**（存量指標）：`memberRemaining` 不吃窗框，後端固定餵 `ReportWindow.All`
  // ——跨年時讓它吃窗框會出現「越做工時剩餘越多」。見下面那張卡的標題與說明。
  const totalRemaining = data.memberRemaining.reduce((acc, m) => acc + (m.remainingHours ?? 0), 0);
  // 鍵是**識別碼**不是文案（`Bar` 的 `dataKey` 指的就是它）——就地換成譯文
  // 會讓鍵跟著語系跑，切一次語系就多出一組長條。顯示名走 `<Bar name={t(...)}>`。
  // 這張圖與下面的「剩餘工時」表**同源、同樣是全期**（存量視角），不隨窗框動。
  const chartData = data.memberRemaining.map(m => ({
    name: m.displayName || m.username,
    logged: m.loggedHours,
    remaining: m.remainingHours ?? 0
  }));

  return (
    <>
      {/* 頂部 KPI 卡片 */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("project:report.kpi.logged.title")}</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatHours(totalLogged)}</div>
            <p className="text-xs text-muted-foreground">{t("project:report.kpi.logged.hint")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("project:report.kpi.remaining.title")}</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatHours(totalRemaining)}</div>
            <p className="text-xs text-muted-foreground">{t("project:report.kpi.remaining.hint")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("project:report.kpi.approval.title")}</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.reviewStats.approvedCount + data.reviewStats.rejectedCount > 0
                ? formatPercent(data.reviewStats.approvedCount / (data.reviewStats.approvedCount + data.reviewStats.rejectedCount))
                : formatPercent(1)}
            </div>
            <p className="text-xs text-muted-foreground">{t("project:report.kpi.approval.hint", { pending: data.reviewStats.pendingCount, score: averageScore })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("project:report.kpi.cards.title")}</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{t("project:report.kpi.cards.value", { count: data.cards.length })}</div>
            <p className="text-xs text-muted-foreground">{t("project:report.kpi.cards.hint")}</p>
          </CardContent>
        </Card>
      </div>

      {/* 工時視覺化圖表 */}
      {chartData.length > 0 && (
        <Card className="p-4">
          <CardHeader className="px-2 pt-0 pb-4">
            <CardTitle className="text-base font-semibold">{t("project:report.chart.title")}</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                {/* 工時一律經 `format.ts`（R11 的單一出口）——原本寫死的 `h` 與
                    「小時」是 P-B0 的遺留：單位由 Intl 提供，`en` 是 `hr`、
                    `es-419` 是 `h`，換語系時不必改任何一條譯文。

                    刻度**與 Tooltip 用同一個函式**：`hourUnit()` 的用途是「數字與單位
                    分屬兩個元素」的版面（見 `WorkLogReport`），拿來串字串會把
                    「數字與單位之間要不要空格」寫死在這裡——zh-TW 是 `12.5 小時`、
                    串起來卻是 `12.5小時`，同一張圖兩種格式。 */}
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => formatHours(value)} />
                <Tooltip formatter={(val: any) => formatHours(val)} />
                <Legend />
                <Bar dataKey="logged" name={t("project:report.chart.logged")} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="remaining" name={t("project:report.chart.remaining")} fill="hsl(var(--muted-foreground) / 0.3)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* 數據明細表格 */}
      <section>
        {/* 匯出鈕已移到工具列（2026-09-22）：它必須緊鄰決定它窗框的選擇器，而選擇器要活在
            取數失敗的時候——取數失敗時它必須還在（那是失敗當下唯一能拿到資料的出路）。 */}
        <h2 className="mb-2 text-sm font-semibold">{t("project:report.memberHours.title")}</h2>
        <Card className="overflow-x-auto">
          <Table className="whitespace-nowrap">
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("project:report.column.member")}</TableHead><TableHead>{t("project:report.memberHours.column.hours")}</TableHead><TableHead>{t("project:report.memberHours.column.cards")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.memberHours.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell>{m.displayName || m.username}</TableCell>
                  <TableCell>{m.hours}</TableCell>
                  <TableCell>{m.cardCount}</TableCell>
                </TableRow>
              ))}
              {data.memberHours.length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-muted-foreground">
                  {/* 空狀態**跟著窗框變**（`TeamReportTab` 的 M-5 同一類）：預設是「今年」，
                      所以資料都在別年時說「尚無工時紀錄」是一句假話——那正是本批在消滅的形狀。 */}
                  {hasWindow ? t("project:report.year.empty") : t("project:report.memberHours.empty")}
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">{t("project:report.remaining.title")}</h2>
        <Card className="overflow-x-auto">
          <Table className="whitespace-nowrap">
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("project:report.column.member")}</TableHead><TableHead>{t("project:report.column.estimated")}</TableHead><TableHead>{t("project:report.column.logged")}</TableHead><TableHead>{t("project:report.column.remainingProgress")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.memberRemaining.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell>{m.displayName || m.username}</TableCell>
                  <TableCell>{m.estimatedHours ?? "—"}</TableCell>
                  <TableCell>{m.loggedHours}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span>{m.remainingHours ?? "—"}</span>
                      <ProgressBar logged={m.loggedHours} estimated={m.estimatedHours} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">{t("project:report.review.title")}</h2>
        <div className="flex gap-4 text-sm">
          <span>{t("project:report.review.pending", { n: data.reviewStats.pendingCount })}</span>
          <span>{t("project:report.review.approved", { n: data.reviewStats.approvedCount })}</span>
          <span>{t("project:report.review.rejected", { n: data.reviewStats.rejectedCount })}</span>
          <span>{t("project:report.review.average", { n: averageScore })}</span>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">{t("project:report.detail.title")}</h2>
        <Card className="overflow-x-auto">
          <Table className="whitespace-nowrap">
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("project:report.detail.column.card")}</TableHead><TableHead>{t("project:report.detail.column.board")}</TableHead><TableHead>{t("project:report.detail.column.list")}</TableHead>
                <TableHead>{t("project:report.column.estimated")}</TableHead><TableHead>{t("project:report.column.logged")}</TableHead><TableHead>{t("project:report.column.remainingProgress")}</TableHead>
                <TableHead>{t("project:report.detail.column.review")}</TableHead><TableHead>{t("project:report.detail.column.priority")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.cards.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.title}</TableCell>
                  <TableCell>{c.boardName}</TableCell>
                  <TableCell>{c.listName}</TableCell>
                  <TableCell>{c.estimatedHours ?? "—"}</TableCell>
                  <TableCell>{c.loggedHours}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span>{c.remainingHours ?? "—"}</span>
                      {/* 進度條與上面的剩餘**同一個時間範圍**（全期）——同一格裡兩個東西不能各說各話。
                          全期已報 ＝ 預估 − 剩餘（後端的剩餘是存量，見
                          `ProjectReportQueries.GetCardRowsAsync` 的 XML 註解）；**不要**改成
                          `c.loggedHours`，那一欄是**窗框內**的流量、與同列的「已報」欄同源。
                          `estimatedHours` 為 null 時 `ProgressBar` 自己回「—」，
                          所以下面那兩個 `?? 0` 不會被用到。 */}
                      <ProgressBar
                        logged={(c.estimatedHours ?? 0) - (c.remainingHours ?? 0)}
                        estimated={c.estimatedHours}
                      />
                    </div>
                  </TableCell>
                  <TableCell>{c.reviewStatus ? reviewLabel(c.reviewStatus) : "—"}</TableCell>
                  <TableCell>{c.priority ? <Badge variant="outline">{c.priority}</Badge> : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>
    </>
  );
}
