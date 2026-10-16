import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssignMemberDialog } from "./AssignMemberDialog";
import { api } from "@/lib/api";
import { localTimeZoneId } from "@/lib/local-day";
import { setLocale } from "@/i18n";
import { useAuth } from "@/stores/auth";
import { axiosStatus } from "@/test/http-errors";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn() } }));

interface UserRow { id: string; username: string; displayName: string; }

const USERS_BY_TEAM: Record<string, UserRow[]> = {
  t1: [{ id: "u1", username: "carol", displayName: "陳助理" }],
  t2: [{ id: "u2", username: "dave", displayName: "林設計" }],
};

// ===== 2026-09-23：`GET /api/auth/users` 收斂為團隊視野 =====
// 該端點現在回「`X-Team-Id` 那個團隊的成員 ∪ 未歸屬使用者」（admin 仍看全庫）。
// 收斂之前它的回應與團隊無關，所以 `AssignMemberDialog` 用一個共用的 query key
// 是對的；收斂之後同一個 key 就錯了：**同時管理兩個團隊的人在這頁切換團隊時，
// 前一個團隊的候選名單會從快取被端出來**（資料還在新鮮期內、不會重取）。
//
// 判別力來自「rerender 之後 key 換了 ⇒ 這是另一筆查詢」：元件實例沒有換，同一個
// QueryObserver 還掛著，key 沒變時 `query === prevQuery` 且 `enabled` 本來就是 true
// ⇒ `shouldFetchOptionally` 的第一個合取項不成立，`isStale` 連看都不看（實查：
// `@tanstack/query-core@5.101.4` 的 `build/modern/queryObserver.js:457-459`，由
// `:251` 的 mounted 分支呼叫；對照組是 remount 走的 `shouldFetchOnMount`，`:447`）
// ⇒ 共用 key 的實作在這一刻**不會**再發請求，畫面繼續顯示前一隊的名單 ⇒ 這支在修好
// 之前是 RED，**與 staleTime 無關**（實測：key 改回 `["all-users"]` ⇒ 兩支都紅，
// `staleTime: 0` 時亦同）。
//
// `STALE_TIME_MS` 仍取生產值（`web/src/main.tsx:23` 的 `staleTime: 30_000`）：
// ① 它對第二支「切回 t1 不重取」那句（`expect(userFetches()).toHaveLength(2)`）今天是
//    **必要**的——`staleTime: 0` 時 key 由 t2 換回 t1 會讓 `shouldFetchOptionally` 落到
//    `isStale` 而為 true ⇒ 多發一次請求（實測：`staleTime: 0` ⇒ 第二支在那一句紅，
//    「expected … to have a length of 2 but got 3」）；
// ② 它也是「這支若改寫成 remount 形狀時救得了它的那個常數」——remount 走
//    `shouldFetchOnMount`，`staleTime: 0` 之下連共用 key 的實作也會重取 ⇒ 那種形狀
//    在 0 之下是**假綠**（實測：remount 形狀 ＋ 共用 key ⇒ `staleTime: 0` 綠、
//    `30_000` 紅）。
const STALE_TIME_MS = 30_000;

function makeClient() {
  // `retry: false`：錯誤分支那支（F-8）要看到的是**失敗當下**的畫面，而 react-query 預設
  // 重試 3 次（1s／2s／4s 退避）⇒ 它會把斷言拖過 `WAIT` 的三倍。其餘測試沒有失敗的查詢，
  // 這個設定對它們是 no-op。
  return new QueryClient({ defaultOptions: { queries: { staleTime: STALE_TIME_MS, retry: false } } });
}

function dialogFor(client: QueryClient, teamId: string) {
  return (
    <QueryClientProvider client={client}>
      <AssignMemberDialog teamId={teamId} />
    </QueryClientProvider>
  );
}

// ===== 2026-09-24：跨團隊指派的使用者搜尋（`GET /api/auth/users/search`） =====
//
// 搜尋是**多出來的第二段**：既有的本地過濾與候選清單一字不動（上面那兩支守著它）。
// 這裡的常數與下面的五支守的是新路徑的性質（計畫 §5B 的 F-1～F-5）。
//
// 搜尋端點的回應是**全目錄**（伺服器刻意不回團隊欄位，計畫 §3.2）——所以這份 fixture
// 刻意同時含「已在 t1 候選名單裡的 carol」與「別的團隊的 erin」。扣掉前者是**前端**的事，
// 那正是 F-3 要釘住的性質；fixture 若只放別隊的人，去重拿掉也不會紅。
const SEARCH_RESULTS: UserRow[] = [
  { id: "u1", username: "carol", displayName: "陳助理" },
  { id: "u3", username: "erin", displayName: "黃工程" },
];

const SEARCH_PREFIX = "/auth/users/search?q=";

// F-4 要按「確認指派」，而它在那個當下必須是可按的 ⇒ 至少要有一個角色可以勾
// （`disabled` 的條件是「沒選人」或「沒勾角色」）。
const ROLES = [{ id: "r1", name: "工程師", isSystem: true, permissionCodes: [] }];

// debounce 用**真時鐘**等，不用 `vi.useFakeTimers()`：本檔其餘測試都是真時鐘，而假時鐘要
// 另外接管 react-query 的排程與 testing-library 的 `waitFor`——混用會讓「這一支為什麼要
// `advanceTimersByTime`」變成第二個得記住的東西，換來的只是省下 300ms。
const DEBOUNCE_MS = 300;
// 要證明「**沒有**發請求」時，得等過一整個 debounce 窗再加一倍裕度，讓「假如真的有發」
// 有機會發生；等不夠的話那個 0 是假的。
const SETTLE_MS = DEBOUNCE_MS * 2;
// 預設 1000ms 在滿載時偏緊（要跑完 debounce 才有請求）⇒ 這一格用 10 倍。
const WAIT = { timeout: DEBOUNCE_MS * 10 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 團隊維度在正式環境走 axios 攔截器加的 `X-Team-Id`（`src/lib/api.ts`），
// 而這裡 `api` 整個被 mock 掉了 ⇒ 用一個可變的 `currentTeam` 代表「伺服器當下看到的團隊」。
//
// `opts` 是後面幾支要的變體，預設值等於原本那支的行為：
//   - `users`：蓋掉候選名單的回應（admin 那一支要餵「全庫」；`/auth/users` 對 admin 不過濾）
//   - `searchResults`：蓋掉搜尋結果（「只有本團隊的人」那個變體，去重後才是空的）
//   - `searchFails`：讓搜尋請求失敗（錯誤分支）
function mockApi(
  currentTeam: () => string,
  opts: { users?: UserRow[]; searchResults?: UserRow[]; searchFails?: boolean } = {},
) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/auth/users") return Promise.resolve({ data: opts.users ?? USERS_BY_TEAM[currentTeam()] });
    if (url.startsWith(SEARCH_PREFIX)) {
      return opts.searchFails
        // 造 axios **實際丟出來的**形狀（`Error.message` 是傳輸層字串、伺服器說的話在
        // `response.data`）：body 的譯文與 `fallback` 不同，三種實作才分得開。
        ? Promise.reject(axiosStatus(403, { code: "permission.denied", message: "SERVER-RAW" }))
        : Promise.resolve({ data: opts.searchResults ?? SEARCH_RESULTS });
    }
    if (url.endsWith("/roles")) return Promise.resolve({ data: ROLES });
    return Promise.resolve({ data: [] });
  });
}

function userFetches() {
  return vi.mocked(api.get).mock.calls.filter(([url]) => url === "/auth/users");
}

// 搜尋請求的 URL（**不含** `/auth/users` 本身：那條走 `===`，這條走前綴；兩者不重疊）。
function searchFetches() {
  return vi.mocked(api.get).mock.calls
    .map(([url]) => url)
    .filter((url) => url.startsWith(SEARCH_PREFIX));
}

function typeQuery(text: string) {
  fireEvent.change(screen.getByPlaceholderText("輸入姓名或帳號即時篩選…"), { target: { value: text } });
}

// 一個字元一個字元地打，字元之間讓出事件迴圈。**這是唯一分辨得出「有沒有 debounce」的形狀**：
// `typeQuery` 一次把整個字串塞進一個 change 事件，全程只產生**一次** state 變更 ⇒ 有沒有
// debounce 都只會發一次請求，既有那 7 支因此在「debounce 被拿掉」的突變下全綠（實測）。
//
// ★ **這個間隔與 debounce 窗無關**（2026-09-28 實測）：`AssignMemberDialog.tsx` 的
// `useEffect` deps 是 `[searchQuery]`、cleanup 會 `clearTimeout` ⇒ 窗是從**最後一次**按鍵
// 起算，整批拉多長都不影響結果（間隔調成 200ms、整批 1000ms 跑 ⇒ 13/13 照綠）。
// 上一版的註解寫「打滿 5 個字元是 250ms，仍在 300ms 的 debounce 窗內」，那是**錯的因果**
// ——`docs/STATE.md` 照著它推論出一個不存在的 flaky 成因（「排程停頓可能讓整批打穿窗」）。
// 這個數字現在唯一的用途是**省時間**（5 × 10ms 對 5 × 50ms），它不是任何東西的守衛。
const TYPE_GAP_MS = 10;
async function typeQuerySlowly(text: string, gapMs = TYPE_GAP_MS) {
  const input = screen.getByPlaceholderText("輸入姓名或帳號即時篩選…");
  let value = "";
  for (const ch of text) {
    value += ch;
    fireEvent.change(input, { target: { value } });
    await sleep(gapMs);
  }
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "指派成員" }));
}

describe("AssignMemberDialog 候選使用者的查詢 key 帶團隊維度", () => {
  beforeEach(() => vi.clearAllMocks());
  // auth store 是模組層級的，不留殘餘（與 TeamMembersTab.test.tsx 同）。
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  it("在同一個快取的有效期內切到另一個團隊，會重取並顯示該團隊的名單", async () => {
    let currentTeam = "t1";
    mockApi(() => currentTeam);
    const client = makeClient();
    const { rerender } = render(dialogFor(client, "t1"));

    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();
    expect(userFetches()).toHaveLength(1);

    // 同一個元件實例、同一個快取，只有 teamId 換了——這正是缺陷的現場：
    // 共用 key 的實作在這一刻沿用 t1 那筆快取（資料還在新鮮期內），畫面繼續顯示 t1 的名單。
    currentTeam = "t2";
    rerender(dialogFor(client, "t2"));

    await waitFor(() => expect(userFetches()).toHaveLength(2));
    expect(await screen.findByText("林設計")).toBeInTheDocument();
    expect(screen.queryByText("陳助理")).not.toBeInTheDocument();
  });

  it("兩個團隊是快取裡兩筆獨立的查詢，各自留著自己的資料", async () => {
    let currentTeam = "t1";
    mockApi(() => currentTeam);
    const client = makeClient();
    const { rerender } = render(dialogFor(client, "t1"));

    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    currentTeam = "t2";
    rerender(dialogFor(client, "t2"));
    await waitFor(() => expect(userFetches()).toHaveLength(2));

    // 切回 t1：那一筆還在、且還在新鮮期內 ⇒ 直接用回自己的資料，不重取。
    currentTeam = "t1";
    rerender(dialogFor(client, "t1"));
    expect(await screen.findByText("陳助理")).toBeInTheDocument();
    expect(userFetches()).toHaveLength(2);

    expect(client.getQueryCache().find({ queryKey: ["all-users", "t1"] })).toBeDefined();
    expect(client.getQueryCache().find({ queryKey: ["all-users", "t2"] })).toBeDefined();
  });
});

describe("AssignMemberDialog 跨團隊使用者搜尋", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  it("F-1：查詢滿 3 個字元會發搜尋請求，結果出現在「其他團隊的成員」區", async () => {
    mockApi(() => "t1");
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("eri");

    expect(await screen.findByText("其他團隊的成員", {}, WAIT)).toBeInTheDocument();
    expect(await screen.findByText("黃工程", {}, WAIT)).toBeInTheDocument();
    // 這一格同時釘住 URL 的形狀（路徑 ＋ `q=` ＋ encodeURIComponent）與「只打一次」。
    expect(searchFetches()).toEqual(["/auth/users/search?q=eri"]);
  });

  it("F-2：未滿 3 個字元一個請求都不發，只顯示提示", async () => {
    mockApi(() => "t1");
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("er");
    // 提示看的是**即時值**（它是「你還沒打夠」的說明，該跟著輸入框走）⇒ 當下就在。
    expect(screen.getByText("輸入至少 3 個字元可搜尋其他團隊的成員")).toBeInTheDocument();
    expect(screen.queryByText("其他團隊的成員")).not.toBeInTheDocument();

    await sleep(SETTLE_MS);

    expect(searchFetches()).toHaveLength(0);
    // 對照組：同一段時間裡這個 mock 確實有在記錄請求 ⇒ 上面的 0 是「沒發」，不是
    // 「這個 helper 壞了」。少了這一行，把 mock 換成一個永遠回空的 spy 也照樣綠。
    expect(userFetches()).toHaveLength(1);
  });

  it("F-3：已在候選名單裡的人不會出現在搜尋區（去重）", async () => {
    mockApi(() => "t1");
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("car");
    expect(await screen.findByText("黃工程", {}, WAIT)).toBeInTheDocument();

    // 伺服器回的兩筆裡 carol（u1）已經在 t1 的候選名單裡 ⇒ 去重後搜尋區只剩 erin。
    // 去重若拿掉，「陳助理」會變成 2 個（候選清單一份、搜尋區一份）。
    expect(screen.getAllByText("陳助理")).toHaveLength(1);
    expect(screen.getAllByText("黃工程")).toHaveLength(1);
  });

  it("F-4：選取搜尋結果後可送出，PUT 帶的是那個人的 username", async () => {
    mockApi(() => "t1");
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("eri");
    fireEvent.click(await screen.findByText("黃工程", {}, WAIT));

    const confirm = screen.getByRole("button", { name: "確認指派成員" });
    // 選了人、還沒勾角色 ⇒ 仍不可按（既有的 disabled 條件沒有被動到）
    expect(confirm).toBeDisabled();

    fireEvent.click(await screen.findByRole("checkbox", {}, WAIT));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith("/teams/t1/members", {
        username: "erin",
        roleIds: ["r1"],
        timeZoneId: localTimeZoneId(),
      }));
  });

  it("F-5：換 teamId prop 不會重取搜尋（查詢 key 刻意不帶 teamId）", async () => {
    let currentTeam = "t1";
    mockApi(() => currentTeam);
    const client = makeClient();
    const { rerender } = render(dialogFor(client, "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("eri");
    expect(await screen.findByText("黃工程", {}, WAIT)).toBeInTheDocument();
    expect(searchFetches()).toHaveLength(1);

    // 換團隊。輸入框裡的「eri」**刻意留著**：搜尋得停在「正在搜尋」的狀態下換團隊，
    // 這一格才問得到「它會不會跟著重取」。清掉的話 `enabled` 變 false，問的就不是同一件事。
    currentTeam = "t2";
    rerender(dialogFor(client, "t2"));

    // 先證明這個 rerender 真的生效了：`["all-users", teamId]` 換了 key ⇒ 打了第二次
    // （兩隊在快取裡是兩筆獨立查詢，由上面那個 describe 守著）。少了這一格，
    // 下面的「只有一筆搜尋」可能只是因為整個元件根本沒重繪。
    await waitFor(() => expect(userFetches()).toHaveLength(2));

    // 再等過一個 debounce 窗：查詢 key 若帶了 teamId，這裡就會多一筆請求與一個快取條目。
    await sleep(SETTLE_MS);
    expect(searchFetches()).toHaveLength(1);
    expect(screen.getAllByText("黃工程")).toHaveLength(1);

    // 濾掉 `k[1] !== ""` 那一筆：元件初次 render 時 `debouncedSearch` 是空字串，
    // react-query 會為那個（disabled 的）key 建立一個不發請求的快取物件；
    // 這裡真正要問的是「非空的搜尋 key 有幾個」。
    const searchKeys = client.getQueryCache().getAll()
      .map((q) => q.queryKey)
      .filter((k) => k[0] === "user-search" && k[1] !== "");
    // 只有「eri」那一筆。查詢 key 若帶了 teamId，換團隊會生出第二筆
    // （例如 `["user-search", "eri", "t2"]`），這裡就會是 2 筆。
    expect(searchKeys).toEqual([["user-search", "eri"]]);
  });
});

// ===== 2026-09-24（review 修正）：debounce、渲染時機、錯誤分支 =====
//
// 這四支補的是**既有 7 支沒有涵蓋的形狀**，不是「斷言不夠多」：
//   F-6 debounce 有沒有作用——`typeQuery` 的形狀分辨不出來（見該 helper 的註解）
//   F-7 這一區看的是哪一個值——看即時值時那段 300ms 會先印一次假的「找不到」
//   F-8 錯誤分支——原本**一支都沒有**（搜尋失敗時畫面上沒有任何斷言看著）
//   F-9 快取 key 用的是不是 trim 過的值——尾端空白會多發一次同樣的請求
describe("AssignMemberDialog 搜尋的 debounce 與渲染時機", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  it("F-6：逐字輸入只送一次請求，而且送的是收斂後的值", async () => {
    mockApi(() => "t1");
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    await typeQuerySlowly("erica");

    expect(await screen.findByText("黃工程", {}, WAIT)).toBeInTheDocument();
    // 五次按鍵、一次請求，而且是**最後**那個字串。少了 debounce（查詢改看即時值）時，
    // 第 3／4／5 個字元各會讓 `enabled` 由 false 轉 true 一次 ⇒ 多兩筆中間值的請求。
    expect(searchFetches()).toEqual(["/auth/users/search?q=erica"]);
  });

  it("F-7：debounce 窗內不印「找不到」（這一區看的是收斂後的值，不是輸入框）", async () => {
    // 只回一位**已經在候選名單裡**的人 ⇒ 去重後這一區是空的，空狀態才有機會出現。
    mockApi(() => "t1", { searchResults: USERS_BY_TEAM.t1 });
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("car");

    // 這一刻請求**還沒被允許發**（debounce 的 300ms 未到 ⇒ `enabled` 還是 false）。
    // 看即時值的實作會在這裡印出「找不到」：那一刻 `searchResults` 是空的，而
    // `searchLoading` 也是 false（查詢被 disable ⇒ `isLoading = isPending && isFetching`
    // 為 false）⇒ 直接落到空狀態。這一句與下一個 `await` 之間沒有讓出事件迴圈，
    // 所以 300ms 的計時器不可能已經跑過。
    expect(screen.queryByText("找不到其他團隊的成員")).not.toBeInTheDocument();

    // 正對照：請求回來之後同一個斷言必須**反過來**成立。少了這一行，上面那句在
    // 「這一區永遠不印」的實作下也照樣綠。
    expect(await screen.findByText("找不到其他團隊的成員", {}, WAIT)).toBeInTheDocument();
  });

  it("F-8：搜尋失敗時顯示錯誤訊息，不是「找不到」", async () => {
    mockApi(() => "t1", { searchFails: true });
    render(dialogFor(makeClient(), "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("eri");

    // `permission.denied` 的譯文——**既不等於** fixture 的傳輸層字串（`SERVER-RAW`），
    // **也不等於** `fallback`（`common:error.load`）⇒ 「直讀 error.message」「只退回
    // fallback」「走 apiErrorMessage」三種實作分得開。
    expect(await screen.findByText("你沒有存取這個資源的權限", {}, WAIT)).toBeInTheDocument();
    expect(screen.queryByText("找不到其他團隊的成員")).not.toBeInTheDocument();
  });

  it("F-9：尾端空白不多發請求、也不多一筆快取（key 用的是 trim 過的值）", async () => {
    mockApi(() => "t1");
    const client = makeClient();
    render(dialogFor(client, "t1"));
    openDialog();
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    typeQuery("erin");
    await waitFor(() => expect(client.getQueryData(["user-search", "erin"])).toBeDefined());
    expect(searchFetches()).toHaveLength(1);

    // 尾端補一個空白：`searchQuery` 變了（debounce 會重跑一次），但 key 與 URL 用的都是
    // trim 後的值 ⇒ 對 react-query 而言這是**同一個 key**，資料還在新鮮期內 ⇒ 不再發請求。
    // key 用未 trim 的值時，這裡會多一筆請求（URL 逐字相同）與一筆新的快取條目。
    // 濾掉 `k[1] !== ""` 那一筆的理由與 F-5 同（元件初次 render 時那個 disabled 的 key）。
    typeQuery("erin ");
    await sleep(SETTLE_MS);

    expect(searchFetches()).toEqual(["/auth/users/search?q=erin"]);
    const searchKeys = client.getQueryCache().getAll()
      .map((q) => q.queryKey)
      .filter((k) => k[0] === "user-search" && k[1] !== "");
    expect(searchKeys).toEqual([["user-search", "erin"]]);
  });
});

// ===== 2026-09-24（review 修正）：「其他團隊」那一區的兩個顯示前提 =====
//
// 這一區靠一個推論活著：「扣掉 `allUsers` 剩下的就是第三類」。那個推論有兩個前提，
// 而**原本兩個都沒有被擋住**（也沒有任何測試看著）：
//   ① 非 admin——`/auth/users` 對 admin 回的是**全庫**（`AuthEndpoints.cs:99-100` 的
//      `scoped` 帶 `!= AdminClaim.Value`）⇒ 去重恆為空。畫面會在上方候選清單明明看得見
//      那個人的同時，於下方標題底下再報一次「找不到」。
//   ② 候選名單已解析——`allUsers` 在查詢還在飛（或失敗）時是 `[]` ⇒ 去重什麼都扣不掉，
//      這一區會把**本團隊**的成員列在「其他團隊的成員」底下。
describe("AssignMemberDialog「其他團隊」那一區的顯示前提", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  // `/auth/users` 對 admin 不過濾 ⇒ 這份就是 admin 看到的「全庫」。
  const ADMIN_DIRECTORY: UserRow[] = [
    { id: "u1", username: "carol", displayName: "陳助理" },
    { id: "u3", username: "erin", displayName: "黃工程" },
  ];

  it("admin：整區不渲染（候選名單已是全庫，這一區只會把看得到的人再報一次找不到）", async () => {
    useAuth.setState({
      user: { userId: "u9", username: "admin", displayName: "管理員", isAdmin: true },
    });
    mockApi(() => "t1", { users: ADMIN_DIRECTORY });
    const client = makeClient();
    render(dialogFor(client, "t1"));
    openDialog();

    // 前提：這個人**在候選清單裡就看得到**——那就是畫面自相矛盾的現場。
    expect(await screen.findByText("陳助理")).toBeInTheDocument();
    expect(await screen.findByText("黃工程")).toBeInTheDocument();

    typeQuery("eri");
    // 正對照：搜尋確實發生過。少了它，「沒渲染」可能只是「還沒跑」。
    await waitFor(() => expect(client.getQueryData(["user-search", "eri"])).toBeDefined());

    // 這一刻 `searchTerm` 是 "eri"（≥ 3）⇒ 區塊、標題、空狀態三者都**已經**在射程內。
    // 它們必須一個都不在——這正是 review 描述的那個畫面。
    expect(screen.queryByText("其他團隊的成員")).not.toBeInTheDocument();
    expect(screen.queryByText("找不到其他團隊的成員")).not.toBeInTheDocument();
    // 那個人只在候選清單裡出現一次（沒有被這一區再列一次）。
    expect(screen.getAllByText("黃工程")).toHaveLength(1);

    // 短查詢：提示也屬於這一區（那句話承諾一個對 admin 永遠不會出現的區塊），
    // 所以它也得跟著消失——這一格要放在上面那幾句**之後**，否則 `searchTerm` 會掉回
    // 2 個字元，上面守標題的那兩句就變成在守一個本來就不會渲染的分支。
    typeQuery("er");
    await sleep(SETTLE_MS);
    expect(screen.queryByText("輸入至少 3 個字元可搜尋其他團隊的成員")).not.toBeInTheDocument();
  });

  it("候選名單還在飛時這一區不出現（標題不會蓋住本團隊的人）", async () => {
    // `/auth/users` 停在「還在飛」，由測試決定何時 resolve——這正是「查詢已送出、還沒
    // 回來」的那一刻，也是 `allUsers` 還是 `[]`、去重扣不掉任何人的那一刻。
    let releaseUsers!: (v: { data: UserRow[] }) => void;
    const usersPromise = new Promise<{ data: UserRow[] }>((resolve) => { releaseUsers = resolve; });
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/auth/users") return usersPromise;
      if (url.startsWith(SEARCH_PREFIX)) return Promise.resolve({ data: SEARCH_RESULTS });
      if (url.endsWith("/roles")) return Promise.resolve({ data: ROLES });
      return Promise.resolve({ data: [] });
    });

    const client = makeClient();
    render(dialogFor(client, "t1"));
    openDialog();

    // `"car"` 是刻意的：它同時命中 carol（**本團隊**的人）與 erin（別隊的人），
    // 所以「carol 該不該出現在這一區」在解析前後各有一個明確的答案。
    typeQuery("car");
    // 正對照：搜尋**確實回來了**——否則「什麼都沒印」可能只是「什麼都沒發生」。
    await waitFor(() => expect(client.getQueryData(["user-search", "car"])).toBeDefined());

    // 候選名單尚未解析 ⇒ 這一區若照常渲染，`carol`（**本團隊**的人）會被列在
    // 「其他團隊的成員」標題底下，而這一刻畫面上根本還沒有候選清單可以對照。
    expect(screen.queryByText("其他團隊的成員")).not.toBeInTheDocument();
    expect(screen.queryByText("陳助理")).not.toBeInTheDocument();

    // 候選名單回來之後才出現（同一個元件實例、沒有重新掛載）。
    await act(async () => { releaseUsers({ data: USERS_BY_TEAM.t1 }); });
    expect(await screen.findByText("其他團隊的成員", {}, WAIT)).toBeInTheDocument();
    // 去重生效：carol 只在候選清單那一份（輸入框裡的 "car" 讓他留在清單上），
    // 這一區只剩 erin。
    expect(screen.getAllByText("陳助理")).toHaveLength(1);
    expect(screen.getAllByText("黃工程")).toHaveLength(1);
  });
});

// ===== 2026-10-08：系統角色名走語系檔（state/31）=====
// 角色勾選清單吃 `GET /teams/{teamId}/roles`（`TeamRoleResponse`，**本來就有 `Code`**）。
// 修好之前這一區在 en 之下顯示的是種子裡的中文（工程師／專案助理…）。
describe("AssignMemberDialog 系統角色名走語系檔", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  it("有 code 的系統角色在 en 之下顯示譯文；沒有 code 的原樣顯示 DB 名", async () => {
    await setLocale("en");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/auth/users") return Promise.resolve({ data: USERS_BY_TEAM.t1 });
      if (url.endsWith("/roles")) {
        return Promise.resolve({
          data: [
            { id: "r1", name: "工程師", code: "engineer", isSystem: true, permissionCodes: [] },
            { id: "r2", name: "資料科學家", code: null, isSystem: false, permissionCodes: [] },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(dialogFor(makeClient(), "t1"));
    // 這裡**不能**用檔案的 `openDialog()`：它以 zh-TW 的可及名稱（「指派成員」）找觸發鈕，
    // 而這支刻意先切到 en（同一顆鈕在 en 之下叫 "Assign member"）。
    fireEvent.click(screen.getByRole("button", { name: "Assign member" }));
    // 正對照：對話框真的開了、候選名單也回來了（否則下面那幾句「找不到」可能是空的 DOM）。
    expect(await screen.findByText("陳助理")).toBeInTheDocument();

    expect(await screen.findByText("Engineer")).toBeInTheDocument();
    expect(screen.getByText("資料科學家")).toBeInTheDocument();
    // 判別器：修好之前兩個標籤印的都是 DB 名，這一句會紅。
    expect(screen.queryByText("工程師")).not.toBeInTheDocument();
  });
});
