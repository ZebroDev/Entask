import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TeamActivityTab } from "./TeamActivityTab";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TeamActivityTab teamId="t1" />
    </QueryClientProvider>
  );
}

function mockLogs(rows: unknown[]) {
  vi.mocked(api.get).mockResolvedValue({ data: { items: rows, nextCursor: null } });
}

const row = (action: string, entityTitle: string) => ({
  id: action,
  action,
  entityType: "team",
  entityTitle,
  createdAt: "2026-09-14T00:00:00Z",
});

describe("TeamActivityTab", () => {
  beforeEach(() => vi.clearAllMocks());

  // 這一支是這張表的**存在理由**：B2-6a 之前畫面印的是 `team.created：核心研發團隊`，
  // 而 `tsc`、全部 zh-TW 測試與 parity 都不會紅——少一條 case 的症狀只有眼睛看得到。
  it("把後端動作識別碼翻成譯文，不原樣印出", async () => {
    mockLogs([row("team.created", "核心研發團隊")]);
    renderTab();

    expect(await screen.findByText("已建立團隊：核心研發團隊")).toBeInTheDocument();
    expect(screen.queryByText(/team\.created/)).toBeNull();
  });

  it("每一條動作都有自己的譯文（抽查三個不同實體）", async () => {
    mockLogs([
      row("board.created", "Sprint 3"),
      row("card.deleted", "修好登入"),
      row("project.member.removed", "王小明"),
    ]);
    renderTab();

    expect(await screen.findByText("已建立看板：Sprint 3")).toBeInTheDocument();
    expect(screen.getByText("已刪除卡片：修好登入")).toBeInTheDocument();
    expect(screen.getByText("已移除專案成員：王小明")).toBeInTheDocument();
  });

  // 認不得的動作**原樣顯示**（與 CardActivityTab 的 typeLabel 同一個判準）：看得出來
  // 比猜一個標籤好。這一支同時釘住「default 不是靜默回傳某個既有標籤」。
  it("認不得的動作原樣顯示，而不是假裝成別種動作", async () => {
    mockLogs([row("team.archived", "核心研發團隊")]);
    renderTab();

    expect(await screen.findByText("team.archived：核心研發團隊")).toBeInTheDocument();
  });

  it("沒有紀錄時顯示空狀態", async () => {
    mockLogs([]);
    renderTab();

    expect(await screen.findByText("尚無活動紀錄")).toBeInTheDocument();
  });

  // actor 是**列左側的另一個節點**（R8）：後端 Task 1 在 DTO 上加了 `userDisplayName`，
  // 這一支釘住它真的被畫出來。少了這支斷言，「actor 兩邊都顯示」這條裁定會靜默只做一半
  // ——actor 節點忘了加、或加了卻被併進既有那一串，全批照樣綠。
  it("顯示操作者的顯示名稱，與既有那一串動作標籤並存", async () => {
    mockLogs([{ ...row("team.created", "核心研發團隊"), userDisplayName: "王小明" }]);
    renderTab();

    const actor = await screen.findByText("王小明");
    expect(screen.getByText("已建立團隊：核心研發團隊")).toBeInTheDocument();
    // 文字流的**分界**：兩個節點之間要有一個空白。`gap-2` 只有視覺效果、DOM 裡看不
    // 到，所以只能驗父節點的 `textContent`。那個空白是 **DOM 文字流的分界、不是無障
    // 礙樹的分界**（2026-10-10 瀏覽器探針：有它沒它，`innerText` 都是換行、AX 樹都是
    // 兩個獨立 `StaticText` ⇒ 它從來沒進過無障礙樹；探針量的是 Chrome 的 AX 樹、不
    // 是 NVDA 的語音）。en 讀起來是 `<顯示名稱> Team created: …`（本 fixture 的動作是
    // `team.created`；`en/team.json:40` ＝ `"Team created"`、`:44` ＝ `"User created"`、
    // 分隔符 `en/common.json:159` ＝ `": "`）。
    expect(actor.parentElement!.textContent).toContain("王小明 已建立團隊：核心研發團隊");
  });

  // fallback：`userDisplayName` 為 null（或整欄缺席）時退回語系值，不是空字串——
  // 空字串會讓列左側看起來像「本來就沒有這個欄位」。
  it("沒有操作者名稱時顯示未知使用者", async () => {
    mockLogs([row("team.created", "核心研發團隊")]);
    renderTab();

    expect(await screen.findByText("未知使用者")).toBeInTheDocument();
  });

  // ★ 這一支是「截斷看得見」的守門員：少了它，「永遠顯示載入更多」這種退化
  //   在畫面上與正確實作長得一模一樣（按鈕在不在，只有 hasNextPage 分得開）。
  it("沒有下一頁時不渲染『載入更多』", async () => {
    mockLogs([row("team.created", "核心研發團隊")]);
    renderTab();

    await screen.findByText("已建立團隊：核心研發團隊");
    expect(screen.queryByRole("button", { name: "載入更多" })).toBeNull();
  });

  it("有下一頁時渲染『載入更多』，按下後帶著 cursor 打第二趟並把列接在後面", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({
        data: { items: [row("team.created", "核心研發團隊")], nextCursor: "2026-01-01T00:00:00.0000000Z|abc" },
      })
      .mockResolvedValueOnce({
        data: { items: [row("board.created", "Sprint 3")], nextCursor: null },
      });
    renderTab();

    await screen.findByText("已建立團隊：核心研發團隊");
    const more = screen.getByRole("button", { name: "載入更多" });
    fireEvent.click(more);

    expect(await screen.findByText("已建立看板：Sprint 3")).toBeInTheDocument();
    // 第一頁的列還在（合併是 flatMap，不是取代）
    expect(screen.getByText("已建立團隊：核心研發團隊")).toBeInTheDocument();
    // 第二趟的 URL 帶著**編碼過**的 cursor（`:`、`|`、`Z` 都是 URL 特殊字元，見 Review Focus 3）
    expect(vi.mocked(api.get).mock.calls[1][0]).toBe(
      "/audit-logs?teamId=t1&cursor=2026-01-01T00%3A00%3A00.0000000Z%7Cabc"
    );
    // 到底了 ⇒ 按鈕消失
    expect(screen.queryByRole("button", { name: "載入更多" })).toBeNull();
  });
});
