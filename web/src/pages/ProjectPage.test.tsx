import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type ComponentType } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectPage } from "./ProjectPage";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// `lazyPage` 要留真的（9 個分頁靠它），只換掉兩個要被斷言的：
// `loadCardDialog` 是 `lazyPage(loadCardDialog, "CardDialog")` 的**參數**，
// 「有沒有真的拆出去」只能從它有沒有被呼叫看出來；`prefetchCardDialog` 同理，
// 這一頁**刻意不預取**（見 `ProjectPage.tsx` 的註解）。
vi.mock("@/lib/lazy-route", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lazy-route")>("@/lib/lazy-route");
  return { ...actual, loadCardDialog: vi.fn(), prefetchCardDialog: vi.fn() };
});

const projectFixture = { id: "p1", teamId: "t1", name: "專案一", description: null, memberCount: 1, boardCount: 1, createdAt: "2026-08-01T00:00:00Z" };
const boardFixture = { id: "b1", projectId: "p1", name: "看板一", description: null, position: "a", isArchived: false };
const reportFixture = {
  memberHours: [], memberRemaining: [],
  reviewStats: { pendingCount: 0, approvedCount: 0, rejectedCount: 0, averageScore: null },
  cards: [],
};

function renderPage(initial = "/projects/p1", withUpperBoundary = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const routes = (
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectPage />} />
    </Routes>
  );
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        {/* `withUpperBoundary` 模擬 `AppLayout` 的 `<Outlet />` 那一層。少了它，
            「有沒有冒泡上去」在測試裡**看不出來**——樹上沒有別的 fallback，
            `queryByText` 當然什麼都找不到，斷言會恆真。 */}
        {withUpperBoundary ? <Suspense fallback={<div>上層邊界</div>}>{routes}</Suspense> : routes}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

// 冷啟動的動態 import 要留在斷言窗口之外（2026-09-30）：這一頁的分頁全是
// `lazyPage`（`React.lazy` ＋ dynamic import），而 `findBy*` 的預設上限是 **1s**。
// 全量跑（兩個 worker 併跑 82 個檔）時，「第一次掛載某個分頁」的那一支會把
// **整條動態 import 鏈**算進那 1 秒——實測紅在 `ProjectPage.test.tsx:119`、
// 該支**恰好 1099ms**（形狀與判準見 `docs/quirks.md` 的〈測試層「找不到元素」〉）。
// ⇒ 在**任何斷言之前**先把本檔真的會被斷言到的兩個分頁載進來。
// （`BoardListTab` 是預設分頁、也會掛載，但斷言它的那幾支只看**分頁列**——
//   分頁列在 Suspense 邊界之外，冷啟動不影響它們。）
// ★ 這**不是**放寬逾時（`AGENTS.md` 明文禁止）：斷言、逾時、被斷言的東西三者都沒有動。
beforeAll(async () => {
  await import("./project/tabs/ReportTab");
  await import("./project/tabs/MindMapTab");
});

beforeEach(() => vi.clearAllMocks());

describe("ProjectPage 心智圖/報表 tab", () => {
  it("有 project.read 顯示心智圖 tab，無權限隱藏", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["project.read", "mindmap.edit"] });
      if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByRole("tab", { name: "心智圖" })).toBeInTheDocument();
  });

  it("無 project.read 不顯示心智圖 tab", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["board.read"] });
      if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await screen.findByRole("tab", { name: "看板" });
    expect(screen.queryByRole("tab", { name: "心智圖" })).not.toBeInTheDocument();
  });

  it("有 report.view 顯示報表 tab；深連結 ?tab=report 直接呈現報表", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["project.read", "report.view"] });
      // 2026-09-22（窗框批次）：`ReportTab` 現在**帶著 query string** 打這條
      // （`?from=…&to=…`，預設是今年）⇒ 精確比對會落空、掉進下面的 catch-all（`data: []`）。
      if (url.startsWith("/projects/p1/report")) return Promise.resolve({ data: reportFixture });
      if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
      return Promise.resolve({ data: [] });
    });
    renderPage("/projects/p1?tab=report");
    expect(await screen.findByRole("tab", { name: "報表" })).toBeInTheDocument();
    expect(await screen.findByText("成員工時")).toBeInTheDocument();   // ReportTab 已掛載
  });

  it("無 report.view 不顯示報表 tab", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["project.read"] });
      if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await screen.findByRole("tab", { name: "看板" });
    expect(screen.queryByRole("tab", { name: "報表" })).not.toBeInTheDocument();
  });

  it("點擊心智圖 tab 掛載 MindMapTab", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["project.read", "mindmap.edit"] });
      if (url === "/projects/p1/mindmap") return Promise.resolve({ data: { id: "m1", projectId: "p1", name: null, nodes: [] } });
      if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    const tab = await screen.findByRole("tab", { name: "心智圖" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByText("尚無節點")).toBeInTheDocument();
  });
});

describe("ProjectPage 的 CardDialog 是 lazy（2026-09-27）", () => {
  async function mockApis() {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["project.read"] });
      if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
      return Promise.resolve({ data: [] });
    });
  }

  it("深連結 ?card=：不觸發上層邊界，且 chunk 到了之後對話框掛得上", async () => {
    await mockApis();
    const { loadCardDialog } = await import("@/lib/lazy-route");
    // 由測試自己決定何時解析 ⇒ 重現「chunk 還沒下載完」那個瞬間。
    let resolveCardDialog!: (m: { CardDialog: ComponentType }) => void;
    vi.mocked(loadCardDialog).mockReturnValue(
      new Promise((resolve) => {
        resolveCardDialog = resolve;
      }) as never,
    );

    renderPage("/projects/p1?card=c1", true);

    // ① 真的有被要求下載。少了這一行，把 import 改回靜態會讓整個檔案照綠
    //    ——那正是這一批要防的退化。
    await waitFor(() => expect(loadCardDialog).toHaveBeenCalled());
    // ② 等待期間：標題列與分頁列都還在，而且**上層邊界沒有出現**。
    //    拔掉那個 `<LazyBoundary fallback={null}>` 的話，最近的界就是上面那一層
    //    ⇒ 整頁（含標題）被「上層邊界」換掉，這兩行當場紅。
    expect(await screen.findByText("專案一")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "看板" })).toBeInTheDocument();
    expect(screen.queryByText("上層邊界")).not.toBeInTheDocument();
    // ③ chunk 到了之後掛得上去——`lazyPage` 取的是**具名匯出**，名字取錯這裡會紅。
    await act(async () => {
      resolveCardDialog({ CardDialog: () => <div>卡片對話框</div> });
    });
    expect(await screen.findByText("卡片對話框")).toBeInTheDocument();
  });

  it("沒有 ?card= 時不下載、也不預取對話框的 chunk", async () => {
    await mockApis();
    const { loadCardDialog, prefetchCardDialog } = await import("@/lib/lazy-route");

    renderPage();

    await screen.findByRole("tab", { name: "看板" });
    // 「順手對齊 BoardPage」把閒置預取搬過來的話這一條會紅——而畫面上什麼都
    // 看不出來（50KB 只是在背景被下載），所以只能靠這一支守（見 ProjectPage.tsx）。
    expect(prefetchCardDialog).not.toHaveBeenCalled();
    expect(loadCardDialog).not.toHaveBeenCalled();
  });
});
