import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkCalendarTab } from "./WorkCalendarTab";
import { useAuth } from "@/stores/auth";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("WorkCalendarTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "王小明", isAdmin: true },
      tokens: null,
      teamId: "t1",
    });
  });

  it("列出例外日，假日與補班日各有自己的標籤", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: [
        { date: "2026-10-05", kind: "Holiday", name: "國慶日" },
        { date: "2026-10-10", kind: "Workday", name: "補班" },
      ],
    });

    render(<WorkCalendarTab teamId="t1" />, { wrapper });

    expect(await screen.findByText("國慶日")).toBeInTheDocument();
    expect(screen.getByText("放假日")).toBeInTheDocument();
    expect(screen.getByText("補班日")).toBeInTheDocument();
  });

  it("沒有例外日時顯示空狀態", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });

    render(<WorkCalendarTab teamId="t1" />, { wrapper });

    expect(await screen.findByText("這一年沒有任何例外日")).toBeInTheDocument();
  });

  it("查詢失敗時顯示載入失敗", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("boom"));

    render(<WorkCalendarTab teamId="t1" />, { wrapper });

    await waitFor(() => expect(screen.getByText("載入失敗")).toBeInTheDocument());
  });

  it("標籤綁在列上：Holiday 的列是放假日、Workday 的列是補班日", async () => {
    // 上一支只斷「兩個標籤各出現過一次」——ternary 反過來時畫面仍各出現一次，那種
    // 顯示錯誤的實作照樣全綠。這一支把標籤綁回它所屬的列。
    vi.mocked(api.get).mockResolvedValue({
      data: [
        { date: "2026-10-05", kind: "Holiday", name: "國慶日" },
        { date: "2026-10-10", kind: "Workday", name: "補班" },
      ],
    });

    render(<WorkCalendarTab teamId="t1" />, { wrapper });

    const holidayRow = (await screen.findByText("國慶日")).closest("tr")!;
    const workdayRow = screen.getByText("補班").closest("tr")!;

    expect(within(holidayRow).getByText("放假日")).toBeInTheDocument();
    expect(within(holidayRow).queryByText("補班日")).not.toBeInTheDocument();
    expect(within(workdayRow).getByText("補班日")).toBeInTheDocument();
    expect(within(workdayRow).queryByText("放假日")).not.toBeInTheDocument();
  });

  it("切換年份會以新的年度區間重查", async () => {
    // 年度區間是這一頁唯一的重讀來源。少了這一支，把 from/to 寫死、或讓 year 不進
    // 查詢，全部測試仍綠——切年就會變成一個只換畫面上數字、不換資料的假動作。
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    const year = new Date().getFullYear();

    render(<WorkCalendarTab teamId="t1" />, { wrapper });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        `/teams/t1/work-calendar?from=${year}-01-01&to=${year}-12-31`,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: String(year - 1) }));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        `/teams/t1/work-calendar?from=${year - 1}-01-01&to=${year - 1}-12-31`,
      ),
    );
  });

  it("中間的年度是「目前選中」的那一個：有自己的框與底色，而且不是按鈕", async () => {
    // 兩旁是 outline 按鈕、中間原本是裸 span ⇒ 中間看起來像凹下去（2026-10-06 使用者回報）。
    // 這一支把「中間要有自己的視覺重量」釘住：裸 span 只有 text-sm font-medium。
    // 同時釘住它不是按鈕——它是目前選中的值（唯讀），做成按鈕等於給出按得動的假承諾。
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    const year = new Date().getFullYear();

    render(<WorkCalendarTab teamId="t1" />, { wrapper });

    const current = await screen.findByText(String(year));
    expect(current).toHaveClass("bg-secondary", "border-input");
    expect(screen.queryByRole("button", { name: String(year) })).not.toBeInTheDocument();
  });
});

describe("WorkCalendarTab 寫入入口的權限閘", () => {
  // admin 走旁路、不查權限清單，這兩支測的是權限本身 ⇒ isAdmin 必須是 false。
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "王小明", isAdmin: false },
      tokens: null,
      teamId: "t1",
    });
  });

  it("有 team.workcalendar.manage 時看得到新增入口", async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.includes("/teams/my-permissions")
        ? { data: [{ teamId: "t1", codes: ["team.read", "team.workcalendar.manage"] }] }
        : { data: [] });
    render(<WorkCalendarTab teamId="t1" />, { wrapper });
    expect(await screen.findByRole("button", { name: "新增例外日" })).toBeInTheDocument();
  });

  it("只有 team.read 時看不到新增入口", async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.includes("/teams/my-permissions")
        ? { data: [{ teamId: "t1", codes: ["team.read"] }] }
        : { data: [] });
    render(<WorkCalendarTab teamId="t1" />, { wrapper });
    await screen.findByText("這一年沒有任何例外日");
    // 先確認權限查詢真的跑完，否則「按鈕不在」可能只是它還沒回來（TeamMembersTab 同一寫法）。
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/teams/my-permissions"));
    expect(screen.queryByRole("button", { name: "新增例外日" })).not.toBeInTheDocument();
  });
});
