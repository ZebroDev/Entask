// Task 5：團隊報表 KPI drill-down 對話框。
//
// 這一檔驗的是**對話框自己**：請求的 URL／參數、以 metric 分流的表格欄位、權限截斷的
// 說明（hiddenCount 的粒度）、列點擊開卡片、分頁、窗框／metric 變更時頁碼歸 1，
// 以及列印版不含這個對話框。與報表頁的接線在 `TeamReportTab.test.tsx`。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportDrilldownDialog } from "./ReportDrilldownDialog";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatDay } from "@/lib/format";
import { axiosNetworkError } from "@/test/http-errors";
import type { Mock } from "vitest";
import type { DrilldownMetric } from "./report-types";
import { makeWrapper } from "./team-report-test-utils";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

/**
 * `CardDialog` 的替身：只把「開的是哪張卡、哪個專案」印在 DOM 上，外加一顆關閉鈕。
 *
 * 關閉鈕是「關閉即卸載，而 drill-down 本身留著」的判別點：一個把兩個對話框綁在同一個
 * open 狀態的實作，會在按下關閉時把整個 drill-down 一起收掉。
 */
vi.mock("@/pages/board/CardDialog", () => ({
  CardDialog: (props: {
    cardId?: string;
    projectId?: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-testid="card-dialog-mock" data-card-id={props.cardId} data-project-id={props.projectId}>
      <button type="button" onClick={() => props.onOpenChange?.(false)}>
        close-card
      </button>
    </div>
  ),
}));

const member = {
  userId: "u1",
  username: "alice",
  displayName: "Alice",
  completedCards: 5,
  totalCards: 10,
  completionRate: 0.5,
};

/** 換成員的重置測試用：同一個 team、不同的 userId。 */
const otherMember = { ...member, userId: "u2", username: "bob", displayName: "Bob" };

/** 一列 drill-down。欄位名是後端 `ReportDrilldownItemDto` 的 camelCase 鏡子。 */
const rowFixture = (overrides: Record<string, unknown> = {}) => ({
  cardId: "c1",
  title: "卡片一",
  projectId: "p1",
  projectName: "專案一",
  completedAt: "2026-06-01T00:00:00Z",
  dueAt: "2026-06-05T00:00:00Z",
  qualifies: true,
  firstReviewEntryId: null,
  firstReviewStatus: null,
  firstReviewAt: null,
  firstReviewerName: null,
  reviewEntryId: null,
  score: null,
  reviewCreatedAt: null,
  reviewerName: null,
  dueChanges: null,
  ...overrides,
});

const responseFixture = (overrides: Record<string, unknown> = {}) => ({
  data: {
    metric: "completion",
    rowKind: "card",
    populationCount: 3,
    qualifyingCount: 2,
    visiblePopulationCount: 2,
    visibleQualifyingCount: 1,
    hiddenCount: 1,
    rows: [rowFixture()],
    page: 1,
    pageSize: 50,
    ...overrides,
  },
});

type DialogProps = ComponentProps<typeof ReportDrilldownDialog>;

const renderDialog = (overrides: Partial<DialogProps> = {}) =>
  render(
    <ReportDrilldownDialog
      open
      onOpenChange={vi.fn()}
      teamId="t1"
      member={member}
      metric="completion"
      {...overrides}
    />,
    { wrapper: makeWrapper() },
  );

/** 第 n 次 `api.get` 的 params（0 起算）。 */
const callParams = (n: number) => (api.get as Mock).mock.calls[n][1].params as Record<string, unknown>;

/**
 * Testing Library **只正規化 DOM 那一側**的空白，字串 matcher 是原樣比對
 * （`@testing-library/dom` 的 `matches.js`：`normalizedText === String(matcher)`）。
 * zh-TW 的 `formatDateTime` 在「日期」與「時段」之間是 U+2009 或 U+0020、視 ICU 而定
 * （`format.test.ts` 的同一家族；2026-10-21 公開 CI 的 v1.0.3 就是紅在這一個字元）。
 * 期望值先過與 DOM 相同的一條 `\s+` → " "，其餘字元仍逐一釘死。
 */
const asRenderedText = (s: string) => s.replace(/\s+/g, " ");

describe("ReportDrilldownDialog", () => {
  afterEach(() => {
    (api.get as Mock).mockReset();
  });

  it("requests the selected metric with the member, window and first page", async () => {
    (api.get as Mock).mockResolvedValue(responseFixture({ metric: "firstPassYield" }));

    renderDialog({
      metric: "firstPassYield",
      from: "2026-01-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });

    // URL 與 params 是**契約**：metric 字串逐字對應後端 `ReportMetric`（wire 名稱），
    // 分頁大小固定 50。
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/teams/t1/report/drilldown", {
        params: {
          userId: "u1",
          metric: "firstPassYield",
          from: "2026-01-01T00:00:00.000Z",
          to: "2027-01-01T00:00:00.000Z",
          page: 1,
          pageSize: 50,
        },
      }),
    );
  });

  it("does not request anything while closed", async () => {
    renderDialog({ open: false });

    // `enabled` 綁 open：關閉時連一支請求都不該飛出去（不是「發了但畫面不看」）。
    expect(api.get).not.toHaveBeenCalled();
  });

  // 標題的 metric 名稱必須與**開啟它的 dossier tile** 用同一個 key／同一份譯文：
  // completion 的 tile 是 `report.stat.completion`（任務達成率），不是表格欄的「達成率」；
  // 平均分的 tile 是 `dossier.explanation.averageScore`。四列逐一釘住，改了 key 就紅。
  it.each([
    ["completion", "任務達成率"],
    ["onTime", "準時交付率"],
    ["firstPassYield", "一次交付通過率"],
    ["averageScore", "平均評分"],
  ])("titles the %s drill-down with the same label as its dossier tile", async (metric, label) => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({ metric, rowKind: metric === "averageScore" ? "reviewEntry" : "card" }),
    );

    renderDialog({ metric: metric as DrilldownMetric });

    expect(await screen.findByText(`Alice · ${label}`)).toBeInTheDocument();
  });

  // hiddenCount 的**粒度跟著 metric 走**：平均分的資料粒度是 review entry，不是卡片。
  // 一個寫死「張卡片」的實作在第一列全綠、第二列紅——這就是這兩個 fixture 的分工。
  it.each([
    ["completion", "card", "3 張卡片位於你無權檢視的專案"],
    ["averageScore", "reviewEntry", "3 筆 review 位於你無權檢視的專案"],
  ])("renders the hidden count at the granularity of %s", async (metric, rowKind, expected) => {
    (api.get as Mock).mockResolvedValue(responseFixture({ metric, rowKind, hiddenCount: 3 }));

    renderDialog({ metric: metric as DrilldownMetric });

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it("shows the population and qualifying counts from the payload", async () => {
    (api.get as Mock).mockResolvedValue(responseFixture({ populationCount: 7, qualifyingCount: 4 }));

    renderDialog();

    expect(await screen.findByText("母體 7")).toBeInTheDocument();
    expect(screen.getByText("符合 4")).toBeInTheDocument();
  });

  it("renders the empty state when there are no rows", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({
        rows: [],
        populationCount: 0,
        qualifyingCount: 0,
        visiblePopulationCount: 0,
        visibleQualifyingCount: 0,
        hiddenCount: 0,
      }),
    );

    renderDialog();

    expect(await screen.findByText("沒有符合條件的資料")).toBeInTheDocument();
  });

  // 錯誤分支：網路層失敗沒有伺服器訊息可讀 ⇒ 走 `apiErrorMessage` 的 fallback，
  // 再由 `common:error.loadDetail` 包起來。fixture 是 axios 真的丟得出來的形狀
  // （裸 `Error` 的 message 與 fallback 可能同字，分不出實作好壞）。
  it("shows the load error through the shared error message", async () => {
    (api.get as Mock).mockRejectedValue(axiosNetworkError());

    renderDialog();

    expect(await screen.findByText("載入失敗：請稍後重試")).toBeInTheDocument();
  });

  // 每一欄的**值**都要被釘住：只驗「卡片列沒有 score」是反證，改壞 `dueDay` 的切片或
  // 把 ISO 原字串倒出來，畫面會壞但不會有紅燈。期望值由 `format.ts` 對同一組 fixture
  // 算出來（欄位的接線是這裡要守的東西；格式化本身的契約在 `format.ts` 的測試）。
  it("renders the card columns with the formatted values", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({
        rows: [
          rowFixture(),
          rowFixture({ cardId: "c2", title: "卡片二", qualifies: false }),
        ],
      }),
    );

    renderDialog();

    const row = (await screen.findByText("卡片一")).closest("tr")!;
    expect(within(row).getByText("專案一")).toBeInTheDocument();
    expect(within(row).getByText(asRenderedText(formatDateTime("2026-06-01T00:00:00Z")))).toBeInTheDocument();
    // dueAt 是「日」不是時間：`dueDay` 先切前 10 碼，再走本地日解析的 `formatDay`。
    expect(within(row).getByText(formatDay("2026-06-05"))).toBeInTheDocument();
    expect(within(row).getByText("✓")).toBeInTheDocument();

    const excluded = (screen.getByText("卡片二")).closest("tr")!;
    expect(within(excluded).getByText("—")).toBeInTheDocument();
  });

  // 卡片類列走 `viewCards`、平均分列走 `viewReviews`——**同一顆按鈕的文案是 metric 的**
  // 一部分（review 粒度的那一列開的是卡片，但使用者看的是 review）。兩個 key 在 Task 5
  // 之前沒有任何消費者，`i18next-parser --fail-on-update` 因此一直是紅的。
  it.each([
    ["completion", "card", "查看卡片"],
    ["averageScore", "reviewEntry", "查看 review"],
  ])("opens CardDialog from a %s row, labelled %s", async (metric, rowKind, actionLabel) => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({
        metric,
        rowKind,
        rows: [rowFixture({ reviewEntryId: "r1", score: 4.5, reviewCreatedAt: "2026-06-02T00:00:00Z", reviewerName: "Bob" })],
      }),
    );

    renderDialog({ metric: metric as DrilldownMetric });

    const row = (await screen.findByText("卡片一")).closest("tr")!;
    // 點**動作鈕**（不是列標題）：按鈕自己的 onClick 也必須走到 onOpenRow，
    // 拿掉它時這一支才會紅。
    fireEvent.click(within(row).getByRole("button", { name: actionLabel }));

    const card = await screen.findByTestId("card-dialog-mock");
    // projectId 是 **CardDialog 自己那一支查詢的 key**（`/projects/{projectId}/members`）：
    // 不傳的實作照樣開得起來，只是整張卡片的成員／權限都查不到——那個壞畫面沒有紅燈。
    expect(card).toHaveAttribute("data-card-id", "c1");
    expect(card).toHaveAttribute("data-project-id", "p1");

    // 關閉卡片對話框 ⇒ 它卸載，但 drill-down 不跟著關。
    fireEvent.click(within(card).getByRole("button", { name: "close-card" }));
    await waitFor(() => expect(screen.queryByTestId("card-dialog-mock")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // 整列也是入口（另一條 handler 路徑）：關掉卡片後再點列一次會重新開啟。
    fireEvent.click(screen.getByText("卡片一"));
    expect(await screen.findByTestId("card-dialog-mock")).toBeInTheDocument();
  });

  it("renders the first review status and reviewer for the FPY metric", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({
        metric: "firstPassYield",
        rows: [
          rowFixture({
            firstReviewEntryId: "e1",
            firstReviewStatus: "approved",
            firstReviewAt: "2026-06-02T00:00:00Z",
            firstReviewerName: "Bob",
          }),
        ],
      }),
    );

    renderDialog({ metric: "firstPassYield" });

    const row = (await screen.findByText("卡片一")).closest("tr")!;
    expect(within(row).getByText("通過")).toBeInTheDocument();
    expect(within(row).getByText(asRenderedText(formatDateTime("2026-06-02T00:00:00Z")))).toBeInTheDocument();
    expect(row).toHaveTextContent("Bob");
  });

  it("renders the score and reviewer for the average-score metric", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({
        metric: "averageScore",
        rowKind: "reviewEntry",
        rows: [
          rowFixture({
            reviewEntryId: "r1",
            score: 4.5,
            reviewCreatedAt: "2026-06-02T00:00:00Z",
            reviewerName: "Bob",
          }),
        ],
      }),
    );

    renderDialog({ metric: "averageScore" });

    const row = (await screen.findByText("卡片一")).closest("tr")!;
    expect(row).toHaveTextContent("4.5");
    expect(within(row).getByText(asRenderedText(formatDateTime("2026-06-02T00:00:00Z")))).toBeInTheDocument();
    expect(row).toHaveTextContent("Bob");
  });

  // 設計 §4.6：舊資料沒有 from／to 就說「舊版未記錄數值」；完成後才發生的變更加一個
  // 標記（不改 on-time 計算）。**兩者可以同時成立**——第三筆就是那個交集。
  it("marks legacy and after-completion due changes, including both at once", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({
        metric: "onTime",
        rows: [
          rowFixture({
            dueChanges: [
              { changedAt: "2026-05-01T00:00:00Z", from: null, to: null },
              { changedAt: "2026-07-01T00:00:00Z", from: "2026-06-10T00:00:00Z", to: "2026-07-10T00:00:00Z" },
              { changedAt: "2026-08-01T00:00:00Z", from: null, to: null },
            ],
          }),
        ],
      }),
    );

    renderDialog({ metric: "onTime" });

    const row = (await screen.findByText("卡片一")).closest("tr")!;
    // 05-01 與 08-01 兩筆是舊資料；07-01 與 08-01 兩筆在 completedAt（06-01）之後。
    expect(within(row).getAllByText("舊版未記錄數值")).toHaveLength(2);
    expect(within(row).getAllByText("完成後變更")).toHaveLength(2);
    // 有數值的變更畫成「基準 → 最終」的日期範圍（不是原始 ISO 字串）。
    expect(
      within(row).getByText(
        `${formatDate("2026-06-10T00:00:00Z")} → ${formatDate("2026-07-10T00:00:00Z")}`,
      ),
    ).toBeInTheDocument();
  });

  // 換頁時表格可以暫時換成 loading，但**頁碼列不得被卸載**：焦點所在的按鈕一消失，
  // 鍵盤／讀屏使用者就被丟回文件開頭。第二支請求刻意不回應，讓「取數中」這一格可斷言。
  it("keeps the pager mounted while the next page is loading", async () => {
    let releaseSecond!: (value: unknown) => void;
    const page = responseFixture({ populationCount: 60, visiblePopulationCount: 60, hiddenCount: 0 });
    (api.get as Mock)
      .mockResolvedValue(page)
      .mockResolvedValueOnce(page)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }));

    renderDialog();
    await screen.findByText("卡片一");

    fireEvent.click(screen.getByRole("button", { name: "下一頁" }));

    expect(screen.getByRole("button", { name: "上一頁" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一頁" })).toBeDisabled();

    await act(async () => { releaseSecond(page); });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(callParams(1)).toMatchObject({ page: 2, pageSize: 50 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "上一頁" })).not.toBeDisabled(),
    );
  });

  it("paginates with page size 50", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({ populationCount: 60, visiblePopulationCount: 60, hiddenCount: 0 }),
    );

    renderDialog();
    await screen.findByText("卡片一");

    fireEvent.click(screen.getByRole("button", { name: "下一頁" }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(callParams(1)).toMatchObject({ page: 2, pageSize: 50 });

    // 頁碼列保持掛載（只是 disabled）⇒ 等它恢復可用再點，不必等整張表回來。
    const previous = screen.getByRole("button", { name: "上一頁" });
    await waitFor(() => expect(previous).not.toBeDisabled());
    fireEvent.click(previous);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(callParams(2)).toMatchObject({ page: 1 });
  });

  // 切換成員／metric／窗框時頁碼必須歸 1：停在 page 2 的實作會請求和畫面**對不上的一頁**，
  // 而使用者只會看到「換了之後是空的」——沒有錯誤、沒有紅燈。`resetKey` 四個維度都要在。
  it("resets the page to 1 when the member, metric or window changes", async () => {
    (api.get as Mock).mockResolvedValue(
      responseFixture({ populationCount: 60, visiblePopulationCount: 60, hiddenCount: 0 }),
    );

    const { rerender } = renderDialog();
    await screen.findByText("卡片一");
    fireEvent.click(screen.getByRole("button", { name: "下一頁" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(callParams(1)).toMatchObject({ page: 2 });

    // 換**成員**：停在 page 2 的實作會拿新成員的第 2 頁（而他的第 1 頁從未出現）。
    rerender(
      <ReportDrilldownDialog
        open
        onOpenChange={vi.fn()}
        teamId="t1"
        member={otherMember}
        metric="completion"
      />,
    );
    await waitFor(() => {
      const last = callParams((api.get as Mock).mock.calls.length - 1);
      expect(last).toMatchObject({ userId: "u2", page: 1 });
    });

    // 回到 page 2 再換 metric／窗框：兩個維度都要重新歸 1（與成員同一條 resetKey）。
    await screen.findByText("卡片一");
    fireEvent.click(await screen.findByRole("button", { name: "下一頁" }));
    await waitFor(() => {
      const last = callParams((api.get as Mock).mock.calls.length - 1);
      expect(last).toMatchObject({ userId: "u2", page: 2 });
    });

    rerender(
      <ReportDrilldownDialog
        open
        onOpenChange={vi.fn()}
        teamId="t1"
        member={otherMember}
        metric="onTime"
        from="2026-01-01T00:00:00.000Z"
        to="2027-01-01T00:00:00.000Z"
      />,
    );

    await waitFor(() => {
      const last = callParams((api.get as Mock).mock.calls.length - 1);
      expect(last).toMatchObject({ metric: "onTime", page: 1, from: "2026-01-01T00:00:00.000Z" });
    });
  });

  // 設計 §4.6：due 變更紀錄是 2026-10-20 才上線的功能，**on-time 的 drill-down 必須說明
  // 「從那一天起才有紀錄」**——否則更早的卡片看起來像「從來沒改過截止日」。
  // completion 沒有這個欄位，那句話出現在那裡就是錯的。
  it.each([
    ["onTime", true],
    ["completion", false],
  ])("only the on-time drill-down says it records due changes since 2026-10-20 (%s)", async (metric, shown) => {
    (api.get as Mock).mockResolvedValue(responseFixture({ metric }));

    renderDialog({ metric: metric as DrilldownMetric });

    if (shown) {
      expect(await screen.findByText("本功能自 2026-10-20 起記錄")).toBeInTheDocument();
    } else {
      // 等其他內容落地再斷言「沒有」：還沒 render 完的樹上什麼都沒有，那種綠是假的。
      await screen.findByText("母體 3");
      expect(screen.queryByText("本功能自 2026-10-20 起記錄")).not.toBeInTheDocument();
    }
  });

  // 設計 §4.5／§4.6：drill-down 不進列印版，而且它不得被塞進 dossier 的 max-w-md。
  it("uses a wide, print-hidden dialog", async () => {
    (api.get as Mock).mockResolvedValue(responseFixture());

    renderDialog();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("max-w-4xl");
    expect(dialog.className).toContain("print:hidden");
    expect(dialog.className).not.toContain("max-w-md");
  });
});
