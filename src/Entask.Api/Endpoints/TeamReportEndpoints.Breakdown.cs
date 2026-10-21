using Entask.Api.Dtos;
using Entask.Core;

namespace Entask.Api.Endpoints;

/// <summary>
/// grade 分解（設計 §4.4）——團隊報表 JSON 的 `ratingBreakdown`。
///
/// **拆檔的理由是行數**（`TeamReportEndpoints.cs` 的硬上限 800），不是語意：
/// 門檻常數（`CompletionS/A/B`、`OnTimeS`、`FpyS`、`FpySampleThreshold`、
/// `AdjustmentUp/Down`、`AdjustmentSampleThreshold`）**留在主檔**——
/// `web/scripts/check-threshold-parity.mjs` 讀的是那條路徑，而且它要求兩組比較
/// （S 資格／gate 狀態、調整早退／未套用原因）**各兩個站點都在主檔裡**指著同一份宣告。
/// 這個檔因此只呼叫主檔的 `FpyGateStatus` 與 `AdjustmentSamplesInsufficient`，
/// 不自己寫比較式——門檻值仍然只有一份。
/// </summary>
public static partial class TeamReportEndpoints
{
    /// <summary>
    /// grade 分解（設計 §4.4）。**全部輸入都是成員迴圈裡已經算好的值**——這一層不查 DB、
    /// 不重算比率，所以它與同一個成員的 `rating`／`completionRate`／`fpy` 不可能各自漂移。
    ///
    /// 兩個 `role` 的語意（設計 §4.4）：
    /// * `tier`（completion）：決定 A／B／C；`tiers` 帶 S／A／B 三個門檻，
    ///   `achievedTier` 是**完成率自己**對到的級（見 `CompletionTier`），不是 `baseRating`。
    ///   有卡片時 status 一律 `met`——完成率一定對得到某一級（C 也是），「不適用」只發生
    ///   在零卡片；**不得改發 `failed`**（tier 角色沒有失敗語意，前端改渲染 `achievedTier`）。
    /// * `sGate`（onTime／FPY）：只影響 S。`failed` 相對的是「S 的資格」，不是目前的等級
    ///   ——畫面必須渲染成「未達 S 門檻（不影響 B／C）」，不得寫成「因為準時率所以是 B」。
    /// 調整項不在 `components`（見 `RatingAdjustmentDto`），它是主觀分數的獨立一層。
    ///
    /// `notApplied` 的原因順序照裁定：`sampleInsufficient` → `atCeiling` → `atFloor` →
    /// `withinRange`。`atCeiling`／`atFloor` 只在**規則真的觸發卻被階梯端點擋住**時成立
    /// ——平均分落在區間內時，即使 base 已經是 S／C，原因仍是 `withinRange`。
    /// </summary>
    private static RatingBreakdownDto BuildRatingBreakdown(
        double? completionRate, int totalCards, double? onTimeRate, int onTimeSamples,
        int reviewed, double? fpy, double? averageScore, int scoreSamples,
        string? baseRating, string? finalRating)
    {
        var completion = new RatingComponentDto(
            "completion", "tier", completionRate, totalCards,
            completionRate is null ? "notApplicable" : "met",
            CompletionTier(completionRate),
            completionRate is null ? "noCards" : null,
            [
                new RatingTierDto(RatingCodes.S, CompletionS),
                new RatingTierDto(RatingCodes.A, CompletionA),
                new RatingTierDto(RatingCodes.B, CompletionB),
            ],
            null);

        var onTime = new RatingComponentDto(
            "onTime", "sGate", onTimeRate, onTimeSamples,
            onTimeRate is null ? "notApplicable" : onTimeRate >= OnTimeS ? "met" : "failed",
            null,
            onTimeRate is null ? "noDueSamples" : null,
            [new RatingTierDto(RatingCodes.S, OnTimeS)],
            null);

        // 樣本數用 reviewed（分母），不是 firstPass（分子）——「樣本不足」問的是分母。
        var firstPassYield = new RatingComponentDto(
            "firstPassYield", "sGate", fpy, reviewed,
            fpy is null ? "notApplicable" : FpyGateStatus(fpy.Value),
            null,
            fpy is null ? "sampleInsufficient" : null,
            [new RatingTierDto(RatingCodes.S, FpyS)],
            FpySampleThreshold);

        var baseIndex = baseRating is null ? -1 : Array.IndexOf(RatingLadder, baseRating);
        var finalIndex = finalRating is null ? -1 : Array.IndexOf(RatingLadder, finalRating);
        var (status, reason) = finalIndex > baseIndex ? ("appliedUp", (string?)null)
            : finalIndex < baseIndex ? ("appliedDown", (string?)null)
            : ("notApplied", NotAppliedReason(averageScore, scoreSamples, baseIndex));

        var adjustment = new RatingAdjustmentDto(
            status, reason, baseRating, finalRating, averageScore, scoreSamples,
            AdjustmentUp, AdjustmentDown, AdjustmentSampleThreshold);

        return new RatingBreakdownDto(baseRating, finalRating,
            [completion, onTime, firstPassYield], adjustment);
    }

    /// <summary>
    /// `adjustment.status == "notApplied"` 時的原因（順序即裁定：樣本不足優先於端點）。
    /// 樣本門檻的比較式在主檔（`AdjustmentSamplesInsufficient`）——`check:thresholds`
    /// 要求它與 `ApplyScoreAdjustment` 的早退各是一個站點、指著同一個常數。
    /// </summary>
    private static string NotAppliedReason(double? averageScore, int scoreSamples, int baseIndex)
    {
        if (AdjustmentSamplesInsufficient(averageScore, scoreSamples)) return "sampleInsufficient";
        if (averageScore >= AdjustmentUp && baseIndex == RatingLadder.Length - 1) return "atCeiling";
        if (averageScore <= AdjustmentDown && baseIndex == 0) return "atFloor";
        return "withinRange";
    }
}
