import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * 語系切換時強制重掛整棵子樹。
 *
 * 為什麼需要：`format.ts` 不是 hook，它讀模組層的 i18n 實例。`useTranslation()` 只在
 * 「有呼叫它的元件」觸發重繪，所以一個只顯示格式化日期、沒有翻譯文字的元件，在切換
 * 語系後不會重繪——畫面上會留著舊語系的日期。P-B1 幾乎沒有元件用 `t()`，這個缺口
 * 從接上 `currentLocale()` 的當天就存在。
 *
 * 代價是子樹 remount（對話框與展開狀態重置）。語系切換是低頻且使用者主動的操作，
 * 可接受；且 CardDialog 是路由驅動，remount 後由 URL 還原。
 */
export function LanguageBoundary({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <Fragment key={i18n.resolvedLanguage}>{children}</Fragment>;
}
