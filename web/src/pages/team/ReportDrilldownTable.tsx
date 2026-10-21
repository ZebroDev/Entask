/**
 * drill-down 的表格（2026-10-21，報表可解釋性 Task 5）。
 *
 * 從 `ReportDrilldownDialog` 拆出的「表格列元件」：對話框那一支負責請求、摘要、分頁與
 * 卡片對話框；欄位依 metric 分流的部分全在這裡。兩個檔都在 300 行以下。
 *
 * 欄位規則（設計 §4.2／§4.6）：
 * * 卡片類（完成率／準時率）：卡片、專案、完成時間、截止日、是否算分子。
 * * 一次交付通過率：多第一筆 review 的狀態、時間與審查者。
 * * 準時率：多截止日變更；`from`／`to` 為 null 是舊資料，`changedAt > completedAt`
 *   是完成後才改的（標記，不改 on-time 計算）。
 * * 平均分：資料粒度是 review entry——分數、審查者、審查時間。
 */
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ExternalLink } from "lucide-react";
import { formatDate, formatDateTime, formatDay, formatDecimal } from "@/lib/format";
import { reviewStateLabel, REVIEW_BADGE_CLASS, REVIEW_BADGE_SHELL } from "@/lib/review-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isReviewMetric, type DrilldownMetric, type ReportDrilldownRowItem } from "./report-types";

type Props = {
  metric: DrilldownMetric;
  rows: ReportDrilldownRowItem[];
  /** 整列可點（列本身就是開卡片對話框的入口）；動作鈕也走同一個 handler。 */
  onOpenRow: (row: ReportDrilldownRowItem) => void;
};

/** due date 是「日」不是時間：`yyyy-MM-dd` 走 `formatDay`（本地日解析），不走 `formatDate`。 */
const dueDay = (iso: string | null) => (iso == null ? "—" : formatDay(iso.slice(0, 10)));

export function ReportDrilldownTable({ metric, rows, onOpenRow }: Props) {
  const { t } = useTranslation(["common", "team"]);
  const review = isReviewMetric(metric);
  // 空狀態那一格的 colSpan 跟著欄數走（含動作欄）：卡片類 6 欄、帶專屬欄的 7 欄。
  const columnCount = review
    ? 6
    : metric === "completion"
      ? 6
      : 7;

  return (
    // 窄螢幕（手機）上表格是 `w-full`：欄位不禁止換行時，日期／徽章／動作鈕先吃掉
    // 最小寬度，卡片欄只剩一個字寬，中文逐字換行 ⇒ 文字看起來是直的、每列高度等於
    // 字數（2026-10-21 使用者實測）。禁止換行後由 `Table` 外層的 `overflow-auto`
    // 橫向捲動——與報表主表格同一個做法。
    <Table className="whitespace-nowrap">
      <TableHeader>
        <TableRow>
          <TableHead>{t("team:report.drilldown.columns.card")}</TableHead>
          <TableHead>{t("team:report.drilldown.columns.project")}</TableHead>
          {review ? (
            <>
              <TableHead>{t("team:report.drilldown.columns.score")}</TableHead>
              <TableHead>{t("team:report.drilldown.columns.reviewer")}</TableHead>
              <TableHead>{t("team:report.drilldown.columns.reviewedAt")}</TableHead>
            </>
          ) : (
            <>
              <TableHead>{t("team:report.drilldown.columns.completedAt")}</TableHead>
              <TableHead>{t("team:report.drilldown.columns.dueAt")}</TableHead>
              {metric === "firstPassYield" && (
                <TableHead>{t("team:report.drilldown.columns.firstReview")}</TableHead>
              )}
              {metric === "onTime" && <TableHead>{t("team:report.drilldown.columns.dueChanges")}</TableHead>}
              <TableHead>{t("team:report.drilldown.columns.qualifies")}</TableHead>
            </>
          )}
          <TableHead className="text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow
            key={`${row.cardId}-${row.reviewEntryId ?? row.firstReviewEntryId ?? index}`}
            className="cursor-pointer hover:bg-muted/40"
            onClick={() => onOpenRow(row)}
          >
            <TableCell className="font-medium">{row.title}</TableCell>
            <TableCell className="text-muted-foreground">{row.projectName}</TableCell>
            {review ? (
              <>
                <TableCell className="tabular-nums">
                  {row.score == null ? "—" : formatDecimal(row.score)}
                </TableCell>
                <TableCell>{row.reviewerName || "—"}</TableCell>
                <TableCell className="text-xs">{formatDateTime(row.reviewCreatedAt)}</TableCell>
              </>
            ) : (
              <>
                <TableCell className="text-xs">{formatDateTime(row.completedAt)}</TableCell>
                <TableCell className="text-xs">{dueDay(row.dueAt)}</TableCell>
                {metric === "firstPassYield" && (
                  <TableCell className="text-xs">
                    <FirstReviewCell
                      status={row.firstReviewStatus}
                      at={row.firstReviewAt}
                      reviewer={row.firstReviewerName}
                      t={t}
                    />
                  </TableCell>
                )}
                {metric === "onTime" && (
                  <TableCell className="text-xs">
                    <DueChangesCell changes={row.dueChanges} completedAt={row.completedAt} />
                  </TableCell>
                )}
                <TableCell>
                  {row.qualifies ? (
                    <span className="text-green-600 dark:text-green-400">✓</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </>
            )}
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenRow(row);
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {/* 卡片類列說「查看卡片」，平均分列說「查看 review」——兩個 key
                    （`dossier.explanation.viewCards`／`viewReviews`）在 Task 5 之前
                    沒有任何消費者（`i18next-parser` 因此是紅的）。 */}
                {review
                  ? t("team:report.dossier.explanation.viewReviews")
                  : t("team:report.dossier.explanation.viewCards")}
              </Button>
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={columnCount} className="py-8 text-center text-muted-foreground">
              {t("team:report.drilldown.empty")}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** FPY 的第一筆 review：狀態徽章＋時間＋審查者。沒有 review 的卡片留白（它是分母）。 */
function FirstReviewCell({
  status,
  at,
  reviewer,
  t,
}: {
  status: string | null;
  at: string | null;
  reviewer: string | null;
  t: TFunction<["common", "team"]>;
}) {
  if (status == null) return <span className="text-muted-foreground">—</span>;
  const verdict = reviewVerdict(status);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {verdict ? (
        <Badge variant="outline" className={`${REVIEW_BADGE_SHELL} ${REVIEW_BADGE_CLASS[verdict]}`}>
          {reviewStateLabel(t, verdict)}
        </Badge>
      ) : (
        // 認不得的狀態原樣顯示（不猜一個「通過」給它）。
        <span>{status}</span>
      )}
      <span className="text-muted-foreground">{formatDateTime(at)}</span>
      {reviewer && <span className="text-muted-foreground">· {reviewer}</span>}
    </span>
  );
}

/**
 * 後端的 `firstReviewStatus` 是字串（`pending`／`approved`／`rejected`）。認不得的值
 * **原樣顯示**，不猜——與評級徽章同一個原則：後端新增狀態而前端沒跟上時，畫面要說
 * 「我不認識它」，不是給一個看起來正常的標籤。
 */
function reviewVerdict(status: string): "pending" | "approved" | "rejected" | null {
  return status === "pending" || status === "approved" || status === "rejected" ? status : null;
}

/**
 * on-time 的 due date 變更。兩條規則可以同時成立：
 * * `from` 或 `to` 為 null ⇒ 舊資料，顯示「舊版未記錄數值」（沒有數值可以畫箭頭）。
 * * `changedAt > completedAt` ⇒ 完成後才改的，加一個標記——**不改 on-time 計算**。
 */
function DueChangesCell({
  changes,
  completedAt,
}: {
  changes: ReportDrilldownRowItem["dueChanges"];
  completedAt: string | null;
}) {
  const { t } = useTranslation(["common", "team"]);
  const list = changes ?? [];
  if (list.length === 0) return <span className="text-muted-foreground">—</span>;
  const completed = completedAt == null ? null : new Date(completedAt).getTime();
  return (
    <ul className="space-y-1">
      {list.map((change, index) => {
        const afterCompletion = completed != null && new Date(change.changedAt).getTime() > completed;
        return (
          <li key={index} className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">{formatDateTime(change.changedAt)}</span>
            <span>
              {change.from == null || change.to == null
                ? t("team:report.drilldown.dueChange.legacy")
                : `${formatDate(change.from)} → ${formatDate(change.to)}`}
            </span>
            {afterCompletion && (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
              >
                {t("team:report.drilldown.dueChange.afterCompletion")}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
