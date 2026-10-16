// 卡片複製（跨專案目標選擇）的測試。
//
// 這一檔守的是**四條「看起來成功、其實做錯事」的路**——它們全都不會有紅燈，
// 除非有斷言精確盯著送出的 body 與失效的 query key：
//
//   ① 沒帶 `targetListId`（或鍵名寫錯）⇒ 後端 `req.TargetListId ?? card.ListId`
//      複製回**原列表**，而畫面照樣 toast 成功。
//   ② 換上層沒清下層 ⇒ select 顯示「P2」而送出的仍是 P1 的列表；後端只看
//      **目標列表所屬專案**的權限 ⇒ 照樣成功。
//   ③ 卡片現址剛好是封存列表 ⇒ 確認鈕的停用規則少一個子句就會送出畫面上看不到的目標。
//   ④ 成功後沒失效**目標**專案的 key ⇒ 新卡不會出現在目標看板／報表上。
//
// **下面三段 `vi.mock` 是逐字複製的，不是重打的**：它們是檔案作用域且會被提升，
// 由共用模組轉出不會生效；漏掉其中一段的失敗方式可能是靜默的（查詢落到真實 api）。
// 共用 fixture 與 render 路徑在 `./card-dialog-test-utils`。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { BoardDetailResponse, CardResponse, ListResponse } from "@/lib/board-types";
import { cardFixture, getApi, renderDialog } from "./card-dialog-test-utils";
import { axiosStatus } from "@/test/http-errors";

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

const P1 = { id: "p1", name: "P1" };
const P2 = { id: "p2", name: "P2" };
const B1 = { id: "b1", name: "B1" };
const B2 = { id: "b2", name: "B2" };

function list(id: string, name: string, isArchived = false): ListResponse {
  return { id, name, position: "a", isArchived, cards: [] };
}

function boardDetail(id: string, projectId: string, lists: ListResponse[]): BoardDetailResponse {
  return { id, projectId, name: id.toUpperCase(), description: null, position: "a", isArchived: false, lists };
}

interface MockOpts {
  permissions?: string[];
  card?: CardResponse;
  projects?: { id: string; name: string }[];
  projectBoards?: Record<string, { id: string; name: string }[]>;
  boardDetails?: Record<string, BoardDetailResponse>;
}

async function mockGet(opts: MockOpts = {}) {
  const { api } = await getApi();
  const card = opts.card ?? cardFixture;
  const projectBoards = opts.projectBoards ?? { p1: [B1], p2: [B2] };
  const boardDetails = opts.boardDetails ?? {
    b1: boardDetail("b1", "p1", [list("l1", "L1")]),
    b2: boardDetail("b2", "p2", [list("l2", "L2")]),
  };
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/cards/c1") return Promise.resolve({ data: card });
    if (url === "/projects/p1/permissions/mine")
      return Promise.resolve({ data: opts.permissions ?? ["card.read", "card.edit", "card.create"] });
    if (url === "/projects") return Promise.resolve({ data: opts.projects ?? [P1, P2] });
    // 順序有意義：`/boards/b1/labels` 也以 `/boards/` 開頭，必須先判掉
    if (url.endsWith("/labels")) return Promise.resolve({ data: [] });
    if (url.startsWith("/projects/") && url.endsWith("/boards"))
      return Promise.resolve({ data: projectBoards[url.slice("/projects/".length, -"/boards".length)] ?? [] });
    if (url.startsWith("/boards/"))
      return Promise.resolve({ data: boardDetails[url.slice("/boards/".length)] ?? boardDetail("?", "p1", []) });
    return Promise.resolve({ data: [] });
  });
  return api;
}

let qc: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidateSpy = vi.spyOn(qc, "invalidateQueries");
});

/** 開主對話框 → 點工具列的複製鈕 → 回傳內層對話框（Radix 的內容掛在 body）。 */
async function openCopy() {
  renderDialog(qc);
  await screen.findByDisplayValue("測試卡");
  fireEvent.click(screen.getByRole("button", { name: "複製" }));
  return await screen.findByRole("dialog", { name: "複製卡片" });
}

/**
 * 等列表那一層就緒。
 *
 * **不能拿「L1 出現在畫面上」當就緒訊號**：卡片現址落在封存列表時，L1 只存在於
 * 還沒展開的選項清單裡，畫面上看不到。改用「下拉可用」——它同時代表看板詳情查詢
 * 已經回來、而且有未封存的列表。
 */
async function ready(dialog: HTMLElement) {
  await waitFor(() => expect(within(dialog).getByLabelText("目標列表")).toBeEnabled());
}

// Radix 的下拉在 jsdom 走 click 開啟路徑（同 ItemDetailsTab.test.tsx 既有手法）。
// 選項清單 portal 到 body，所以用 screen 查而不是 within(dialog)。
//
// 換上層之後下層會先進入載入中（該層停用）——**先等它可用再點**，
// 否則點在一顆 disabled 的按鈕上，選項永遠不會出現。
async function pick(dialog: HTMLElement, label: string, option: string) {
  const trigger = within(dialog).getByLabelText(label);
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  await screen.findAllByRole("option");
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("CopyCardDialog 入口閘門", () => {
  it("有 card.create 時工具列出現在複製鈕", async () => {
    await mockGet({ permissions: ["card.read", "card.edit", "card.create"] });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    expect(screen.getByRole("button", { name: "複製" })).toBeInTheDocument();
  });

  it("沒有 card.create 時沒有複製鈕", async () => {
    await mockGet({ permissions: ["card.read", "card.edit"] });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    expect(screen.queryByRole("button", { name: "複製" })).toBeNull();
  });
});

describe("CopyCardDialog 三層目標選擇", () => {
  it("開啟後三層預填卡片現址", async () => {
    await mockGet();
    const dialog = await openCopy();
    // 等清單查詢回來才斷言——否則下面三條會在「根本還沒渲染」時僥倖成立
    await ready(dialog);
    expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1");
    expect(within(dialog).getByLabelText("目標看板")).toHaveTextContent("B1");
    expect(within(dialog).getByLabelText("目標列表")).toHaveTextContent("L1");
  });

  it("直接確認送出卡片現址的列表 id，並帶上 locale", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockResolvedValue({ data: { ...cardFixture, id: "c2" } });
    const dialog = await openCopy();
    await ready(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "確定複製" }));
    // 逐字比對（`expect.anything()` 會讓「忘了帶 body」綠）
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/cards/c1/copy?locale=zh-TW", { targetListId: "l1" }));
  });

  it("選到別的專案的列表後，送出的就是那個列表的 id", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockResolvedValue({ data: { ...cardFixture, id: "c2", listId: "l2" } });
    const dialog = await openCopy();
    await ready(dialog);
    await pick(dialog, "目標專案", "P2");
    await pick(dialog, "目標看板", "B2");
    await pick(dialog, "目標列表", "L2");
    fireEvent.click(within(dialog).getByRole("button", { name: "確定複製" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/cards/c1/copy?locale=zh-TW", { targetListId: "l2" }));
  });

  it("換專案會清掉看板與列表，並停用確認鈕", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockResolvedValue({ data: { ...cardFixture, id: "c2" } });
    const dialog = await openCopy();
    await ready(dialog);
    await pick(dialog, "目標專案", "P2");
    // 立刻斷言：換專案當下就不能再顯示來源的 B1／L1（這是「清了沒」的本體，
    // 不等查詢回來——等回來才斷言的話，中途顯示舊值也照樣綠）
    expect(within(dialog).getByLabelText("目標看板")).not.toHaveTextContent("B1");
    expect(within(dialog).getByLabelText("目標列表")).not.toHaveTextContent("L1");
    // 查詢回來之後看板是空的（顯示 placeholder）
    await waitFor(() =>
      expect(within(dialog).getByLabelText("目標看板")).toHaveTextContent("選擇看板"));
    // 停用是重點：只清 state 不停用的實作會顯示「P2」而實際送 P1 的列表
    const confirm = within(dialog).getByRole("button", { name: "確定複製" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(api.post).not.toHaveBeenCalled();
    // 清單的選項也換了：選了 P2 的看板之後，來源的 L1 不在選項裡
    await pick(dialog, "目標看板", "B2");
    const listTrigger = within(dialog).getByLabelText("目標列表");
    await waitFor(() => expect(listTrigger).toBeEnabled());
    fireEvent.click(listTrigger);
    await screen.findAllByRole("option");
    expect(screen.getByRole("option", { name: "L2" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "L1" })).toBeNull();
  });

  it("換看板會清掉列表（同一個專案內）", async () => {
    await mockGet({
      projectBoards: { p1: [B1, { id: "b3", name: "B3" }] },
      boardDetails: {
        b1: boardDetail("b1", "p1", [list("l1", "L1")]),
        b3: boardDetail("b3", "p1", [list("l3", "L3")]),
      },
    });
    const dialog = await openCopy();
    await ready(dialog);
    await pick(dialog, "目標看板", "B3");
    expect(within(dialog).getByLabelText("目標列表")).not.toHaveTextContent("L1");
    await waitFor(() =>
      expect(within(dialog).getByLabelText("目標列表")).toHaveTextContent("選擇列表"));
    expect(within(dialog).getByRole("button", { name: "確定複製" })).toBeDisabled();
  });

  it("換看板再換回來，列表不會悄悄回復先前那個選擇", async () => {
    // 這一條是為**突變 M6**（拿掉「換看板清列表」那一行）補的：那個突變一開始
    // **沒有讓任何測試變紅**，因為顯示與送出的兩道關卡（`listValue` 的 placeholder 還原、
    // `canSubmit` 要求選中的必須在可見選項裡）都已經把它擋住了。
    // 它真正改變的行為是**狀態留存**：切走再切回來，先前的 l1 會自己復活——
    // 而中間那段它在別的看板的選項裡是**隱形**的。畫面上兩者一模一樣，只有這一條分得開。
    await mockGet({
      projectBoards: { p1: [B1, { id: "b3", name: "B3" }] },
      boardDetails: {
        b1: boardDetail("b1", "p1", [list("l1", "L1")]),
        b3: boardDetail("b3", "p1", [list("l3", "L3")]),
      },
    });
    const dialog = await openCopy();
    await ready(dialog);
    expect(within(dialog).getByLabelText("目標列表")).toHaveTextContent("L1");
    await pick(dialog, "目標看板", "B3");
    await pick(dialog, "目標看板", "B1");
    await waitFor(() =>
      expect(within(dialog).getByLabelText("目標列表")).toHaveTextContent("選擇列表"));
    expect(within(dialog).getByRole("button", { name: "確定複製" })).toBeDisabled();
  });

  it("已封存的列表不出現在選項裡，未封存的照常在", async () => {
    await mockGet({
      boardDetails: {
        b1: boardDetail("b1", "p1", [list("l1", "L1"), list("l8", "L8"), list("l9", "L9", true)]),
      },
    });
    const dialog = await openCopy();
    await ready(dialog);
    fireEvent.click(within(dialog).getByLabelText("目標列表"));
    await screen.findAllByRole("option");
    expect(screen.getByRole("option", { name: "L8" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "L9" })).toBeNull();
  });

  it("卡片現址落在封存列表時，確認鈕停用", async () => {
    await mockGet({
      card: { ...cardFixture, listId: "l9" },
      boardDetails: { b1: boardDetail("b1", "p1", [list("l1", "L1"), list("l9", "L9", true)]) },
    });
    const dialog = await openCopy();
    await ready(dialog);
    // 列表那一層可用，但選中的 l9 不在（未封存的）選項裡 ⇒ 停用。
    // 少了「選中的必須在可見選項裡」這個子句，這裡會是可以按的。
    expect(within(dialog).getByLabelText("目標列表")).toHaveTextContent("選擇列表");
    expect(within(dialog).getByRole("button", { name: "確定複製" })).toBeDisabled();
  });
});

describe("CopyCardDialog 送出後的失效與收尾", () => {
  it("成功後失效目標專案的每一個檢視，且不失效來源", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockResolvedValue({ data: { ...cardFixture, id: "c2", listId: "l2" } });
    const dialog = await openCopy();
    await ready(dialog);
    await pick(dialog, "目標專案", "P2");
    await pick(dialog, "目標看板", "B2");
    await pick(dialog, "目標列表", "L2");
    fireEvent.click(within(dialog).getByRole("button", { name: "確定複製" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    for (const key of [
      ["board", "b2"],
      ["project-cards-table", "p2"],
      ["project-cards", "p2"],
      ["project-cards-nodue", "p2"],
      ["mindmap", "p2"],
      ["report", "p2"],
      ["project-cards-drawer", "p2"],
    ]) {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: key }));
    }
    // 只失效目標：來源卡完全沒被改（沒有這一條，整包來源 key 一起失效也會綠）
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["board", "b1"] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["project-cards", "p1"] }));
    // 行為斷言：目標看板是**在掛載中**被失效的（對話框自己的 ["board","b2"] 觀察者），
    // 所以會真的重抓一次——失效旗標本身看不出這件事
    await waitFor(() =>
      expect(vi.mocked(api.get).mock.calls.filter(([u]) => u === "/boards/b2")).toHaveLength(2));
  });

  it("成功後關閉複製對話框、toast 譯文，主對話框留著", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockResolvedValue({ data: { ...cardFixture, id: "c2" } });
    const dialog = await openCopy();
    await ready(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "確定複製" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "複製卡片" })).toBeNull());
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith("卡片已複製");
    // 順手把整張卡也關掉的實作會讓這條紅
    expect(screen.getByDisplayValue("測試卡")).toBeInTheDocument();
  });

  it("403 顯示的是錯誤碼的譯文，不是傳輸層字串也不是伺服器原文", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockRejectedValue(
      axiosStatus(403, { code: "permission.denied", message: "SERVER-RAW" }));
    const dialog = await openCopy();
    await ready(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "確定複製" }));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("你沒有存取這個資源的權限"));
    // 失敗不關對話框——關了就得重選一次目標
    expect(screen.getByRole("dialog", { name: "複製卡片" })).toBeInTheDocument();
  });

  it("伺服器沒說話時顯示 fallback 的譯文", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockRejectedValue(axiosStatus(403));
    const dialog = await openCopy();
    await ready(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "確定複製" }));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("複製失敗"));
  });

  it("送出中停用確認鈕且不重複送出", async () => {
    const api = await mockGet();
    vi.mocked(api.post).mockReturnValue(new Promise(() => {}));
    const dialog = await openCopy();
    await ready(dialog);
    const confirm = within(dialog).getByRole("button", { name: "確定複製" });
    fireEvent.click(confirm);
    const busy = await within(dialog).findByRole("button", { name: "複製中…" });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "複製卡片" })).toBeInTheDocument();
  });

  it("取消後再開會回到卡片現址", async () => {
    await mockGet();
    const dialog = await openCopy();
    await ready(dialog);
    await pick(dialog, "目標專案", "P2");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "複製卡片" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "複製" }));
    const reopened = await screen.findByRole("dialog", { name: "複製卡片" });
    await within(reopened).findByText("L1");
    expect(within(reopened).getByLabelText("目標專案")).toHaveTextContent("P1");
    expect(within(reopened).getByLabelText("目標看板")).toHaveTextContent("B1");
    expect(within(reopened).getByLabelText("目標列表")).toHaveTextContent("L1");
  });
});

// ===== 入口鈕的名稱必須來自譯文（同 CardDialog.test.tsx 的分頁名稱那一條） =====
//
// zh-TW 的斷言對「把中文寫死在 JSX 裡」是全盲的——寫死的中文在 zh-TW 畫面下看起來就是對的。
// 真正的不變量是「名稱跟著語系走」，所以這一條必須以 en 執行。
describe("複製鈕的名稱來自譯文", () => {
  it("切到 en 之後入口鈕的名稱是 Copy", async () => {
    const { setLocale } = await import("@/i18n");
    const { act } = await import("@testing-library/react");
    await mockGet();
    await act(async () => {
      await setLocale("en");
    });
    renderDialog(qc);
    await screen.findByDisplayValue("測試卡");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
