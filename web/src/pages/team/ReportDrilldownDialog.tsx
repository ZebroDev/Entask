/**
 * 團隊報表的 drill-down 對話框（2026-10-21，報表可解釋性 Task 5）。
 *
 * 由 dossier 的某個 metric 觸發：問後端「這個成員在這個窗框內的這個 metric，是由哪些
 * 卡片／review entry 組成的」。四個 metric 共用一個對話框；表格與各 metric 的專屬欄位
 * 在 `ReportDrilldownTable`（拆檔以免兩邊都超過 300 行）。
 *
 * 兩條界線（裁定，不要「改良」）：
 * 1. **列點擊開既有的 `CardDialog`**——review history 是卡片對話框既有的分頁，不在這裡
 *    另做一個歷史清單。卡片對話框**條件掛載、關閉即卸載**（照 `CopyCardDialog` 的模式），
 *    本對話框本身不跟著關。
 * 2. 母體／分子／可見數全由後端算好；這裡不重算、也不寫任何門檻。`hiddenCount` 只拿來
 *    說明「有多少列因為權限看不到」，不改比率，而且單位跟著 metric 的粒度
 *    （平均分是「筆 review」，其餘是「張卡片」）。
 *
 * 窗框（`from`／`to`）是**後端 `ReportWindow` 的 ISO 界線**，由報表頁以同一個
 * `windowParams` 推導——兩邊各寫一份會讓 drill-down 的數字對不上上面的表。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CardDialog } from "@/pages/board/CardDialog";
import { ReportDrilldownTable } from "./ReportDrilldownTable";
import {
  isReviewMetric,
  type DrilldownMetric,
  type MemberPerformance,
  type ReportDrilldownResponse,
  type ReportDrilldownRowItem,
} from "./report-types";

/** 設計 §4.8：預設分頁 50（後端上限 200），對話框不提供改頁面大小的控件。 */
const PAGE_SIZE = 50;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  member: MemberPerformance;
  metric: DrilldownMetric;
  from?: string;
  to?: string;
};

export function ReportDrilldownDialog({ open, onOpenChange, teamId, member, metric, from, to }: Props) {
  const { t } = useTranslation(["common", "team"]);

  // 切換 metric／成員／窗框時頁碼歸 1。**在 render 期間歸零，不用 effect**：effect 會在
  // 第一個 commit 之後才跑，那時舊頁碼的那一跑已經把請求送出去了（使用者看到的是
  // 「換了 metric 之後短暫空白」，而多出來的請求沒有任何畫面看得到）。
  const resetKey = `${teamId}|${member.userId}|${metric}|${from ?? ""}|${to ?? ""}`;
  const [page, setPage] = useState(1);
  const [pageResetFor, setPageResetFor] = useState(resetKey);
  if (pageResetFor !== resetKey) {
    setPageResetFor(resetKey);
    setPage(1);
  }

  const [openRow, setOpenRow] = useState<ReportDrilldownRowItem | null>(null);

  const query = useQuery({
    // 六個維度全在 key 裡：少一個就會拿到另一組參數的快取，而畫面只會「數字不變」。
    queryKey: ["team-report-drilldown", teamId, member.userId, metric, from ?? null, to ?? null, page],
    queryFn: async () =>
      (
        await api.get(`/teams/${teamId}/report/drilldown`, {
          // 缺席的 from／to 不送（全期）——送空字串會被後端當成無效的 DateTime。
          params: {
            userId: member.userId,
            metric,
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            page,
            pageSize: PAGE_SIZE,
          },
        })
      ).data as ReportDrilldownResponse,
    // 關閉時不得發出請求：這個對話框由父層條件掛載已經保證一次，但 props 的 `open`
    // 仍是契約的一部分（直接使用這個元件的人不該因為忘了條件掛載就多打一支 API）。
    enabled: open,
  });

  const data = query.data;
  const rows = data?.rows ?? [];
  const review = isReviewMetric(metric);

  // 標題的 metric 名稱**逐一沿用 dossier tile 的 key**（不是表格欄那一套）：
  // completion 的 tile 是「任務達成率」、表格欄是「達成率」，兩個字串不一樣；
  // 平均分的 tile 用 `dossier.explanation.averageScore`。四處各寫一份的話，
  // 同一個 KPI 在 tile 與 drill-down 標題上會叫兩個名字，而畫面上沒有異狀。
  const metricName =
    metric === "completion"
      ? t("team:report.stat.completion")
      : metric === "onTime"
        ? t("team:report.metric.onTime")
        : metric === "firstPassYield"
          ? t("team:report.column.firstPassYield")
          : t("team:report.dossier.explanation.averageScore");

  // 錯誤文字先提成陳述式（`t()` 不得巢狀在另一個 `t()` 的引數子樹裡）。
  const loadErrorDetail = apiErrorMessage(query.error, t("common:error.tryLater"));

  // 剩下的列數看**可見母體**（rows 只含可讀專案的列），不是 qualifyingCount。
  const canNext = data != null && page * data.pageSize < data.visiblePopulationCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto print:hidden">
        <DialogHeader>
          <DialogTitle>
            {t("team:report.drilldown.title", {
              name: member.displayName || member.username,
              metric: metricName,
            })}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {data && (
                <>
                  <span>{t("team:report.drilldown.population", { n: data.populationCount })}</span>
                  <span>{t("team:report.drilldown.qualifying", { n: data.qualifyingCount })}</span>
                  {data.hiddenCount > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {review
                        ? t("team:report.drilldown.hiddenReviews", { count: data.hiddenCount })
                        : t("team:report.drilldown.hiddenCards", { count: data.hiddenCount })}
                    </span>
                  )}
                </>
              )}
            </div>
          </DialogDescription>
          {/* 設計 §4.6：due 變更紀錄自 2026-10-20 起才寫入——on-time 的 drill-down 必須
              說明這件事，否則更早的卡片看起來像「從來沒改過截止日」。其他 metric 沒有
              這個欄位，那句話出現在那裡就是錯的。 */}
          {metric === "onTime" && (
            <p className="text-xs text-muted-foreground">
              {t("team:report.drilldown.recordedSince")}
            </p>
          )}
        </DialogHeader>

        {query.isPending ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("common:state.loading")}</p>
        ) : query.isError ? (
          <p className="text-destructive">{t("common:error.loadDetail", { detail: loadErrorDetail })}</p>
        ) : (
          <ReportDrilldownTable metric={metric} rows={rows} onOpenRow={setOpenRow} />
        )}

        {/* 頁碼列**永遠掛載**：換頁時表格可以暫時換成 loading，但按鈕若跟著被卸載，
            焦點所在的元素會消失（鍵盤／讀屏使用者被丟回文件開頭）。取數中一律 disabled。 */}
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={query.isFetching || page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t("team:report.drilldown.page.prev")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={query.isFetching || !canNext}
            onClick={() => setPage((current) => current + 1)}
          >
            {t("team:report.drilldown.page.next")}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 條件掛載：關閉即卸載、重開即重新初始化（照 `CopyCardDialog` 的模式）。
            這個 Dialog 的 `open` 不隨卡片對話框變動——關掉卡片，drill-down 還在。 */}
        {openRow && (
          <CardDialog
            cardId={openRow.cardId}
            projectId={openRow.projectId}
            open
            onOpenChange={(next) => {
              if (!next) setOpenRow(null);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
