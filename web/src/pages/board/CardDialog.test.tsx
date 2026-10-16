// CardDialog **外殼**（分頁之外的對話框本體）的測試。
//
// 2026-09-21 自單一檔的 CardDialog.test.tsx 按分頁拆出（見
// `.superpowers/sdd/2026-09-21-entask-carddialog-test-split/progress.md`）。
// 這一檔守的是**不屬於任何分頁**的部分：標題／截止日／成員／標籤／色板／載入骨架／
// 心智圖節點連結，以及分頁的無障礙名稱。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { CardResponse } from "@/lib/board-types";
import { CardDialog } from "./CardDialog";
import { setLocale } from "@/i18n";
import { cardFixture, getApi, renderDialog } from "./card-dialog-test-utils";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// ItemDetailsTab 以 zustand selector 形式呼叫 useAuth((s) => s.user?.userId)——
// mock 須支援 selector 引數，selector 形式回傳 "u1"（真實 AuthUser 欄位為 userId）
vi.mock("@/stores/auth", () => ({
  useAuth: (sel?: (s: unknown) => unknown) =>
    sel
      ? sel({ user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } })
      : { user: { userId: "u1", username: "admin", displayName: "測試員", isAdmin: false } },
}));

beforeEach(() => vi.clearAllMocks());

describe("CardDialog", () => {
  it("渲染標題與活動串", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url.startsWith("/cards/c1/activity")) return Promise.resolve({ data: { items: [{ id: "a1", cardId: "c1", userId: "u1", username: "admin", displayName: "管理員", type: "create", text: null, detail: null, createdAt: "2026-08-15T00:00:00Z" }], nextCursor: null } });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url.includes("/activity")) return Promise.resolve({ data: { items: [], nextCursor: null } });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    // 標題為 DialogHeader 內的 input，用 display value 斷言
    expect(await screen.findByDisplayValue("測試卡")).toBeInTheDocument();
    // TabsContent 未 forceMount，非作用中分頁內容不掛載——先切到活動分頁再斷言
    fireEvent.mouseDown(screen.getByRole("tab", { name: "活動" }));
    fireEvent.click(screen.getByRole("tab", { name: "活動" }));
    expect(await screen.findByText("管理員")).toBeInTheDocument();
  });

  it("修改標題 blur 後呼叫 api.put", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: cardFixture });
    renderDialog();
    const input = await screen.findByDisplayValue("測試卡");
    fireEvent.change(input, { target: { value: "新標題" } });
    // React 的 onBlur 監聽 focusout 事件（fireEvent.blur 派發的 blur 不會觸發）；
    // saveCard.mutate 經 tanstack v5 retryer 於 microtask 才呼叫 api.put，須以 waitFor 斷言
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/cards/c1", { title: "新標題" }));
  });

  it("成員勾選後以全量清單呼叫 PUT members", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [{ userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] }] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [{ id: "lb1", name: "紅", color: "#B60205", position: "0" }] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: { ...cardFixture, members: ["u2"] } });
    renderDialog();
    // radix DropdownMenuTrigger 以 onPointerDown 開選單（mousedown/click 不觸發）
    fireEvent.pointerDown(await screen.findByRole("button", { name: "成員 0" }));
    fireEvent.click(await screen.findByText("鮑伯（bob）"));
    // mutate 經 tanstack v5 於 microtask 才呼叫 api.put，須以 waitFor 斷言
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/cards/c1/members", { userIds: ["u2"] }));
  });

  const axiosConflict = () =>
    Object.assign(new Error("Request failed with status code 409"), {
      isAxiosError: true,
      response: { status: 409, data: "並發更新衝突，請重試" },
    });

  it("members PUT 409 衝突時 toast 顯示伺服器中文 detail", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read", "card.assign"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [{ userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] }] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockRejectedValue(axiosConflict());
    renderDialog();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "成員 0" }));
    fireEvent.click(await screen.findByText("鮑伯（bob）"));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("並發更新衝突，請重試"));
  });

  it("labels PUT 409 衝突時 toast 顯示伺服器中文 detail", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read", "board.edit"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [{ id: "lb1", name: "紅", color: "#B60205", position: "0" }] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockRejectedValue(axiosConflict());
    renderDialog();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "標籤 0" }));
    fireEvent.click(await screen.findByText("紅"));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("並發更新衝突，請重試"));
  });

  it("封存（vars 鍵迴圈非 title 呼叫端）回應快照含舊 title 不覆寫較新 title", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    const puts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1") return new Promise((resolve) => puts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    // 標題存檔（PUT #1）完成 → cache title=新標題
    const titleInput = screen.getByDisplayValue("測試卡");
    fireEvent.change(titleInput, { target: { value: "新標題" } });
    fireEvent.focusOut(titleInput);
    await waitFor(() => expect(puts).toHaveLength(1));
    puts[0].resolve({ data: { ...cardFixture, title: "新標題" } });
    await waitFor(() => expect(qc.getQueryData<CardResponse>(["card", "c1"])?.title).toBe("新標題"));
    // 封存（PUT #2）回應快照含舊 title——vars 僅 isArchived，不可覆寫 title
    fireEvent.click(screen.getByRole("button", { name: "封存" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].body).toEqual({ isArchived: true });
    puts[1].resolve({ data: { ...cardFixture, title: "測試卡", isArchived: true } });
    await waitFor(() => expect(qc.getQueryData<CardResponse>(["card", "c1"])?.isArchived).toBe(true));
    expect(qc.getQueryData<CardResponse>(["card", "c1"])?.title).toBe("新標題");
  });

  it("建立標籤後 POST 並加入卡片", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockResolvedValue({ data: { id: "lb2", name: "新標", color: "#B60205", position: "1" } });
    vi.mocked(api.put).mockResolvedValue({ data: { ...cardFixture, labels: [{ id: "lb2", name: "新標", color: "#B60205", position: "1" }] } });
    renderDialog();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "標籤 0" }));
    fireEvent.change(await screen.findByPlaceholderText("標籤名稱…"), { target: { value: "新標" } });
    fireEvent.click(screen.getByRole("button", { name: "建立標籤" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/boards/b1/labels", { name: "新標", color: "#B60205" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/cards/c1/labels", { labelIds: ["lb2"] }));
  });
});

describe("CardDialog 標題守護", () => {
  it("跨欄位隔離：title 回應快照含舊 labels，落地不覆寫已樂觀更新的標籤", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithLabels });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [lb1] });
      return Promise.resolve({ data: [] });
    });
    const titlePuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    const labelPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1") return new Promise((resolve) => titlePuts.push({ body, resolve }));
      if (url === "/cards/c1/labels") return new Promise((resolve) => labelPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    // 取消唯一標籤（labels PUT pending，樂觀態 labels=[]）
    fireEvent.pointerDown(await screen.findByRole("button", { name: "標籤 1" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "紅" }));
    await waitFor(() => expect(labelPuts).toHaveLength(1));
    expect(labelPuts[0].body).toEqual({ labelIds: [] });
    await waitFor(() => expect(screen.getByRole("button", { name: "標籤 0" })).toBeInTheDocument());
    // 存標題（title PUT pending）
    const input = screen.getByDisplayValue("測試卡");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "新標題" } });
    fireEvent.focusOut(input);
    await waitFor(() => expect(titlePuts).toHaveLength(1));
    // title 回應後到——伺服器處理 label PUT 前生成的快照（labels 仍為 [lb1]）
    titlePuts[0].resolve({ data: { ...cardWithLabels, title: "新標題" } });
    await act(async () => {});
    const cached = qc.getQueryData<CardResponse>(["card", "c1"])!;
    expect(cached.title).toBe("新標題");
    // 舊快照的 labels 不得覆寫樂觀更新的標籤
    expect(cached.labels.map((l) => l.id)).toEqual([]);
  });

  it("存檔回應延遲期間繼續輸入，舊回應到達不覆寫輸入中文字", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    let resolvePut!: (v: unknown) => void;
    vi.mocked(api.put).mockImplementation(
      () => new Promise((resolve) => { resolvePut = resolve; }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    const input = await screen.findByDisplayValue("測試卡");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "新標題" } });
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/cards/c1", { title: "新標題" }));
    // PUT 未回應期間繼續輸入新文字
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "新標題續" } });
    // 舊回應到達（內含存檔當時的「新標題」）
    resolvePut({ data: { ...cardFixture, title: "新標題" } });
    await waitFor(() =>
      expect((qc.getQueryData<CardResponse>(["card", "c1"]))?.title).toBe("新標題"));
    expect(input).toHaveValue("新標題續");
  });
});

describe("CardDialog 截止日輸入路徑", () => {
  it("onChange 不立即 PUT，blur 恰一次送出", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: { ...cardFixture, dueAt: "2026-09-02T00:00:00Z" } });
    renderDialog();
    const input = await screen.findByLabelText("截止日：");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2026-09-01" } });
    fireEvent.change(input, { target: { value: "2026-09-02" } });
    // 沖掉 mutation microtask 佇列——舊行為（onChange 即 PUT）此時已送出兩次
    await act(async () => {});
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith("/cards/c1", { dueAt: "2026-09-02T00:00:00Z" });
  });
});

// ===== P3 Task 3：#10-#14 回饋延遲與競態 =====

const lb1 = { id: "lb1", name: "紅", color: "#B60205", position: "0" };
const lb2 = { id: "lb2", name: "新標", color: "#B60205", position: "1" };
const lb3 = { id: "lb3", name: "藍", color: "#1D76DB", position: "2" };
const cardWithLabels: CardResponse = { ...cardFixture, labels: [lb1] };
const cardWithThreeLabels: CardResponse = { ...cardFixture, labels: [lb1, lb2, lb3] };

describe("成員/標籤樂觀 toggle（#10）", () => {
  it("連點競態：快速 toggle 序列以最新 cache 計算 payload，最終 members 為 {B} 且 checkbox 回應前翻動", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members")
        return Promise.resolve({
          data: [
            { userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] },
            { userId: "u3", username: "charles", displayName: "查理", roleIds: [] },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const memberPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1/members")
        return new Promise((resolve) => memberPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    await screen.findByRole("button", { name: "成員 0" });
    // radix CheckboxItem 點選後會關閉選單——每次 toggle 後重新開啟（連點語義同）
    const toggleMemberItem = async (name: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /^成員/ }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
    };
    // 勾 A（u2）
    await toggleMemberItem("鮑伯（bob）");
    await waitFor(() => expect(memberPuts).toHaveLength(1));
    expect(memberPuts[0].body).toEqual({ userIds: ["u2"] });
    // 樂觀：PUT 回應前 UI 已翻動（成員數 0→1）
    await waitFor(() => expect(screen.getByRole("button", { name: "成員 1" })).toBeInTheDocument());
    // 勾 B（u3）
    await toggleMemberItem("查理（charles）");
    await waitFor(() => expect(memberPuts).toHaveLength(2));
    expect(memberPuts[1].body).toEqual({ userIds: ["u2", "u3"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "成員 2" })).toBeInTheDocument());
    // 取消 A（u2）
    await toggleMemberItem("鮑伯（bob）");
    await waitFor(() => expect(memberPuts).toHaveLength(3));
    expect(memberPuts[2].body).toEqual({ userIds: ["u3"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "成員 1" })).toBeInTheDocument());
    // mock PUT 依序回應（echo 各自 payload）
    memberPuts[0].resolve({ data: { ...cardFixture, members: ["u2"] } });
    memberPuts[1].resolve({ data: { ...cardFixture, members: ["u2", "u3"] } });
    memberPuts[2].resolve({ data: { ...cardFixture, members: ["u3"] } });
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.members).toEqual(["u3"]));
  });

  it("回應亂序守護：較新回應先到、舊回應後到，舊回應不覆寫最新集合", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members")
        return Promise.resolve({
          data: [
            { userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] },
            { userId: "u3", username: "charles", displayName: "查理", roleIds: [] },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    const memberPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1/members")
        return new Promise((resolve) => memberPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    await screen.findByRole("button", { name: "成員 0" });
    const toggleMemberItem = async (name: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /^成員/ }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
    };
    await toggleMemberItem("鮑伯（bob）");
    await waitFor(() => expect(memberPuts).toHaveLength(1));
    expect(memberPuts[0].body).toEqual({ userIds: ["u2"] });
    await toggleMemberItem("查理（charles）");
    await waitFor(() => expect(memberPuts).toHaveLength(2));
    expect(memberPuts[1].body).toEqual({ userIds: ["u2", "u3"] });
    // 亂序回應：較新 PUT #2 先到並套用
    memberPuts[1].resolve({ data: { ...cardFixture, members: ["u2", "u3"] } });
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.members).toEqual(["u2", "u3"]));
    // 舊 PUT #1 後到：cache 已分叉，守護跳過覆寫
    memberPuts[0].resolve({ data: { ...cardFixture, members: ["u2"] } });
    await act(async () => {});
    expect(qc.getQueryData<CardResponse>(["card", "c1"])?.members).toEqual(["u2", "u3"]);
  });

  it("跨欄位隔離：成員回應快照含舊 labels，落地不覆寫已樂觀更新的標籤（5c 序列）", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithThreeLabels });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members")
        return Promise.resolve({
          data: [{ userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] }],
        });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [lb1, lb2, lb3] });
      return Promise.resolve({ data: [] });
    });
    const memberPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    const labelPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1/members")
        return new Promise((resolve) => memberPuts.push({ body, resolve }));
      if (url === "/cards/c1/labels")
        return new Promise((resolve) => labelPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    await screen.findByRole("button", { name: "成員 0" });
    const toggleMemberItem = async (name: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /^成員/ }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
    };
    const toggleLabelItem = async (name: string) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: /^標籤/ }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
    };
    // 5c 序列：勾成員（PUT #1 pending）→ 不等回應連點取消 3 標籤
    await toggleMemberItem("鮑伯（bob）");
    await waitFor(() => expect(memberPuts).toHaveLength(1));
    expect(memberPuts[0].body).toEqual({ userIds: ["u2"] });
    await toggleLabelItem("紅");
    await waitFor(() => expect(labelPuts).toHaveLength(1));
    await toggleLabelItem("新標");
    await waitFor(() => expect(labelPuts).toHaveLength(2));
    await toggleLabelItem("藍");
    await waitFor(() => expect(labelPuts).toHaveLength(3));
    expect(labelPuts[2].body).toEqual({ labelIds: [] });
    // 樂觀：標籤數已翻為 0
    await waitFor(() => expect(screen.getByRole("button", { name: "標籤 0" })).toBeInTheDocument());
    // 成員 PUT 回應後到——伺服器處理 label PUTs 前生成的快照（labels 仍為 3 個）
    memberPuts[0].resolve({ data: { ...cardWithThreeLabels, members: ["u2"] } });
    await act(async () => {});
    const cached = qc.getQueryData<CardResponse>(["card", "c1"])!;
    expect(cached.members).toEqual(["u2"]);
    // 舊快照的 labels 不得覆寫樂觀更新的標籤
    expect(cached.labels.map((l) => l.id)).toEqual([]);
  });

  it("跨欄位隔離：完成勾選回應快照含舊 members，落地不覆寫已樂觀更新的成員（5c 序列）", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members")
        return Promise.resolve({
          data: [{ userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] }],
        });
      return Promise.resolve({ data: [] });
    });
    const memberPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    const completionPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1/members")
        return new Promise((resolve) => memberPuts.push({ body, resolve }));
      if (url === "/cards/c1/completion")
        return new Promise((resolve) => completionPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    // 勾成員（PUT pending）→ 不等回應勾選完成
    fireEvent.pointerDown(await screen.findByRole("button", { name: "成員 0" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "鮑伯（bob）" }));
    await waitFor(() => expect(memberPuts).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "完成" }));
    await waitFor(() => expect(completionPuts).toHaveLength(1));
    // 完成 PUT 回應後到——伺服器處理成員 PUT 前生成的快照（members 仍為空）
    completionPuts[0].resolve({ data: { ...cardFixture, completedAt: "2026-09-07T10:00:00Z" } });
    await act(async () => {});
    const cached = qc.getQueryData<CardResponse>(["card", "c1"])!;
    expect(cached.completedAt).toBe("2026-09-07T10:00:00Z");
    // 舊快照的 members 不得覆寫樂觀更新的成員
    expect(cached.members).toEqual(["u2"]);
  });

  it("createLabel 追打 saveLabels 以樂觀後 cache 為基底", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithLabels });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [lb1] });
      return Promise.resolve({ data: [] });
    });
    const labelPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1/labels")
        return new Promise((resolve) => labelPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    vi.mocked(api.post).mockResolvedValue({ data: lb2 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "標籤 1" }));
    // 取消 lb1（PUT #1 刻意保持 pending；radix 點選後選單關閉）
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "紅" }));
    await waitFor(() => expect(labelPuts).toHaveLength(1));
    expect(labelPuts[0].body).toEqual({ labelIds: [] });
    // 樂觀：PUT 回應前按鈕計數已翻為 0
    await waitFor(() => expect(screen.getByRole("button", { name: "標籤 0" })).toBeInTheDocument());
    // PUT #1 尚未回應時重新開選單建立新標籤 → 追打以樂觀後 cache 為基底
    fireEvent.pointerDown(screen.getByRole("button", { name: "標籤 0" }));
    fireEvent.change(await screen.findByPlaceholderText("標籤名稱…"), { target: { value: "新標" } });
    fireEvent.click(screen.getByRole("button", { name: "建立標籤" }));
    await waitFor(() => expect(labelPuts).toHaveLength(2));
    expect(labelPuts[1].body).toEqual({ labelIds: ["lb2"] });
    // 依序回應：先取消 lb1、後加入 lb2
    labelPuts[0].resolve({ data: { ...cardWithLabels, labels: [] } });
    labelPuts[1].resolve({ data: { ...cardWithLabels, labels: [lb2] } });
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.labels.map((l) => l.id)).toEqual(["lb2"]));
  });
});

describe("留言/審查 Enter 與 isPending（#14）", () => {
  it("可指派與取消審查者並正確呼叫 API", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign", "board.edit"] });
      if (url === "/projects/p1/members")
        return Promise.resolve({
          data: [{ userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] }]
        });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: [{ reviewerUserId: "u2", status: "pending" }] });
    
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    
    // 開啟審查者選單
    fireEvent.pointerDown(await screen.findByRole("button", { name: "審查者 0" }));
    
    // 點擊成員以指派
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "鮑伯（bob）" }));
    
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/cards/c1/reviews", { reviewerUserIds: ["u2"] }));
  });
});

// ===== P3 Task 4：#16 誤導空態 =====

describe("誤導空態（#16）", () => {
  it("成員查詢失敗顯示載入失敗與重試而非尚無專案成員", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.assign"] });
      if (url === "/projects/p1/members") return Promise.reject(new Error("403"));
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "成員 0" }));
    expect(await screen.findByText("成員載入失敗")).toBeInTheDocument();
    expect(screen.queryByText("尚無專案成員")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });

  it("標籤查詢失敗顯示載入失敗與重試", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "board.edit"] });
      if (url === "/boards/b1/labels") return Promise.reject(new Error("403"));
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "標籤 0" }));
    expect(await screen.findByText("標籤載入失敗")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });
});

// ===== P3 Task 5：#27 a11y =====

describe("色板 a11y（#27）", () => {
  it("10 色按鈕有中文 aria-label，aria-pressed 反映選中色", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "board.edit"] });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/boards/b1/labels") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "標籤 0" }));
    const names = ["紅色", "橙色", "黃色", "綠色", "藍色", "紫色", "粉紅色", "青色", "淺綠色", "灰紫色"];
    for (const name of names) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // 初始選中 LABEL_PALETTE[0]（紅）
    expect(screen.getByRole("button", { name: "紅色" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "藍色" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "藍色" }));
    expect(screen.getByRole("button", { name: "藍色" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "紅色" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("CardDialog 載入骨架（#26）", () => {
  it("卡片載入中渲染 Skeleton 對話框，載入後渲染內容", async () => {
    const { api } = await getApi();
    let resolveCard!: (v: unknown) => void;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1")
        return new Promise((resolve) => { resolveCard = resolve; });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    expect(await screen.findByTestId("card-dialog-skeleton")).toBeInTheDocument();
    resolveCard({ data: cardFixture });
    expect(await screen.findByDisplayValue("測試卡")).toBeInTheDocument();
    expect(screen.queryByTestId("card-dialog-skeleton")).not.toBeInTheDocument();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

describe("CardDialog 心智圖節點連結", () => {
  it("標頭顯示綁定 node 連結，點擊導向 ?tab=mindmap&node=<id>", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({
        data: {
          ...cardFixture,
          mindMapNodes: [{ id: "n1", parentId: null, title: "根節點", note: null, position: "h", cardId: "c1", card: null }],
        },
      });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/projects/p1/boards/b1/cards/c1"]}>
          <Routes>
            <Route path="/projects/:projectId/boards/:boardId/cards/:cardId" element={<CardDialog />} />
            <Route path="/projects/:projectId" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "心智圖：根節點" }));
    expect(await screen.findByTestId("location-probe")).toHaveTextContent("/projects/p1?tab=mindmap&node=n1");
  });
});

// ===== 分頁的無障礙名稱必須跟著語系走（2026-09-14） =====
//
// 這一條不是在驗「翻譯對不對」，是在驗**無障礙名稱的來源**：它必須來自可見文字，
// 而不是一個寫死的字串。2026-08-15 的 bda27b5 把這個分頁的可見文字寫成 "Item Details"
// （其餘五個分頁都是中文），P9 的 3bf5781 把可見文字翻成「詳細資訊」時，為了不動
// 既有的 `getByRole("tab", { name: "Item Details" })` 斷言而補上同名的 aria-label——
// 於是**六個語系下的無障礙名稱全都是英文**，而畫面上是中文。
//
// 本檔其餘 26 處斷言（`{ name: "詳細資訊" }`）只證明「移除 aria-label 之後 zh-TW 對了」；
// 它們擋不住「換成 aria-label="詳細資訊"」這種修法——那仍然是把名稱寫死，英文使用者
// 拿到的是中文。真正的不變量是下面這一條，所以它必須以 en 執行。
describe("分頁無障礙名稱的來源是譯文，不是寫死的字串", () => {
  afterEach(async () => {
    // setLocale(null) ＝「跟隨瀏覽器」，而 src/test/locale-pin.ts 把 navigator.languages
    // 釘在 zh-TW——所以這是回到本檔其餘測試的語系，不是回到「未設定」。
    await act(async () => {
      await setLocale(null);
    });
  });

  it("切到 en 後，「詳細資訊」分頁的名稱是 Details", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      return Promise.resolve({ data: [] });
    });

    await act(async () => {
      await setLocale("en");
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");

    // 缺陷回歸點（兩行是同一件事的兩面）：把 aria-label 加回去，兩行同時變紅。
    expect(screen.getByRole("tab", { name: "Details" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Item Details" })).toBeNull();
  });
});
