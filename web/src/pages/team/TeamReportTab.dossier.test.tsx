// dossier 的 grade 分解（`ratingBreakdown`）與考評表明細的測試。
//
// 2026-10-21（報表可解釋性 Task 5）自 `TeamReportTab.test.tsx` 拆出：那個檔在 Task 5
// 加了 drill-down 的兩支測試之後會撞上 800 行上限，而這一組測試自成一個主題——
// 它們全部在「開 dossier → 看解釋區塊」這個路徑上。共用的 fixture 與 wrapper 在
// `team-report-test-utils.tsx`。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamReportTab } from "./TeamReportTab";
import { api } from "@/lib/api";
import type { Mock } from "vitest";
import { makeWrapper, memberFixture } from "./team-report-test-utils";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

/**
 * 明細對話框裡某一張統計卡的值。
 *
 * **必須以對話框為範圍查標籤**：`準時交付率` 這個字串在表格表頭也有一份
 * （同一條 `team:report.metric.onTime`），不限定範圍會命中表頭那一份。
 */
const dialogStat = async (label: string) => {
  const dialog = await screen.findByRole("dialog");
  const labelEl = within(dialog).getByText(label);
  return labelEl.parentElement!.querySelector(".text-xl") as HTMLElement;
};

describe("TeamReportTab dossier", () => {
  afterEach(() => {
    (api.get as Mock).mockReset();
    vi.restoreAllMocks();
  });

  // ---------- Task 4：dossier 的 grade 分解（ratingBreakdown）----------
  //
  // 解釋區塊**只渲染伺服器算好的 `ratingBreakdown`**：門檻（0.85／0.80／4.5／2.0／3／5）
  // 一律由 payload 帶下來，前端不重算、也不寫第二份（`check:thresholds` 守著生產程式碼）。
  // fixture 裡的門檻值是**payload 的形狀**，不是前端常數。
  //
  // 判定「有沒有解釋區塊」一律以 `rating-explanation` 為範圍：同一個詞（例如「樣本不足」）
  // 在 dossier 的 stat 上也有，不限定範圍會命中錯的那一份。

  const completionTiers = [
    { rating: "S", threshold: 0.85 },
    { rating: "A", threshold: 0.7 },
    { rating: "B", threshold: 0.5 },
  ];

  /** 一個「有卡片、可以被解釋」的分解。個別測試覆寫自己關心的那幾個欄位。 */
  const explanationFixture = (overrides: Record<string, unknown> = {}) => ({
    baseRating: "B",
    finalRating: "B",
    components: [
      { key: "completion", role: "tier", value: 0.6, sampleSize: 5, status: "met", achievedTier: "B", reason: null, tiers: completionTiers, sampleThreshold: null },
      { key: "onTime", role: "sGate", value: 1, sampleSize: 1, status: "met", achievedTier: null, reason: null, tiers: [{ rating: "S", threshold: 0.85 }], sampleThreshold: null },
      { key: "firstPassYield", role: "sGate", value: 1, sampleSize: 5, status: "met", achievedTier: null, reason: null, tiers: [{ rating: "S", threshold: 0.8 }], sampleThreshold: 5 },
    ],
    adjustment: { status: "notApplied", reason: "withinRange", from: "B", to: "B", averageScore: 3, scoreSamples: 3, upThreshold: 4.5, downThreshold: 2, sampleThreshold: 3 },
    ...overrides,
  });

  const openDossier = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /檢視檔案/ }));
    return screen.findByRole("dialog");
  };

  it("dossier 顯示 grade 分解與調整方向，並依 components 的陣列順序渲染", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("C", {
        ratingBreakdown: explanationFixture({
          finalRating: "C",
          // **刻意打亂順序**：伺服器目前固定送 completion → onTime → firstPassYield，而
          // 用正序 fixture 驗不到「照陣列順序渲染」——一個以 key 個別查找、再按固定順序
          // 排的實作在正序下照樣全綠。陣列順序就是畫面順序（裁定）。
          components: [
            { key: "firstPassYield", role: "sGate", value: 1, sampleSize: 5, status: "met", achievedTier: null, reason: null, tiers: [{ rating: "S", threshold: 0.8 }], sampleThreshold: 5 },
            { key: "completion", role: "tier", value: 0.6, sampleSize: 5, status: "met", achievedTier: "B", reason: null, tiers: completionTiers, sampleThreshold: null },
            { key: "onTime", role: "sGate", value: 1, sampleSize: 1, status: "met", achievedTier: null, reason: null, tiers: [{ rating: "S", threshold: 0.85 }], sampleThreshold: null },
          ],
          adjustment: { status: "appliedDown", reason: null, from: "B", to: "C", averageScore: 2, scoreSamples: 3, upThreshold: 4.5, downThreshold: 2, sampleThreshold: 3 },
        }),
      }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();
    const explanation = await within(dialog).findByTestId("rating-explanation");

    expect(within(explanation).getByText("為什麼是這個等級")).toBeInTheDocument();
    // completion 那一句要把 payload 的值與 achievedTier **都**帶進句子：只斷言標籤順序
    // 的話，拿掉 `value` 或 `achievedTier` 的內插照樣全綠。
    expect(explanation).toHaveTextContent("完成率 60.0% → B");
    // 調整方向與它的原料（分數、樣本數）都在同一行；數字格式化走 format.ts 的同一個出口。
    expect(explanation).toHaveTextContent("B → C（平均分 2.0，3 筆）");

    const text = explanation.textContent ?? "";
    expect(text.indexOf("一次交付通過率")).toBeLessThan(text.indexOf("完成率"));
    expect(text.indexOf("完成率")).toBeLessThan(text.indexOf("準時交付率"));
  });

  // 後端契約下 `appliedUp`／`appliedDown` 一定帶得到 `averageScore`（沒有分數就不會套用），
  // 所以這一支是**壞資料的守門員**，不是可達狀態的規格：句子不能長成「平均分 ，3 筆」。
  // 修法不新增 i18n key——樣本數沿用既有的 `team:report.sampleCount`（複數族）。
  it("調整項套用但沒有平均分時，句子省略平均分而不是留下空的括號子句", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("C", {
        ratingBreakdown: explanationFixture({
          finalRating: "C",
          adjustment: { status: "appliedDown", reason: null, from: "B", to: "C", averageScore: null, scoreSamples: 3, upThreshold: 4.5, downThreshold: 2, sampleThreshold: 3 },
        }),
      }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();
    const explanation = await within(dialog).findByTestId("rating-explanation");

    expect(explanation).toHaveTextContent("B → C (3 筆)");
    expect(explanation).not.toHaveTextContent("平均分 ，");
  });

  it("不適用的條件顯示各自的原因（無截止日樣本／樣本不足）", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("B", {
        fpy: null,
        ratingBreakdown: explanationFixture({
          components: [
            { key: "completion", role: "tier", value: 0.6, sampleSize: 5, status: "met", achievedTier: "B", reason: null, tiers: completionTiers, sampleThreshold: null },
            { key: "onTime", role: "sGate", value: null, sampleSize: 0, status: "notApplicable", achievedTier: null, reason: "noDueSamples", tiers: [{ rating: "S", threshold: 0.85 }], sampleThreshold: null },
            { key: "firstPassYield", role: "sGate", value: null, sampleSize: 3, status: "notApplicable", achievedTier: null, reason: "sampleInsufficient", tiers: [{ rating: "S", threshold: 0.8 }], sampleThreshold: 5 },
          ],
          adjustment: { status: "notApplied", reason: "sampleInsufficient", from: "B", to: "B", averageScore: null, scoreSamples: 0, upThreshold: 4.5, downThreshold: 2, sampleThreshold: 3 },
        }),
      }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();
    const explanation = await within(dialog).findByTestId("rating-explanation");

    expect(within(explanation).getByText("無截止日樣本")).toBeInTheDocument();
    expect(within(explanation).getByText("樣本不足")).toBeInTheDocument();
    // 未套用時顯示原因：樣本數與門檻都取自 payload，不是前端的字面值。
    expect(explanation).toHaveTextContent("樣本不足（0 / 3 筆）");
  });

  it("零卡片的成員顯示「樣本不足，不評等」，且不渲染調整項的數字", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture(undefined, {
        completedCards: 0,
        totalCards: 0,
        completionRate: null,
        onTimeRate: null,
        fpy: null,
        averageScore: null,
        scoreSamples: 0,
        ratingBreakdown: {
          baseRating: null,
          finalRating: null,
          components: [
            { key: "completion", role: "tier", value: null, sampleSize: 0, status: "notApplicable", achievedTier: null, reason: "noCards", tiers: completionTiers, sampleThreshold: null },
            { key: "onTime", role: "sGate", value: null, sampleSize: 0, status: "notApplicable", achievedTier: null, reason: "noDueSamples", tiers: [{ rating: "S", threshold: 0.85 }], sampleThreshold: null },
            { key: "firstPassYield", role: "sGate", value: null, sampleSize: 0, status: "notApplicable", achievedTier: null, reason: "sampleInsufficient", tiers: [{ rating: "S", threshold: 0.8 }], sampleThreshold: 5 },
          ],
          adjustment: { status: "notApplied", reason: "sampleInsufficient", from: null, to: null, averageScore: null, scoreSamples: 0, upThreshold: 4.5, downThreshold: 2, sampleThreshold: 3 },
        },
      }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();
    const explanation = await within(dialog).findByTestId("rating-explanation");

    expect(within(explanation).getByText("樣本不足，不評等")).toBeInTheDocument();
    // 「不評等」時 adjustment 的數字一個都不該出現（沒有等級可以加減）。
    expect(within(explanation).queryByText("主管評分調整")).not.toBeInTheDocument();
    expect(explanation).not.toHaveTextContent("平均分");
  });

  it("舊回應沒有 ratingBreakdown 時不渲染解釋區塊，也不 crash", async () => {
    // fixture 不帶 ratingBreakdown——舊後端的回應就是這個形狀。
    (api.get as Mock).mockResolvedValue(memberFixture("A"));

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();

    expect(within(dialog).queryByTestId("rating-explanation")).not.toBeInTheDocument();
    // 對話框本身仍然正常（不是「整棵樹被 crash 掉」之後的空畫面）。
    expect(within(dialog).getByText("綜合評級")).toBeInTheDocument();
  });

  it.each([
    { final: "B", achievedTier: "B", completion: 0.6, showNote: true, label: "顯示" },
    // **C 這一列不能省**：只驗 B（顯示）與 A（隱藏）時，一個把條件寫成「只有 B」的實作
    // 兩列都對——而 C 與 B 在設計裡是同一組（「未達 S 門檻（不影響 B／C）」）。
    { final: "C", achievedTier: "C", completion: 0.4, showNote: true, label: "顯示" },
    { final: "A", achievedTier: "S", completion: 1, showNote: false, label: "不顯示" },
  ])(
    "sGate 未達 S 且 final 為 $final 時，sGate 註記$label",
    async ({ final, achievedTier, completion, showNote }) => {
      (api.get as Mock).mockResolvedValue(
        memberFixture(final, {
          ratingBreakdown: explanationFixture({
            baseRating: final,
            finalRating: final,
            components: [
              { key: "completion", role: "tier", value: completion, sampleSize: 5, status: "met", achievedTier, reason: null, tiers: completionTiers, sampleThreshold: null },
              { key: "onTime", role: "sGate", value: 0.5, sampleSize: 2, status: "failed", achievedTier: null, reason: null, tiers: [{ rating: "S", threshold: 0.85 }], sampleThreshold: null },
              { key: "firstPassYield", role: "sGate", value: 0.9, sampleSize: 5, status: "met", achievedTier: null, reason: null, tiers: [{ rating: "S", threshold: 0.8 }], sampleThreshold: 5 },
            ],
          }),
        }),
      );

      render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
      const dialog = await openDossier();
      const explanation = await within(dialog).findByTestId("rating-explanation");

      const note = within(explanation).queryByText(/未達 S 門檻/);
      if (showNote) {
        // 設計 §4.4 明令：failed 只說「未達 S 門檻」，不得寫成「因為準時率所以是 B」。
        expect(note).toHaveTextContent(`未達 S 門檻（不影響 ${final}）`);
      } else {
        expect(note).not.toBeInTheDocument();
      }
    },
  );

  // 設計 §1：解釋區塊要同時呈現「值、門檻、樣本數」。門檻與樣本數**全部來自 payload**
  // （`tiers[].threshold`／`sampleSize`／`sampleThreshold`）——前端一個門檻字面值都沒有。
  it("每個條件都渲染伺服器帶下來的門檻與樣本數", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("B", { ratingBreakdown: explanationFixture() }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();
    const explanation = await within(dialog).findByTestId("rating-explanation");

    // completion 的三個門檻（fixture 的 0.85／0.7／0.5）走 `formatPercent` 的一位小數。
    expect(explanation).toHaveTextContent("S ≥ 85.0%");
    expect(explanation).toHaveTextContent("A ≥ 70.0%");
    expect(explanation).toHaveTextContent("B ≥ 50.0%");
    // 樣本資訊：FPY 的樣本數（reviewed）與樣本門檻並列（fixture 的 5 與 5）。
    expect(explanation).toHaveTextContent("5 筆，門檻 5");
  });

  // 列印版的四個 KPI tile 是 `print:hidden`，`notApplied` 那一行因此是列印版唯一看得到
  // 平均分的地方——分數與樣本數必須併進那一行，四種原因句本身照舊。
  it("notApplied 且帶平均分時，那一行仍看得到分數與樣本數", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("B", {
        ratingBreakdown: explanationFixture({
          adjustment: { status: "notApplied", reason: "withinRange", from: "B", to: "B", averageScore: 3.2, scoreSamples: 4, upThreshold: 4.5, downThreshold: 2, sampleThreshold: 3 },
        }),
      }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    const dialog = await openDossier();
    const explanation = await within(dialog).findByTestId("rating-explanation");

    expect(explanation).toHaveTextContent(
      "維持 B：平均分介於 2.0 與 4.5 之間（平均分 3.2，4 筆）",
    );
  });

  it("明細對話框的達成率與準時率同樣顯示「樣本不足」", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("A", { completionRate: null, onTimeRate: null, completedCards: 0, totalCards: 0 }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByRole("button", { name: /檢視檔案/ }));

    expect((await dialogStat("任務達成率")).textContent).toBe("樣本不足");
    expect((await dialogStat("準時交付率")).textContent).toBe("樣本不足");
  });
});
