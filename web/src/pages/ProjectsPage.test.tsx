import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ProjectsPage } from "./ProjectsPage";
import { localTimeZoneId } from "@/lib/local-day";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
// usePermissions 以 selector 形式讀 teamId（useAuth((s) => s.teamId)）
vi.mock("@/stores/auth", () => ({
  useAuth: (sel?: (s: { user: unknown; teamId: string | null }) => unknown) =>
    sel
      ? sel({ user: { displayName: "測試員" }, teamId: "t1" })
      : { user: { displayName: "測試員" }, teamId: "t1" },
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("列出我的專案", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      data: [{ id: "p1", teamId: "t1", name: "測試專案", description: null, memberCount: 1, boardCount: 0, createdAt: "2026-08-15T00:00:00Z" }],
    });
    renderPage();
    expect(await screen.findByText("測試專案")).toBeInTheDocument();
  });

  it("有 project.create 權限時顯示建立專案按鈕", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects") return Promise.resolve({ data: [] });
      if (url === "/permissions/mine?teamId=t1")
        return Promise.resolve({ data: ["project.read", "project.create"] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByRole("button", { name: "建立專案" })).toBeInTheDocument();
  });

  it("無 project.create 權限時隱藏建立專案按鈕", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects") return Promise.resolve({ data: [] });
      if (url === "/permissions/mine?teamId=t1")
        return Promise.resolve({ data: ["project.read"] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    // 等權限查詢完成（不因載入中而誤判隱藏）
    await waitFor(() =>
      expect(vi.mocked(api.get)).toHaveBeenCalledWith("/permissions/mine?teamId=t1"),
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "建立專案" })).not.toBeInTheDocument();
  });

  it("載入中渲染 Skeleton（#26），載入後消失", async () => {
    const { api } = await import("@/lib/api");
    let resolveProjects!: (v: unknown) => void;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects")
        return new Promise((resolve) => { resolveProjects = resolve; });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByTestId("projects-skeleton")).toBeInTheDocument();
    resolveProjects({ data: [] });
    await waitFor(() =>
      expect(screen.queryByTestId("projects-skeleton")).not.toBeInTheDocument());
  });

  it("一般工程師（無 team.read）在無專案時顯示指派提示且無切換團隊按鈕", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects") return Promise.resolve({ data: [] });
      if (url === "/teams/my-permissions")
        return Promise.resolve({ data: [{ teamId: "t1", codes: ["card.read", "card.edit"] }] });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(await screen.findByText("尚無任何專案")).toBeInTheDocument();
    expect(
      screen.getByText("您目前尚未加入任何專案。請聯絡專案管理員或團隊經理為您指派專案與工作任務。")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "選擇 / 切換團隊" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "前往選擇 / 建立團隊" })).not.toBeInTheDocument();
  });

  // T7 的五個寫入站點之一（`POST /projects`）：`timeZoneId` 是發起人時區，後端用它凍結
  // 建立者的到職本地日。這一站在本批之前沒有任何斷言看得到——本檔原有五支碰的是列表、
  // 按鈕與 Skeleton，沒有一支有 body 斷言 ⇒ 所以 body 的三個成分一起釘：`name`、
  // `timeZoneId`、以及團隊標頭（都是這一支的契約）。
  it("建立專案時 body 帶發起人時區與團隊標頭", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects") return Promise.resolve({ data: [] });
      if (url === "/permissions/mine?teamId=t1")
        return Promise.resolve({ data: ["project.read", "project.create"] });
      if (url === "/teams") return Promise.resolve({ data: [{ id: "t1", name: "核心團隊" }] });
      if (url === "/teams/my-permissions")
        return Promise.resolve({ data: [{ teamId: "t1", codes: ["project.create"] }] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockResolvedValue({ data: { id: "p9", teamId: "t1", name: "新專案" } });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "建立專案" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("專案名稱"), { target: { value: "新專案" } });
    // Radix Select：點 trigger（role=combobox）開啟 popup，再點 option（同 CustomFieldsTab.test.tsx）
    fireEvent.click(within(dialog).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "核心團隊" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "建立" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/projects",
        { name: "新專案", timeZoneId: localTimeZoneId() },
        { headers: { "X-Team-Id": "t1" } },
      ),
    );
  });
});
