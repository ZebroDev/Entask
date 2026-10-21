import { BadgeCheck, Clock, XCircle } from "lucide-react";
import type { TFunction } from "i18next";

// 審查呈現的**唯一來源**：文字徽章的 className、圖示、圖示的語意色、三態文字。
//
// 共用這裡的落點：看板卡片、卡片對話框、表格（文字徽章）；月曆、甘特、心智圖（圖示）。
// 心智圖有**兩個**圖示落點：畫布節點（`MindMapCustomNode.tsx`）與大綱列（`MindMapTab.tsx`
// 的 `NodeRow`，2026-09-18 使用者裁定補上）。這裡刻意不寫總數——它每加一個落點就腐爛一次。
// `REVIEW_BADGE_CLASS` 與 `REVIEW_ICON_CLASS` 的語意必須同源同順序，兩半各有閘門：
// **key 的存在性由 `tsc -b` 擋**——這兩個物件在整個 `src/` 只有五個索引點
// （`ReviewStateIcon.tsx` 的 `REVIEW_ICON[state]` 與 `REVIEW_ICON_CLASS[state]` 兩處，
// 索引鍵都是完整的 `ReviewVerdict`；`BoardCard.tsx`、`ItemDetailsTab.tsx`、`TableTab.tsx`
// 三處的 `REVIEW_BADGE_CLASS[card.reviewState]` 在 `card.reviewState &&` 的真值窄化之下
// 也同樣是那三個鍵），少一鍵就在其中一處紅。**值的漂移**（同一狀態兩邊不同色系）
// `tsc -b` 看不到，由 `review-badge.test.ts` 逐狀態比對色彩家族，三個狀態兩兩相異
// 也釘在同一支。「同順序」仍是可讀性慣例，沒有閘門。
// ★ **同一組語意的第三份副本**是心智圖匯出的 SVG `fill`——`pages/project/mindmap/
//   mindmap-export.ts` 的 `REVIEW_EXPORT_COLOR`。它只能是 hex、無法共用這裡的 utility，
//   而上一段的家族比對**看不到色階**（`green-600` → `green-500` 家族沒變）⇒ 那兩份之間
//   另有一組契約（同一個測試檔，含 `--destructive` 這個 CSS 變數那一格）。
//
// 文字的部分是 switch ＋ 字面值 key：`i18next-parser` 只認字面值引數，查表會讓 key
// 被 `keepRemoved: false` 從語系檔刪掉，畫面直接印出 key 本身而沒有任何紅燈。
//
// 徽章**外殼**：三個文字落點共用的一組幾何與字級 class——看板卡片（`BoardCard.tsx`）、
// 卡片對話框（`ItemDetailsTab.tsx`）、表格（`TableTab.tsx`）。落點各自要的額外 class
// 接在這一串的前後（`shrink-0` 在前、`ml-2` 在前、`align-middle` 在後），**位置照舊**，
// 所以抽出來前後的畫面 className 逐字元相同。
//
// 抽出來的理由就是這一階段的論點：三個徽章必須**看起來是同一顆**，而三份字面值裡有
// 任何一份被改到，都不會有任何紅燈（沒有測試斷言 className）。
export const REVIEW_BADGE_SHELL = "px-1.5 py-0.5 rounded text-[10px] font-medium";

export const REVIEW_BADGE_CLASS = {
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  approved: "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100",
  rejected: "bg-destructive/15 text-destructive",
} as const;

export type ReviewState = "pending" | "approved" | "rejected" | null;
export type ReviewVerdict = Exclude<ReviewState, null>;

// 與 REVIEW_BADGE_CLASS 同一組語意、同一個順序。
// 圖示刻意不用 CheckCircle2：它在本 repo 已經是「完成」的圖示（甘特左欄、心智圖節點），
// 審查「通過」再用它會讓兩個構面塌成一個。BadgeCheck 讀作「核定」，形狀也不同。
export const REVIEW_ICON = {
  pending: Clock,
  approved: BadgeCheck,
  rejected: XCircle,
} as const;

export const REVIEW_ICON_CLASS = {
  pending: "text-amber-600 dark:text-amber-400",
  approved: "text-green-600 dark:text-green-400",
  rejected: "text-destructive",
} as const;

// 各落點的翻譯函式來自不同的 namespace 組合（看板卡片是 card ＋ common、
// 表格是 common ＋ project ＋ card、圖示只有 common），而 i18next 的型別化 key 把
// namespace 清單編進 `$TFunctionBrand`——**任兩組不同的清單互不相容**，所以參數寫成
// 裸的 `TFunction`（＝單一 namespace）或只列一組清單，都會在呼叫端紅。
//
// 這裡並列目前呼叫端實際傳進來的清單。逐審查者的那一支是 `ItemDetailsTab.tsx` 的
// `reviewStatusLabel`——**不在本檔**，與這裡的 `reviewStateLabel` 只差一個字、語意不同
// （一個翻某位審查者的立場、一個翻整張卡的 rollup），別把兩邊的參數清單互相照抄；
// 那一支的型別說明在它自己檔案裡。新增呼叫端時把它的那一組補進來：
// **少補會在呼叫端紅，不會靜默**。
type ReviewLabelTranslate = TFunction<
  | readonly ["card", "common"]
  | readonly ["common"]
  | readonly ["common", "card"]
  | readonly ["common", "project", "card"]
  // 團隊報表的 drill-down（2026-10-21）：FPY 的第一筆 review 狀態。
  | readonly ["common", "team"]
>;

// **兩個 key 仍不同，但顯示字已於 2026-09-19 統一為「待審查」**：本支走 `common:state.pending`，
// 逐審查者那一支（`ItemDetailsTab.tsx` 的 `reviewStatusLabel`，**不在本檔**；與本支只差一個字，
// 別把兩邊的參數清單互相照抄）走 `card:review.status.pending`。兩個鍵的**值**現在逐字相同
// （2026-09-19 使用者裁定統一；原本是「待審查」／「待審」的分裂，那個分裂已不存在）。
// 語意仍是兩件事——一個翻整張卡的 rollup、一個翻某位審查者的立場——所以**鍵不合并**，
// 但**不要再把這兩個鍵描述成「刻意不同字」**（那會讓下一個譯者以為值必須不一樣）。
//
// 下面兩條守門員的敘述**只有 ① 還成立**：
// ① 本支改接 `card:review.status.*` ⇒ `check:labels` 紅（本表 `allowedPrefixes` 只有 `common:state.`）。
// ② **已失效（2026-09-21 突變實測推翻 2026-09-18 的敘述）**：把逐審查者那一支改接
//    `common:state.pending` ⇒ 三道防線**全綠**（`CardDialog.test.tsx` 82/82、`check:labels`
//    exit 0、`tsc -b` exit 0）。舊敘述預測它會紅在「精確字串 `管理員：待審`」，那個預測的前提
//    是兩支**不同字**；統一之後前提消失。⇒ **今天沒有機器守著「逐審查者那一支要走
//    `card:review.status.pending`」**，改掉它只會讓其中一個鍵變成孤兒，而且沒有紅燈。
// 檢查 8 與這件事無關（2026-09-18 whole-branch review 的 I-1 實查：檢查 8 只比對同一支檔案裡的
// 兩個 `scope` 表，合併之後全庫僅存的兩個 scoped 表分屬兩支檔案 ⇒ 已無對象可比）。
export function reviewStateLabel(t: ReviewLabelTranslate, state: ReviewVerdict): string {
  switch (state) {
    case "pending": return t("common:state.pending");
    case "approved": return t("common:state.approved");
    case "rejected": return t("common:state.rejected");
  }
}
