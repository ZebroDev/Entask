// 「詳細資訊」分頁（`ItemDetailsTab`）的測試。
//
// 2026-09-21 自單一檔的 CardDialog.test.tsx 按分頁拆出（見
// `.superpowers/sdd/2026-09-21-entask-carddialog-test-split/progress.md`）。
// 自訂欄位、工時、審查表單（預填／退回禁用分數／意見必填）、審查狀態徽章、審查歷程
// 都掛在這個分頁上，所以都在這裡。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { CardResponse, ReviewEntryResponse } from "@/lib/board-types";
import { setLocale } from "@/i18n";
import { localTimeZoneId } from "@/lib/local-day";
import { axios400 } from "@/test/http-errors";
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

const textField = { id: "f1", scopeType: "project", scopeId: "p1", name: "文字欄", type: "text", options: null, position: "a" };
const numberField = { id: "f2", scopeType: "project", scopeId: "p1", name: "數字欄", type: "number", options: null, position: "b" };

async function renderDetailsTab(options: { card?: CardResponse; permissions?: string[]; reviewHistory?: ReviewEntryResponse[]; reviewHistoryError?: boolean } = {}) {
  const { api } = await import("@/lib/api");
  // 狀態化 mock：自訂欄位 PUT 後，整卡 refetch 回傳已儲存值（模擬伺服器真值）
  const savedFields: Record<string, unknown> = {};
  const permissions = options.permissions ?? ["card.edit", "card.read"];
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/cards/c1")
      return Promise.resolve({
        data: {
          ...(options.card ?? cardFixture),
          customFields: Object.entries(savedFields).map(([fieldDefinitionId, value]) => ({ fieldDefinitionId, value })),
        },
      });
    if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: permissions });
    if (url === "/projects/p1/custom-fields") return Promise.resolve({ data: [textField, numberField] });
    // 審查歷程回的是**裸陣列**（不是 `{items, nextCursor}`）。沒指定時是空陣列，
    // 與下面的 fallthrough 同值——寫出來是為了讓「這裡有一支查詢」看得見。
    // `reviewHistoryError` 是失敗態的開關（queryClient 的 retry 已關，會直接落到 error 態）。
    if (url === "/cards/c1/review-history")
      return options.reviewHistoryError
        ? Promise.reject(new Error("500"))
        : Promise.resolve({ data: options.reviewHistory ?? [] });
    return Promise.resolve({ data: [] });
  });
  vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
    if (url === "/cards/c1/custom-fields") Object.assign(savedFields, body);
    // #25：PUT 回傳 CardResponse（模擬伺服器真值：合併後 customFields 回映）
    return Promise.resolve({
      data: {
        ...cardFixture,
        customFields: Object.entries(savedFields).map(([fieldDefinitionId, value]) => ({ fieldDefinitionId, value })),
      },
    });
  });
  renderDialog();
  await screen.findByDisplayValue("測試卡");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
  fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
  return api;
}

describe("ItemDetailsTab 自訂欄位輸入路徑", () => {
  it("text 欄位逐字輸入不觸發 PUT，blur 恰一次送出最終值且輸入不被回寫", async () => {
    const api = await renderDetailsTab();
    const input = await screen.findByLabelText("文字欄");
    for (const value of ["h", "he", "hel", "hell", "hello"]) {
      fireEvent.change(input, { target: { value } });
    }
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith("/cards/c1/custom-fields", { f1: "hello" });
    await waitFor(() => expect(screen.getByLabelText("文字欄")).toHaveValue("hello"));
  });

  it("IME 組字中 Enter 不觸發提交，組字結束後 Enter 恰一次送出", async () => {
    const api = await renderDetailsTab();
    const input = await screen.findByLabelText("文字欄");
    // 真實 focus：Enter 以 blur() 委派送出，需 activeElement 使 blur() 生效
    input.focus();
    fireEvent.change(input, { target: { value: "你好" } });
    // jsdom 的 KeyboardEvent 建構式不帶 isComposing，以 defineProperty 模擬組字中
    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(imeEnter, "isComposing", { value: true });
    fireEvent(input, imeEnter);
    // 沖掉 mutation microtask 佇列——舊行為（無 IME 守護）此時已送出 PUT
    await act(async () => {});
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith("/cards/c1/custom-fields", { f1: "你好" });
  });

  it("number 欄位同型：輸入中不 PUT，blur 送出數值", async () => {
    const api = await renderDetailsTab();
    const input = await screen.findByLabelText("數字欄");
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.change(input, { target: { value: "42" } });
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith("/cards/c1/custom-fields", { f2: 42 });
  });
});

const cardWithReview: CardResponse = {
  ...cardFixture,
  reviews: [
    { id: "r1", reviewerUserId: "u1", reviewerUsername: "admin", reviewerDisplayName: "管理員", status: "pending", score: null, comment: null, updatedAt: "2026-08-15T00:00:00Z" },
  ],
};

describe("留言/審查 Enter 與 isPending（#14）", () => {
  // 2026-10-14 起提交多了一步確認視窗，這支測試的守門位置跟著換：
  // 真正打 API 的是**確認鈕**，而它一按下去 Radix 就把視窗關掉、同時把底下整個
  // 卡片對話框標成 `aria-hidden`——這就是 `hidden: true` 的來源（不是為了繞過斷言，
  // 是那個按鈕此刻真的不在無障礙樹上）。
  it("提交期間底下那顆提交鈕停用（#14 的 pending 守門）", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardWithReview });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.review"] });
      return Promise.resolve({ data: [] });
    });
    let resolvePut!: (v: unknown) => void;
    vi.mocked(api.put).mockImplementation(
      () => new Promise((resolve) => { resolvePut = resolve; }),
    );
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(await screen.findByRole("button", { name: "提交" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "確認送出" }));
    // in-flight：視窗已關，而底下的提交鈕停用 ⇒ 使用者打不開第二次確認視窗
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提交", hidden: true })).toBeDisabled());
    resolvePut({ data: {} });
    // 回應落地後恢復可用——這一條同時證明 modal 真的關了（按鈕回到無障礙樹上）
    await waitFor(() => expect(screen.getByRole("button", { name: "提交" })).toBeEnabled());
  });
});

const memberField = { id: "f3", scopeType: "project", scopeId: "p1", name: "成員欄", type: "member", options: null, position: "c" };

describe("誤導空態（#16）", () => {
  it("自訂欄位查詢失敗顯示載入失敗與重試而非尚無自訂欄位", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields") return Promise.reject(new Error("403"));
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    expect(await screen.findByText("自訂欄位載入失敗")).toBeInTheDocument();
    expect(screen.queryByText("尚無自訂欄位")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });

  it("成員查詢失敗時 member 型欄位顯示載入失敗與重試", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields")
        return Promise.resolve({ data: [memberField] });
      if (url === "/projects/p1/members") return Promise.reject(new Error("403"));
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    expect(await screen.findByText("成員載入失敗")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument();
  });
});

describe("進度條 a11y（#27）", () => {
  it("ItemDetailsTab 工時進度條 role=progressbar＋aria-valuenow", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });
});

// ===== P3 Task 6：#25 mutation 回傳 patch cache、R10 權限停用 affordance、#26 skeleton =====

describe("mutation 回傳 patch card cache（#25）", () => {
  it("自訂欄位存檔後以 PUT 回應 patch card cache——不 invalidate card、不重取整卡", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields") return Promise.resolve({ data: [textField] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({
      data: { ...cardFixture, customFields: [{ fieldDefinitionId: "f1", value: "hello" }] },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    const input = await screen.findByLabelText("文字欄");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.focusOut(input);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/cards/c1/custom-fields", { f1: "hello" }));
    // PUT 回應（CardResponse）patch 進 card cache
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.customFields)
        .toEqual([{ fieldDefinitionId: "f1", value: "hello" }]));
    // 無 card invalidate → 無整卡 refetch（GET /cards/c1 僅初始一次）
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["card", "c1"] }));
    expect(vi.mocked(api.get).mock.calls.filter(([u]) => u === "/cards/c1")).toHaveLength(1);
  });

  it("回應亂序守護：較新欄位值樂觀在途時舊回應不覆寫", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields")
        return Promise.resolve({ data: [textField, numberField] });
      return Promise.resolve({ data: [] });
    });
    const fieldPuts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1/custom-fields")
        return new Promise((resolve) => fieldPuts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    // 存 f1=hello（PUT #1 在途）
    const text = await screen.findByLabelText("文字欄");
    fireEvent.change(text, { target: { value: "hello" } });
    fireEvent.focusOut(text);
    await waitFor(() => expect(fieldPuts).toHaveLength(1));
    // 存 f2=42（PUT #2 在途，樂觀 patch 已含 f1、f2）
    const num = await screen.findByLabelText("數字欄");
    fireEvent.change(num, { target: { value: "42" } });
    fireEvent.focusOut(num);
    await waitFor(() => expect(fieldPuts).toHaveLength(2));
    // 較新回應 #2 先到
    fieldPuts[1].resolve({ data: { ...cardFixture, customFields: [
      { fieldDefinitionId: "f1", value: "hello" }, { fieldDefinitionId: "f2", value: 42 }] } });
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.customFields)
        .toEqual([
          { fieldDefinitionId: "f1", value: "hello" },
          { fieldDefinitionId: "f2", value: 42 },
        ]));
    // 舊回應 #1 後到（只含 f1）——cache 已分叉，守護跳過覆寫
    fieldPuts[0].resolve({ data: { ...cardFixture, customFields: [{ fieldDefinitionId: "f1", value: "hello" }] } });
    await act(async () => {});
    expect(qc.getQueryData<CardResponse>(["card", "c1"])?.customFields)
      .toEqual([
        { fieldDefinitionId: "f1", value: "hello" },
        { fieldDefinitionId: "f2", value: 42 },
      ]);
  });
});

describe("estimate 回應亂序守護（I-1）", () => {
  it("estimate 舊回應（含舊 title）後到不覆寫較新 title", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields") return Promise.resolve({ data: [] });
      if (url === "/projects/p1") return Promise.resolve({ data: { name: "專案一" } });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    // estimate 與 title 皆 PUT /cards/c1，以 body 區分、按呼叫序入列
    const puts: Array<{ body: unknown; resolve: (v: unknown) => void }> = [];
    vi.mocked(api.put).mockImplementation((url: string, body?: unknown) => {
      if (url === "/cards/c1") return new Promise((resolve) => puts.push({ body, resolve }));
      return Promise.resolve({ data: {} });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    // 存估時 5h（PUT #1 在途）
    const estimateInput = await screen.findByDisplayValue("8");
    fireEvent.change(estimateInput, { target: { value: "5" } });
    fireEvent.focusOut(estimateInput);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ estimatedHours: 5 });
    // 存標題（PUT #2 在途，較新）
    const titleInput = await screen.findByDisplayValue("測試卡");
    fireEvent.change(titleInput, { target: { value: "新標題" } });
    fireEvent.focusOut(titleInput);
    await waitFor(() => expect(puts).toHaveLength(2));
    // 較新回應（title）先到
    puts[1].resolve({ data: { ...cardFixture, title: "新標題" } });
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.title).toBe("新標題"));
    // 舊 estimate 回應（含舊 title）後到——不可覆寫新 title，僅吸收 estimatedHours
    puts[0].resolve({ data: { ...cardFixture, title: "測試卡", estimatedHours: 5 } });
    await act(async () => {});
    const cached = qc.getQueryData<CardResponse>(["card", "c1"]);
    expect(cached?.title).toBe("新標題");
    expect(cached?.estimatedHours).toBe(5);
  });

  it("estimate 舊回應後到不覆寫較新 estimate（同欄位亂序）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine") return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields") return Promise.resolve({ data: [] });
      if (url === "/projects/p1") return Promise.resolve({ data: { name: "專案一" } });
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
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
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    const estimateInput = await screen.findByDisplayValue("8");
    // 存 5h（PUT #1 在途）
    fireEvent.change(estimateInput, { target: { value: "5" } });
    fireEvent.focusOut(estimateInput);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ estimatedHours: 5 });
    // 改存 10h（PUT #2 在途，較新）
    fireEvent.change(estimateInput, { target: { value: "10" } });
    fireEvent.focusOut(estimateInput);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].body).toEqual({ estimatedHours: 10 });
    // 較新回應先到
    puts[1].resolve({ data: { ...cardFixture, estimatedHours: 10 } });
    await waitFor(() =>
      expect(qc.getQueryData<CardResponse>(["card", "c1"])?.estimatedHours).toBe(10));
    // 舊回應後到——序號守護應跳過覆寫
    puts[0].resolve({ data: { ...cardFixture, estimatedHours: 5 } });
    await act(async () => {});
    expect(qc.getQueryData<CardResponse>(["card", "c1"])?.estimatedHours).toBe(10);
  });
});

const selectField = { id: "f4", scopeType: "project", scopeId: "p1", name: "優先級", type: "select", options: ["高", "中", "低"], position: "d" };
const checkboxField = { id: "f5", scopeType: "project", scopeId: "p1", name: "完成", type: "checkbox", options: null, position: "e" };
const dateField = { id: "f6", scopeType: "project", scopeId: "p1", name: "截止", type: "date", options: null, position: "f" };

describe("自訂欄位無編輯權限 affordance（R10）", () => {
  it("select/checkbox/date/member 停用態有 aria-disabled、title 與唯讀標示", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.read"] });
      if (url === "/projects/p1/custom-fields")
        return Promise.resolve({ data: [selectField, checkboxField, dateField, memberField] });
      if (url === "/projects/p1/members")
        return Promise.resolve({ data: [{ userId: "u2", username: "bob", displayName: "鮑伯", roleIds: [] }] });
      return Promise.resolve({ data: [] });
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    // select 型欄位（優先級、成員欄）：停用＋aria-disabled＋title＋opacity 視覺
    const selects = await screen.findAllByRole("combobox");
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      expect(select).toBeDisabled();
      expect(select).toHaveAttribute("aria-disabled", "true");
      expect(select).toHaveAttribute("title", "需要卡片編輯權限");
      expect(select.className).toContain("opacity-50");
    }
    // 四型輸入全部帶 title affordance（select×2、checkbox、date）
    expect(screen.getAllByTitle("需要卡片編輯權限")).toHaveLength(4);
    // 欄位名旁（唯讀）標示
    expect(screen.getByText("優先級（唯讀）")).toBeInTheDocument();
    expect(screen.getByText("完成（唯讀）")).toBeInTheDocument();
    expect(screen.getByText("截止（唯讀）")).toBeInTheDocument();
    expect(screen.getByText("成員欄（唯讀）")).toBeInTheDocument();
  });
});

describe("ItemDetailsTab select 型自訂欄位 Radix popup（盲區消除）", () => {
  it("開啟 Radix 下拉後選項清單可見於 DOM，點選選項立即 PUT 欄位值", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields")
        return Promise.resolve({ data: [selectField] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({
      data: { ...cardFixture, customFields: [{ fieldDefinitionId: "f4", value: "高" }] },
    });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    // Radix trigger 為 role=combobox 按鈕；jsdom 無 mouse pointerType，click 走 Radix 開啟路徑
    const trigger = await screen.findByRole("combobox");
    fireEvent.click(trigger);
    // popup 以 role=option 渲染於 DOM（原生 select popup 在 jsdom 不可見——此即盲區）
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["—", "高", "中", "低"]);
    fireEvent.click(screen.getByRole("option", { name: "高" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/cards/c1/custom-fields", { f4: "高" }));
  });

  it("點選「—」清除既有值時 PUT null（哨兵 __none__ 不送出空字串）", async () => {
    const { api } = await getApi();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1")
        return Promise.resolve({
          data: { ...cardFixture, customFields: [{ fieldDefinitionId: "f4", value: "高" }] },
        });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read"] });
      if (url === "/projects/p1/custom-fields")
        return Promise.resolve({ data: [selectField] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.put).mockResolvedValue({ data: { ...cardFixture, customFields: [] } });
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    const trigger = await screen.findByRole("combobox");
    fireEvent.click(trigger);
    await screen.findAllByRole("option");
    fireEvent.click(screen.getByRole("option", { name: "—" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/cards/c1/custom-fields", { f4: null }));
  });
});

// ===== P21 follow-up：工時回報是 worklog 列的唯一生產者，記錄成功須失效 ["worklog"] =====

describe("ItemDetailsTab 工時回報失效 worklog（P21 follow-up）", () => {
  it("記錄工時成功後失效 worklog 快取", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.effort.update"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockResolvedValue({ data: { id: "e1" } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    // 釘時鐘（同 `WorkLogReport.test.tsx`）：body 裡的 `localDate` 是當日，
    // render 與斷言各讀一次時鐘——不釘的話跨午夜會紅（`finally` 還原真時鐘）。
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0));
    try {
      renderDialog(qc);
      await screen.findByDisplayValue("測試卡");
      fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
      fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
      fireEvent.change(await screen.findByPlaceholderText("工時（小時）"), { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "記錄工時" }));
      // body 是 Task 6 的三欄契約（`localDate` 補登日、`timeZoneId` 自陳時區）；
      // 這一支只在意「有送出、且送出後失效 worklog」，逐欄的斷言在下面的 Task 6 那組。
      await waitFor(() => expect(api.post).toHaveBeenCalledWith("/cards/c1/effort", {
        hours: 2, timeZoneId: localTimeZoneId(), localDate: "2026-09-10",
      }));
      // 缺陷回歸點：移除 ItemDetailsTab onSuccess 的 ["worklog"] 失效，此斷言即紅
      await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["worklog"] }));
    } finally {
      vi.useRealTimers();
    }
  });

  // `effort.hoursNotPositive` 是工時端點**唯一**的錯誤碼，body 的 `message` 刻意與譯文不同。
  it("記錄工時失敗（後端回錯誤碼）時顯示譯文，不是傳輸層字串", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/cards/c1") return Promise.resolve({ data: cardFixture });
      if (url === "/projects/p1/permissions/mine")
        return Promise.resolve({ data: ["card.edit", "card.read", "card.effort.update"] });
      return Promise.resolve({ data: [] });
    });
    vi.mocked(api.post).mockRejectedValue(
      axios400({ code: "effort.hoursNotPositive", message: "SERVER-RAW" }),
    );
    renderDialog();
    await screen.findByDisplayValue("測試卡");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.click(screen.getByRole("tab", { name: "詳細資訊" }));
    fireEvent.change(await screen.findByPlaceholderText("工時（小時）"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "記錄工時" }));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("工時須大於 0"));
  });
});

// ===== Task 6：審查表單（預填、退回禁用分數、意見必填）＋ 卡片對話框的徽章 =====
//
// 審查 UI 沒有自己的測試檔——它掛在「詳細資訊」分頁上，而那個分頁的既有覆蓋就在本檔
// （`renderDetailsTab`），所以 Task 6 的測試全部落在這裡，不另開一份 fixture。
//
// 本檔的 useAuth mock 讓 `myUserId` 固定是 u1，提交表單因此只對 reviewerUserId="u1"
// 的審查列渲染；而表單還需要 `card.review` 權限，所以下面另外傳 permissions。

// 提交表單的權限前提有兩個：`card.review` 決定表單渲染不渲染，`card.rate` 決定**分數欄**
// 渲染不渲染（Task 9，設計 §13.5 的 D8——分數只有主管角色能填）。這一組常數是「有評分權」
// 的基準，另一邊（沒有 card.rate）由同一個 describe 裡那支專屬測試覆蓋；兩邊各有一個前提，
// 所以任何一邊單獨看都只是半個故事。
const reviewPermissions = ["card.edit", "card.read", "card.review", "card.rate"];

// 已退回、且帶著上一輪意見的審查：預填的來源就是這一筆。
const cardWithRejectedReview: CardResponse = {
  ...cardFixture,
  reviews: [
    { id: "r1", reviewerUserId: "u1", reviewerUsername: "admin", reviewerDisplayName: "管理員", status: "rejected", score: null, comment: "第一輪不合格", updatedAt: "2026-08-15T00:00:00Z" },
  ],
};

// 已經帶著分數的審查。`cardWithReview` 的 score 是 null，所以「送出 null」那支測試
// **不看 `isReject ||` 也會過**——有分數的這一筆才能證明那個子句存在（一個狀態值要能
// 分辨實作的有無，它必須落在兩者結果不同的地方）。
const cardWithScoredReview: CardResponse = {
  ...cardFixture,
  reviews: [
    { id: "r1", reviewerUserId: "u1", reviewerUsername: "admin", reviewerDisplayName: "管理員", status: "pending", score: 3, comment: null, updatedAt: "2026-08-15T00:00:00Z" },
  ],
};

// 已核定的一列（approved ＋ 有分數 ＋ 有評語）。確認視窗的「覆蓋上一輪」與
// 「沒有變更」兩條路徑只有這一種 fixture 走得到：`cardWithScoredReview` 的立場是
// pending，而 pending 永遠不可能算「沒有變更」——下拉選單裡沒有 pending 這個選項。
const cardWithRatedReview: CardResponse = {
  ...cardFixture,
  reviews: [
    { id: "r1", reviewerUserId: "u1", reviewerUsername: "admin", reviewerDisplayName: "管理員", status: "approved", score: 3, comment: "第一輪合格", updatedAt: "2026-08-15T00:00:00Z" },
  ],
};

describe("審查表單（預填、退回禁用分數、意見必填）", () => {
  // Radix 的下拉在 jsdom 走 click 開啟路徑（同本檔既有的自訂欄位 select 測試）
  async function selectReviewStatus(name: string) {
    fireEvent.click(await screen.findByLabelText("審查狀態"));
    await screen.findAllByRole("option");
    fireEvent.click(screen.getByRole("option", { name }));
  }

  async function selectScore(name: string) {
    fireEvent.click(await screen.findByLabelText("評分"));
    await screen.findAllByRole("option");
    fireEvent.click(screen.getByRole("option", { name }));
  }

  // 2026-10-14 起提交多了一步確認：核定的分數會經 `CardReviewEntries` 進主管評分平均，
  // 而平均會透過 `ApplyScoreAdjustment` 改動評等——誤觸的第二次提交不是噪音，是改到
  // 一個人的評等。確認鈕一律在 alertdialog 之內找：`取消`／`提交` 這種字在卡片對話框
  // 本身也可能存在，`within` 讓「找不到」不會靜默落到外層去。
  async function confirmSubmit() {
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "確認送出" });
    // 「確認鈕可用」直接斷言，不靠「點下去之後有送出」推導——後者紅起來是一句
    // 五秒逾時，指不到真正的原因（按鈕狀態）。
    //
    // 2026-10-14 實測（不是推論）：把確認鈕改成 `disabled={true}` 之後，本檔**7 支**
    // 變紅，紅的全是走這個 helper 的——所以這一格本來就被點擊路徑釘住了，這一行的
    // 價值在於讓紅燈指名按鈕狀態。log 在 ledger 的 `mut-fe-disabled.log`。
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
  }

  it("以當前立場預填——已退回的審查打開就是退回＋原本的意見", async () => {
    await renderDetailsTab({ card: cardWithRejectedReview, permissions: reviewPermissions });
    expect(screen.getByLabelText("審查狀態")).toHaveTextContent("退回");
    expect(screen.getByPlaceholderText("評語")).toHaveValue("第一輪不合格");
    // 退回的立場下**分數欄不渲染**（退回不是一種結果），所以「不評分」那一格
    // 只有非退回的列看得到——它由下一支的 cardWithReview（pending、score null）釘住。
    expect(screen.queryByLabelText("評分")).toBeNull();
  });

  it("選退回時分數欄消失、意見變必填、送出鈕停用", async () => {
    await renderDetailsTab({ card: cardWithReview, permissions: reviewPermissions });
    // 前置：未退回時分數欄在、送出鈕可用——少了這兩行，下面的斷言可能是因為
    // 「表單根本沒渲染」而僥倖成立（本檔既有測試的教訓）
    expect(screen.getByLabelText("評分")).toBeInTheDocument();
    // 沒有分數的這一列落在「不評分」，不是一個空白欄位——空白分不出
    // 「這次不打分」與「我忘了填」，而兩者送出去是同一件事（null）。
    expect(screen.getByLabelText("評分")).toHaveTextContent("不評分");
    expect(screen.getByRole("button", { name: "提交" })).toBeEnabled();

    await selectReviewStatus("退回");

    // 退回不是一種結果，沒有分數可言——欄位是不渲染，不是禁用
    expect(screen.queryByLabelText("評分")).toBeNull();
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
  });

  it("退回並填了意見之後可以送出，且分數以 null 送出", async () => {
    const api = await renderDetailsTab({ card: cardWithReview, permissions: reviewPermissions });
    await selectReviewStatus("退回");
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("評語"), { target: { value: "測試失敗" } });
    expect(screen.getByRole("button", { name: "提交" })).toBeEnabled();

    await confirmSubmit();
    // 設計 D4：退回不可帶分數——0 與 null 在後端是兩件事，這裡送的是 null
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "rejected", score: null, comment: "測試失敗" }));
  });

  // 上一支的 fixture 沒有分數（`score` state 是 ""），所以它驗不到 `isReject ||`：
  // 少了那個子句，`score === "" ? null : …` 照樣是 null。真正需要它的是這一支——
  // **已經有分數**的審查被改成退回時，欄位不渲染了，但 state 裡還留著舊值。
  // 少了它會送出 `score: 3, status: "rejected"`，違反 Task 2 的後端契約（400）。
  it("已有分數的審查改成退回時，送出的是 null 而不是欄位裡殘留的分數", async () => {
    const api = await renderDetailsTab({ card: cardWithScoredReview, permissions: reviewPermissions });
    // 前置：分數欄帶著既有的分數——少了這一行，下面的斷言可能是因為「本來就沒分數」而成立
    expect(screen.getByLabelText("評分")).toHaveTextContent("3");

    await selectReviewStatus("退回");
    // 欄位是不渲染，但 state 沒有跟著清空——這就是那個子句要擋的縫
    expect(screen.queryByLabelText("評分")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("評語"), { target: { value: "三分的審查改成退回" } });
    await confirmSubmit();

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "rejected", score: null, comment: "三分的審查改成退回" }));
  });

  // Task 9（設計 §13.5 的 D8）：分數會進績效評等，所以只有主管角色能填——沒有 `card.rate`
  // 的人**看不到**分數欄（不是禁用：沒有分數語意時，一個灰掉的輸入框只是噪音）。
  // 這一支與上面那一組唯一的差別是權限集，而 `filter(權限) !== 顯示` 的那一半
  // 只有它驗得到；反向（有 card.rate 就看得到）由本檔其他支共用的 reviewPermissions 覆蓋。
  it("沒有 card.rate 時不渲染分數欄，但技術複核仍可送出", async () => {
    const api = await renderDetailsTab({
      card: cardWithReview,
      permissions: ["card.edit", "card.read", "card.review", "card.assign"],
    });

    // `cardWithReview` 的立場是 pending ⇒ 表單預填成「通過」，所以欄位本來該在——
    // 這一條的紅只可能來自 canRate（這正是它對 `canRate &&` 的辨別力）。
    expect(screen.queryByLabelText("評分")).toBeNull();

    // canRate 與 isReject 是兩個獨立條件：切到退回、再切回通過，欄位都不得出現
    // （少了後半，把條件寫成 `isReject && canRate` 的實作照樣綠）。
    await selectReviewStatus("退回");
    expect(screen.queryByLabelText("評分")).toBeNull();
    await selectReviewStatus("通過");
    expect(screen.queryByLabelText("評分")).toBeNull();

    // 技術複核不受影響：沒有分數要填，提交鈕仍可用，送出的分數是 null
    expect(screen.getByRole("button", { name: "提交" })).toBeEnabled();
    await confirmSubmit();
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "approved", score: null, comment: "" }));
  });

  // 同一條縫的另一半，而且只有 fixture 帶著分數才驗得到：上面那一支的 `cardWithReview`
  // score 是 null（state 是 ""），**不看 `!canRate ||` 也會過**。
  // 少了那個子句：欄位不渲染、state 仍留著上一輪的 3，送出的是 `score: 3`，
  // 後端回 400（review.rateNotPermitted），整個提交連同剛打的意見一起失敗，
  // 而畫面上根本沒有欄位可以改——表單送出的內容必須是它顯示的內容。
  it("沒有 card.rate 但這一列已帶著分數時，送出的是 null 而不是看不到的那個分數", async () => {
    const api = await renderDetailsTab({
      card: cardWithScoredReview,
      permissions: ["card.edit", "card.read", "card.review", "card.assign"],
    });
    // 前置：欄位不渲染，但 state 是這一列上一輪的分數（3）——從畫面上無從改起
    expect(screen.queryByLabelText("評分")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("評語"), { target: { value: "技術複核" } });
    await confirmSubmit();

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "approved", score: null, comment: "技術複核" }));
  });

  // ── 2026-10-14 追加：確認視窗與下拉分數 ──

  it("提交前跳出確認視窗，逐項顯示將送出的立場、分數與評語", async () => {
    const api = await renderDetailsTab({ card: cardWithScoredReview, permissions: reviewPermissions });
    fireEvent.change(screen.getByPlaceholderText("評語"), { target: { value: "交付品質良好" } });

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    const dialog = await screen.findByRole("alertdialog");
    // 三項都要在。少一項，這個視窗就只是一次多餘的點擊——使用者無從核對他正要送出什麼，
    // 而那正是它的全部意義。
    expect(within(dialog).getByText(/通過/)).toBeInTheDocument();
    expect(within(dialog).getByText(/3/)).toBeInTheDocument();
    expect(within(dialog).getByText(/交付品質良好/)).toBeInTheDocument();
    // 確認之前一個請求都不該出去（「先送出再問」等於沒問）
    expect(api.put).not.toHaveBeenCalled();
  });

  it("確認視窗按取消不會送出任何請求", async () => {
    const api = await renderDetailsTab({ card: cardWithReview, permissions: reviewPermissions });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.put).not.toHaveBeenCalled();
  });

  it("內容與目前核定完全相同時確認鈕停用並說明沒有變更", async () => {
    // 已核定的那一列：一個欄位都不動就再送一次＝後端會判為同值（不寫第二筆 entry、
    // 不發通知、樣本數不變）。前端應該當場說「沒有變更」，而不是給一顆按了什麼都
    // 不會發生的鈕——後端那道守門是可達的，但讓使用者走到那裡才發現是設計失誤。
    const api = await renderDetailsTab({ card: cardWithRatedReview, permissions: reviewPermissions });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "確認送出" })).toBeDisabled();
    expect(within(dialog).getByText(/沒有需要送出的變更/)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("改了分數之後確認鈕恢復可用，且送出的是新分數", async () => {
    const api = await renderDetailsTab({ card: cardWithRatedReview, permissions: reviewPermissions });
    await selectScore("5");
    await confirmSubmit();
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "approved", score: 5, comment: "第一輪合格" }));
  });

  it("只改了評語也能送出（確認鈕可用），且送出的是新評語", async () => {
    // `unchanged` 的三項之一是評語。少了它，一個只比分數與立場的實作會讓「更正評語」
    // 變成按不下去的鈕——那正是「更正被吃掉」的方向，比誤觸更糟。
    // 後端那一半由 `Resubmit_ChangedCommentOnly_WritesSecondEntry` 釘住，兩邊同一個判準。
    const api = await renderDetailsTab({ card: cardWithRatedReview, permissions: reviewPermissions });
    fireEvent.change(screen.getByPlaceholderText("評語"), { target: { value: "第一輪合格，補一句" } });
    await confirmSubmit();
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "approved", score: 3, comment: "第一輪合格，補一句" }));
  });

  it("純空白的評語：畫面顯示「沒有評語」，送出的也是空字串", async () => {
    // 顯示與送出必須是同一個值。少了 `sentComment`，畫面說「評語：—」而 DB 收到三個
    // 空白——那會是本檔那條「表單送出的內容必須是它顯示的內容」唯一的反例
    // （approve 路徑可達；reject 已被必填擋住）。
    const api = await renderDetailsTab({ card: cardWithRatedReview, permissions: reviewPermissions });
    fireEvent.change(screen.getByPlaceholderText("評語"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("評語：—")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "確認送出" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/cards/c1/reviews/r1", { status: "approved", score: 3, comment: "" }));
  });

  it("確認視窗標示將被覆蓋的上一輪核定", async () => {
    // 只有「已有立場」的那一列看得到這一行——pending 的一列沒有東西可以被覆蓋，
    // 對它顯示「將覆蓋…」會是一句假陳述。
    await renderDetailsTab({ card: cardWithRatedReview, permissions: reviewPermissions });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/將覆蓋/)).toBeInTheDocument();
  });

  it("分數是下拉選單而不是可自由輸入的欄位", async () => {
    await renderDetailsTab({ card: cardWithReview, permissions: reviewPermissions });
    // 前置：分數欄在（沒有 card.rate 的人看不到它，那一半由上面的測試覆蓋）
    const trigger = screen.getByLabelText("評分");
    // 不是 <input>：自由輸入正是「4.5 ⇒ 後端 JSON 繫結失敗 ⇒ 400 且 body 不帶本 app 的
    // code／message ⇒ 前端只印得出通用失敗字串」那條路的來源。分數是五個值的枚舉，
    // 讓不合法狀態不可表示比事後驗證便宜。
    expect(trigger.tagName).not.toBe("INPUT");

    fireEvent.click(trigger);
    // 可選值**恰好**是「不評分」＋ 1–5：整數性與範圍都由選項集合決定，不是靠驗證。
    // 排序後比較——Radix 的選項 DOM 順序不是這裡要釘的契約。
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect([...labels].sort()).toEqual(["1", "2", "3", "4", "5", "不評分"].sort());
  });
});

// 徽章是**整張卡的 rollup**（卡片對話框與看板卡片上的那一顆是同一個狀態），
// 文字走 `common:state.*`；審查者摘要列走的是**逐審查者**的 `card:review.status.pending`。
//
// **兩者原本刻意不同字**（徽章 `待審查`、摘要列 `待審`，產品文案裁定清單第 2 條）。
// 2026-09-19 使用者裁定統一，`card:review.status.pending` 已改成 `待審查`
// ——**但這裡要守的性質沒有跟著消失**：`待審` 仍是 `待審查` 的子字串，
// 而兩個節點依然同時出現在「詳細資訊」分頁：
// 斷言一律用**精確字串**；`getByText(/待審/)` 會同時命中兩個元素而紅。
//
// **但「用精確比對」不等於「拿子字串當引數」**（2026-09-17 實測更正——
// 原註解寫「`getByText("待審")` 只中摘要列」是錯的，它一個都命中不到）：
// 字串引數比對的是元素**直接文字子節點串接後的整串**，不是其中任一段。
// 摘要列那個 `<span>` 依序放了摘要、分數、評語三段（`{{name}}：{{status}}` 等），
// 本 fixture 的後兩段是空的 ⇒ 整串就是 `管理員：待審查`，
// 而 `getByText("待審查")` 在任何組合下都命中不到它。
// 徽章是獨立節點、內容就是那三個字，所以 `getByText("待審查")` 只中徽章。
describe("卡片對話框的審查狀態徽章", () => {
  function renderDetailsWithReviewState(reviewState: CardResponse["reviewState"]) {
    return renderDetailsTab({ card: { ...cardFixture, reviewState } });
  }

  it("reviewState 為 null 時不顯示任何審查狀態徽章", async () => {
    await renderDetailsWithReviewState(null);
    expect(screen.queryByText("待審查")).not.toBeInTheDocument();
    expect(screen.queryByText("通過")).not.toBeInTheDocument();
    expect(screen.queryByText("退回")).not.toBeInTheDocument();
  });

  it.each<[CardResponse["reviewState"], string]>([
    ["pending", "待審查"],
    ["approved", "通過"],
    ["rejected", "退回"],
  ])("reviewState=%s 時顯示 %s", async (state, label) => {
    await renderDetailsWithReviewState(state);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // 上面那段註解描述的場景（`待審` 是 `待審查` 的子字串、兩者同畫面）在上面六支
  // **一次都沒有發生**：`cardFixture.reviews` 是空陣列，徽章與摘要列從未共存，
  // 所以把斷言放寬成 `/待審/` 也是全綠。這一支讓兩者同時存在。
  //
  // **這一支原本是「刻意分裂」的契約**（舊註解寫著「統一措辭在這裡會紅」；
  // 2026-09-19 使用者裁定統一，那個預測已經執行完畢）。統一之後它守的東西反而更吃重：
  // 兩個節點現在帶著**同一組字**，只剩「字串引數比對的是整串、不是子字串」這個性質
  // 還分得開它們——放寬成正則就再也分不出「兩個節點都在」與「第三個也帶這兩個字」。
  it("rollup 徽章與逐審查者的摘要列同字時，精確字串斷言仍分得開兩者", async () => {
    await renderDetailsTab({
      card: { ...cardWithReview, reviewState: "pending" },
      permissions: reviewPermissions,
    });

    // 徽章＝整張卡的 rollup（common:state.pending）：待審查
    expect(screen.getByText("待審查")).toBeInTheDocument();
    // 摘要列＝逐審查者的立場（card:review.status.pending）：也是待審查。
    // 模板是 `{{name}}：{{status}}`，`getByText` 比對的是元素的直接文字節點，
    // 所以摘要列在這裡是整句而不是只有狀態那三個字——**這正是它沒被上一行一起命中的原因**。
    expect(screen.getByText("管理員：待審查")).toBeInTheDocument();
    // 上面兩行必須是精確字串的理由，直接在測試裡釘住：`待審` 是 `待審查` 的子字串，
    // 放寬成正則會同時命中兩者。這裡記**數量**而不是「`getByText` 會拋」——
    // 後者已被上面兩行蕴含（兩者都存在 ⇒ 一定拋多個），永遠不可能是失敗的那一行
    // （2026-09-17 scoped re-review 的 M-a）；記數量還能抓到「第三個元素也帶這兩個字」。
    expect(screen.getAllByText(/待審/)).toHaveLength(2);
  });
});

// ===== Task 7：審查歷程 =====
//
// `GET /cards/{id}/review-history` 回的是**裸陣列**（不是 `{items, nextCursor}`——
// 歷史是 append-only，刻意不分頁）。`reviewerDisplayName` 可能是**空字串**：後端走
// 兩步查 User 的 `u?.DisplayName ?? ""`，查不到人時就是空的，畫面不能假設它一定有值。
//
// 立場走 Task 6 建好的 `reviewStatusLabel`（`common:state.approved`／`rejected` 與
// `card:review.status.pending` 的 switch），與審查者摘要列同一支；rollup 徽章那一支
// （`reviewStateLabel`，`common:state.*`）刻意不同字，見上面的說明。
const reviewHistoryFixture: ReviewEntryResponse[] = [
  { id: "h1", reviewerUserId: "u1", reviewerUsername: "admin", reviewerDisplayName: "管理員", status: "rejected", score: null, comment: "第一輪不合格", createdAt: "2026-08-15T00:00:00Z" },
  { id: "h2", reviewerUserId: "u2", reviewerUsername: "bob", reviewerDisplayName: "", status: "approved", score: 4, comment: null, createdAt: "2026-08-16T00:00:00Z" },
];

describe("審查歷程", () => {
  afterEach(async () => {
    await act(async () => {
      await setLocale(null);
    });
  });

  it("逐列顯示人名、立場、分數、意見、時間", async () => {
    await renderDetailsTab({ reviewHistory: reviewHistoryFixture, permissions: reviewPermissions });

    // 標題是無條件渲染的，**列不是**——它們要等查詢回來。這裡一律用 `findBy`
    // （`getBy` 會在查詢還沒落地時就斷言，紅在「找不到列」而不是被測行為）。
    expect(await screen.findByText("審查歷程")).toBeInTheDocument();
    // 立場是標籤（退回／通過）而不是後端識別碼（rejected／approved）
    expect(await screen.findByText(/^管理員 · 退回 · （第一輪不合格） · /)).toBeInTheDocument();
    // 第二列：人名是空字串、沒有意見——空的那兩格直接不佔位，整列仍要完整
    expect(await screen.findByText(/^通過 · 4 分 · /)).toBeInTheDocument();
  });

  it("沒有歷史時顯示空態", async () => {
    await renderDetailsTab({ permissions: reviewPermissions });
    expect(await screen.findByText("尚無審查紀錄")).toBeInTheDocument();
  });

  it("查詢失敗時顯示載入失敗，不是尚無審查紀錄", async () => {
    await renderDetailsTab({ permissions: reviewPermissions, reviewHistoryError: true });

    // 失敗態下 `isLoading` 是 false、`data` 是 undefined，空態的 `?? []` 於是命中——
    // **少了 error 分支，下面第一行紅、第二行反而通過**：畫面斷言「尚無審查紀錄」，
    // 一句關於治理留痕的假陳述（同檔的 `CardActivityTab` 早有這個分支）。
    expect(await screen.findByText("載入失敗")).toBeInTheDocument();
    expect(screen.queryByText("尚無審查紀錄")).toBeNull();
  });

  it("提交審查後重新取得審查歷程（自己的提交路徑）", async () => {
    const api = await renderDetailsTab({ card: cardWithReview, permissions: reviewPermissions });
    const historyFetches = () =>
      vi.mocked(api.get).mock.calls.filter(([url]) => url === "/cards/c1/review-history").length;

    // 前置：歷程查詢已經打過一次。少了這一行，「變成 2」也可能只是因為它從沒打過
    // （本檔既有測試的教訓：先證明東西在，再證明它變了）。
    await waitFor(() => expect(historyFetches()).toBe(1));
    const before = historyFetches();

    // `cardWithReview` 的 review 是 pending ⇒ 表單預填成 approved，送出不必填任何欄位
    // （2026-10-14 起提交前多一步確認視窗，所以這裡是兩個點擊）
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "確認送出" }));

    // 這一條的重點是**有第二條失效路徑**：`onRefresh()` 失效的是 `["card", c1]`，
    // 而 react-query 的前綴比對是逐元素的——`"card"` 不等於 `"card-review-history"`。
    // 少了那一行，摘要列會更新（`card` 失效了）而歷程停在舊資料上，畫面自相矛盾。
    await waitFor(() => expect(historyFetches()).toBe(before + 1));
  });

  it("en 之下的歷史列不會多出空白", async () => {
    await renderDetailsTab({
      reviewHistory: [{
        id: "h3", reviewerUserId: "u2", reviewerUsername: "bob", reviewerDisplayName: "admin",
        status: "approved", score: 4, comment: "ok", createdAt: "2026-08-16T00:00:00Z",
      }],
      permissions: reviewPermissions,
    });
    // 分頁名跟著語系走（`renderDetailsTab` 用的是中文的「詳細資訊」）⇒ 語系在
    // **切到該分頁之後**才換。換語系會讓已掛載的內容重繪，查詢不受影響。
    await act(async () => {
      await setLocale("en");
    });

    // 這一列是 `join(" · ")`，而 en 的 `card:review.score`／`card:review.comment`
    // **自帶前導空白**（接在別的字後面用的）⇒ 不退掉的話分隔符後面會多一個空白。
    // 斷言 `textContent`（不是 `getByText`）：normalizer 會收斂連續空白，
    // 雙空白對它完全隱形。
    const row = await screen.findByText(/^admin · Approved/);
    const text = row.textContent ?? "";
    expect(text).toContain(" · Approved · 4 pts · (ok) · ");
    expect(text).not.toMatch(/ {2}/);
  });

  it("立場欄不印原始識別碼", async () => {
    await renderDetailsTab({ reviewHistory: reviewHistoryFixture, permissions: reviewPermissions });

    // 前置：歷史列確實渲染了。少了這一行，「整塊不存在」也會讓下面的斷言通過
    // （本檔既有測試的教訓：先證明東西在，再證明它長什麼樣）。
    expect(await screen.findByText(/^管理員 · /)).toBeInTheDocument();

    // 突變：把 `reviewStatusLabel(t, h.status)` 換成 `h.status` → **這一行**變紅，
    // 上面那行仍是綠的（`管理員 · rejected…` 一樣以「管理員 · 」開頭）。
    expect(screen.queryByText(/rejected/)).toBeNull();
    expect(screen.queryByText(/approved/)).toBeNull();
  });
});

// ===== Task 6（工作日界線）：工時表單的補登日期、時區與凍結日清單 =====
//
// 工時回報是**補登**（設計 D2）：body 逐欄帶 `hours`、`timeZoneId`（瀏覽器的 IANA ID）
// 與 `localDate`（使用者選定、預設今日的本地日）。後端拿 `localDate` 凍結工作日誌的
// 那一日，**不從時間戳回推**——所以清單列印的是那一欄本身，不是任何時間轉換的產物。
//
// 「未來日」有兩層：前端這一層是 `max={localDayString()}`（`yyyy-MM-dd` 零填充 ⇒
// 字典序＝時序，T5 審查已驗），後端另有 `effort.localDateInFuture` 的 400。
// `max` 只是 UI affordance（表單改得掉），後端那一層才是契約。
describe("工時回報的補登日期與凍結日（Task 6）", () => {
  // 表單要 `card.effort.update` 才渲染——少了它，下面每一支都會紅在「找不到欄位」，
  // 而那正是「這一支在測什麼」的前提。
  const effortPermissions = ["card.edit", "card.read", "card.effort.update"];

  async function renderEffortForm(card: CardResponse = cardFixture) {
    const api = await renderDetailsTab({ card, permissions: effortPermissions });
    vi.mocked(api.post).mockResolvedValue({ data: { id: "e1" } });
    return api;
  }

  it("日期欄預設今日，且 max 也是今日（未來的日子選不到）", async () => {
    // 釘時鐘（形狀同 `WorkLogReport.test.tsx`）：`當日` 由 render 時的系統時鐘決定，
    // 而斷言比的是字面的那一天——不釘的話跨午夜會紅。`setSystemTime` 只假 Date、
    // 不開 fake timers（RTL 的 findBy／waitFor 照走真時鐘），`finally` 還原。
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0)); // 2026-09-10（週四）中午，本地
    try {
      await renderEffortForm();
      const dateInput = await screen.findByLabelText("日期");
      expect(dateInput).toHaveAttribute("type", "date");
      expect(dateInput).toHaveValue("2026-09-10");
      expect(dateInput).toHaveAttribute("max", "2026-09-10");
    } finally {
      vi.useRealTimers();
    }
  });

  it("送出工時時 body 帶滿 hours／timeZoneId／localDate 三欄", async () => {
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0));
    try {
      const api = await renderEffortForm();
      fireEvent.change(await screen.findByPlaceholderText("工時（小時）"), { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "記錄工時" }));
      // 逐欄相等——舊契約（只有 `hours` 一欄）或漏掉任何一欄都會讓這一行紅。
      // `timeZoneId` 不可以寫死（例如 "Asia/Taipei"）：那會讓「跑在哪台機器都成立」
      // 的假象蓋掉真正的來源（`localTimeZoneId()`）；`localDate` 反而是字面的那一天
      // （時鐘已釘住），所以「當日」這一條也是逐字釘的，不是推導來的。
      await waitFor(() => expect(api.post).toHaveBeenCalledWith("/cards/c1/effort", {
        hours: 2, timeZoneId: localTimeZoneId(), localDate: "2026-09-10",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("清空日期欄之後不能送出（空字串的 localDate 會死在後端繫結）", async () => {
    // 這一支不必釘時鐘：兩條斷言都與「當日」無關（只比 before／after 的停用態）。
    await renderEffortForm();
    const submit = await screen.findByRole("button", { name: "記錄工時" });
    fireEvent.change(screen.getByPlaceholderText("工時（小時）"), { target: { value: "2" } });
    // 前置：兩欄都有值時可送出。少了這一行，「停用」也可能是別的原因（工時沒填、
    // mutation 在途）——本檔既有測試的教訓：先證明東西在，再證明它變了。
    expect(submit).toBeEnabled();
    const dateInput = screen.getByLabelText("日期");
    fireEvent.change(dateInput, { target: { value: "" } });
    expect(dateInput).toHaveValue("");
    // 停用就是這一站的防線（**不是**「空＝今天」：猜一個使用者沒選的日子，等於替他
    // 寫了一筆他不知道的工作日誌）。真的送出去的話，空字串的 `localDate` 會死在
    // 後端的繫結 400，而那則訊息不是在這裡翻得出來的。
    expect(submit).toBeDisabled();
  });

  it("改選補登日期後送的是選定的那一日，不是今天", async () => {
    // 這一支也不必釘時鐘：預期值是字面的 2026-09-01，不依賴「當日」。
    const api = await renderEffortForm();
    fireEvent.change(await screen.findByLabelText("日期"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByPlaceholderText("工時（小時）"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "記錄工時" }));
    // 判別點是「state 有沒有進 body」：忽略 `logDate`、一律送當日的實作，
    // 在這一支紅而在上一支綠（上一支的當日與 state 同值）。
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/cards/c1/effort", {
      hours: 2, timeZoneId: localTimeZoneId(), localDate: "2026-09-01",
    }));
  });

  it("清單列顯示凍結的本地日而不是時間戳", async () => {
    await renderEffortForm({
      ...cardFixture,
      effort: {
        logs: [{ id: "e1", userId: "u1", username: "admin", displayName: "管理員", hours: 2, note: null, localDate: "2026-09-01" }],
        totalHours: 2,
      },
    });
    // `formatDay`：`09/01（二）`——`09/01` 是那一日本身的字，不隨執行時區位移。
    const row = await screen.findByText(/09\/01/);
    // 反面：時間戳，**範圍收在這一列內**（review 的 M-2）。整個對話框掃的話，
    // 別處任何帶時刻的字都會讓它誤紅，而它要證的是「這一列印的是日期、不是時刻」。
    // 退化版的實際輸出：`formatDateTime("2026-09-01")` → `2026/9/1 上午8:00:00`
    // （把它解成 UTC 午夜再按執行時區位移）。
    expect(within(row.closest("li")!).queryByText(/\d{1,2}:\d{2}/)).toBeNull();
  });
});
