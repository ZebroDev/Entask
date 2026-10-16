import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import { ProjectPage } from "./ProjectPage";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// 每個分頁模組的 factory 只在該模組**第一次被 import** 時跑一次，而 `lazyPage` 把那次
// import 推遲到該分頁第一次被 render ⇒ `loaded` 量的就是 lazy 本身。
// 少了它，「把 lazyPage 改回靜態 import」會讓本檔全部照綠——而那正是這一批要防的退化。
// ★ factory 的結果被 vitest 快取（一個模組只載入一次），所以唯一能讀這份清單的時機是
//   本檔**第一支**會 render 的測試；那一支用 `toEqual` 精確比對 ⇒ 順序一亂就會大聲壞掉，
//   不會靜默變成空轉。
const { loaded } = vi.hoisted(() => ({ loaded: [] as string[] }));

// 甘特圖永不解析，用來把「載入中」那一刻固定住（固定的是**元件自己**走 Suspense 協定，
// 不是 dynamic import——vitest 給不了「import() 永不 settle」那個形狀）。
vi.mock("./project/tabs/GanttTab", () => {
  loaded.push("GanttTab");
  return {
    GanttTab: () => {
      throw new Promise<void>(() => {});
    },
  };
});

// 心智圖換成有記號的替身，讓「切過去之後真的掛載了」有東西可斷言。
vi.mock("./project/tabs/MindMapTab", () => {
  loaded.push("MindMapTab");
  return { MindMapTab: () => <div>心智圖內容</div> };
});

// 其餘 7 個只記「有沒有被載入」，內容原樣回傳 ⇒ 既有行為一字不變。
// 逐條寫死而不是用迴圈／helper：`vi.mock` 只會被提升**頂層的字面值呼叫**，
// 包在函式裡就得靠「它在 import 之後、第一次 render 之前跑完」這個轉譯順序僥倖——
// 那正是本檔上面在防的那種靜默失效。
vi.mock("./project/BoardListTab", async () => {
  loaded.push("BoardListTab");
  return await vi.importActual("./project/BoardListTab");
});
vi.mock("./project/MembersTab", async () => {
  loaded.push("MembersTab");
  return await vi.importActual("./project/MembersTab");
});
vi.mock("./project/CustomFieldsTab", async () => {
  loaded.push("CustomFieldsTab");
  return await vi.importActual("./project/CustomFieldsTab");
});
vi.mock("./project/tabs/ReportTab", async () => {
  loaded.push("ReportTab");
  return await vi.importActual("./project/tabs/ReportTab");
});
vi.mock("./reports/WorkLogReport", async () => {
  loaded.push("WorkLogReport");
  return await vi.importActual("./reports/WorkLogReport");
});
vi.mock("./project/tabs/CalendarTab", async () => {
  loaded.push("CalendarTab");
  return await vi.importActual("./project/tabs/CalendarTab");
});
vi.mock("./project/tabs/TableTab", async () => {
  loaded.push("TableTab");
  return await vi.importActual("./project/tabs/TableTab");
});

const projectFixture = { id: "p1", teamId: "t1", name: "專案一", description: null, memberCount: 1, boardCount: 1, createdAt: "2026-08-01T00:00:00Z" };
const boardFixture = { id: "b1", projectId: "p1", name: "看板一", description: null, position: "a", isArchived: false };
const reportFixture = {
  memberHours: [], memberRemaining: [],
  reviewStats: { pendingCount: 0, approvedCount: 0, rejectedCount: 0, averageScore: null },
  cards: [],
};

async function mockApi() {
  const { api } = await import("@/lib/api");
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/projects/p1") return Promise.resolve({ data: projectFixture });
    if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["project.read", "report.view"] });
    if (url.startsWith("/projects/p1/report")) return Promise.resolve({ data: reportFixture });
    if (url === "/projects/p1/boards") return Promise.resolve({ data: [boardFixture] });
    return Promise.resolve({ data: [] });
  });
}

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("ProjectPage 的分頁邊界", () => {
  // ★ 這一支必須是本檔**第一支**會 render 的測試——`loaded` 由模組快取決定，跑在後面就讀不到。
  it("只載入被選到的分頁，其餘 8 個都不載入（守的是 lazy 本身）", async () => {
    await mockApi();
    renderPage("/projects/p1"); // 預設分頁是 boards
    await screen.findByRole("tab", { name: "看板" });
    await screen.findByRole("tab", { name: "心智圖" });

    expect([...loaded].sort()).toEqual(["BoardListTab"]);

    const tab = screen.getByRole("tab", { name: "心智圖" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);

    // 這一行是上一行的對照組：計數器真的量得到東西，不是恆為空
    expect(await screen.findByText("心智圖內容")).toBeInTheDocument();
    expect([...loaded].sort()).toEqual(["BoardListTab", "MindMapTab"]);
  });

  it("分頁還在載入時，分頁列留著、並顯示載入提示", async () => {
    await mockApi();
    renderPage("/projects/p1?tab=gantt");

    // 分頁列是外框，必須比 Suspense 邊界活得久——邊界若擺到 `<Tabs>` 外面（或包住整頁），
    // 這一行就會連同整個專案頁一起被 fallback 換掉。
    expect(await screen.findByRole("tab", { name: "甘特圖" })).toBeInTheDocument();

    const fallback = await screen.findByText(i18n.t("common:state.loading"));
    expect(fallback).toBeInTheDocument();
    // defaultNS 三處不一致時 t() 會**靜默回傳 key 字串本身**，而上面那行比的是同一個 t()
    // ⇒ 少了這一行，「語系有設好」與「根本沒設好」都會過。
    expect(fallback).not.toHaveTextContent("common:state.loading");
  });

  it("分頁載入完成後提示不再留著（正向對照：邊界不是恆顯）", async () => {
    await mockApi();
    // 暖機：把冷啟動的動態 import 移出 `findBy*` 的斷言窗口。**整條鏈**（`lazyPage` 的
    // `import` → 本檔的 mock factory → `importActual` → `ReportTab` 自己的 recharts）
    // 都算在那 1000ms 裡，全量平行負載下跑不完，孤立跑則可以。
    // ★ **不能改用檔頭的 `beforeAll`**：hook 不論寫在 describe 的哪一行，都在**第一支**
    //   測試之前跑，而那一支拿 `loaded` 做精確計數（`toEqual(["BoardListTab"])`），
    //   mock factory 一跑就把 `ReportTab` 推進去、哨兵當場壞掉。
    // ★ 這**不是**放寬逾時：斷言、逾時、被斷言的東西三者都沒有動——與
    //   `ProjectPage.test.tsx` 的處置同一個原則（該檔的修法只涵蓋它自己，
    //   本檔是同一形狀的第二支，2026-10-04 才補上）。
    await import("./project/tabs/ReportTab");
    renderPage("/projects/p1?tab=report");

    expect(await screen.findByText("成員工時")).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("common:state.loading"))).not.toBeInTheDocument();
  });
});
