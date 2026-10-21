// 團隊報表測試的共用 fixture 與 render wrapper（2026-10-21，報表可解釋性 Task 5）。
//
// 自 `TeamReportTab.test.tsx` 抽出：dossier／解釋區塊那一組測試搬到
// `TeamReportTab.dossier.test.tsx` 之後，兩個檔都要同一組成員／報表 fixture——
// 各抄一份的話，fixture 的形狀會在兩邊漂移，而漂移的那一邊仍然全綠。
//
// **這裡刻意不 mock `@/lib/api`**：`vi.mock` 是逐測試檔的宣告，放在共用檔裡
// 不會生效（factory 只在被 mock 的那個模組載入時跑）。各測試檔自己宣告。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

/** 單一成員的報表回應。`rating` 缺席即模擬後端沒給評級（fixture 刻意允許不傳）。 */
export const memberFixture = (rating?: string, extra: Record<string, unknown> = {}) => ({
  data: {
    members: [
      {
        userId: "u1",
        username: "alice",
        displayName: "Alice",
        completedCards: 5,
        totalCards: 10,
        completionRate: 0.5,
        ...(rating === undefined ? {} : { rating }),
        ...extra,
      },
    ],
  },
});

/**
 * 完整的報表回應（含頂層的 `availableYears`）。
 *
 * `memberFixture` 的 `extra` 展開在**成員**物件上、帶不了頂層欄位，所以另外包一層而不是
 * 改它的形狀——那個形狀有二十幾支測試依賴。
 */
export const reportFixture = (years: number[] = []) => ({
  data: { ...memberFixture().data, availableYears: years },
});
