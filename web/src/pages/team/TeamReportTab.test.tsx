import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamReportTab } from "./TeamReportTab";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Mock } from "vitest";
import { setLocale } from "@/i18n";
import { formatDayRange } from "@/lib/format";
import { axiosNetworkError } from "@/test/http-errors";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

/** 單一成員的報表回應。`rating` 缺席即模擬後端沒給評級（fixture 刻意允許不傳）。 */
const memberFixture = (rating?: string, extra: Record<string, unknown> = {}) => ({
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
 * 改它的形狀——那個形狀有 23 支測試依賴。
 */
const reportFixture = (years: number[] = []) => ({
  data: { ...memberFixture().data, availableYears: years },
});

/**
 * 一個一定不等於今年的年份。fixture 用它才驗得出「今年由前端併入下拉」——
 * 後端刻意不讀時鐘，`availableYears` 不含今年（設計 D3／§6.2）。
 */
const LAST_YEAR = new Date().getFullYear() - 1;

/**
 * 某一年的窗框查詢片段（本地年頭轉 UTC、上界排他）。這是**規格**、元件那一份是實作；
 * 它擋得住「窗框沒帶／年份錯／xls 那顆接錯分隔符」，擋不住兩邊用同一個式子一起寫錯。
 */
const windowOf = (y: number) =>
  `from=${encodeURIComponent(new Date(y, 0, 1).toISOString())}` +
  `&to=${encodeURIComponent(new Date(y + 1, 0, 1).toISOString())}`;

/**
 * 清掉 `api.get` 的呼叫紀錄。這個 mock 是**整檔共用**的同一個 `vi.fn()`，呼叫歷史會跨測試
 * 累積：本檔其餘測試讀的是「有沒有被這樣呼叫過」（`toHaveBeenCalledWith`），不受影響；
 * 但下面那一組要讀「**第幾次**呼叫」，不清就會拿到前一支測試留下的那一筆——那會讓斷言
 * 因為**錯誤的理由**變綠（`` `reportUrls()[0]` `` 是前一支測試的 URL，不是這一支的）。
 */
const clearApiCalls = () => (api.get as Mock).mockClear();

/** 報表**查詢**的 URL（濾掉匯出——那兩條路徑也含 `/report`），依呼叫順序。 */
const reportUrls = () =>
  (api.get as Mock).mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.includes("/report") && !u.includes("/export"));

/**
 * 攔下 `a.click()`，回傳「被點的 anchor」。
 *
 * **R6 當場實測**：這個 jsdom（29.1.1）**有**實作 `URL.createObjectURL`（回
 * `blob:nodedata:…`，`revokeObjectURL` 也在），兩顆匯出鈕因此真的會走到 `a.click()`
 * ——檔名只有在這裡看得到（`a.download` 會覆蓋伺服器的 `Content-Disposition`）。
 * 所以**不必**在 `setup.ts` 補 stub：補了會靜默改到同一個環境裡的每一支測試。
 *
 * 用完務必 `restore()`：`vi.spyOn` 動的是 prototype，不還原會讓同檔其餘測試的
 * `a.click()` 一起變成 no-op。
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

/** 評級欄（第 3 格）的文字。用 td 的索引而不是 role，避免對表格語意多做假設。 */
const ratingCell = async () => {
  const row = (await screen.findByText("Alice")).closest("tr")!;
  return row.children[2] as HTMLElement;
};

/** 一次交付通過率欄（第 7 格）。索引不必等於欄序的權威，但順序一變這裡就該跟著改。 */
const firstPassCell = async () => {
  const row = (await screen.findByText("Alice")).closest("tr")!;
  return row.children[6] as HTMLElement;
};

/** 平均評分欄（第 8 格）。 */
const averageScoreCell = async () => {
  const row = (await screen.findByText("Alice")).closest("tr")!;
  return row.children[7] as HTMLElement;
};

/** 達成率欄（第 5 格）。 */
const completionCell = async () => {
  const row = (await screen.findByText("Alice")).closest("tr")!;
  return row.children[4] as HTMLElement;
};

/** 準時交付率欄（第 6 格）——**使用者回報的那一格**。 */
const onTimeCell = async () => {
  const row = (await screen.findByText("Alice")).closest("tr")!;
  return row.children[5] as HTMLElement;
};

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

describe("TeamReportTab", () => {
  // 每一個測試都**自己宣告回應**：`api.get` 是整檔共用的同一個 `vi.fn()`，而
  // `mockClear()`（下面的 `clearApiCalls`）只清呼叫紀錄、**不清實作**——「匯出帶與畫面同一組
  // 窗框」那一支用的是 `mockImplementation`（依 URL 分流），它留下的實作會跟著下一個測試，
  // 而症狀是下一個測試拿到別人的回應。`mockReset()` 把實作一起清掉，於是「忘了自己宣告」
  // 會當場變成 `undefined` 的回應，不是靜默沿用。
  // `restoreAllMocks()` 補的是另一半：`captureAnchorClicks` 動的是
  // `HTMLAnchorElement.prototype.click`（prototype 上的 spy），它那一支自己收尾的那一行
  // **只有 happy path 走得到**——斷言中途失敗時不會執行，之後每一支的 `a.click()` 都變成
  // no-op。收在這裡就涵蓋兩種路徑。
  afterEach(() => {
    (api.get as Mock).mockReset();
    vi.restoreAllMocks();
  });

  it("renders report table with members", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture());

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("50.0%")).toBeInTheDocument();
    });
  });

  it("已知評級顯示對應的譯文", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture("A"));

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect(await ratingCell()).toHaveTextContent("A 優良");
  });

  // 後端 `RatingCodes` 新增等級而前端沒跟上時，**改版前**的症狀是顯示「C 待加強」——
  // 一個看起來完全正常的標籤。這支釘住的是「看不懂就說看不懂」。
  it("不認得的評級原樣顯示，不猜成 C", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture("D"));

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    const cell = await ratingCell();
    expect(cell).toHaveTextContent("D");
    expect(cell).not.toHaveTextContent("待加強");
  });

  it("後端沒給評級時該格留白，不擅自補一個 C", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture());

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect((await ratingCell()).textContent).toBe("");
  });

  // ---------- Task 10／11 的兩個新指標 ----------
  //
  // 兩欄刻意插在 onTime（索引 5）與 action 欄之間 ⇒ 索引 6 與 7。插在評級欄之前會讓
  // `ratingCell()` 的 `children[2]` 指向別的欄，上面那幾支評級斷言會以「像翻譯壞了」
  // 的樣子變紅。

  it("有樣本時顯示一次交付通過率與平均評分", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("A", { fpy: 0.6, averageScore: 4.5, scoreSamples: 12 }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect(await firstPassCell()).toHaveTextContent("60.0%");
    expect(await averageScoreCell()).toHaveTextContent("4.5 (12 筆)");
  });

  // fpy 為 null 是「樣本不足」，0 是「一次都沒通過」——後端刻意回 null 而不是 0
  // （`FirstPassYieldOrNull`），前端若把它當 0 就會顯示 0.0%。
  it("fpy 為 null 時顯示「樣本不足」而不是 0.0%", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("A", { fpy: null, averageScore: null, scoreSamples: 0 }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    const cell = await firstPassCell();
    expect(cell).toHaveTextContent("樣本不足");
    expect(cell).not.toHaveTextContent("0.0%");
  });

  // 樣本門檻（設計 §13.4）：< 3 筆不做調整、也不顯示平均分。4 是門檻的正上方——
  // 少了它，一個把門檻寫成 5 的實作照樣全綠。
  it.each([
    [2, "樣本不足"],
    [3, "2.0 (3 筆)"],
    [4, "2.0 (4 筆)"],
  ])("評分樣本 %i 筆時顯示「%s」", async (samples, expected) => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("A", { averageScore: 2, scoreSamples: samples as number }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect(await averageScoreCell()).toHaveTextContent(expected as string);
  });

  // **這一支是兩個 JavaScript 陷阱的守門員**（兩者都只壞畫面、四道閘門全都不會紅）：
  //
  //   1. 欄位缺席時是 `undefined`，而 `undefined === null` 是 **false** ⇒ 會拿
  //      undefined 進百分比格式化（寬鬆等於才涵蓋它）。
  //   2. `undefined < 3` 是 **false** ⇒ 會跳過「樣本不足」去渲染一個不存在的平均分
  //      （`?? 0` 才讓缺席落回樣本不足那一邊）。
  //
  // fixture 不帶任何新欄位——這正是**既有那幾支測試**與**舊版後端的回應**的形狀。
  //
  // 斷言用**整格文字全等**而不是「包含樣本不足」：測試語系 zh-TW 的 `Intl` 把 NaN 的百分比
  // 印成「非數值%」（不是字面上的 `NaN`），所以「不含 NaN」在 zh-TW 恆真、擋不住任何東西。
  // 全等同時涵蓋那個字串與留白兩種壞畫面。
  it("後端沒給新欄位時兩欄都是「樣本不足」，不是壞掉的數字", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture("A"));

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect((await firstPassCell()).textContent).toBe("樣本不足");
    expect((await averageScoreCell()).textContent).toBe("樣本不足");
  });

  // ---------- 兩個比率欄的「樣本不足」（2026-09-21，使用者回報）----------
  //
  // 後端在 2026-09-21 之前對這兩個比率寫的是
  // `completed > 0 ? (double)onTime / completed : 1.0`——**零交付的後備值是 1.0**。
  // 於是「一張完成的卡片都沒有」的人在準時率那一格看到 **100.0%**，而同一列的
  // 一次交付通過率與平均評分（後端回 null）顯示「樣本不足」：同一個詞在相鄰三欄
  // 有兩種語意，這正是使用者回報的矛盾。
  //
  // 這一組與上面那支互補：上面那支釘的是**後端新增的欄位缺席**（undefined），
  // 這一組釘的是**後端明確回 null**。兩種都必須落進同一格文字。

  it("準時率缺席時顯示「樣本不足」而不是 100.0%", async () => {
    // fixture 本來就沒有 onTimeRate——舊回應與既有 fixture 的形狀都是這樣。
    (api.get as Mock).mockResolvedValue(memberFixture("A"));

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    // 整格全等而不是「不含 100.0%」：壞掉的實作印的就是 `100.0%` 這四個字，
    // 而修好的實作印的是另一串字——全等一次涵蓋兩邊。
    expect((await onTimeCell()).textContent).toBe("樣本不足");
  });

  it("準時率為 null 時顯示「樣本不足」", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture("A", { onTimeRate: null }));

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect((await onTimeCell()).textContent).toBe("樣本不足");
  });

  // 達成率的 0 與 null 是兩件事：「一張都沒完成」（分母存在）與「沒有任何卡片依據」。
  // 前者是 0.0%、後者是樣本不足——**只把 null 當樣本不足，不要把 0 也吞掉**。
  it("達成率為 null 時顯示「樣本不足」", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("A", { completionRate: null, completedCards: 0, totalCards: 0 }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    const cell = await completionCell();
    expect(cell.textContent).toBe("樣本不足");
  });

  // 分母存在就不是樣本不足——這一支是上一支的反向對照，少了它「把 0 也當成
  // 樣本不足」的過度修正不會有紅燈（`completionRate: 0` 是合法的比率）。
  it("達成率為 0 時仍顯示 0.0%，不是樣本不足", async () => {
    (api.get as Mock).mockResolvedValue(
      memberFixture("A", { completionRate: 0, completedCards: 0, totalCards: 4 }),
    );

    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    const cell = await completionCell();
    expect(cell).toHaveTextContent("0.0%");
    expect(cell).not.toHaveTextContent("樣本不足");
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

  // 匯出鈕有兩顆（Excel 與 CSV），用 `/匯出 Excel/` 才只命中要驗的那一顆
  it("匯出網址帶上目前語系", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture("A"));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    (api.get as Mock).mockResolvedValue({ data: new Blob(["x"]) });
    fireEvent.click(screen.getByRole("button", { name: /匯出 Excel/ }));

    await waitFor(() => {
      // 年份窗框（Task 7）與語系是**並存**的兩個 query 參數（`&`），不是互相取代
      // ——xls 這顆自己帶著 `?locale=`，窗框接在它後面。
      expect(api.get).toHaveBeenCalledWith(
        `/teams/t1/report/export-excel?locale=zh-TW&${windowOf(new Date().getFullYear())}`,
        expect.objectContaining({ responseType: "blob" }),
      );
    });
  });

  // 上面那條驗的是**測試語系**（`src/test/setup.ts` 的 beforeEach 清掉語系鍵，
  // 解析結果是 locale-pin 釘住的 zh-TW），所以把 `currentLocale()` 換成寫死的 `"zh-TW"`
  // 六道閘門不會有一道變紅。這一條以 en 執行才是那個不變量。
  it("匯出網址跟著目前語系走（en）", async () => {
    (api.get as Mock).mockResolvedValue(memberFixture("A"));
    // 不需要 afterEach 還原：src/test/setup.ts 的 beforeEach 會清掉語系鍵
    // （它刻意放在 beforeEach——afterEach 會在 RTL 卸載元件前跑而產生 act 警告）。
    await act(async () => { await setLocale("en"); });
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    (api.get as Mock).mockResolvedValue({ data: new Blob(["x"]) });
    fireEvent.click(screen.getByRole("button", { name: /Export Excel/ }));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        `/teams/t1/report/export-excel?locale=en&${windowOf(new Date().getFullYear())}`,
        expect.objectContaining({ responseType: "blob" }),
      );
    });
  });

  // ---------- 年份窗框（Task 7）----------
  //
  // 這一組各自釘住一個**沒有紅燈**的失敗模式：
  //   ① 不帶窗框 ⇒ 畫面寫「年度」而後端算全期（本階段修掉的缺陷本身）
  //   ② 全期仍帶窗框 ⇒ 後端把全期當成某一年
  //   ③ 年份沒進 query key ⇒ 切年份拿到上一個年份的快取，畫面只會「數字不變」
  //   ④ 下拉沒併入今年 ⇒ 預設值（今年）在選單裡沒有對應選項，`select` 顯示成空白
  //   ⑤ 匯出沒帶同一組 ⇒ 螢幕上是 2026、下載下來是全期

  it("預設帶今年的窗框", async () => {
    clearApiCalls();
    (api.get as Mock).mockResolvedValue(reportFixture());
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    expect(reportUrls()[0]).toBe(`/teams/t1/report?${windowOf(new Date().getFullYear())}`);
  });

  it("下拉選項併入今年，且預設值真的落在某個選項上", async () => {
    clearApiCalls();
    // 時區位移**釘住**（I-3 之後選項集合與它有關）：`availableYears` 的每一項都會併入它的
    // **本地年候選**，位移不同則候選不同——不釘的話，下面那條精確相等的斷言在 UTC 以西的
    // 機器上會多出一個 `LAST_YEAR - 1`（綠燈的理由與這支要驗的「今年併入」無關）。
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    // 由大到小、末項固定全期；**今年必須在**——它不在 `availableYears` 裡（後端不讀時鐘），
    // 少了前端併入這一步就沒有對應的 option，而瀏覽器不會抱怨：`value` 對不到選項時
    // 只會靜默變成空字串（下面那條斷言就是把這個靜默狀態抓出來）。
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      String(new Date().getFullYear()),
      String(LAST_YEAR),
      "all",
      // 2026-09-22：選擇器改成共用的 `ReportWindowPicker`（多了自訂區間）⇒ 尾端多這一個。
      // 它與 `"all"` 一樣是**哨兵值**，不是譯文——見 `lib/report-window.ts` 的檔頭。
      "custom",
    ]);
    expect(select.value).toBe(String(new Date().getFullYear()));
  });

  it("切到全期時不帶窗框", async () => {
    clearApiCalls();
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    // 起點必須是有窗框的：少了這一行，下面那條「沒有 from=」在一個從不帶窗框的實作上也成立。
    expect(reportUrls()[0]).toContain("from=");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });

    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    expect(reportUrls()[1]).toBe("/teams/t1/report");
  });

  it("切換年份會用新年份重新取數（query key 含年份）", async () => {
    clearApiCalls();
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: String(LAST_YEAR) } });

    // **判別依據是「重新取數」這個行為，不是 query key 的字面拼法**：少了年份那一格，
    // react-query 會直接回上一個年份的快取——`api.get` 只被呼叫一次、畫面只會「數字不變」，
    // 而一支只斷言 key 拼法的測試在快取根本沒失效時照樣是綠的。
    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    expect(reportUrls()[1]).toBe(`/teams/t1/report?${windowOf(LAST_YEAR)}`);
  });

  it("匯出帶與畫面同一組窗框，檔名帶選定的年份（全期則兩者都無）", async () => {
    clearApiCalls();
    // 依 URL 分流，而不是「載入完成後把 mockResolvedValue 換成 blob」：這一支中途會再取
    // 一次報表（切到全期），換掉之後那一次的 `data.members` 就變成 undefined。
    (api.get as Mock).mockImplementation(async (url: string) =>
      url.includes("/export") ? { data: new Blob(["x"]) } : reportFixture([LAST_YEAR]),
    );
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    const thisYear = new Date().getFullYear();
    const { clicked, restore } = captureAnchorClicks();

    fireEvent.click(screen.getByRole("button", { name: /匯出 CSV/ }));
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        `/teams/t1/report/export?${windowOf(thisYear)}`,
        expect.objectContaining({ responseType: "blob" }),
      );
    });
    await waitFor(() => expect(clicked).toHaveLength(1));
    // 檔名由**前端**決定（`a.download` 覆蓋伺服器的 `Content-Disposition`，後端的年份後綴
    // 到不了 SPA 使用者），年份取**選定的本地年**——不是由窗框的 UTC 界線推導：UTC 以東
    // 選 2026 時那會落回 2025（設計 §5.4 已記載的已知誤差）。
    // 檔名**不自稱 annual**（M-4）：全期時後綴是空的，檔名卻寫 annual 就是名實不符。
    expect(clicked[0].download).toBe(`team-performance-t1-${thisYear}.csv`);

    fireEvent.click(screen.getByRole("button", { name: /匯出 Excel/ }));
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        // xls 這顆自己帶著 `?locale=` ⇒ 窗框接在它**後面**（`&`），不是第二個 `?`
        `/teams/t1/report/export-excel?locale=zh-TW&${windowOf(thisYear)}`,
        expect.objectContaining({ responseType: "blob" }),
      );
    });
    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(clicked[1].download).toBe(`team-performance-t1-${thisYear}.xls`);

    // 全期：窗框與檔名後綴**兩者都不帶**（與後端 `YearSuffix` 的空字串規則同一個語意）。
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });
    // **新契約（2026-09-22，final review 的 I-1）**：重新取數期間**工具列仍在 DOM 裡**——
    // skeleton 只換掉它下面的內容。這一條同時保證下面那顆按鈕帶著新狀態的 handler
    // （不會點到還掛著舊窗框的那一次 render）——舊版是靠「按鈕不在 DOM 裡」達到同一個保證的。
    expect(screen.getByTestId("team-report-skeleton")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /匯出 CSV/ })).toBeInTheDocument();

    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(select.value).toBe("all");

    fireEvent.click(screen.getByRole("button", { name: /匯出 CSV/ }));
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        "/teams/t1/report/export",
        expect.objectContaining({ responseType: "blob" }),
      );
    });
    await waitFor(() => expect(clicked).toHaveLength(3));
    expect(clicked[2].download).toBe("team-performance-t1.csv");

    restore();
  });

  // ---------- 考評表上的考核期間（Task 8）----------
  //
  // 考評表（明細對話框）上的每個數字都落在**選定窗框**內：標題與評級欄在 Task 8 改成中性
  // 措辭（不再自稱「年度」），「這是哪一段期間」改由這一列說。少了它，列印出來的主管簽核
  // 檔案上沒有任何字看得出是哪一年的考評——而**紙上只剩這一列**（下拉與 KPI 都不在紙上）。
  //
  // 全期那一邊驗的是「沿用下拉的同一個字串」（`report.year.all`）而不是另一份同義詞：
  // 斷言用的字串就是下拉選項那個字串，兩處分家的話這支會紅。
  it("考評表顯示選定的考核期間（年度顯示年份、全期顯示全期）", async () => {
    clearApiCalls();
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    const year = new Date().getFullYear();

    // 預設是今年：這一列印的是**選定年份**，不是標題裡的年份（標題已經沒有年份了）
    fireEvent.click(screen.getByRole("button", { name: /檢視檔案/ }));
    const yearDialog = await screen.findByRole("dialog");
    expect(within(yearDialog).getByText("考核期間")).toBeInTheDocument();
    expect(within(yearDialog).getByText(String(year))).toBeInTheDocument();

    // 必須先關掉再切年份，不能開著切：對話框開著時整棵樹被 aria-hidden，而且切年份會
    // 重新取數、`isLoading` 的 skeleton 分支把對話框一起卸載（`selectedMember` 還在，
    // 但那個分支在 return 之前）——所以換完年份要再開一次才是新窗框的那一份考評表。
    fireEvent.click(within(yearDialog).getByRole("button", { name: "關閉" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });
    await waitFor(() => expect(reportUrls()).toHaveLength(2));

    fireEvent.click(await screen.findByRole("button", { name: /檢視檔案/ }));
    const allDialog = await screen.findByRole("dialog");
    expect(within(allDialog).getByText("全期")).toBeInTheDocument();
  });

  // 2026-09-22：選擇器共用化之後，團隊頁也能送**自訂區間**。這一支釘兩件事：
  //
  // ① 區間真的送到後端，而且**結束日含當日**（URL 的 `to` 是**隔天**的本地午夜）——
  //    漏掉那個 +1 會靜默吃掉最後一天，而起始日正常 ⇒ 不對稱的少一天讀起來像資料有問題。
  // ② `reportWindowLabel` 的**區間分支**：它在頁面上唯一的落點就是考評表那一列，
  //    沒有這一支就沒有任何測試看得到它（年度與全期兩支都只走各自的分支）。
  it("選自訂區間時送出該區間，考評表的考核期間換成區間文字", async () => {
    clearApiCalls();
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    const year = new Date().getFullYear();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    // 播種值＝剛才那一年，再把結束日改成 6/30。
    fireEvent.change(screen.getByLabelText("結束日期"), { target: { value: `${year}-06-30` } });

    const expected =
      `/teams/t1/report?from=${encodeURIComponent(new Date(year, 0, 1).toISOString())}` +
      `&to=${encodeURIComponent(new Date(year, 6, 1).toISOString())}`;   // 7/1：結束日含當日
    await waitFor(() => expect(reportUrls().at(-1)).toBe(expected));

    fireEvent.click(await screen.findByRole("button", { name: /檢視檔案/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("考核期間")).toBeInTheDocument();
    // 走的是 `format.ts` 的 `formatDayRange`（`common:date.range`）——比對它算出來的字串
    // 是**接線**斷言（頁面有沒有用那一個格式化出口），格式化本身的契約在 `format.ts` 那一側。
    expect(within(dialog).getByText(formatDayRange(`${year}-01-01`, `${year}-06-30`))).toBeInTheDocument();
    // 反面：不得把原始日字串直接倒出來。
    expect(within(dialog).queryByText(`${year}-01-01`)).not.toBeInTheDocument();
  });

  // ---------- I-1：工具列活在取數狀態之上（2026-09-22，final whole-branch review）----------
  //
  // 搬移之前，`isLoading`／`isError` 兩個 early return 在工具列（標題 ＋ 年份下拉 ＋ 兩顆
  // 匯出鈕）**之上** ⇒ 那次取數失敗時整頁只剩一段錯誤文字，而**年份下拉是唯一能救回這個
  // 分頁的控件**（換一個年份就是換一個 query key）；剩下的出路是重新載入頁面，載入後還
  // 落回預設年份、不是他正在看的那一年。下面兩支各釘一半：失敗時下拉還在且能復原、
  // 取數期間工具列不被拆掉。

  it("取數失敗時年份下拉仍在，換一個年份就能重新取數", async () => {
    clearApiCalls();
    // 用**網路層失敗**的形狀（axios 真的丟得出來的那一種），不是裸 `Error`：
    // 裸 Error 的 `message` 與 fallback 可能同字，分不出實作好壞。
    (api.get as Mock).mockRejectedValueOnce(axiosNetworkError());
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    // 錯誤文字在工具列**之下**，而工具列本身還在。
    expect(await screen.findByText(/載入失敗/)).toBeInTheDocument();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /匯出 CSV/ })).toBeInTheDocument();

    // 而且它是**可操作的**——這就是復原路徑（換年份 ⇒ 新的 query key ⇒ 重新取數）。
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    fireEvent.change(select, { target: { value: "all" } });

    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    expect(reportUrls()[1]).toBe("/teams/t1/report");
    expect(await screen.findByText("Alice")).toBeInTheDocument();
  });

  it("取數期間工具列仍在，且能直接再選年份", async () => {
    clearApiCalls();
    // 第一支請求**不回應**：不然取數可能在斷言之前就結束，而這支要驗的正是 loading 那一格
    // 的形狀（一個已經跑完的取數會讓它以「像通過」的樣子空轉）。
    let releaseFirst!: (v: unknown) => void;
    (api.get as Mock).mockImplementationOnce(() => new Promise(res => { releaseFirst = res; }));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    // 還在 loading：skeleton 在，而工具列**也**在（搬移之前這裡只會有 skeleton）。
    expect(screen.getByTestId("team-report-skeleton")).toBeInTheDocument();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe(String(new Date().getFullYear()));

    // 取數還沒回來就能再選年份 ⇒ 新的 query key ⇒ 第二次請求。
    (api.get as Mock).mockResolvedValue(reportFixture([LAST_YEAR]));
    fireEvent.change(select, { target: { value: "all" } });
    await waitFor(() => expect(reportUrls()).toHaveLength(2));
    expect(reportUrls()[1]).toBe("/teams/t1/report");
    expect(await screen.findByText("Alice")).toBeInTheDocument();

    // 收尾：放掉第一支請求（不讓它在這支測試結束之後才 settle）。
    await act(async () => { releaseFirst(reportFixture([LAST_YEAR])); });
  });

  // ---------- I-3：年份標籤要涵蓋**本地年**（2026-09-22，final whole-branch review）----------
  //
  // `availableYears` 是 **UTC 曆年**（後端對 `CreatedAt`／`CompletedAt` 取 `.Year`），而標籤
  // 與窗框是**本地年**。UTC 以東（本機就是 UTC+8）時兩者差一年：台北 2026-01-01 02:00 交付
  // ＝ 2025-12-31T18:00Z ⇒ 那一年的標籤是 2025，但它落在使用者的 **2026** 窗裡。少了候選
  // 那一步，真正含資料的年份選不到、而標著 2025 的那一年開起來是空的——數字沒錯、導覽錯了。
  //
  // **年份刻意相對今年**（不是寫死 2025／2026）：寫死的話，在「今年」正好等於那個候選年的
  // 機器上，斷言會被「今年併入下拉」那一條代為滿足——綠燈的理由與這支要驗的東西無關。
  // 三列涵蓋的新分支是**位移的正負號**（`offsetMin < 0` 併 `y + 1`、`> 0` 併 `y - 1`）。
  it.each([
    [-480, "UTC+8（以東）", [0, 1]],
    [0, "UTC", [0]],
    [480, "UTC-8（以西）", [-1, 0]],
  ])("時區位移 %i（%s）時，資料年併入的標籤候選是 %j", async (offset, _name, deltas) => {
    const thisYear = new Date().getFullYear();
    const dataYear = thisYear - 3;   // 與今年差 3 年 ⇒ 所有候選都不會撞到「今年」
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(offset as number);
    (api.get as Mock).mockResolvedValue(reportFixture([dataYear]));
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });
    await screen.findByText("Alice");

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    // 逐項全等（不是「包含」）：多出來的候選（例如無腦加 ±1）一樣紅。
    // prototype 上的 spy 由 afterEach 的 `vi.restoreAllMocks()` 還原。
    expect(Array.from(select.options).map(o => o.value)).toEqual([
      String(thisYear),
      ...(deltas as number[]).map(d => dataYear + d).sort((a, b) => b - a).map(String),
      "all",
      "custom",
    ]);
  });

  // ---------- M-5：空狀態分兩種（2026-09-22，final whole-branch review）----------
  //
  // 預設是「今年」（設計 D5）⇒ 團隊的資料都在別年時，空狀態若說「目前沒有任何績效數據」
  // 就是假話（2027-01-01 首次進入、交付全在 2026）。全期仍用原來那一條。
  // 2026-09-22（窗框選單批次）：措辭由「所選**年度**」改成「所選**期間**」——這一批之後
  // 這一頁也能選自訂區間，說「年度」在區間模式下是假話（專案頁同一類誠實性缺陷）。
  // key 名不變（`team:report.year.empty`），只有值跟著語意走。
  it("空狀態分兩種：選了期間說所選期間沒有資料，全期說目前沒有任何資料", async () => {
    clearApiCalls();
    (api.get as Mock).mockResolvedValue({ data: { members: [], availableYears: [LAST_YEAR] } });
    render(<TeamReportTab teamId="t1" />, { wrapper: makeWrapper() });

    expect(await screen.findByText("所選期間沒有績效數據")).toBeInTheDocument();
    expect(screen.queryByText("目前沒有任何績效數據")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "all" } });
    await waitFor(() => expect(reportUrls()).toHaveLength(2));

    expect(await screen.findByText("目前沒有任何績效數據")).toBeInTheDocument();
    expect(screen.queryByText("所選期間沒有績效數據")).not.toBeInTheDocument();
  });
});
