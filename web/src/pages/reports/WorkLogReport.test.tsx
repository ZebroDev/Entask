import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { Mock } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkLogReport } from "./WorkLogReport";
import type { WorkLogReportResponse } from "@/lib/board-types";
import { setLocale } from "@/i18n";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const fixture: WorkLogReportResponse = {
  scope: "Project",
  fromDate: "2026-09-07",
  toDate: "2026-09-14",
  workdays: ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"],
  summary: { totalHours: 9, memberCount: 2, entryCount: 3, cardCount: 2, workdayCount: 5 },
  members: [
    {
      userId: "u1", username: "erin", displayName: "艾琳", avatarUrl: null,
      totalHours: 5, entryCount: 2, cardCount: 2,
      activeDays: 2, reportedWorkdays: 1, missingWorkdays: 1,
      // 後端契約：missingWorkdays == missingDays.length（同一集合的兩個出口）。日期與分母
      // 刻意與「workdays 減已回報」的推導分道（判別力在那個差上——見下方對話框測試）：
      // 09-09 就在下面的 days 裡 ⇒ 真實後端不會產生這一格，刻意留著釘住「逐字渲染」。
      expectedWorkdays: 2, missingDays: ["2026-09-09"], completedCards: 0,
      projects: [{ projectId: "p1", projectName: "日誌專案", hours: 5, entryCount: 2 }],
      days: [
        {
          date: "2026-09-09", totalHours: 3, entryCount: 1,
          entries: [{
            logId: "l1", loggedAtLocal: "2026-09-09T10:00:00", hours: 3, note: null,
            cardId: "c1", cardTitle: "評估A系統需求", cardCompletedAt: null, cardEstimatedHours: null,
            teamName: "日誌團隊", projectId: "p1", projectName: "日誌專案",
            boardId: "b1", boardName: "日誌板", listId: "li1", listName: "待辦",
          }],
        },
        {
          date: "2026-09-12", totalHours: 2, entryCount: 1,
          entries: [{
            logId: "l2", loggedAtLocal: "2026-09-12T11:00:00", hours: 2, note: "訪談前置",
            cardId: "c2", cardTitle: "客戶需求訪談", cardCompletedAt: "2026-09-12T05:00:00Z", cardEstimatedHours: 4,
            teamName: "日誌團隊", projectId: "p1", projectName: "日誌專案",
            boardId: "b1", boardName: "日誌板", listId: "li1", listName: "待辦",
          }],
        },
      ],
    },
  ],
};

// 全數回報的合成日（無明細列）：供「漏 0 天」與「全員無漏報」fixture 使用
const allReportedDays = fixture.workdays.map((date) => ({ date, totalHours: 1, entryCount: 1, entries: [] }));

/** 3 人：小安漏 2 天、艾琳漏 1 天、法蘭克 0 天——驗證篩選、排序與「另有 K 人無漏報」 */
const mixedFixture: WorkLogReportResponse = {
  ...fixture,
  members: [
    fixture.members[0]!,
    {
      ...fixture.members[0]!,
      userId: "u2", username: "ann", displayName: "小安",
      reportedWorkdays: 3, missingWorkdays: 2,
      // 後端可產生的形狀：漏報日 ⊆ workdays 且不含已回報日（days＝07,08,09）
      expectedWorkdays: 3, missingDays: ["2026-09-10", "2026-09-11"],
      days: allReportedDays.slice(0, 3),
    },
    {
      ...fixture.members[0]!,
      userId: "u3", username: "frank", displayName: "法蘭克",
      reportedWorkdays: 5, missingWorkdays: 0, expectedWorkdays: 5, missingDays: [],
      days: allReportedDays,
    },
  ],
};

/** 全員 0 漏報 */
const noMissingFixture: WorkLogReportResponse = {
  ...fixture,
  members: [
    { ...fixture.members[0]!, reportedWorkdays: 5, missingWorkdays: 0, expectedWorkdays: 5, missingDays: [], days: allReportedDays },
  ],
};

/** 夾擠語意的乾淨成員（後端可產生的形狀；非共用 fixture 的艾琳——她帶 R15 探針，不拿來斷言卡片）：
 *  到職本地日＝09-10 ⇒ 該員的工作日只剩 {09-10, 09-11}（expectedWorkdays 2），後端的
 *  missingDays 就是這兩天。09-09 是**到職前**的紀錄（reportedWorkdays 不夾：報了就算，R10），
 *  週視圖畫成 day row；07、08 到職前又沒回報 ⇒ 既不是 day row 也不是 missing row。 */
const clampedMemberFixture: WorkLogReportResponse = {
  ...fixture,
  members: [{
    ...fixture.members[0]!,
    expectedWorkdays: 2,
    missingWorkdays: 2,
    missingDays: ["2026-09-10", "2026-09-11"],
  }],
};

function renderReport(scope: "me" | "project" | "team" = "project", scopeId = "p1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <WorkLogReport scope={scope} scopeId={scopeId} />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

beforeEach(() => vi.clearAllMocks());

describe("WorkLogReport", () => {
  it("以 /projects/{id}/worklog 取得資料（不得有 /api 前綴）並顯示 KPI", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    // 釘住時鐘，查詢字串才能逐字斷言——不釘的話它跟著「今天」跑，跨午夜還會偶發紅。
    // `vi.setSystemTime` 不開 fake timers（只假 Date、setTimeout 仍是真貨），
    // RTL 的 findBy／waitFor 照走真時鐘；`finally` 還原，後面的測試不受這顆假時鐘影響。
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0));   // 週四中午（本地）
    try {
      renderReport();
      expect(await screen.findByText("評估A系統需求")).toBeInTheDocument();
      const url = vi.mocked(api.get).mock.calls[0][0] as string;
      expect(url).not.toContain("/api/api");
      // 契約（T5）：查詢參數只有兩個**本地日**（yyyy-MM-dd，to 排他），不再有時區參數。
      // **逐字**釘住而不是釘形狀：日模式的 to ＝ 隔天，所以 from／to 對調、值寫成同一天、
      // 參數改名、或舊的 tzOffsetMinutes 殘留都會紅——形狀 regex 對「對調」與「同一天」是盲的。
      expect(url).toBe("/projects/p1/worklog?from=2026-09-10&to=2026-09-11");
      expect(screen.getByTestId("worklog-kpi-hours")).toHaveTextContent("9.0");
      expect(screen.getByTestId("worklog-kpi-missing")).toHaveTextContent("1");

      // 週模式：請求的窗逐字等於 fixture 宣告的 fromDate／toDate（09-07 起、to 排他 ⇒ 09-14，
      // 畫面上最後一天是 09-13）——fixture 的「窗」與送出的「窗」是同一個。
      fireEvent.click(screen.getByRole("button", { name: "週" }));
      await waitFor(() => {
        expect(vi.mocked(api.get).mock.calls.at(-1)![0]).toBe("/projects/p1/worklog?from=2026-09-07&to=2026-09-14");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("me 範圍打 /me/worklog 且不顯示成員區標題", async () => {
    const { api } = await import("@/lib/api");
    // 這支自帶 payload：刻意讓兩個來源**不等**——me 讀 members[0].reportedWorkdays（1），
    // 群體合計 Σ missingWorkdays 是 4 ⇒ 讀錯來源會印成「4 / 5」，這條斷言才守得住來源。
    // （共用的 fixture 兩者恰好同值 1，分不出來源。）payload 覆寫的三欄——expectedWorkdays／
    // missingWorkdays／missingDays——逐項照後端推導，不是只挑三個數值湊；其餘欄位沿用共用
    // fixture、未逐一推導（例如 completedCards）。Me 範圍沒有成員列 ⇒ memberWorkdays 不夾＝
    // 整個窗 5 天（expectedWorkdays 5）；該員只回報 09-09 這個工作日 ⇒ missingDays ＝窗內其餘
    // 4 天（升冪）＝missingWorkdays 4（她另有一筆週末 09-12，但 09-12 不在 `workdays` 內 ⇒ 不影響推導）。
    vi.mocked(api.get).mockResolvedValue({
      data: {
        ...fixture,
        scope: "Me",
        members: [{
          ...fixture.members[0]!,
          expectedWorkdays: 5,
          missingWorkdays: 4,
          missingDays: ["2026-09-07", "2026-09-08", "2026-09-10", "2026-09-11"],
        }],
      },
    });
    renderReport("me");
    expect(await screen.findByText("評估A系統需求")).toBeInTheDocument();
    expect((vi.mocked(api.get).mock.calls[0][0] as string).startsWith("/me/worklog?")).toBe(true);
    expect(screen.queryByTestId("worklog-members-heading")).not.toBeInTheDocument();
    // me 範圍的 KPI 讀 members[0].reportedWorkdays（1）；讀成群體範圍的 Σ missingWorkdays
    // （本 payload＝4）會印「4 / 5」——少了這個分支，工程師看到的標題數字會變成專案範圍的語意
    expect(screen.getByTestId("worklog-kpi-missing")).toHaveTextContent("1 / 5");
  });

  it("team 範圍顯示成員區標題與人數", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: { ...fixture, scope: "Team" } });
    renderReport("team", "t1");
    expect(await screen.findByTestId("worklog-members-heading")).toHaveTextContent("團隊成員（2 人）");
    expect((vi.mocked(api.get).mock.calls[0][0] as string).startsWith("/teams/t1/worklog?")).toBe(true);
  });

  it("切換模式會改變查詢期間", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    const before = vi.mocked(api.get).mock.calls[0][0] as string;
    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await vi.waitFor(() => {
      expect(vi.mocked(api.get).mock.calls.at(-1)![0]).not.toBe(before);
    });
  });

  it("已完成卡片顯示徽章", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });

  it("空資料顯示空狀態", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: { ...fixture, members: [], summary: { totalHours: 0, memberCount: 0, entryCount: 0, cardCount: 0, workdayCount: 5 } },
    });
    renderReport();
    expect(await screen.findByText(/尚無工時回報/)).toBeInTheDocument();
  });

  it("匯出以 api 實例呼叫 blob（不使用 window.open）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    const openSpy = vi.spyOn(window, "open");
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: /匯出/ }));
    await vi.waitFor(() => {
      expect(vi.mocked(api.get).mock.calls.at(-1)![0]).toContain("/projects/p1/worklog/export?");
    });
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("週模式列出未回報的工作日且不可展開", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: clampedMemberFixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "週" }));
    const notReported = await screen.findAllByText("未回報");
    // 語意變了（R17）：週視圖不再自行以 workdays × days 推導，改吃該成員夾擠後的清單——
    // 該員（到職 09-10）看得到的工作日只有 09-09（到職前已回報）、09-10、09-11，
    // 後兩天是後端 missingDays ⇒ 2 列未回報。舊推導會把 07、08 也畫成未回報（4 列）。
    expect(notReported).toHaveLength(2);
    // 到職前的工作日既不是 day row、也不是 missing row——完全不出現
    expect(screen.queryByText("09/07（一）")).not.toBeInTheDocument();
    expect(screen.queryByText("09/08（二）")).not.toBeInTheDocument();
    // 已回報的週間日仍是 day row：filter 的 `dayMap.has(date)` 那一半的判別力——拿掉它，
    // 09-09 會整個消失，而其餘斷言（未回報 2 列、07/08 為 null、09/12 仍在）照樣綠
    const reportedDay = await screen.findByRole("button", { name: /09\/09（三）/ });
    expect(reportedDay).toHaveAttribute("data-testid", "worklog-day-row");
    expect(reportedDay).not.toHaveTextContent("未回報");
    // 週末（09-12）不在 workdays 內，但仍須以加班身分顯示於清單
    expect(await screen.findByText(/09\/12（六）/)).toBeInTheDocument();
  });

  it("月模式顯示專案分佈與每日迷你長條，預設不展開明細", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "月" }));
    expect(await screen.findByTestId("worklog-project-slice")).toHaveTextContent("日誌專案");
    expect(screen.getByTestId("worklog-project-slice")).toHaveTextContent("100%");
    expect(screen.getByTestId("worklog-spark")).toBeInTheDocument();
    expect(screen.queryByText("評估A系統需求")).not.toBeInTheDocument();
  });

  it("週模式：有明細的日子預設收合為單列摘要，明細列尚未 render", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "週" }));
    const row = await screen.findByRole("button", { name: /09\/09（三）/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("3.0 小時");
    // 摘要行＝該日卡片與時數串接（規格：評估A系統需求 2.0 · 客戶需求訪談 3.0）
    expect(row).toHaveTextContent("評估A系統需求 3.0");
    expect(screen.queryByTestId("worklog-day-detail")).not.toBeInTheDocument();
    // EntryRow 的路徑行只在展開後出現
    expect(screen.queryByText(/日誌板/)).not.toBeInTheDocument();
  });

  it("週模式：展開某日才顯示該日明細列", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "週" }));
    fireEvent.click(await screen.findByRole("button", { name: /09\/09（三）/ }));
    const detail = await screen.findByTestId("worklog-day-detail");
    expect(within(detail).getByText(/日誌板/)).toBeInTheDocument();
    expect(within(detail).getByText("評估A系統需求")).toBeInTheDocument();
    // 一次只展開被點擊的那一天
    expect(screen.getAllByTestId("worklog-day-detail")).toHaveLength(1);
  });

  it("週模式：未回報列不可展開（無按鈕、無 chevron）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: clampedMemberFixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "週" }));
    const missingRows = await screen.findAllByTestId("worklog-missing-row");
    // 語意變了（R17）：列集合改吃該成員夾擠後的清單（見上方週模式測試）——2 列而非 4 列
    expect(missingRows).toHaveLength(2);
    for (const row of missingRows) {
      expect(row).toHaveTextContent("未回報");
      expect(within(row).queryByRole("button")).not.toBeInTheDocument();
      expect(row.querySelector("[aria-expanded], svg")).toBeNull();
    }
  });

  it("週模式：沒有卡片層級的展開鈕", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "週" }));
    await screen.findByRole("button", { name: /09\/09（三）/ });
    expect(screen.queryByRole("button", { name: /顯示每日明細/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /收合明細/ })).not.toBeInTheDocument();
  });

  it("週模式：週末加班日與工作日同樣可逐日展開", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "週" }));
    const row = await screen.findByRole("button", { name: /09\/12（六）/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("客戶需求訪談 2.0");
    fireEvent.click(row);
    const detail = await screen.findByTestId("worklog-day-detail");
    expect(within(detail).getByText("客戶需求訪談")).toBeInTheDocument();
    expect(within(detail).getByText("已完成")).toBeInTheDocument();
  });

  it("月模式展開後才顯示明細", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await screen.findByTestId("worklog-spark");
    fireEvent.click(screen.getByRole("button", { name: /顯示每日明細/ }));
    expect(await screen.findByText("客戶需求訪談")).toBeInTheDocument();
  });

  it("project 範圍第四張 KPI 標題標明合計，副標寫出人數與每人工作日", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    // 數值仍是 Σ missingWorkdays（1），變的只有標籤：原本並排「多人加總的分子」與
    // 「單一人的分母」才有 88 > 22 的矛盾讀感
    expect(screen.getByTestId("worklog-kpi-missing")).toHaveTextContent("1");
    expect(screen.getByText("未回報工作日（合計）")).toBeInTheDocument();
    expect(screen.getByText(/天（2 人合計；每人 5 個工作日） · 查看明細/)).toBeInTheDocument();
    // 真 button 守護：改成可點 div 時 getByTestId 照樣命中，故另以 role 釘住無障礙契約
    expect(screen.getByRole("button", { name: /未回報工作日（合計）/ }))
      .toHaveAttribute("aria-haspopup", "dialog");
  });

  it("me 範圍第四張 KPI 維持已回報工作日語意、不出現合計", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: { ...fixture, scope: "Me" } });
    renderReport("me");
    await screen.findByText("評估A系統需求");
    expect(screen.getByTestId("worklog-kpi-missing")).toHaveTextContent("1 / 5");
    expect(screen.getByText("已回報工作日")).toBeInTheDocument();
    expect(screen.queryByText(/合計/)).not.toBeInTheDocument();
    expect(screen.getByText("天 · 查看明細")).toBeInTheDocument();
  });

  it("點擊第四張 KPI 開啟漏報明細：成員與排序沿用 missingWorkdays，日期與分母逐字吃後端", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mixedFixture });
    renderReport();
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByTestId("worklog-kpi-missing-button"));

    const dialog = await screen.findByTestId("worklog-missing-dialog");
    expect(within(dialog).getByText("漏報明細")).toBeInTheDocument();
    expect(within(dialog).getByText("共 5 個工作日")).toBeInTheDocument();

    // 漏報多者在前（小安 2 > 艾琳 1）；漏 0 天者不成列，僅計入底部
    const rows = within(dialog).getAllByTestId("worklog-missing-member");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("小安")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("艾琳")).toBeInTheDocument();
    expect(within(dialog).queryByText("法蘭克")).not.toBeInTheDocument();
    expect(within(dialog).getByText("另有 1 人無漏報")).toBeInTheDocument();

    // 語意已搬遷（推導在後端、單一出處）：日期與分母逐字來 fixture 的
    // missingDays／expectedWorkdays，不由 workdays 推導，分母也不是範圍級的
    // workdays.length。兩列各自與舊推導分道（判別點見各列註解）。
    //
    // rows[0] 小安：後端給 {09-10, 09-11}（09-09 有回報，不可能是漏報日）。舊推導
    // 「workdays 減已回報」生出的日期集合與後端相同 ⇒ 這一列靠分母分道（3 vs 5）。
    expect(within(rows[0]!).getByTestId("worklog-missing-count")).toHaveTextContent("未回報 2 / 3 天");
    expect(within(rows[0]!).getAllByTestId("worklog-missing-day")).toHaveLength(2);
    expect(within(rows[0]!).getByText("09/10（四）")).toBeInTheDocument();
    expect(within(rows[0]!).queryByText("09/09（三）")).not.toBeInTheDocument();

    // rows[1] 艾琳：後端給 {09-09}——刻意的探針（見上方 fixture 註解）。舊推導會生
    // {09-07,08,10,11}、分母取範圍級 5 ⇒ 分子、分母、日期集合三處都分道。
    expect(within(rows[1]!).getByTestId("worklog-missing-count")).toHaveTextContent("未回報 1 / 2 天");
    expect(within(rows[1]!).getAllByTestId("worklog-missing-day")).toHaveLength(1);
    expect(within(rows[1]!).getByText("09/09（三）")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("09/07（一）")).not.toBeInTheDocument();
  });

  it("全員無漏報時對話框顯示此期間無漏報", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: noMissingFixture });
    renderReport();
    await screen.findByTestId("worklog-kpi-missing-button");
    expect(screen.getByTestId("worklog-kpi-missing")).toHaveTextContent("0");
    fireEvent.click(screen.getByTestId("worklog-kpi-missing-button"));
    const dialog = await screen.findByTestId("worklog-missing-dialog");
    expect(within(dialog).getByText("此期間無漏報")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("worklog-missing-member")).not.toBeInTheDocument();
    // 「另有」預設上方存在一份清單：清單為空時該列不得同時出現，否則同一段文字又要自相矛盾
    expect(within(dialog).queryByTestId("worklog-missing-none")).not.toBeInTheDocument();
  });

  it("me 範圍對話框標題為我的漏報明細，且不顯示另有 K 人無漏報", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: { ...fixture, scope: "Me" } });
    renderReport("me");
    await screen.findByText("評估A系統需求");
    fireEvent.click(screen.getByTestId("worklog-kpi-missing-button"));
    const dialog = await screen.findByTestId("worklog-missing-dialog");
    expect(within(dialog).getByText("我的漏報明細")).toBeInTheDocument();
    expect(within(dialog).getByTestId("worklog-missing-member")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("worklog-missing-none")).not.toBeInTheDocument();
  });

  it("me 範圍全數回報時顯示此期間你沒有漏報", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: { ...noMissingFixture, scope: "Me" } });
    renderReport("me");
    await screen.findByTestId("worklog-kpi-missing-button");
    fireEvent.click(screen.getByTestId("worklog-kpi-missing-button"));
    const dialog = await screen.findByTestId("worklog-missing-dialog");
    expect(within(dialog).getByText("此期間你沒有漏報")).toBeInTheDocument();
  });

  // B2-6b：成員摘要列是**一個 key 組出來的複合句**（原本 6 個運算式交錯的文字節點），
  // 兩張 KPI 的單位又是**數字在隔壁元素**的 caption。這三處的佔位順序寫反或接錯，
  // 畫面會靜默變成另一句話（`{{cards}} 張卡 · {{entries}} 筆`），而其他斷言都碰不到
  // ——下面的期望字串是**改寫前**那一行渲染出來的樣子，逐字元。
  it("成員摘要列與 KPI 單位 caption 維持原本渲染的字串", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: clampedMemberFixture });
    renderReport();
    // 「已回報」的分母語意變了（R17）：改吃該員的 expectedWorkdays（2——已夾到職日），
    // 不再是範圍級的 workdays.length（5）。分子不變（reportedWorkdays 不夾）。
    expect(await screen.findByText("5.0 小時 · 2 筆 · 2 張卡 · 已回報 1/2 工作日")).toBeInTheDocument();
    // 單位與數字分屬兩個元素：單位是複數族但值裡沒有 {{count}}，靠呼叫端傳的 count 選尾綴
    expect(screen.getByText("筆")).toBeInTheDocument();
    expect(screen.getByText("張")).toBeInTheDocument();
  });

  // 三個 scope 各一次：它們共用同一個呼叫點，但網址的 base 不同
  it.each([
    ["me", undefined, "/me/worklog"],
    ["project", "p1", "/projects/p1/worklog"],
    ["team", "t1", "/teams/t1/worklog"],
  ] as const)("%s 的匯出網址帶上目前語系", async (scope: "me" | "project" | "team", scopeId: string | undefined, base: string) => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue({ data: fixture });
    renderReport(scope, scopeId);
    await screen.findByText("艾琳");

    (api.get as Mock).mockResolvedValue({ data: new Blob(["x"]) });
    fireEvent.click(screen.getByRole("button", { name: /匯出/ }));

    await waitFor(() => {
      const url = (api.get as Mock).mock.calls.at(-1)![0] as string;
      expect(url).toContain(`${base}/export?`);
      expect(url).toContain("&locale=zh-TW");
      // 匯出以外的請求不帶 locale——它對 JSON 端點沒有意義
      expect((api.get as Mock).mock.calls[0][0]).not.toContain("locale=");
    });
  });

  // 上面那三條驗的是**測試語系**（`src/test/setup.ts` 的 beforeEach 清掉語系鍵，
  // 解析結果是 locale-pin 釘住的 zh-TW），所以把 `currentLocale()` 換成寫死的 `"zh-TW"`
  // 六道閘門不會有一道變紅——而那正是本階段要消滅的形狀（寫死的顯示文字）的鄰居。
  // 這一條以 en 執行才是那個不變量。
  it("匯出網址跟著目前語系走（en）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: fixture });
    // 不需要 afterEach 還原：src/test/setup.ts 的 beforeEach 會清掉語系鍵
    // （它刻意放在 beforeEach——afterEach 會在 RTL 卸載元件前跑而產生 act 警告）。
    await act(async () => { await setLocale("en"); });
    renderReport();
    await screen.findByText("艾琳");

    (api.get as Mock).mockResolvedValue({ data: new Blob(["x"]) });
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));

    await waitFor(() => {
      const url = (api.get as Mock).mock.calls.at(-1)![0] as string;
      expect(url).toContain("/projects/p1/worklog/export?");
      expect(url).toContain("&locale=en");
    });
  });
});

// B2-7：第四張 KPI 的括號裡有**兩個**會隨數量變形的數字，而一個 key 只有一個複數維度
// （`count`）。處置是各自寫成一條複數族（`kpi.missing.members`／`kpi.missing.each`），
// 由呼叫端先算成字串、再當參數傳進外層訊息。
//
// 這裡的資料刻意讓兩個數量都是 1——那正是改寫前唯一壞掉的一格
// （`1 people in total`／`1 workdays each`），而它在 zh-TW 下**永遠看不到**
// （中文無複數，任何數量都印同一句）。所以這條不變量必須以 en 執行：
// 上面那些 zh-TW 斷言只證明「改走複數族之後 zh-TW 沒變」。
describe("未回報 KPI 的英文複數（B2-7）", () => {
  it("成員數與每人天數都是 1 時，兩個量都要用單數形", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: {
        ...fixture,
        workdays: ["2026-09-09"],
        summary: { ...fixture.summary, memberCount: 1, workdayCount: 1 },
        // 這個窗只剩 1 個工作日：該員的應填日數與漏報清單都必須跟著窗走（後端夾擠後
        // 的形狀才可能長這樣）
        members: [{ ...fixture.members[0]!, reportedWorkdays: 0, missingWorkdays: 1, expectedWorkdays: 1, days: [] }],
      },
    });
    // 不需要 afterEach 還原：src/test/setup.ts 的 beforeEach 會清掉語系鍵
    // （它刻意放在 beforeEach——afterEach 會在 RTL 卸載元件前跑而產生 act 警告）。
    await act(async () => { await setLocale("en"); });
    renderReport();
    expect(
      await screen.findByText("day (1 person in total; 1 workday each) · View details"),
    ).toBeInTheDocument();
  });
});

// B2-7：成員摘要列是**一句話裡有三個**會隨數量變形的名詞（`1 entries`／`1 cards`／
// `1/1 workdays`），而一個 key 只有一個複數維度（`count`）。處置與上面那條相同：
// 三個數量各自寫成一條複數族，呼叫端先算成字串、再當參數傳進外層訊息。
//
// 三個數量**同時**取 1 是唯一壞掉的一格，而且只在 en 顯形；`count` 對應的分別是
// 明細筆數、卡片張數、以及**總工作日**（分母——`1/1 workday` vs `1/5 workdays`）。
describe("成員摘要列的英文複數（B2-7）", () => {
  it("三個數量都是 1 時，三個名詞都要用單數形", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: {
        ...fixture,
        workdays: ["2026-09-09"],
        members: [{
          ...fixture.members[0]!,
          entryCount: 1,
          cardCount: 1,
          reportedWorkdays: 1,
          missingWorkdays: 0,
          // 0 漏報 ⇒ 清單必須是空的（契約：兩個出口相等）；窗只剩 1 個工作日亦然
          expectedWorkdays: 1,
          missingDays: [],
        }],
      },
    });
    // 不需要 afterEach 還原：src/test/setup.ts 的 beforeEach 會清掉語系鍵。
    await act(async () => { await setLocale("en"); });
    renderReport();
    expect(
      await screen.findByText("5.0 hr · 1 entry · 1 card · 1/1 workday reported"),
    ).toBeInTheDocument();
  });
});
