import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GanttTab, type ProjectCardItem } from "./GanttTab";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import type { Mock } from "vitest";

const makeWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

const mockCards = {
  items: [
    {
      id: "c1",
      title: "API 端點開發",
      boardId: "b1",
      boardName: "後端看板",
      listId: "l1",
      listName: "進行中",
      dueAt: new Date().toISOString(),
      isOverdue: false,
      isArchived: false,
      assignees: [{ userId: "u1", username: "alice", displayName: "Alice" }],
      labelNames: ["後端"],
      estimatedHours: 8,
      loggedHours: 4,
      checklistProgress: { total: 4, completed: 2 },
      reviewState: null,
    },
    {
      id: "c2",
      title: "無截止日待辦任務",
      boardId: "b1",
      boardName: "後端看板",
      listId: "l2",
      listName: "待辦",
      dueAt: null,
      isOverdue: false,
      isArchived: false,
      assignees: [],
      labelNames: [],
      estimatedHours: null,
      loggedHours: 0,
      checklistProgress: { total: 0, completed: 0 },
      reviewState: null,
    },
  ],
  total: 2,
};

describe("GanttTab", () => {
  beforeEach(() => {
    (api.get as Mock).mockResolvedValue({ data: mockCards });
  });

  it("renders_gantt_view_modes_and_controls", async () => {
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("日檢視")).toBeInTheDocument();
      expect(screen.getByText("週檢視")).toBeInTheDocument();
      expect(screen.getByText("月檢視")).toBeInTheDocument();
      expect(screen.getByText("今天")).toBeInTheDocument();
    });
  });

  it("renders_scheduled_cards_and_task_bars", async () => {
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByText("API 端點開發").length).toBeGreaterThan(0);
      expect(screen.getByText("50%")).toBeInTheDocument();
      // 8.0 小時：P-B0 殘餘收尾後工時一律走 format.ts 的 formatHours()，
      // 不再是硬編碼的 `8h`（B2-4 的 ItemDetailsTab 工時摘要已先走同一條路）。
      expect(screen.getByText("8.0 小時")).toBeInTheDocument();
    });
  });

  it("renders_unscheduled_cards_section", async () => {
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/無截止日任務待排程/)).toBeInTheDocument();
      expect(screen.getByText("無截止日待辦任務")).toBeInTheDocument();
    });
  });

  it("switches_view_mode_to_week", async () => {
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByText("週檢視"));
    fireEvent.click(screen.getByText("週檢視"));
    expect(screen.getByText("週檢視")).toBeInTheDocument();
  });
});

// ===== P18：開工時間（startAt）甘特圖渲染 =====
describe("GanttTab startAt rendering", () => {
  // 以本地午夜建基準日期，與元件 baseDate（today-5）同日對齊。
  // 註：台灣無 DST，日差必為整數；DST 地區此數學會偏移 dayWidth（此 repo 僅本地使用）。
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  };

  const makeCard = (overrides: Partial<ProjectCardItem>) => ({
    id: "c1",
    title: "有開工日任務",
    boardId: "b1",
    boardName: "後端看板",
    listId: "l1",
    listName: "進行中",
    startAt: null,
    dueAt: null,
    isOverdue: false,
    isArchived: false,
    assignees: [],
    labelNames: [],
    estimatedHours: null,
    loggedHours: 0,
    checklistProgress: { total: 0, completed: 0 },
    reviewState: null,
    ...overrides,
  });

  // 時程區卡片長條（inline style 帶 left）——左側任務列沒有 inline left
  const findBar = (title: string): HTMLElement => {
    const span = screen.getAllByText(title).find((s) => s.closest('button[style*="left"]'));
    if (!span) throw new Error(`未找到時程長條：${title}`);
    return span.closest('button[style*="left"]') as HTMLElement;
  };

  beforeEach(() => {
    (api.get as Mock).mockResolvedValue({ data: { items: [], total: 0 } });
  });

  it("renders_real_span_from_startAt_to_dueAt", async () => {
    // 跨度取 5 天（非 3 天）：舊假造「截止前 3 天」實作會畫出 132px，此斷言可分辨兩者
    (api.get as Mock).mockResolvedValue({
      data: { items: [makeCard({ startAt: day(1), dueAt: day(5) })], total: 1 },
    });
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getAllByText("有開工日任務").length).toBeGreaterThan(0));
    // baseDate=today-5、dayWidth=44：startDiff=6 → left=264；width=(10-6+1)*44=220
    expect(findBar("有開工日任務")).toHaveStyle({ left: "264px", width: "220px" });
  });

  it("renders_single_day_marker_without_startAt", async () => {
    (api.get as Mock).mockResolvedValue({
      data: { items: [makeCard({ dueAt: day(0) })], total: 1 },
    });
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getAllByText("有開工日任務").length).toBeGreaterThan(0));
    // dueDiff=5 → left=220；width=44*0.8=35.2（單日標記，非多日假跨度）
    expect(findBar("有開工日任務")).toHaveStyle({ left: "220px", width: "35.2px" });
  });

  it("keeps_startAt_only_card_in_unscheduled", async () => {
    (api.get as Mock).mockResolvedValue({
      data: { items: [makeCard({ startAt: day(1), dueAt: null })], total: 1 },
    });
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText(/無截止日任務待排程/)).toBeInTheDocument());
    expect(screen.getByText("有開工日任務")).toBeInTheDocument();
  });
});

describe("GanttTab 的審查狀態圖示", () => {
  const withReviewState = (reviewState: ProjectCardItem["reviewState"]) => ({
    data: { items: [{ ...mockCards.items[0], reviewState }], total: 1 },
  });

  // 左側任務列的容器：`卡片標題` 表頭（唯一）的祖先，class 帶 `w-36`。
  // 正面斷言靠它限定範圍——**只寫「不在長條裡」是不夠的**：那個否定式也成立於
  // 「根本沒渲染在這一側」與「放到第三個位置」（2026-09-17 殘餘點名的失敗模式）。
  const leftColumn = (): HTMLElement => screen.getByText("卡片標題").closest(".w-36") as HTMLElement;

  it.each<["pending" | "approved" | "rejected", string]>([
    ["pending", "審查狀態：待審查"],
    ["approved", "審查狀態：通過"],
    ["rejected", "審查狀態：退回"],
  ])("reviewState=%s 時左側列圖示的無障礙名稱是 %s", async (reviewState, label) => {
    (api.get as Mock).mockResolvedValue(withReviewState(reviewState));
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    const icon = await screen.findByLabelText(label);
    expect(icon).toBeInTheDocument();
    // 正面：圖示在**左側列的那一列按鈕**裡面（那一列按鈕在左側列的容器內）。
    const row = within(leftColumn()).getByText("API 端點開發").closest("button") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.contains(icon)).toBe(true);
    // 落點是左側清單列，不是時間軸長條——長條的最小寬度只有 dayWidth * 0.8
    // （月檢視 12 * 0.8 = 9.6px），塞進去的徽章會溢出。`button[style*="left"]`
    // 是本檔既有的長條判別式（見上面的 findBar）：與上面那條正面斷言一個釘
    // 「在左側列那一列裡」、一個釘「不在長條裡」，兩個落點都釘死。
    expect(icon.closest('button[style*="left"]')).toBeNull();
  });

  it("reviewState 為 null 時不顯示審查狀態圖示", async () => {
    (api.get as Mock).mockResolvedValue(withReviewState(null));
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    await screen.findAllByText("API 端點開發");
    expect(screen.queryByLabelText(/^審查狀態：/)).not.toBeInTheDocument();
  });

  // 跨視圖一致性（本階段四個落點的最終契約）。四個視圖共用 `lib/review-badge.ts`，
  // 但**共用不是斷言**——任何一個落點自己接死字串、或接到別的 key，四道閘門都不會響
  // （它們比的是後端常數、前端 switch 與語系檔，不看呼叫端接對沒有）。
  // 甘特（與月曆、心智圖）走**無障礙名稱**：`findByLabelText` 的字串比對是精確比對，
  // 所以下面那一行同時釘住「前綴」「狀態詞」與「沒有多餘字元」。
  // 上面兩條斷言是**來源**（釘住共用的鍵與樣板），第三條是畫面、刻意寫字面值。
  // 判別力在第三條：實測（2026-09-17）只留第三條並把 zh-TW 的 rejected 譯文改壞，
  // 這支當場紅——來源那兩條的價值是失敗時直接指出契約的來源是哪一環。
  // 三支圖示視圖的斷言逐字相同——四個檔案裡的那個字面值必須一起改，否則其中一支當場紅。
  it("rejected 的圖示無障礙名稱逐字等於審查狀態：退回", async () => {
    (api.get as Mock).mockResolvedValue(withReviewState("rejected"));
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });
    expect(i18n.t("common:state.rejected")).toBe("退回");
    expect(i18n.t("common:reviewStatus.tooltip", { status: "退回" })).toBe("審查狀態：退回");
    expect(await screen.findByLabelText("審查狀態：退回")).toBeInTheDocument();
  });
});

// 靜默截斷的回歸測試（與 TableTab、CalendarTab 同型）。甘特圖的查詢 pageSize 上限是 500
// （`ProjectCardEndpoints` 硬擋 >500）而沒有分頁 UI ⇒ 超過 500 張的專案只拿得到前 500 張，
// 畫面卻讀起來像「這個專案就這些卡」。修掉之前只有表格那一邊有提示。
//
// **兩支成對，判別力在第二支**：只寫「截斷時要顯示」的話，「無條件顯示」也照樣綠。
// 這個 describe 是上面那些的**兄弟**，繼承不到它們的 beforeEach ⇒ 每一支都自己設定 mock。
describe("GanttTab 的截斷提示", () => {
  const loaded = mockCards.items.length;

  it("total 大於已載入筆數時，提示同時印出總數與已載入筆數", async () => {
    (api.get as Mock).mockResolvedValue({ data: { ...mockCards, total: loaded + 598 } });
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    expect(
      await screen.findByText(`共 ${loaded + 598} 筆，僅載入前 ${loaded} 筆`)
    ).toBeInTheDocument();
  });

  it("total 等於已載入筆數時不顯示提示", async () => {
    (api.get as Mock).mockResolvedValue({ data: mockCards });
    render(<GanttTab projectId="p1" canEdit={false} />, { wrapper: makeWrapper() });

    // 先等一個**資料相依**的內容渲染出來——少了這一步，「找不到提示」可能只是還沒載入
    expect(await screen.findByText("8.0 小時")).toBeInTheDocument();
    expect(screen.queryByText(/僅載入前/)).not.toBeInTheDocument();
  });
});
