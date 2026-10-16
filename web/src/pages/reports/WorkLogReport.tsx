import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { currentLocale, formatDecimal, hourUnit } from "@/lib/format";
import type { WorkLogReportResponse } from "@/lib/board-types";
import { localDayString } from "@/lib/local-day";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ChevronLeft, ChevronRight, Clock, FileText, Layers, UserX, Download, NotebookPen } from "lucide-react";
import { buildRange, shiftAnchor, type WorkLogMode } from "./worklog-range";
import { WorkLogMemberCard } from "./WorkLogMemberCard";
import { WorkLogMissingDialog } from "./WorkLogMissingDialog";
import { useTranslation } from "react-i18next";

interface Props {
  scope: "me" | "project" | "team";
  scopeId?: string;
}

// 模組層級只放識別碼：文案寫在這裡會在 import 時求值完，切換語系不會重算
// （「程式碼不變量 → i18n」的「模組層級的常數」）。文案由 `modeLabel` 在 render 端產生。
const MODES: WorkLogMode[] = ["day", "week", "month"];

export function WorkLogReport({ scope, scopeId }: Props) {
  const { t } = useTranslation(["common", "worklog"]);
  const [mode, setMode] = useState<WorkLogMode>("day");
  const [anchor, setAnchor] = useState(() => new Date());
  const [missingOpen, setMissingOpen] = useState(false);

  const range = buildRange(mode, anchor);
  const fromDay = localDayString(range.from);
  const toDay = localDayString(range.to);

  const base =
    scope === "me" ? "/me/worklog" : scope === "project" ? `/projects/${scopeId}/worklog` : `/teams/${scopeId}/worklog`;
  const queryString = `?from=${fromDay}&to=${toDay}`;

  const report = useQuery({
    queryKey: ["worklog", scope, scopeId ?? "", fromDay, toDay],
    queryFn: async () => (await api.get(`${base}${queryString}`)).data as WorkLogReportResponse,
  });

  const handleExport = async () => {
    try {
      // 匯出是唯一需要語系的請求：它打的是後端產生的 .xls，標籤住在伺服器端資源檔。
      // 偽語系 en-XA 到不了後端（伺服器認不得 → 回 zh-TW），僅 dev 可達。
      const res = await api.get(
        `${base}/export${queryString}&locale=${encodeURIComponent(currentLocale())}`,
        { responseType: "blob" },
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `worklog-${scope}-${fromDay.replaceAll("-", "")}.xls`;
      document.body.appendChild(a);
      a.click();
      // 延後到事件迴圈再釋放——同步 revoke 可能中斷部分瀏覽器的下載
      setTimeout(() => window.URL.revokeObjectURL(url), 0);
      a.remove();
    } catch {
      toast.error(t("common:error.export"));
    }
  };

  const data = report.data;
  const missingTotal = data ? data.members.reduce((acc, m) => acc + m.missingWorkdays, 0) : 0;

  // 第四張 KPI 括號裡的兩個數量。**先各自算成變數**，再當字串傳進外層訊息——
  // 一個 key 只有一個複數維度，`{{members}}` 與 `{{days}}` 各自變形只能在各自的訊息裡；
  // 而把內層呼叫直接寫進外層的選項物件裡時，i18next-parser **抽不到**內層那一條，
  // `keepRemoved: false` 會把那兩條從語系檔刪掉、畫面直接印出 key（B2-5b 的陷阱）。
  const missingMembers = t("worklog:kpi.missing.members", { count: data?.summary.memberCount ?? 0 });
  const missingEach = t("worklog:kpi.missing.each", { count: data?.summary.workdayCount ?? 0 });

  // 動態 key 一律寫成 switch ＋ 字面值（`custom-fields.ts` 的 `typeLabel` 是範本）：
  // `i18next-parser` 只認字面值引數，查表會讓這三條被 `keepRemoved: false` 從語系檔刪掉。
  const modeLabel = (m: WorkLogMode) => {
    switch (m) {
      case "day": return t("worklog:mode.day");
      case "week": return t("worklog:mode.week");
      case "month": return t("worklog:mode.month");
    }
  };

  const loadErrorDetail = apiErrorMessage(report.error, t("common:error.tryLater"));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {MODES.map((m) => (
            <Button
              key={m}
              variant={mode === m ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setMode(m)}
            >
              {modeLabel(m)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-7 w-7"
            aria-label={t("worklog:nav.prev.aria")} onClick={() => setAnchor((a) => shiftAnchor(mode, a, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[13rem] text-center text-sm font-medium" data-testid="worklog-range-label">
            {range.label}
          </span>
          <Button variant="outline" size="icon" className="h-7 w-7"
            aria-label={t("worklog:nav.next.aria")} onClick={() => setAnchor((a) => shiftAnchor(mode, a, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAnchor(new Date())}>
          {t("worklog:nav.today")}
        </Button>
        <Button variant="outline" size="sm" className="ml-auto h-7 gap-1.5 text-xs" onClick={handleExport}>
          <Download className="h-3.5 w-3.5" />
          {t("worklog:export.action")}
        </Button>
      </div>

      {report.isLoading && <Skeleton className="h-40 w-full" data-testid="worklog-skeleton" />}
      {report.isError && <p className="text-destructive">{t("common:error.loadDetail", { detail: loadErrorDetail })}</p>}

      {data && (
        <>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t("worklog:kpi.hours.title")}</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="worklog-kpi-hours">
                  {formatDecimal(data.summary.totalHours)}
                </div>
                <p className="text-xs text-muted-foreground">{hourUnit()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t("worklog:kpi.entries.title")}</CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="worklog-kpi-entries">{data.summary.entryCount}</div>
                {/* 單位與數字分屬兩個元素，所以 `count` 要自己傳：值裡沒有 `{{count}}`
                    可放（放進去等於同一張卡印兩次同一個數字），但 i18next 靠**選項名稱**
                    決定要不要做複數解析——`1 entry`／`12 entries` 就是靠這一個選項。 */}
                <p className="text-xs text-muted-foreground">
                  {t("worklog:kpi.entries.unit", { count: data.summary.entryCount })}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t("worklog:kpi.cards.title")}</CardTitle>
                <Layers className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="worklog-kpi-cards">{data.summary.cardCount}</div>
                <p className="text-xs text-muted-foreground">
                  {t("worklog:kpi.cards.unit", { count: data.summary.cardCount })}
                </p>
              </CardContent>
            </Card>
            {/* 第四張 KPI 可點擊開啟漏報明細：三個範圍都可點（me 看自己的漏報日）。
                用真正的 button 而非可點 div，Card 內無互動元素故合法。 */}
            <button
              type="button"
              className="w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-haspopup="dialog"
              data-testid="worklog-kpi-missing-button"
              onClick={() => setMissingOpen(true)}
            >
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    {scope === "me" ? t("worklog:kpi.reported.title") : t("worklog:kpi.missing.title")}
                  </CardTitle>
                  <UserX className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold" data-testid="worklog-kpi-missing">
                    {scope === "me"
                      ? `${data.members[0]?.reportedWorkdays ?? 0} / ${data.summary.workdayCount}`
                      : missingTotal}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {/* 複數跟的是上面那個大數字：me 是「已回報 / 本期」的天數比值
                        （分母決定單複數），群體範疇則是跨成員的漏報總和。 */}
                    {scope === "me"
                      ? t("worklog:kpi.reported.unit", { count: data.summary.workdayCount })
                      : t("worklog:kpi.missing.unit", {
                          count: missingTotal,
                          members: missingMembers,
                          days: missingEach,
                        })}
                    {t("worklog:kpi.missing.detail")}
                  </p>
                </CardContent>
              </Card>
            </button>
          </div>

          <WorkLogMissingDialog
            scope={scope}
            members={data.members}
            workdays={data.workdays}
            open={missingOpen}
            onOpenChange={setMissingOpen}
          />

          {scope !== "me" && (
            <h2 className="text-sm font-semibold text-foreground" data-testid="worklog-members-heading">
              {t("worklog:member.heading", { count: data.summary.memberCount })}
            </h2>
          )}

          {data.members.length === 0 ? (
            <EmptyState
              icon={<NotebookPen className="h-6 w-6" />}
              title={scope === "me" ? t("worklog:empty.me.title") : t("worklog:empty.group.title")}
              description={t("worklog:empty.description")}
            />
          ) : (
            <div className="space-y-3">
              {data.members.map((m) => (
                // key 帶 mode：切換日／週／月時強制重掛載，讓 WorkLogMemberCard 的
                // expanded 初始值（依 mode 決定）重新生效。少了 mode，從日模式切到月模式時
                // expanded 會殘留 true，月報就不會預設收合。
                <WorkLogMemberCard key={`${m.userId}-${mode}`} member={m} mode={mode} workdays={data.workdays} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
