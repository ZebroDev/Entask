import { useTranslation } from "react-i18next";
import { REVIEW_ICON, REVIEW_ICON_CLASS, reviewStateLabel, type ReviewVerdict } from "@/lib/review-badge";

// 圖示形式的單一落點（月曆／甘特／心智圖）。無障礙名稱與 hover 提示都是完整句子
// ——單獨一個「通過」對螢幕閱讀器是歧義的。
//
// hover 提示走 SVG 原生的 title 子元素：React 的 SVG 型別沒有 title 屬性，掛在圖示上
// 過不了 `tsc -b`。無障礙名稱仍由 aria-label 提供（測試的 `*ByLabelText` 靠它，
// 不是靠 title 屬性）。
export function ReviewStateIcon({ state, className = "h-3 w-3" }: { state: ReviewVerdict; className?: string }) {
  const { t } = useTranslation(["common"]);
  const Icon = REVIEW_ICON[state];
  const label = t("common:reviewStatus.tooltip", { status: reviewStateLabel(t, state) });
  return (
    <Icon className={`${className} shrink-0 ${REVIEW_ICON_CLASS[state]}`} aria-label={label}>
      <title>{label}</title>
    </Icon>
  );
}
