// 團隊報表的回應型別。**從 `TeamReportTab.tsx` 原樣搬出來**（2026-10-21，Task 4）：
// grade 分解的解釋區塊（`RatingExplanation`）與 Task 5 的 drill-down 對話框都要用同一組
// 型別，留在元件檔裡就得讓對話框反向匯入頁面元件——型別因此獨立一份。
//
// 這些欄位名是**後端 JSON 契約的鏡子**（`RatingBreakdownDto` 家族，camelCase），
// 不是可以隨手改的前端內部名稱；改名要兩邊一起改，而沒有閘門會替你看見漂移。

export interface MemberPerformance {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  completedCards: number;
  totalCards: number;
  // **兩個比率可為 null＝「樣本不足」**（2026-09-21）：後端在沒有樣本時回 null，
  // 不回 0 也不回 1——0 是「一張都沒完成」、1 是「全部準時」，兩者都是有依據的結論。
  // 型別刻意寫成 `number | null`（不是 optional）：後端每一列都會帶這兩個鍵，
  // 而編譯器會因此強迫下面兩個欄位先收斂 null 分支才碰得到格式化函式。
  completionRate: number | null;
  onTimeCards?: number;
  onTimeRate?: number | null;
  // 準時率的分母。與 `firstPass`／`reviewed`／`scoreSamples` 同一個道理：原料與比率
  // 一起回傳，否則消費端看到 null 分不出「沒有樣本」與「別的原因」。前端目前只顯示比率。
  onTimeSamples?: number;
  loggedHours?: number;
  // 等級集合的權威在後端 `RatingCodes`（守門員是第六張標籤表），前端不再複寫第四份。
  // 沒有基準就沒有評等 ⇒ 一張卡片都沒有的成員這裡是 null。
  rating?: string | null;
  // Task 10／11 的兩個新指標。**全部選擇性**：舊的回應、以及這個檔既有的 fixture
  // 都不帶它們，缺席是常態而不是異常。缺席時的判斷見下面兩個欄位的註解（`== null`
  // 與 `?? 0` 是刻意的，兩者寫成嚴格比較都會靜默產生壞畫面）。
  firstPass?: number;
  reviewed?: number;
  fpy?: number | null;
  averageScore?: number | null;
  scoreSamples?: number;
  // grade 分解（設計 §4.4）。**選擇性**：舊後端的回應沒有這個鍵——缺席時整個解釋區塊
  // 不渲染（不是顯示一堆空值）。內容全由伺服器算好，前端只渲染、不重算門檻。
  ratingBreakdown?: RatingBreakdown;
}

/** 一個等級門檻。`threshold` 是 0..1 的比例（完成率／準時率／FPY 各自帶自己的）。 */
export type RatingTier = { rating: string; threshold: number };

/**
 * 一個「條件」。`role` 決定它的語意（`tier` 決定 A／B／C、`sGate` 只影響 S），
 * `status` 一律相對**該條件自己的規則**。`reason` 只在 `notApplicable` 時有值。
 */
export type RatingComponent = {
  key: string;
  role: "tier" | "sGate";
  value: number | null;
  sampleSize: number;
  status: "met" | "failed" | "notApplicable";
  achievedTier?: string | null;
  reason?: string | null;
  tiers?: RatingTier[];
  sampleThreshold?: number | null;
};

/**
 * 主管評分的調整項（客觀公式外面的獨立一層）。`from`／`to` 恆為「基準 → 最終」，
 * 沒有等級（零卡片）時兩者皆 null；`averageScore` null ＝ 沒有可用的評分樣本。
 */
export type RatingAdjustment = {
  status: "appliedUp" | "appliedDown" | "notApplied";
  reason?: string | null;
  from?: string | null;
  to?: string | null;
  averageScore?: number | null;
  scoreSamples: number;
  upThreshold: number;
  downThreshold: number;
  sampleThreshold: number;
};

export type RatingBreakdown = {
  baseRating: string | null;
  finalRating: string | null;
  components: RatingComponent[];
  adjustment: RatingAdjustment;
};

/** drill-down 的 metric wire 名稱（與後端 `MetricKey` 逐字對應）。Task 5 使用。 */
export type DrilldownMetric = "completion" | "onTime" | "firstPassYield" | "averageScore";

/**
 * 平均分的資料粒度是 **review entry**（一列＝一筆 entry），其餘三個是卡片。
 * 這個判斷同時決定表格欄位與 hiddenCount 的單位（「張卡片」／「筆 review」）——
 * 寫成兩個地方各一份的話，兩邊會各自漂移而畫面仍然像對的。
 */
export const isReviewMetric = (metric: DrilldownMetric) => metric === "averageScore";

// ---- drill-down 回應（Task 5）----
//
// 同樣是後端 JSON 契約的鏡子：`ReportDrilldownResponseDto`／`ReportDrilldownItemDto`／
// `DueChangeDto`（`src/Entask.Api/Dtos/ReportDtos.cs`）的 camelCase 版本。
// 日期一律是 ISO 字串；`null` 與 `0` 的區分沿用後端的語意（例如 `score` 為 null＝這一列
// 沒有分數，不是 0 分）。
//
// `dueChanges` 只有 on-time 的列會帶（其他 metric 是 null）。

/** 一筆 due date 變更。舊資料的 `from`／`to` 是 null（當時只記了時間）。 */
export type ReportDrilldownDueChange = {
  changedAt: string;
  from: string | null;
  to: string | null;
};

export type ReportDrilldownRowItem = {
  cardId: string;
  title: string;
  projectId: string;
  projectName: string;
  completedAt: string | null;
  dueAt: string | null;
  /** 這一列在母體內；`false` ＝在母體但不算分子（只對比率型 metric 有意義）。 */
  qualifies: boolean;
  firstReviewEntryId: string | null;
  firstReviewStatus: string | null;
  firstReviewAt: string | null;
  firstReviewerName: string | null;
  reviewEntryId: string | null;
  score: number | null;
  reviewCreatedAt: string | null;
  reviewerName: string | null;
  dueChanges: ReportDrilldownDueChange[] | null;
};

export type ReportDrilldownResponse = {
  metric: DrilldownMetric;
  rowKind: "card" | "reviewEntry";
  /** 全團隊（含呼叫者無權檢視的專案）：與團隊報表上的分子／分母逐格相等。 */
  populationCount: number;
  qualifyingCount: number;
  /** 只算呼叫者有 `card.read` 的專案；`hiddenCount` 是兩者的差額。 */
  visiblePopulationCount: number;
  visibleQualifyingCount: number;
  hiddenCount: number;
  rows: ReportDrilldownRowItem[];
  page: number;
  pageSize: number;
};
