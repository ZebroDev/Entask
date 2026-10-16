import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { MindMapTab } from "./tabs/MindMapTab";
import type { MindMapResponse } from "@/lib/board-types";
import i18n from "@/i18n";
import { MINDMAP_CASCADE_DRAG_KEY, MINDMAP_COLLAPSED_PREFIX } from "@/lib/storage-keys";

// 攔截 DndContext 捕捉 onDragEnd，以合成事件模擬 drop（board-drop.test.tsx 同型：
// jsdom 下 rect 全零、真實指標拖曳碰撞解析不可靠）
const dndHandlers = vi.hoisted(() => ({
  onDragEnd: null as null | ((event: DragEndEvent) => void),
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndHandlers.onDragEnd = props.onDragEnd ?? null;
      return <actual.DndContext {...props} />;
    },
  };
});
// 攔截 MiniMap 的 props：jsdom 沒有版面量測，縮圖的方塊**一個都不會渲染**
// （`MiniMapNodes` 對 `nodeHasDimensions` 為 false 的節點回 null，實查
// `@xyflow/react/dist/esm/index.mjs` 的 `NodeComponentWrapperInner`），
// 所以縮圖的顏色只能從「傳進去的函式」驗——與上面攔 `DndContext` 同型。
const minimapProps = vi.hoisted(() => ({ nodeColor: null as null | ((node: never) => string) }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    MiniMap: (props: ComponentProps<typeof actual.MiniMap>) => {
      minimapProps.nodeColor = props.nodeColor as (node: never) => string;
      return <actual.MiniMap {...props} />;
    },
  };
});
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mindmapFixture: MindMapResponse = {
  id: "m1", projectId: "p1", name: null,
  nodes: [
    { id: "n1", parentId: null, title: "根", note: null, position: "h", cardId: null, card: null },
    { id: "n2", parentId: "n1", title: "子", note: "註", position: "h", cardId: "c1", card: { id: "c1", title: "卡A", isArchived: false, completedAt: null, reviewState: null } },
    { id: "n3", parentId: "n1", title: "弟", note: null, position: "n", cardId: null, card: null },
  ],
};

// 完成狀態：卡A 已完成、卡B 未完成——同一棵樹內對照，避免「有沒有渲染」的假陽性
const completedCardFixture: MindMapResponse = {
  id: "m1", projectId: "p1", name: null,
  nodes: [
    { id: "n1", parentId: null, title: "根", note: null, position: "h", cardId: null, card: null },
    { id: "n2", parentId: "n1", title: "子", note: null, position: "h", cardId: "c1", card: { id: "c1", title: "卡A", isArchived: false, completedAt: "2026-09-10T00:00:00Z", reviewState: null } },
    { id: "n3", parentId: "n1", title: "弟", note: null, position: "h", cardId: "c2", card: { id: "c2", title: "卡B", isArchived: false, completedAt: null, reviewState: null } },
  ],
};

// **只給 n2 那張卡**：`mindmapFixture` 只有**一個**綁卡節點（n2 的卡A；n3 是
// `cardId: null, card: null`）——「兩個綁卡節點」的是 `completedCardFixture`（n2 的卡A、
// n3 的卡B，同一棵樹內對照完成狀態用）。注入一律指名 n2：`findByLabelText` 就不會因
// 多重命中而拋錯，也不隨 fixture 之後多幾個綁卡節點而變。
// 2026-09-18 起審查狀態有**兩個**落點（大綱列與畫布節點），故由畫布那個 describe
// 提到模組層級共用。
const withReviewState = (reviewState: "pending" | "approved" | "rejected" | null) => ({
  data: {
    ...mindmapFixture,
    nodes: mindmapFixture.nodes.map((n) =>
      n.id === "n2" && n.card ? { ...n, card: { ...n.card, reviewState } } : n
    ),
  },
});

function renderTab(canEdit = true, focusNodeId: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MindMapTab projectId="p1" canEdit={canEdit} focusNodeId={focusNodeId} />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("MindMapTab 樹渲染與 CRUD", () => {
  it("渲染巢狀樹", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    expect(await screen.findByText("根")).toBeInTheDocument();
    expect(screen.getByText("子")).toBeInTheDocument();
    expect(screen.getByText("弟")).toBeInTheDocument();
  });

  it("新增子節點以 POST 送出 title 與 parentId", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.post).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click((await screen.findAllByRole("button", { name: "新增子節點" }))[0]!);   // 根
    const input = screen.getByPlaceholderText("子節點標題…");
    fireEvent.change(input, { target: { value: "新節點" } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/projects/p1/mindmap/nodes", { title: "新節點", parentId: "n1" }));
  });

  it("取消不送出新增：blur-commit 不與取消按鈕競逐", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click((await screen.findAllByRole("button", { name: "新增子節點" }))[0]!);   // 根
    const input = screen.getByPlaceholderText("子節點標題…");
    fireEvent.change(input, { target: { value: "新節點" } });
    const cancel = screen.getByRole("button", { name: "取消" });
    fireEvent.mouseDown(cancel);   // 瀏覽器真實事件序：mousedown → blur → click
    fireEvent.blur(input);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByPlaceholderText("子節點標題…")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("改名以 PUT 送出 title", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click(await screen.findByText("根"));
    const input = await screen.findByDisplayValue("根");
    fireEvent.change(input, { target: { value: "新根" } });
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n1", { title: "新根" }));
  });

  it("刪除前顯示子樹後果確認，取消不呼叫 DELETE", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click((await screen.findAllByRole("button", { name: "刪除節點" }))[0]!);   // 根（含 2 子節點）
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/2 個子節點/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(api.delete).not.toHaveBeenCalled());
  });

  it("確認後以 DELETE 呼叫", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.delete).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click((await screen.findAllByRole("button", { name: "刪除節點" }))[0]!);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n1"));
  });

  it("無編輯權限時隱藏新增/刪除並以灰底＋禁點游標停用改名（R10 同型 aria-disabled＋title）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab(false);
    await screen.findByText("根");
    expect(screen.queryByRole("button", { name: "新增子節點" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刪除節點" })).not.toBeInTheDocument();
    const titleBtn = screen.getByText("根");
    expect(titleBtn).toHaveAttribute("aria-disabled", "true");
    expect(titleBtn).toHaveAttribute("title", "無編輯權限");
    expect(titleBtn).toHaveClass("opacity-50");
    expect(titleBtn).toHaveClass("cursor-not-allowed");
  });

  it("載入失敗顯示錯誤與重試", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockRejectedValue(new Error("Network Error"));
    renderTab();
    expect(await screen.findByText(/載入失敗/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });
});

describe("MindMapTab 拖曳排序與 reparent", () => {
  it("拖到兄弟節點 → 以 between 位置 PUT（插入其前）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "n2" }, over: { id: "n3" } } as unknown as DragEndEvent);
    });
    // between("h", "n") = "k"（base62）
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n2/position",
      { parentId: "n1", position: "k" }));
  });

  it("拖子節點到根節點 → PUT body parentId 顯式 null（移根）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "n2" }, over: { id: "n1" } } as unknown as DragEndEvent);
    });
    // between(null, "h") = "L"（base62）
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n2/position",
      { parentId: null, position: "L" }));
  });

  it("拖到節點 -body 區 → after 末位 append 為其子節點", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "n2" }, over: { id: "n3-body" } } as unknown as DragEndEvent);
    });
    // after(null) = "U"（base62）
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n2/position",
      { parentId: "n3", position: "U" }));
  });

  it("拖到自身子孫 → toast 攔截且不送 PUT", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "n1" }, over: { id: "n2" } } as unknown as DragEndEvent);
    });
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith("不可移至自身子節點之下");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("失敗回滾：PUT 拒絕後還原樂觀快照並 toast", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockRejectedValue(new Error("Request failed with status code 400"));
    const qc = renderTab();
    await screen.findByText("根");
    act(() => {
      dndHandlers.onDragEnd!({ active: { id: "n2" }, over: { id: "n3" } } as unknown as DragEndEvent);
    });
    await waitFor(() => {
      const cached = qc.getQueryData<MindMapResponse>(["mindmap", "p1"]);
      expect(cached?.nodes.find((n) => n.id === "n2")?.position).toBe("h");   // 還原樂觀前
      expect(cached?.nodes.find((n) => n.id === "n2")?.parentId).toBe("n1");
    });
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalled();
  });
});

const boardCards = [
  { id: "c1", listId: "l1", title: "卡A", position: "a", isArchived: false, dueAt: null, coverAttachmentId: null, labels: [], members: [], checklistDone: 0, checklistTotal: 0, loggedHours: 0, remainingHours: null },
  { id: "c2", listId: "l1", title: "封存卡", position: "b", isArchived: true, dueAt: null, coverAttachmentId: null, labels: [], members: [], checklistDone: 0, checklistTotal: 0, loggedHours: 0, remainingHours: null },
];

describe("MindMapTab 綁定 picker", () => {
  it("搜尋列表排除封存卡，選取後以 PUT cardId 綁定", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1/mindmap") return Promise.resolve({ data: mindmapFixture });
      if (url === "/projects/p1/boards") return Promise.resolve({
        data: [{ id: "b1", projectId: "p1", name: "板", description: null, position: "a", isArchived: false }],
      });
      if (url === "/boards/b1") return Promise.resolve({
        data: { id: "b1", projectId: "p1", name: "板", description: null, position: "a", isArchived: false,
          lists: [{ id: "l1", name: "待辦", position: "a", isArchived: false, cards: boardCards }] },
      });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click((await screen.findAllByRole("button", { name: "綁定卡片" }))[0]!);   // 根（未綁）
    const dialog = await screen.findByRole("dialog");
    // boards→details 兩段查詢為非同步載入，需以 findByText 等待卡片列表渲染（getByText 會先看到「無相符卡片」）
    expect(await within(dialog).findByText(/卡A/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/封存卡/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByText(/卡A/));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n1", { cardId: "c1" }));
  });

  it("已綁節點顯示卡片標題，可解綁（PUT cardId null）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) =>
      url === "/projects/p1/mindmap" ? Promise.resolve({ data: mindmapFixture }) : Promise.resolve({ data: [] }));
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "卡A" }));   // n2 已綁 c1
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/已綁定：卡A/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "解綁" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/projects/p1/mindmap/nodes/n2", { cardId: null }));
  });

  it("無編輯權限時不顯示綁定按鈕，但顯示已綁卡標題", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab(false);
    await screen.findByText("根");
    expect(screen.queryByRole("button", { name: "綁定卡片" })).not.toBeInTheDocument();
    expect(screen.getByText("卡A")).toBeInTheDocument();   // n2 已綁標題（唯讀）
  });
});

// ===== 綁定卡片完成狀態：免點開卡片即可辨識 =====

describe("MindMapTab 綁定卡片完成狀態", () => {
  it("大綱列：完成卡顯示已完成標記與刪節線，未完成卡兩者皆無", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: completedCardFixture });
    renderTab();

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getAllByText("已完成")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "卡A" }).className).toContain("line-through");
    expect(screen.getByRole("button", { name: "卡B" }).className).not.toContain("line-through");
  });

  it("唯讀檢視同樣看得到完成標記（無編輯權限也要能辨識）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: completedCardFixture });
    renderTab(false);

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    // 唯讀時卡片標題為純文字而非綁定按鈕
    expect(screen.getByText("卡A").className).toContain("line-through");
    expect(screen.getByText("卡B").className).not.toContain("line-through");
  });
});

// ===== 綁定卡片審查狀態：大綱（tree）列的落點（2026-09-18 使用者裁定）=====
// 生產預設是畫布（`MindMapTab` 的 `isTestEnv` 分支），測試環境預設則是大綱，所以這一組
// **不需要切換檢視**；畫布那一組相反，一律先 `switchToCanvas()`。
describe("MindMapTab 大綱列的審查狀態圖示", () => {
  it.each<["pending" | "approved" | "rejected", string]>([
    ["pending", "審查狀態：待審查"],
    ["approved", "審查狀態：通過"],
    ["rejected", "審查狀態：退回"],
  ])("card.reviewState=%s 時大綱列的圖示無障礙名稱是 %s", async (reviewState, label) => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue(withReviewState(reviewState));
    renderTab();
    // 落點是 n2 那一列（唯一的綁卡節點）。`within` 是必要的：不對範圍的話，把圖示插到
    // 樹根或其他列也會綠。列本身要先 await——`getByTestId` 在查詢解析前跑會直接拋。
    const row = await screen.findByTestId("mm-node-n2");
    const icon = await within(row).findByLabelText(label);
    expect(icon).toBeInTheDocument();
    // 位置的兩條閘門（`within(row)` 只釘「在這一列」，釘不住在列裡的哪裡）：
    // ① 不包在按鈕裡——進了綁卡按鈕會讓「審查狀態：退回」併進那顆按鈕的無障礙名稱；
    // ② 在卡片標題按鈕之前——即與封存／完成同一組狀態標記，不是列的尾端裝飾。
    expect(icon.closest("button")).toBeNull();
    const titleButton = within(row).getByRole("button", { name: "卡A" });
    expect(icon.compareDocumentPosition(titleButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向對照：同一棵樹裡**沒有綁卡**的那一列（n3）沒有這個圖示。
    // 不可拿 n1（根）當對照——`NodeRow` 把子孫渲染在自己的 wrapper 裡，
    // 根的那個 `data-testid` 包著整棵子樹，`queryByLabelText` 一定找得到。
    expect(within(screen.getByTestId("mm-node-n3")).queryByLabelText(/^審查狀態：/)).toBeNull();
  });

  it("card.reviewState 為 null 時大綱列不顯示審查狀態圖示", async () => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue(withReviewState(null));
    renderTab();
    await screen.findByText("卡A");
    expect(screen.queryByLabelText(/^審查狀態：/)).not.toBeInTheDocument();
  });

  it("唯讀檢視同樣看得到審查狀態圖示（無編輯權限也要能辨識）", async () => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue(withReviewState("rejected"));
    renderTab(false);
    expect(await screen.findByLabelText("審查狀態：退回")).toBeInTheDocument();
  });
});

// ===== Task 17：深連結 focusNodeId 聚焦 =====

describe("MindMapTab 深連結聚焦", () => {
  // jsdom 未實作 scrollIntoView——stub 後可斷言呼叫（ring 斷言不依賴此 stub）
  const scrollIntoViewSpy = vi.fn();
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("focusNodeId 節點渲染後 scrollIntoView 並加 ring", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab(true, "n2");
    await screen.findByText("子");
    await waitFor(() => {
      const row = screen.getByTestId("mm-node-n2");
      expect((row.firstElementChild as HTMLElement).className).toContain("ring-2 ring-ring");
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center" });
  });

  it("目標在摺疊祖先下：展開後重觸發聚焦（collapsed 於 effect deps）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    // 預先摺疊根節點 n1（localStorage 跨 session 持久化——review Important 情境）
    localStorage.setItem(`${MINDMAP_COLLAPSED_PREFIX}p1`, JSON.stringify({ n1: true }));
    renderTab(true, "n2");
    await screen.findByText("根");
    // 摺疊下 n2 未渲染，無元素可聚焦
    expect(screen.queryByTestId("mm-node-n2")).not.toBeInTheDocument();
    // 展開 n1 → effect 因 collapsed 變化重觸發 → n2 聚焦 ring
    fireEvent.click(screen.getByRole("button", { name: "展開" }));
    await waitFor(() => {
      const row = screen.getByTestId("mm-node-n2");
      expect((row.firstElementChild as HTMLElement).className).toContain("ring-2 ring-ring");
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center" });
  });
});

// 畫布模式共用：切到畫布後等到節點渲染完成（畫布對話框與審查狀態圖示兩個 describe 都用）
const switchToCanvas = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /畫布模式/ }));
  // 畫布節點渲染完成：每個可編輯節點都有 hover 操作列＋按鈕（title 屬性）
  expect((await screen.findAllByTitle("新增子節點")).length).toBeGreaterThan(0);
};

describe("MindMapTab 畫布模式（Canvas）對話框", () => {
  beforeEach(() => {
    // React Flow（畫布）於 jsdom 需 ResizeObserver；容器量測回 0 不影響節點渲染
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    // 避免 stub 洩漏至其他測試（本檔案 vitest unstubGlobals 預設關閉）
    vi.unstubAllGlobals();
  });

  it("點節點＋顯示輸入對話框，Enter 送出 POST 子節點", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.post).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await switchToCanvas();
    // 目標：根節點（標題「根」）的 hover 操作列按鈕——wrapper 為 relative group 容器
    const rootWrapper = screen.getByText("根").closest(".group") as HTMLElement;
    fireEvent.click(within(rootWrapper).getByTitle("新增子節點"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("新增子節點")).toBeInTheDocument();
    const input = within(dialog).getByPlaceholderText("新節點");
    fireEvent.change(input, { target: { value: "子A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/mindmap/nodes", { title: "子A", parentId: "n1" }));
  });

  it("工具列新增根節點於畫布模式顯示對話框", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.post).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await switchToCanvas();
    fireEvent.click(screen.getByRole("button", { name: "新增根節點" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("新增根節點")).toBeInTheDocument();
    const input = within(dialog).getByPlaceholderText("新主題");
    fireEvent.change(input, { target: { value: "根B" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "確定" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/mindmap/nodes", { title: "根B", parentId: null }));
  });

  it("點刪除顯示確認對話框，取消不呼叫 DELETE", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await switchToCanvas();
    fireEvent.click((await screen.findAllByTitle("刪除節點"))[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/刪除節點/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(api.delete).not.toHaveBeenCalled());
  });

  it("畫布模式包含連動模式開關並可切換", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await switchToCanvas();
    const cascadeCheckbox = await screen.findByLabelText("分支連動模式");
    expect(cascadeCheckbox).toBeInTheDocument();
    expect(cascadeCheckbox).not.toBeChecked();

    fireEvent.click(cascadeCheckbox);
    expect(cascadeCheckbox).toBeChecked();
    expect(localStorage.getItem(MINDMAP_CASCADE_DRAG_KEY)).toBe("true");
  });

  it("點擊一鍵整理排版自動送出最新座標至後端持久化", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    renderTab();
    await switchToCanvas();
    const autoLayoutBtn = await screen.findByTitle("一鍵智慧拓撲排版並儲存");
    fireEvent.click(autoLayoutBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith(
        "/projects/p1/mindmap/nodes/coordinates",
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "n1", x: expect.any(Number), y: expect.any(Number) }),
          ]),
        })
      );
    });
  });

  it("畫布節點的綁定卡片以無障礙名稱與刪節線標示完成", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: completedCardFixture });
    renderTab();
    await switchToCanvas();

    // 完成狀態須進得了無障礙名稱（畫布無文字徽章，僅圖示＋顏色對螢幕閱讀器不可見）
    const done = await screen.findByTitle("卡片：卡A (點擊開啟)（已完成）");
    expect(within(done).getByText("卡A").className).toContain("line-through");
    const notDone = screen.getByTitle("卡片：卡B (點擊開啟)");
    expect(within(notDone).getByText("卡B").className).not.toContain("line-through");
  });
});

// ===== 綁定卡片審查狀態：畫布節點的綁定卡片晶片 =====

describe("心智圖的審查狀態圖示（大綱列＋畫布節點）", () => {
  beforeEach(() => {
    // React Flow（畫布）於 jsdom 需 ResizeObserver；容器量測回 0 不影響節點渲染
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    // 避免 stub 洩漏至其他測試（本檔案 vitest unstubGlobals 預設關閉）
    vi.unstubAllGlobals();
  });

  it.each<["pending" | "approved" | "rejected", string]>([
    ["pending", "審查狀態：待審查"],
    ["approved", "審查狀態：通過"],
    ["rejected", "審查狀態：退回"],
  ])("card.reviewState=%s 時圖示的無障礙名稱是 %s", async (reviewState, label) => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue(withReviewState(reviewState));
    renderTab();
    // 測試環境的預設檢視是大綱（MindMapTab 的 isTestEnv 分支），而圖示的落點是
    // 畫布節點——不切到畫布就永遠找不到（實測：未加此行時實作完成仍 3 支紅）。
    await switchToCanvas();
    const icon = await screen.findByLabelText(label);
    expect(icon).toBeInTheDocument();
    // 落點是綁定卡片晶片（晶片的 tooltip 以「卡片：」開頭），不是節點的其他位置；
    // 少了這一行，把圖示插到節點別處仍全綠（實測）。
    expect(icon.closest('[title^="卡片："]')).not.toBeNull();
  });

  it("縮圖（MiniMap）的方塊依分支上色", async () => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await switchToCanvas();
    await screen.findByText("卡A");
    // 傳的是**函式**而不是固定色：固定色會讓整張縮圖退回單色，正是這次要修的樣子
    expect(typeof minimapProps.nodeColor).toBe("function");
    expect(minimapProps.nodeColor!({ data: { branchColor: "#3b82f6" } } as never)).toBe("#3b82f6");
    // 根節點是靛藍、其餘取自分支色票——與畫布節點同一個來源（`branchColor`）
    expect(minimapProps.nodeColor!({ data: { branchColor: "#6366f1" } } as never)).toBe("#6366f1");
  });

  it("card.reviewState 為 null 時不顯示審查狀態圖示", async () => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue(withReviewState(null));
    renderTab();
    // 同上一支：不切到畫布的話這支在大綱模式下恆綠，鑑別力為零
    await switchToCanvas();
    await screen.findByText("卡A");
    expect(screen.queryByLabelText(/^審查狀態：/)).not.toBeInTheDocument();
  });

  // 跨視圖一致性（本階段四個落點的最終契約）。四個視圖共用 `lib/review-badge.ts`，
  // 但**共用不是斷言**——任何一個落點自己接死字串、或接到別的 key，四道閘門都不會響
  // （它們比的是後端常數、前端 switch 與語系檔，不看呼叫端接對沒有）。
  // 心智圖（與月曆、甘特）走**無障礙名稱**：`findByLabelText` 的字串比對是精確比對，
  // 所以下面那一行同時釘住「前綴」「狀態詞」與「沒有多餘字元」。
  // 上面兩條斷言是**來源**（釘住共用的鍵與樣板），第三條是畫面、刻意寫字面值。
  // 判別力在第三條：實測（2026-09-17）只留第三條並把 zh-TW 的 rejected 譯文改壞，
  // 這支當場紅——來源那兩條的價值是失敗時直接指出契約的來源是哪一環。
  // 三支圖示視圖的斷言逐字相同——四個檔案裡的那個字面值必須一起改，否則其中一支當場紅。
  // 心智圖有**兩個**落點（2026-09-18 使用者裁定後大綱列也補上）：先釘大綱列，再切到
  // 畫布釘畫布節點——`switchToCanvas()` 之後大綱卸載，兩條各自釘住一個落點，任一被
  // 拿掉都會紅。
  it("rejected 的圖示在大綱列與畫布節點都逐字等於審查狀態：退回", async () => {
    const { api } = await import("@/lib/api");
    (api.get as Mock).mockResolvedValue(withReviewState("rejected"));
    renderTab();
    expect(i18n.t("common:state.rejected")).toBe("退回");
    expect(i18n.t("common:reviewStatus.tooltip", { status: "退回" })).toBe("審查狀態：退回");
    const row = await screen.findByTestId("mm-node-n2");
    expect(await within(row).findByLabelText("審查狀態：退回")).toBeInTheDocument();
    await switchToCanvas();
    expect(await screen.findByLabelText("審查狀態：退回")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 全螢幕浮層（2026-09-25）
//
// 修的是什麼：外框原本同時帶 `relative` 與 `fixed`（`'relative …' + (isFullscreen ?
// "fixed inset-0 …" : "…")`）。**class 的順序不決定勝負，輸出樣式表裡的規則順序才決定**
// ——Tailwind 依 `static, fixed, absolute, relative, sticky` 輸出 ⇒ `.relative` 在
// `.fixed` **之後** ⇒ 全螢幕時 computed position 是 `relative`，外框從未變成浮層，
// 只是變成一個 `100vw × 100vh` 的**流內**方塊（撐出橫向捲軸、把頁面往下推）。
//
// jsdom **不載入這個專案的 CSS**（本檔不 import index.css）⇒ 這裡驗不到「哪一條勝出」，
// 那一半只有瀏覽器量得到（ledger 的 `tmp/probe_fullscreen.cjs`：改前 computed position
// ＝ `relative`、九宮格 4/9、`horizontalOverflow: true`）。這裡守的是另一半——
// **讓那個串接有機會發生**的 class 形狀，以及 JS 那一半（Escape／滾動鎖／焦點）。
// 兩者互補：形狀是「浮層能不能成立」的前提，瀏覽器量測是「它真的成立了」的證據。
describe("MindMapCanvas 全螢幕浮層", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.overflow = "";
  });

  // 外框＝全螢幕鈕往上第一個帶 transition-all 的祖先（控制列自己沒有）；
  // 鈕用 title 查而非 accessible name——後者會隨狀態在「全螢幕」與「退出全螢幕」間改變。
  const setup = async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await switchToCanvas();
    const button = screen.getByTitle("全螢幕沉浸模式") as HTMLButtonElement;
    let wrapper = button.parentElement;
    while (wrapper && !String(wrapper.className || "").includes("transition-all")) {
      wrapper = wrapper.parentElement;
    }
    return { button, wrapper: wrapper as HTMLElement };
  };

  it("進入全螢幕時外框只帶 fixed、不帶 relative（同時帶兩者時 .relative 會勝出）", async () => {
    const { button, wrapper } = await setup();
    // 非全螢幕：靠 relative 定位內部的絕對定位控制列
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).not.toContain("fixed");

    fireEvent.click(button);

    expect(wrapper.className).toContain("fixed");
    // ★ 這一條是這個 bug 的回歸鎖：兩個都在時，瀏覽器會選 relative
    expect(wrapper.className).not.toContain("relative");
  });

  it("Escape 退出全螢幕，其他按鍵不會", async () => {
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    expect(wrapper.className).toContain("fixed");

    fireEvent.keyDown(document, { key: "a" });
    expect(wrapper.className).toContain("fixed");   // 不是「任何按鍵都退出」

    fireEvent.keyDown(document, { key: "Escape" });
    expect(wrapper.className).not.toContain("fixed");
    expect(button.getAttribute("title")).toBe("全螢幕沉浸模式");
  });

  it("全螢幕期間鎖住 body 滾動，退出後還原成原本的值（不是一律清空）", async () => {
    // 先放一個非空值：這樣「還原」與「清空」才分得開（後者會在 jsdom 下假綠）
    document.body.style.overflow = "scroll";
    const { button } = await setup();

    fireEvent.click(button);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("再點一次按鈕同樣退出，且滾動與焦點一併還原（與 Escape 是兩條路徑）", async () => {
    document.body.style.overflow = "scroll";
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    expect(wrapper.className).toContain("fixed");

    fireEvent.click(button);

    expect(wrapper.className).not.toContain("fixed");
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.activeElement).toBe(button);
  });

  it("上層浮層吃掉的那顆 Escape 不退全螢幕（第二顆才退）", async () => {
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    expect(wrapper.className).toContain("fixed");

    // fixture 造的是**實測到的**形狀（ledger 的 `tmp/probe_esc.cjs`）：Radix 的
    // `useEscapeKeydown` 掛在 document 的 **capture 階段**，它處理完會 preventDefault，
    // 而對話框的 DOM 在那個當下**已經不在了**（探針在 capture 階段量到 `dialogs: 0`）。
    // ⇒ 判別式只能是「這顆事件有沒有被處理過」，不能是「現在有沒有對話框」。
    // 這裡不開真的卡片對話框——那要連 api.get 的卡片端點一起造假，反而離題。
    const radixLike = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    document.addEventListener("keydown", radixLike, { capture: true });
    try {
      fireEvent.keyDown(document, { key: "Escape" });
      // ★ 這一條是重點：兩者都在 document 上聽同一顆按鍵 ⇒ 不擋就會一次退兩層
      expect(wrapper.className).toContain("fixed");
    } finally {
      document.removeEventListener("keydown", radixLike, { capture: true });
    }

    fireEvent.keyDown(document, { key: "Escape" });
    expect(wrapper.className).not.toContain("fixed");
  });

  it("進入時焦點移到外框、退出時回到全螢幕鈕", async () => {
    const { button, wrapper } = await setup();
    // jsdom 的 focus() 只對「可聚焦」的元素生效 ⇒ 這一條同時釘住 tabIndex={-1}，
    // 少了它 focus() 是 no-op、activeElement 會留在按鈕上
    fireEvent.click(button);
    expect(document.activeElement).toBe(wrapper);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(button);
  });

  it("全螢幕那一支帶著 !m-0（否則上緣會靜默留一條 16px 的縫）", async () => {
    // ★ 這一條守的**只是 class 形狀**，不是效果：`!m-0` 的作用（rect.top 由 16 變 0）
    //   在 jsdom 下量不到（本檔不載入 CSS）。效果那一半的證據是瀏覽器探針
    //   （ledger 的 `tmp/probe_fullscreen.cjs`：改前 `rect.top=16`／九宮格 6/9／
    //   頂部列只被蓋住 15/16）。**兩半互補，缺一不可**——少了這一條，誰把 `!m-0`
    //   刪掉都不會有紅燈，那條縫會靜默回來（複閱的 MEDIUM-2 實查：測試檔裡
    //   原本完全沒有 `m-0` 字樣）。
    const { button, wrapper } = await setup();
    expect(wrapper.className).not.toContain("!m-0");   // 非全螢幕那一支不該帶

    fireEvent.click(button);
    expect(wrapper.className).toContain("!m-0");
  });

  it("節點內嵌編輯中的 Escape 只取消編輯、不退全螢幕", async () => {
    // 這是**浮層內部**的第三條 Escape 路徑（前兩條：文件層、巢狀對話框層）。
    // 節點標題雙擊 ⇒ 內嵌 `Input`，它的 Escape 分支原本只取消編輯、**不宣告吃掉這顆按鍵**
    // ⇒ 冒泡到本檔的 document 監聽器時 `defaultPrevented` 仍是 false ⇒ 一顆 Escape 退兩層
    // （複閱以瀏覽器探針實測到，`MindMapCustomNode.tsx` 的修法見該檔註解）。
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    expect(wrapper.className).toContain("fixed");

    fireEvent.doubleClick(screen.getByText("子"));
    const editor = await screen.findByDisplayValue("子");
    fireEvent.keyDown(editor, { key: "Escape" });

    expect(screen.queryByDisplayValue("子")).toBeNull();   // 編輯取消
    expect(wrapper.className).toContain("fixed");           // 浮層還在
  });

  it("全螢幕期間卸載（切換路由）也要還原 body 滾動", async () => {
    // effect 的 cleanup 是卸載那條路徑的**唯一**守衛。少了這一支，把還原搬進
    // `exitFullscreen`（看起來等價）會讓 body 被永久鎖住——畫面看不出來、
    // 其他 44 支也都不會紅（複閱的 MEDIUM-3）。
    document.body.style.overflow = "scroll";
    const { button } = await setup();
    fireEvent.click(button);
    expect(document.body.style.overflow).toBe("hidden");

    cleanup();

    expect(document.body.style.overflow).toBe("scroll");
  });

  // ---- 焦點界線（2026-09-28）----
  // 這顆浮層是**純 div**、不是 Radix 模態 ⇒ 沒有 focus scope、沒有 `aria-modal`。
  // Chromium 探針實測（N=30、1440×900、罐頭 API）：浮層開著時按 Tab **第 71 步離開浮層**，
  // 先到 BODY，再到浮層**後面**的「畫布模式／大綱樹狀／新增根節點」；那三顆在**自己矩形
  // 中心**做 `elementFromPoint` 全部回「被蓋住」（3/3）⇒ **看不見的焦點**。
  // ★ jsdom 沒有順序焦點導覽，量不到那個現象本身；這裡釘的是**我們的處理器**
  //   （到邊界要環繞、以及兩個方向都不介入不該介入的情況），現象那一半靠上面那支探針。
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
  const focusablesIn = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("tabindex") !== "-1"
    );

  it("全螢幕時外框是 dialog（aria-modal ＋ 名稱），退出後三個屬性都拿掉", async () => {
    const { button, wrapper } = await setup();
    expect(wrapper.getAttribute("role")).toBeNull();
    expect(wrapper.getAttribute("aria-modal")).toBeNull();

    fireEvent.click(button);

    expect(wrapper.getAttribute("role")).toBe("dialog");
    expect(wrapper.getAttribute("aria-modal")).toBe("true");
    // 名稱沿用鈕的可見文字那個 key ⇒ 不新增語系鍵，也不另外寫一份名稱
    expect(wrapper.getAttribute("aria-label")).toBe("全螢幕");

    fireEvent.click(button);
    expect(wrapper.getAttribute("role")).toBeNull();
    expect(wrapper.getAttribute("aria-modal")).toBeNull();
    expect(wrapper.getAttribute("aria-label")).toBeNull();
  });

  it("全螢幕時浮層外的內容變成惰性（inert ＋ aria-hidden），退出後還原", async () => {
    // `aria-modal` 是宣告，這一條守的是它的**實作**（`lib/hide-outside.ts`）。
    // jsdom 看不到「離開無障礙樹」本身（那要瀏覽器），這裡守的是**屬性被正確地
    // 下在正確的節點上、而且還原得回來**——含「上一層也算外」與「浮層自己不算」。
    const { button, wrapper } = await setup();
    const outsideButton = screen.getByRole("button", { name: /畫布模式/ });
    expect(outsideButton.closest("[inert]")).toBeNull();

    fireEvent.click(button);

    const siblings = Array.from(wrapper.parentElement!.children).filter((el) => el !== wrapper);
    // ★ 對照組：同層沒東西可標時，下面那圈迴圈會零次通過——綠燈分不出「標對了」與
    //   「根本沒標」（本 repo 的老問題）。
    expect(siblings.length, "同層要有東西可標").toBeGreaterThan(0);
    for (const sibling of siblings) {
      expect(sibling.getAttribute("inert")).toBe("");
      expect(sibling.getAttribute("aria-hidden")).toBe("true");
    }
    // 具體那一顆（檢視切換列在**被標的子樹**裡）：走訪是逐層的，往外每一層的兄弟都算外
    expect(outsideButton.closest('[inert][aria-hidden="true"]')).not.toBeNull();
    // 浮層自己與它的祖先鏈不是「外」
    expect(wrapper.hasAttribute("inert")).toBe(false);
    expect(wrapper.parentElement!.hasAttribute("inert")).toBe(false);

    fireEvent.click(button);

    expect(outsideButton.closest("[inert]")).toBeNull();
    expect(wrapper.parentElement!.querySelector("[inert]")).toBeNull();
  });

  it("焦點在浮層內最後一顆時，Tab 環繞到第一顆（並吃掉那顆按鍵）", async () => {
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    const items = focusablesIn(wrapper);
    expect(items.length).toBeGreaterThan(1);
    const first = items[0];
    const last = items[items.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);

    const ev = createEvent.keyDown(document, { key: "Tab" });
    fireEvent(document, ev);

    expect(document.activeElement).toBe(first);
    // 沒吃掉的話瀏覽器會自己再往下走一格 ⇒ 回到浮層外
    expect(ev.defaultPrevented).toBe(true);
  });

  it("焦點在浮層內第一顆時，Shift+Tab 環繞到最後一顆", async () => {
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    const items = focusablesIn(wrapper);
    const first = items[0];
    const last = items[items.length - 1];
    first.focus();

    const ev = createEvent.keyDown(document, { key: "Tab", shiftKey: true });
    fireEvent(document, ev);

    expect(document.activeElement).toBe(last);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("焦點在外框本身時（進入後的原狀），Tab 到第一顆、Shift+Tab 到最後一顆", async () => {
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    expect(document.activeElement).toBe(wrapper); // 進入時焦點就在外框上
    const items = focusablesIn(wrapper);
    const first = items[0];
    const last = items[items.length - 1];

    const fwd = createEvent.keyDown(document, { key: "Tab" });
    fireEvent(document, fwd);
    expect(document.activeElement).toBe(first);
    expect(fwd.defaultPrevented).toBe(true);

    wrapper.focus();
    const back = createEvent.keyDown(document, { key: "Tab", shiftKey: true });
    fireEvent(document, back);
    expect(document.activeElement).toBe(last);
    expect(back.defaultPrevented).toBe(true);
  });

  it("反向對照：沒開浮層時 Tab 不受影響（不介入、也不搬焦點）", async () => {
    const { wrapper } = await setup();
    const items = focusablesIn(wrapper);
    const last = items[items.length - 1];
    last.focus();

    const ev = createEvent.keyDown(document, { key: "Tab" });
    fireEvent(document, ev);

    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("上層已經吃掉那顆 Tab 時不介入（與上面那顆 Escape 同一條判別式）", async () => {
    // 形狀照「上層浮層吃掉的那顆 Escape」那一支：用 capture 階段的監聽器模擬
    // Radix 的 focus scope。少了這一支，把頂端的 `defaultPrevented` 拿掉不會有紅燈
    // ——而它正是「浮層裡的對話框自己處理 Tab」時的唯一分界。
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    const items = focusablesIn(wrapper);
    const first = items[0];
    const last = items[items.length - 1];
    last.focus();

    const radixLike = (e: KeyboardEvent) => {
      if (e.key === "Tab") e.preventDefault();
    };
    document.addEventListener("keydown", radixLike, { capture: true });
    try {
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(last); // 環繞沒有發生
    } finally {
      document.removeEventListener("keydown", radixLike, { capture: true });
    }

    // 對照：沒有那顆攔截時，同一顆 Tab 是會環繞的（證明上面那一格不是恆真）
    first.focus();
    const ev = createEvent.keyDown(document, { key: "Tab", shiftKey: true });
    fireEvent(document, ev);
    expect(document.activeElement).toBe(last);
  });

  it("焦點在浮層外時不介入（Radix 抽屜是 portal 到 body，不歸這顆浮層管）", async () => {
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    // ★ fixture 換過（2026-09-28，第十一批）：原本拿「畫布模式」鈕當浮層外的元素，
    //   而背景惰性化之後那顆**已經帶著 `inert` 與 `aria-hidden`**（`getByRole` 預設
    //   看不到它）——它不再是「可聚焦的外」，拿它驗等於在驗一個瀏覽器裡不存在的狀態
    //   （`inert` 元素的 `focus()` 是 no-op）。這裡改成**標題自己講的那個形狀**：
    //   body 的子節點、不在容器裡（與 Radix 的 portal 同一個位置關係）。
    const outside = document.createElement("button");
    outside.textContent = "portal 探針";
    document.body.append(outside);
    try {
      expect(wrapper.contains(outside)).toBe(false);
      outside.focus();
      expect(document.activeElement).toBe(outside);

      const ev = createEvent.keyDown(document, { key: "Tab" });
      fireEvent(document, ev);

      expect(ev.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('浮層末尾的 tabindex="-1" 不算停留點（否則環繞會送上一顆不是 Tab 停留點的元素）', async () => {
    // 那把尺排除 `tabindex="-1"` 是**契約**（第九批：一個節點對 Tab 只有一個停留點，
    // 操作列那 4 顆靠 `→` 進入）。真實浮層裡嚴格尺與放寬尺的端點**恰好相同**（探針
    // 實測：70 vs 189 顆，first／last 逐字是同一個元素）——但那是**這個樹形的性質，
    // 不是契約**：控制列或工具列的順序一換，`last` 就會落到一顆 `-1` 上，而環繞會把
    // 焦點送到那裡（下一次 Tab 從一個不是停留點的地方出發）。
    // ⇒ 把那個形狀造出來，否則「把尺放寬」這個突變不會有紅燈（實測：全綠）。
    const { button, wrapper } = await setup();
    fireEvent.click(button);
    const items = focusablesIn(wrapper);
    const first = items[0];
    const last = items[items.length - 1];

    const injected = document.createElement("button");
    injected.setAttribute("tabindex", "-1");
    injected.textContent = "末尾注入";
    wrapper.appendChild(injected);

    last.focus();
    const ev = createEvent.keyDown(document, { key: "Tab" });
    fireEvent(document, ev);

    // 環繞的目標仍是那把尺的第一顆，不是末尾那顆 `-1`
    expect(document.activeElement).toBe(first);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// 卡片庫抽屜的靜默截斷（與 TableTab、GanttTab、CalendarTab 同型）。抽屜只載入固定筆數
// （上限見 `ProjectCardEndpoints`）而沒有分頁 UI ⇒ 專案超過那個筆數時，抽屜讀起來像
// 「專案就這些卡」，搜尋不到時更像「沒有這張卡」而不是「它不在載入的那一段裡」。
//
// **兩支成對，判別力在第二支**：只寫「截斷時要顯示」的話，「無條件顯示」也照樣綠。
// 畫布模式在測試環境不是預設（`MindMapTab` 依 `isTestEnv` 選樹狀），故先切上去；
// 這個 describe 是那些畫布 describe 的**兄弟**，繼承不到它們的 ResizeObserver stub。
describe("MindMapTab 卡片庫抽屜的截斷提示", () => {
  const loaded = 1;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 標題刻意不叫「卡A」——`mindmapFixture` 的 n2 就綁著那張卡，畫布上也有同一個字串，
  // 用它會變成多重命中而拋錯（不是斷言失敗，是測試本身壞掉）。
  // `api` 在本檔是**逐測試動態 import**（頂端只 mock 模組），所以這裡也照做。
  const mockDrawer = async (total: number) => {
    const { api } = await import("@/lib/api");
    const items = [{ id: "c9", title: "抽屜卡", boardName: "看板", listName: "待辦", completedAt: null }];
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.includes("/cards?pageSize=")) return Promise.resolve({ data: { items, total } });
      return Promise.resolve({ data: mindmapFixture });
    });
  };

  const openDrawer = async () => {
    await switchToCanvas();
    fireEvent.click(await screen.findByRole("button", { name: /卡片庫/ }));
    await screen.findByPlaceholderText("搜尋看板卡片…");
  };

  it("total 大於已載入筆數時，提示同時印出總數與已載入筆數", async () => {
    await mockDrawer(loaded + 598);
    renderTab();
    await openDrawer();

    expect(await screen.findByText("共 599 筆，僅載入前 1 筆")).toBeInTheDocument();
  });

  it("total 等於已載入筆數時不顯示提示", async () => {
    await mockDrawer(loaded);
    renderTab();
    await openDrawer();

    // 先等抽屜內容真的渲染出來——少了這一步，「找不到提示」可能只是抽屜還沒開好
    expect(await screen.findByText("抽屜卡")).toBeInTheDocument();
    expect(screen.queryByText(/僅載入前/)).not.toBeInTheDocument();
  });
});

// ── 每節點 Tab 停留點收斂（2026-09-27）──────────────────────────────────────
// 尺與 TableTab 的 composite grid 同一把（a[href], button, input, select, textarea,
// [tabindex]，去掉 tabindex="-1" 與 disabled），但**根元素本身也算**——那一個停留點就是它。
//
// 兩個檢視的「那一個停留點」都不是我們的原始碼，別在這裡找 tabIndex：
//   畫布 = React Flow 的 NodeWrapper（`nodesFocusable` 預設 true，@xyflow/react :3337）
//   大綱 = @dnd-kit useDraggable 的 attributes（tabIndex = 0，@dnd-kit/core :3404）
const TABBABLE_SEL = 'a[href], button, input, select, textarea, [tabindex]';
const isTabbable = (el: HTMLElement) =>
  el.matches(TABBABLE_SEL) && el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("disabled");
const tabbableIn = (root: HTMLElement) =>
  [root, ...Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SEL))].filter(isTabbable);

describe("心智圖的每節點 Tab 停留點收斂（2026-09-27）", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const canvasNodes = () => Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node"));
  const outlineRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-outline-row]"));

  // 大綱的尺**不能只量列的子樹**：備註 `<Input>` 在列 div 之外（`:253` 的 `</div>` 之後、
  // 與子節點列同層）⇒ 只量子樹會看不到它，得到「每列 1 個」的假結論。這裡數的是
  // 「落在任何 `mm-node-` 容器裡」的停留點——列本身、列內控制項、備註欄一網打盡。
  const outlineStops = () =>
    Array.from(document.querySelectorAll<HTMLElement>(TABBABLE_SEL))
      .filter(isTabbable)
      .filter((el) => el.closest('[data-testid^="mm-node-"]') !== null);

  async function toCanvas() {
    fireEvent.click(await screen.findByRole("button", { name: /畫布模式/ }));
    await waitFor(() => expect(canvasNodes().length).toBeGreaterThan(0));
  }
  const canvasNodeOf = (text: string) => screen.getByText(text).closest<HTMLElement>(".react-flow__node")!;
  const outlineRowOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-outline-row]")!;
  const widgetsOf = (root: HTMLElement, attr: string) =>
    Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`));

  async function renderCanvas(canEdit = true) {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab(canEdit);
    await toCanvas();
  }

  it("畫布：可編輯時每個節點只剩一個 Tab 停留點，而那一個就是節點本身", async () => {
    await renderCanvas();

    const stops = canvasNodes().map(tabbableIn);
    expect(stops.map((g) => g.length)).toEqual([1, 1, 1]);
    expect(stops.every((g) => g[0]!.classList.contains("react-flow__node"))).toBe(true);

    // 整張畫布＝3 個節點 ＋ **5 個常數**（React Flow 控制列 4：Zoom In／Out／Fit View／
    // Toggle Interactivity，＋ attribution 連結 1，授權要求）——常數刻意不動。
    expect(tabbableIn(document.querySelector<HTMLElement>(".react-flow")!).length).toBe(3 + 5);
  });

  it("畫布：唯讀時每個節點也是一個停留點（回歸——唯讀本來就沒有操作列）", async () => {
    await renderCanvas(false);

    expect(canvasNodes().map((n) => tabbableIn(n).length)).toEqual([1, 1, 1]);
  });

  it("畫布：→ 從節點進操作列，列內 ←／→ 移動，第一顆 ← 回到節點", async () => {
    await renderCanvas();

    const node = canvasNodeOf("子");
    const widgets = widgetsOf(node, "data-node-widget");
    expect(widgets.length).toBe(4);

    node.focus();
    fireEvent.keyDown(node, { key: "ArrowRight" });
    expect(document.activeElement).toBe(widgets[0]);

    fireEvent.keyDown(widgets[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(widgets[1]);

    fireEvent.keyDown(widgets[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(widgets[0]);

    fireEvent.keyDown(widgets[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(node);
  });

  it("畫布：defaultPrevented 時不搶方向鍵（已選取的節點，方向鍵屬於 React Flow）", async () => {
    await renderCanvas();

    const node = canvasNodeOf("子");
    node.focus();
    // 在容器 capture 階段先 preventDefault：模擬 React Flow 已經處理掉這顆鍵
    // （它移動已選取的節點時就是這樣做的，@xyflow/react :2317-2330）
    // 型別參數不是裝飾：`Element` 的事件表只有 fullscreen 那兩個，`keydown` 在
    // `HTMLElementEventMap`（＝`ElementEventMap` ＋ `GlobalEventHandlersEventMap`）裡
    // ⇒ 少了它，`addEventListener("keydown", …)` 兩個重載都不合，`tsc -b` exit 2
    // 而 vitest 照樣全綠（2026-09-27 實測，這是那道閘門存在的理由）。
    const rf = document.querySelector<HTMLElement>(".react-flow")!;
    const kill = (e: KeyboardEvent) => e.preventDefault();
    rf.addEventListener("keydown", kill, true);
    fireEvent.keyDown(node, { key: "ArrowRight" });
    rf.removeEventListener("keydown", kill, true);

    expect(document.activeElement).toBe(node);
  });

  it("大綱：可編輯時整棵樹只剩每列一個 Tab 停留點（列本身）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");

    expect(outlineRows().length).toBe(3);
    expect(outlineStops().map((el) => el.getAttribute("data-outline-row"))).toEqual(["n1", "n2", "n3"]);
  });

  it("大綱：唯讀時也是每列一個", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab(false);
    await screen.findByText("根");

    expect(outlineStops().map((el) => el.getAttribute("data-outline-row"))).toEqual(["n1", "n2", "n3"]);
  });

  it("大綱：→ 進列內控制項、← 回到列", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");

    const row = outlineRowOf("根");
    const widgets = widgetsOf(row, "data-row-widget");
    expect(widgets.length).toBeGreaterThan(0);

    row.focus();
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(document.activeElement).toBe(widgets[0]);

    fireEvent.keyDown(widgets[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(widgets[1]);

    fireEvent.keyDown(widgets[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row);
  });

  it("大綱：在列上按 → 不會改名、也不會刪除（這一版是純加法）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.put).mockResolvedValue({ data: mindmapFixture });
    vi.mocked(api.delete).mockResolvedValue({ data: mindmapFixture });
    renderTab();
    await screen.findByText("根");

    const row = outlineRowOf("根");
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowRight" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  // 操作列的 `stopPropagation()` 是**必要的**，不是保險——這一支是它的守門員。
  // React Flow 的節點層處理器（`@xyflow/react/dist/esm/index.js:2312-2327`）在
  // 「已選取 ＋ isDraggable ＋ 方向鍵」時 `preventDefault()` 並搬動節點，而它**不檢查
  // `defaultPrevented`** ⇒ 少了 stopPropagation，使用者在操作列裡按 `→` 會一邊移動焦點、
  // 一邊把整張卡片推走。★ 這裡**必須先選取節點**：未選取時那條分支不成立，突變看不到
  // （2026-09-27 突變 M4 實測：拿掉 stopPropagation 時，本檔其餘 8 支全綠、只有這支紅）。
  it("畫布：在操作列裡按 → 不會被 React Flow 當成「搬動已選取的節點」", async () => {
    await renderCanvas();

    const node = canvasNodeOf("子");
    fireEvent.click(node); // 選取：React Flow 只在**已選取**的節點上搬方向鍵
    node.focus(); // jsdom 的 click 不搬焦點，要明著來
    const atRest = node.style.transform;

    // 對照組（沒有它，下面的斷言分不出「stopPropagation 擋住了」與「React Flow 根本沒動」）
    fireEvent.keyDown(node, { key: "ArrowRight" });
    const movedByFlow = node.style.transform;
    expect(movedByFlow).not.toBe(atRest);
    // 而這一按也不該把焦點吸進操作列——React Flow 先認領了那顆鍵（`defaultPrevented` 契約）
    expect(document.activeElement).toBe(node);

    const widgets = widgetsOf(node, "data-node-widget");
    widgets[0]!.focus();
    fireEvent.keyDown(widgets[0]!, { key: "ArrowRight" });

    expect(document.activeElement).toBe(widgets[1]); // 列內移動照常
    expect(node.style.transform).toBe(movedByFlow); // 但節點沒有被推走
  });
});
