import { useTranslation } from "react-i18next";
import { formatDecimal, formatPercent } from "@/lib/format";
import type { MemberPerformance, RatingAdjustment, RatingComponent } from "./report-types";

/**
 * dossier 的「為什麼是這個等級」區塊（2026-10-21，報表可解釋性 Task 4）。
 *
 * **它只渲染伺服器的 `ratingBreakdown`，不在前端算任何門檻**（設計 §4.4）：
 * 完成率／準時率／FPY 的界線、調整項的上下限與樣本門檻全部由 payload 帶下來
 * （`tiers`／`sampleThreshold`／`upThreshold`／`downThreshold`），這裡一個字面值都沒有
 * ——`check:thresholds` 守著「同一個門檻在 C# 與 TS 各有一份」的對，而這裡連一份都不該有。
 *
 * 三條渲染規則（裁定，照做不要「改良」）：
 * 1. `components` **照陣列順序**渲染：不依 key 查找、不在前端重排。
 * 2. sGate 的 `failed` 只影響 S 的資格。只有 `finalRating` 是 B／C 時才補上
 *    「未達 S 門檻（不影響 {{final}}）」——設計 §4.4 明令不得寫成「因為準時率所以是 B」；
 *    final 是 A（或 S）時這句話會誤導（A 的成因是完成率，不是這道 gate）。
 * 3. `finalRating` 為 null（零卡片／沒有任何評等依據）時顯示「樣本不足，不評等」，
 *    **不渲染 adjustment 的數字**：沒有等級就沒有加減的對象，把 0 筆樣本與門檻並列
 *    只會讓人以為「差一點就調整了」。
 *
 * 舊後端的回應沒有 `ratingBreakdown` ⇒ 整個區塊不渲染（不是顯示空殼）。
 */
export function RatingExplanation({ member }: { member: MemberPerformance }) {
  const { t } = useTranslation(["team"]);
  const breakdown = member.ratingBreakdown;
  if (!breakdown) return null;

  const { components, adjustment, finalRating } = breakdown;

  /**
   * `notApplicable` 的原因。認不得的原因與 `sampleInsufficient` 同一格：句子的意思是
   * 「這個條件沒有足夠樣本」，而畫面上留白會讀成「這個條件通過了」。
   */
  const notApplicableText = (reason: string | null | undefined): string => {
    switch (reason) {
      case "noDueSamples":
        return t("team:report.dossier.explanation.notApplicable.noDueSamples");
      case "noCards":
        return t("team:report.dossier.explanation.notApplicable.noCards");
      case "sampleInsufficient":
      default:
        return t("team:report.dossier.explanation.notApplicable.sampleInsufficient");
    }
  };

  /**
   * 單一條件的文字。`completion` 是 `tier`（說「完成率對到哪一級」），另外兩條是
   * `sGate`（只說自己的達成值；未達 S 的部分由呼叫端的註記負責）。
   *
   * `value` 為 null 卻不是 `notApplicable` 的形狀後端不會送；這裡仍留一條顯示原因的分支，
   * 因為壞掉的數字（`null` 進百分比格式化會印成「非數值%」）比留白更難查。
   */
  const componentText = (component: RatingComponent): string => {
    if (component.status === "notApplicable" || component.value == null) {
      return notApplicableText(component.reason);
    }
    const value = formatPercent(component.value, 1);
    switch (component.key) {
      case "completion":
        return t("team:report.dossier.explanation.completion", {
          value,
          achievedTier: component.achievedTier ?? "",
        });
      case "onTime":
        return t("team:report.dossier.explanation.onTime", { value });
      case "firstPassYield":
        return t("team:report.dossier.explanation.firstPassYield", { value });
      default:
        // 後端新增了前端還不認識的條件：原樣顯示 key 與數值。猜一個標籤會讓新增的
        // 條件**看起來**已經被解釋了，而沒有人會發現前端沒跟上。
        return `${component.key}: ${value}`;
    }
  };

  /**
   * 一個條件的「門檻 ＋ 樣本數」副行（設計 §1：值、門檻、樣本數三件都要在畫面上）。
   *
   * **所有數字都來自 payload**（`tiers[].threshold`／`sampleSize`／`sampleThreshold`）
   * ——這裡仍然沒有門檻字面值，`check:thresholds` 的意義因此不變。`sampleThreshold`
   * 只有 FPY 會帶（後端契約），缺席時就不提門檻，不補一個預設值。
   */
  const componentDetail = (component: RatingComponent): string => {
    const parts: string[] = [];
    if (component.tiers && component.tiers.length > 0) {
      parts.push(
        component.tiers
          .map((tier) =>
            t("team:report.dossier.explanation.tierThreshold", {
              rating: tier.rating,
              threshold: formatPercent(tier.threshold, 1),
            }),
          )
          .join(" · "),
      );
    }
    parts.push(
      component.sampleThreshold == null
        ? t("team:report.dossier.explanation.sampleSize", { samples: component.sampleSize })
        : t("team:report.dossier.explanation.sampleWithThreshold", {
            samples: component.sampleSize,
            threshold: component.sampleThreshold,
          }),
    );
    return parts.join(" · ");
  };

  /** `notApplied` 的原因。四種原因各自一句，**不巢狀呼叫翻譯函式**（閘門 `check:error-paths`）。 */
  const adjustmentReasonText = (value: RatingAdjustment): string => {
    switch (value.reason) {
      case "sampleInsufficient":
        return t("team:report.dossier.explanation.adjustment.sampleInsufficient", {
          samples: value.scoreSamples,
          threshold: value.sampleThreshold,
        });
      case "atCeiling":
        return t("team:report.dossier.explanation.adjustment.atCeiling");
      case "atFloor":
        return t("team:report.dossier.explanation.adjustment.atFloor");
      case "withinRange":
      default:
        return t("team:report.dossier.explanation.adjustment.withinRange", {
          down: formatDecimal(value.downThreshold),
          up: formatDecimal(value.upThreshold),
        });
    }
  };

  /**
   * 沒有平均分時的調整句。**後端契約下走不到**（沒有分數樣本就不會套用調整），但字串
   * 不能留成「平均分 ，N 筆」——那是一個看起來像翻譯壞掉的句子。不新增 i18n key：
   * 等級代碼與箭頭是資料，樣本數沿用既有的 `team:report.sampleCount`（複數族），
   * 括號沿用本頁既有的字串拼接慣例（表格的平均分欄同一個形狀）。
   */
  const appliedWithoutScore = (value: RatingAdjustment): string =>
    `${value.from ?? ""} → ${value.to ?? ""} (${t("team:report.sampleCount", { count: value.scoreSamples })})`;

  /**
   * 調整項的一行字。`from`／`to` 是等級代碼（原文，不經標籤表）：這一行是「B → C」
   * 的算式，等級的中文名在旁邊的評級徽章上已經有了。
   */
  const adjustmentText = (value: RatingAdjustment): string => {
    const score = value.averageScore == null ? null : formatDecimal(value.averageScore);
    if (value.status === "appliedUp") {
      return score == null
        ? appliedWithoutScore(value)
        : t("team:report.dossier.explanation.adjustment.appliedUp", {
            from: value.from ?? "",
            to: value.to ?? "",
            score,
            samples: value.scoreSamples,
          });
    }
    if (value.status === "appliedDown") {
      return score == null
        ? appliedWithoutScore(value)
        : t("team:report.dossier.explanation.adjustment.appliedDown", {
            from: value.from ?? "",
            to: value.to ?? "",
            score,
            samples: value.scoreSamples,
          });
    }
    // **未套用也要帶分數**：四個 KPI tile 是 `print:hidden`，列印版看不到它們；這一格
    // 若只寫原因，列印出來的平均分就整個消失了（2026-10-21 review 的列印缺口）。
    // 四種原因句本身不變——分數與樣本數是併在後面的括號子句。
    if (score == null) {
      return t("team:report.dossier.explanation.adjustment.notApplied", {
        rating: value.from ?? "",
        reason: adjustmentReasonText(value),
      });
    }
    return t("team:report.dossier.explanation.adjustment.notAppliedWithScore", {
      rating: value.from ?? "",
      reason: adjustmentReasonText(value),
      score,
      samples: value.scoreSamples,
    });
  };

  return (
    <div data-testid="rating-explanation" className="p-3 rounded-lg border space-y-2">
      <div className="text-sm font-medium">{t("team:report.dossier.explanation.title")}</div>
      {finalRating == null ? (
        <p className="text-xs text-muted-foreground">
          {t("team:report.dossier.explanation.notApplicable.noCards")}
        </p>
      ) : (
        <>
          <ul className="space-y-1 text-xs">
            {components.map((component) => {
              // 註記只在「該 gate 真的沒過 S」且「最終等級是 B／C」時出現——final 是 A
              // 時這句話不成立（A 不是被這道 gate 決定的），出現就是設計 §4.4 禁止的誤導。
              const showSGateNote =
                component.role === "sGate" &&
                component.status === "failed" &&
                (finalRating === "B" || finalRating === "C");
              return (
                <li key={component.key} className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-muted-foreground">{componentText(component)}</span>
                    <span className="text-muted-foreground/80">{componentDetail(component)}</span>
                  </div>
                  {showSGateNote && (
                    <span className="text-amber-600 dark:text-amber-400 shrink-0">
                      {t("team:report.dossier.explanation.sGateNote", { final: finalRating })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex items-start justify-between gap-2 border-t pt-2 text-xs">
            <span className="text-muted-foreground">{t("team:report.dossier.explanation.adjustmentLabel")}</span>
            <span className="font-medium text-right">{adjustmentText(adjustment)}</span>
          </div>
        </>
      )}
    </div>
  );
}
