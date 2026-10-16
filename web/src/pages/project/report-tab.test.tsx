import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import { ReportTab } from "./tabs/ReportTab";
import type { ProjectReportResponse } from "@/lib/board-types";
import { axiosNetworkError } from "@/test/http-errors";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const reportFixture: ProjectReportResponse = {
  memberHours: [{ userId: "u1", username: "erin", displayName: "艾琳", hours: 3, cardCount: 1 }],
  memberRemaining: [{ userId: "u1", username: "erin", displayName: "艾琳", estimatedHours: 10, loggedHours: 3, remainingHours: 7 }],
  reviewStats: { pendingCount: 1, approvedCount: 2, rejectedCount: 0, averageScore: 4.5 },
  cards: [{
    id: "c1", title: "卡一", boardId: "b1", boardName: "看板一", listId: "l1", listName: "待辦",
    assigneeUserIds: ["u1"], estimatedHours: 10, loggedHours: 3, remainingHours: 7,
    reviewStatus: "pending", priority: "高",
  }],
};

const THIS_YEAR = new Date().getFullYear();
/** 去年。刻意取「今年 − 1」而不是寫死年份：`yearOptions` 的 UTC 曆年候選在 UTC 以東是
 *  `[y, y+1]`（本機就是 UTC+8），所以去年**一定**在選項裡，`fireEvent.change` 才選得中。 */
const LAST_YEAR = THIS_YEAR - 1;

const requestedUrls = () => vi.mocked(api.get).mock.calls.map((c) => c[0] as string);
/** 報表**查詢**的 URL（濾掉匯出——那條路徑也含 `/report`），依呼叫順序。 */
const reportUrls = () => requestedUrls().filter((u) => u.includes("/report") && !u.includes("/export"));
const exportUrls = () => requestedUrls().filter((u) => u.includes("/export"));

/**
 * URL 的窗框**解回本地日**（`{ from, to }`；沒有窗框回 `null`）。
 *
 * **刻意不拿 `windowParams()` 造期望值**：那會與實作共用同一個算式，`to` 少加一天時兩邊
 * 一起錯、測試照綠（`TeamReportTab.test.tsx` 的 `windowOf` 就是那個形狀——它驗得到
 * 「窗框有沒有帶」，驗不到「界線對不對」）。解回**本地日**之後，「到 3/31」送出的 `to`
 * 必須是 **4/1** 才是真的被斷言到。
 */
const localDayOf = (encodedIso: string) => {
  const d = new Date(decodeURIComponent(encodedIso));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const localWindowOf = (url: string): { from: string; to: string } | null => {
  const m = url.match(/[?&]from=([^&]+)&to=([^&]+)/);
  return m ? { from: localDayOf(m[1]), to: localDayOf(m[2]) } : null;
};

/**
 * 攔下 `a.click()`，回傳「被點的 anchor」——檔名只有在這裡看得到（`a.download` 會覆蓋
 * 伺服器的 `Content-Disposition`）。`vi.spyOn` 動的是 prototype，用完務必 `restore()`。
 */
const captureAnchorClicks = () => {
  const clicked: HTMLAnchorElement[] = [];
  const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  return { clicked, restore: () => spy.mockRestore() };
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ReportTab projectId="p1" />
    </QueryClientProvider>,
  );
  return qc;
}

// `api.get` 是模組層級的 `vi.fn()`，呼叫歷史會跨測試累積；上面那些「讀第幾次呼叫」的斷言
// 靠這一行才不會拿到前一支測試留下的那一筆（那會讓斷言因為**錯誤的理由**變綠）。
beforeEach(() => vi.clearAllMocks());

describe("ReportTab", () => {
  it("以表格呈現工時/剩餘/審查統計/卡片明細", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: reportFixture });
    renderTab();
    expect(await screen.findByText("成員工時")).toBeInTheDocument();
    expect(screen.getAllByText("艾琳").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("待審查 1")).toBeInTheDocument();
    expect(screen.getByText("通過 2")).toBeInTheDocument();
    expect(screen.getByText("平均分 4.5")).toBeInTheDocument();
    expect(screen.getByText("卡一")).toBeInTheDocument();
    expect(screen.getByText("看板一")).toBeInTheDocument();
    expect(screen.getByText("高")).toBeInTheDocument();
    expect(screen.getByText("待審查", { selector: "td" })).toBeInTheDocument();
    expect(screen.getAllByTestId("progress-fill").length).toBeGreaterThan(0);
    // 這一支的 fixture **沒有 `availableYears`**（欄位是選填的：舊後端不帶它）——
    // 窗框仍然要送出去，因為它是從 **state** 算的、不是從選項清單算的；而選定年由
    // 前端併入（`yearOptions` 的三來源之一），所以下拉也不會空白。
    expect(localWindowOf(reportUrls()[0])).toEqual({
      from: `${THIS_YEAR}-01-01`,
      to: `${THIS_YEAR + 1}-01-01`,
    });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(String(THIS_YEAR));
  });

  // 卡片列的進度條吃**全期**已報（＝預估 − 剩餘），不是同列「已報」欄那個**窗框內**的數字。
  // fixture 刻意把兩者拉開：窗框內 2、全期 10 ⇒ 20% 與 100%——傳 `c.loggedHours` 的實作
  // 會畫出 20%，這一支當場紅。**成員那一列也有一條進度條**（30%），所以斷言要用
  // `within(row)` 定到卡片那一列，否則 `getByTestId` 會撞到成員那一條。
  it("卡片列的進度條吃全期已報，不是同列的窗框內已報", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        ...reportFixture,
        cards: [{
          id: "c1", title: "卡一", boardId: "b1", boardName: "看板一", listId: "l1", listName: "待辦",
          assigneeUserIds: ["u1"], estimatedHours: 10, loggedHours: 2, remainingHours: 0,
          reviewStatus: "pending", priority: "高",
        }],
      },
    });
    renderTab();

    const row = (await screen.findByText("卡一")).closest("tr") as HTMLElement;
    expect(within(row).getByTestId("progress-fill").style.width).toBe("100%");
    // 對照組：同列的「已報」欄仍是窗框內的 2（裁定 1——流量欄維持吃窗框）。
    expect(within(row).getByText("2")).toBeInTheDocument();
  });

  // 這支是上面那支的判別力補丁：fixture 的 `4.5` 剛好就是一位小數，
  // 「有沒有過 formatDecimal」在畫面上完全一樣——斷言 `平均分 4.5` 對這個缺陷是瞎的。
  // 真實資料算出來的是 `4.666666666666667`（2026-09-19 重拍手冊截圖時拍到），所以餵它。
  it("平均分取固定一位小數，兩個落點都印不出後端的原始 double", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        ...reportFixture,
        reviewStats: { ...reportFixture.reviewStats, averageScore: 4.666666666666667 },
      },
    });
    renderTab();
    // 落點一：KPI 卡的說明列；落點二：審查統計列。兩個都改過，就兩個都要釘。
    expect(await screen.findByText("待審查：1 | 均分：4.7")).toBeInTheDocument();
    expect(screen.getByText("平均分 4.7")).toBeInTheDocument();
  });

  it("載入失敗顯示錯誤", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("Network Error"));
    renderTab();
    expect(await screen.findByText(/載入失敗/)).toBeInTheDocument();
  });

  // 2026-09-22（窗框批次）：預設窗框由**全期**改成**今年**（裁定 2），所以同一份空資料
  // 現在落在「有窗框」那一格。**兩格都要釘**——只釘一格的話，另一格的措辭無人看管。
  it("空報表顯示空態：預設帶窗框說所選期間，切全期說尚無紀錄", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        memberHours: [], memberRemaining: [],
        reviewStats: { pendingCount: 0, approvedCount: 0, rejectedCount: 0, averageScore: null },
        cards: [],
      },
    });
    renderTab();
    expect(await screen.findByText("所選期間沒有工時資料")).toBeInTheDocument();
    expect(screen.queryByText("尚無工時紀錄")).not.toBeInTheDocument();
    // 沒有審查紀錄時後端回 null；`—` 的判斷與格式化同在一行，兩者要一起驗。
    expect(screen.getByText("平均分 —")).toBeInTheDocument();

    // 全期是退回今日視圖的出口，也是這一格的另一半。
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });
    expect(await screen.findByText("尚無工時紀錄")).toBeInTheDocument();
    expect(screen.queryByText("所選期間沒有工時資料")).not.toBeInTheDocument();
  });

  // ---------- 窗框接線（2026-09-22）----------
  //
  // 後端在 `1155372` 就把專案報表收斂到 `ReportWindow` 了，但**前端從未接線**：
  // `/projects/{id}/report` 不帶 query string ⇒ 窗框恆為全期。以下每一支都從 **URL** 入手
  // ——畫面文字驗不到窗框有沒有真的送到後端。

  it("預設窗框是今年，選擇器也標著今年", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ...reportFixture, availableYears: [LAST_YEAR] } });
    renderTab();
    await screen.findByText("成員工時");

    expect(localWindowOf(reportUrls()[0])).toEqual({
      from: `${THIS_YEAR}-01-01`,
      to: `${THIS_YEAR + 1}-01-01`,
    });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(String(THIS_YEAR));
  });

  it("切換年份會重新取數，並帶著那一年的窗框", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ...reportFixture, availableYears: [LAST_YEAR] } });
    renderTab();
    await screen.findByText("成員工時");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: String(LAST_YEAR) } });
    // **判別依據是「重新取數」這個行為，不是 query key 的字面拼法**：少了窗框那一格，
    // react-query 會直接回上一個年份的快取——`api.get` 只被呼叫一次、畫面只會「數字不變」，
    // 而一支只斷言 key 拼法的測試在快取根本沒失效時照樣是綠的。
    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    expect(localWindowOf(reportUrls()[1])).toEqual({
      from: `${LAST_YEAR}-01-01`,
      to: `${LAST_YEAR + 1}-01-01`,
    });
  });

  it("全期不帶任何窗框參數", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ...reportFixture, availableYears: [LAST_YEAR] } });
    renderTab();
    await screen.findByText("成員工時");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });
    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    expect(reportUrls()[1]).toBe("/projects/p1/report");
    expect(localWindowOf(reportUrls()[1])).toBeNull();
  });

  // 計畫的「手測 ④」自動化：選項的 `value` 若用了譯文，切一次語系選中值就對不到任何選項
  // ——原生 `<select>` **靜默變空白**，沒有錯誤、沒有紅燈（`GanttTab` 的「未指派」同一類）。
  // 這一格無法手測（沒有瀏覽器），而它正是 H3 存在的理由，所以用測試釘住。
  it("切換語系後選中值不跟著跑（option value 是哨兵，不是譯文）", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ...reportFixture, availableYears: [LAST_YEAR] } });
    renderTab();
    await screen.findByText("成員工時");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("all"));

    // `changeLanguage` 是非同步的，之後才落地的重繪會落在 act 之外（`UserSettingsDialog.test.tsx`
    // 的同一個形狀）。還原由 `src/test/setup.ts` 的 beforeEach 負責（推回 locale-pin 釘住的 zh-TW）。
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    // 標籤跟著換、選中值不動——兩者都斷言，否則「完全沒重繪」也會讓這一格綠。
    expect(await screen.findByText("All time")).toBeInTheDocument();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("all");
    expect(screen.queryByText("全期")).not.toBeInTheDocument();
  });

  it("自訂期間的結束日含當日：選到 3/31 時送出的 to 是 4/1", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ...reportFixture, availableYears: [] } });
    renderTab();
    await screen.findByText("成員工時");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    // 選「自訂」會**播種**成完整的那一年（兩個欄位都是空的區間送不出任何請求）。
    const toInput = await screen.findByLabelText("結束日期");
    fireEvent.change(toInput, { target: { value: `${THIS_YEAR}-03-31` } });

    // wire 窗是 `[from, to)`（上界排他），UI 的結束日含當日 ⇒ 漏了 `+1` 會讓 3/31 整天消失，
    // 而起始日行為正常——不對稱的少一天讀起來像資料有問題。
    await waitFor(() =>
      expect(localWindowOf(reportUrls().at(-1)!)).toEqual({
        from: `${THIS_YEAR}-01-01`,
        to: `${THIS_YEAR}-04-01`,
      }),
    );
  });

  it("起始日越過結束日時被夾住，永不送出顛倒的窗框", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ...reportFixture, availableYears: [] } });
    renderTab();
    await screen.findByText("成員工時");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    const fromInput = await screen.findByLabelText("起始日期");
    fireEvent.change(screen.getByLabelText("結束日期"), { target: { value: `${THIS_YEAR}-03-31` } });
    fireEvent.change(fromInput, { target: { value: `${THIS_YEAR}-06-15` } });

    // 夾住而不是「讓後端 400」：夾住是唯一對兩頁都成立的規則，而且使用者看到的是
    // **另一個欄位跟著動**，不是兩個欄位無聲地不一致。
    await waitFor(() =>
      expect(localWindowOf(reportUrls().at(-1)!)).toEqual({
        from: `${THIS_YEAR}-06-15`,
        to: `${THIS_YEAR}-06-16`,
      }),
    );
    expect((screen.getByLabelText("結束日期") as HTMLInputElement).value).toBe(`${THIS_YEAR}-06-15`);
  });

  it("取數失敗時選擇器仍在，換期間就能救回", async () => {
    // 用 `axiosNetworkError()`（沒有 `response`）而不是裸 `new Error`：後者的 `message`
    // 與 fallback 可能剛好相同，分不出「走 apiErrorMessage」與「直接讀 error.message」。
    vi.mocked(api.get)
      .mockRejectedValueOnce(axiosNetworkError())
      .mockResolvedValue({ data: { ...reportFixture, availableYears: [LAST_YEAR] } });
    renderTab();

    // 「伺服器沒說話」時顯示的**只有**呼叫端的 fallback，不是傳輸層字串。
    expect(await screen.findByText("載入失敗：請稍後重試")).toBeInTheDocument();
    expect(screen.queryByText(/Network Error/)).not.toBeInTheDocument();

    // 失敗當下 `availableYears` 是空的 ⇒ 選定年由前端併入（`yearOptions` 的三來源之一）；
    // 少了那一步，這顆唯一能救回畫面的下拉會在**失敗當下**變成空白。
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe(String(THIS_YEAR));

    // 換期間＝換 query key＝重新取數。（用「全期」是因為它永遠是一個選項——
    // 失敗當下 `availableYears` 還沒有值，年份選項不一定在。）
    fireEvent.change(select, { target: { value: "all" } });
    expect(await screen.findByText("成員工時")).toBeInTheDocument();
    expect(screen.queryByText("載入失敗：請稍後重試")).not.toBeInTheDocument();
  });

  it("匯出帶與畫面同一組窗框，檔名帶選定的期間", async () => {
    // 依 URL 分流，而不是「載入完成後把 mockResolvedValue 換成 blob」——這一支中途會再取
    // 一次報表（切到自訂區間），換掉之後那一次的 `data` 就變成 blob 了。
    (api.get as Mock).mockImplementation(async (url: string) =>
      url.includes("/export")
        ? { data: new Blob(["x"]) }
        : { data: { ...reportFixture, availableYears: [] } },
    );
    renderTab();
    await screen.findByText("成員工時");
    const { clicked, restore } = captureAnchorClicks();

    fireEvent.click(screen.getByRole("button", { name: /匯出 CSV/ }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    // 匯出與畫面**同一組窗框**：兩者分道揚鑣時，使用者下載到的檔案與他正在看的數字不同，
    // 而兩邊都不會報錯（後端對兩條路徑各有自己的窗框語意）。
    expect(localWindowOf(exportUrls()[0])).toEqual(localWindowOf(reportUrls()[0]));
    // 檔名由**前端**決定（`a.download` 覆蓋伺服器的 `Content-Disposition`）。
    expect(clicked[0].download).toBe(`project-report-p1-${THIS_YEAR}.csv`);

    // 切到自訂區間（3/1–3/31）：URL 與檔名都跟著換。
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    const fromInput = await screen.findByLabelText("起始日期");
    fireEvent.change(fromInput, { target: { value: `${THIS_YEAR}-03-01` } });
    fireEvent.change(screen.getByLabelText("結束日期"), { target: { value: `${THIS_YEAR}-03-31` } });

    fireEvent.click(screen.getByRole("button", { name: /匯出 CSV/ }));
    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(clicked[1].download).toBe(`project-report-p1-${THIS_YEAR}0301-${THIS_YEAR}0331.csv`);
    expect(localWindowOf(exportUrls().at(-1)!)).toEqual({
      from: `${THIS_YEAR}-03-01`,
      to: `${THIS_YEAR}-04-01`,
    });

    restore();
  });
});
