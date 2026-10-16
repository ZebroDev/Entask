// 清單複製（跨看板目標選擇）的測試。
//
// 四條「看起來成功、其實做錯事」的路：
//   ① 沒帶 `targetBoardId` ⇒ 後端 `req.TargetBoardId ?? list.BoardId` 就地複製回原看板，
//      而畫面照樣 toast 成功（使用者以為複製到別的地方了）。
//   ② 換專案沒清看板 ⇒ 下拉顯示 P2 而送出的仍是 P1 的看板。
//   ③ 來源看板剛好封存 ⇒ 它不在選項裡，停用規則少一個子句就會送出畫面上看不到的目標。
//   ④ 目標專案缺 `board.edit` 卻仍可按確認 ⇒ 只換來一個 403。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyListDialog } from "./CopyListDialog";
import { axiosStatus } from "@/test/http-errors";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const P1 = { id: "p1", name: "P1" };
const P2 = { id: "p2", name: "P2" };

interface MockOpts {
  permissions?: Record<string, string[]>;
  boards?: Record<string, { id: string; name: string; isArchived: boolean }[]>;
  /** 讓 `/projects/{id}/boards` 失敗——用來驗「載入失敗要說出來」。 */
  boardsError?: unknown;
}

async function mockGet(opts: MockOpts = {}) {
  const { api } = await import("@/lib/api");
  const permissions = opts.permissions ?? { p1: ["board.read", "board.edit"] };
  const boards = opts.boards ?? {
    p1: [{ id: "b1", name: "B1", isArchived: false }],
    p2: [{ id: "b2", name: "B2", isArchived: false }],
  };
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/projects") return Promise.resolve({ data: [P1, P2] });
    const projectPerms = /^\/projects\/([^/]+)\/permissions\/mine$/.exec(url);
    if (projectPerms) return Promise.resolve({ data: permissions[projectPerms[1]] ?? [] });
    const projectBoards = /^\/projects\/([^/]+)\/boards$/.exec(url);
    if (projectBoards) {
      if (opts.boardsError) return Promise.reject(opts.boardsError);
      return Promise.resolve({ data: boards[projectBoards[1]] ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
  return api;
}

function renderDialog(props: Partial<Parameters<typeof CopyListDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CopyListDialog
        list={{ id: "l1", name: "L1" }}
        defaults={{ projectId: "p1", boardId: "b1" }}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        pending={false}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onConfirm, dialog: screen.getByTestId("copy-list-dialog") };
}

/** Radix 的下拉在 jsdom 走 click 開啟路徑（同 CopyCardDialog.test.tsx 既有手法）。 */
async function pick(dialog: HTMLElement, label: string, option: string) {
  const trigger = within(dialog).getByLabelText(label);
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  await screen.findAllByRole("option");
  fireEvent.click(screen.getByRole("option", { name: option }));
}

function confirmButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "確定複製" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CopyListDialog 兩層目標選擇", () => {
  it("開啟後專案與看板都預填清單現址", async () => {
    await mockGet();
    const { dialog } = renderDialog();
    await waitFor(() => expect(within(dialog).getByLabelText("目標看板")).toHaveTextContent("B1"));
    expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1");
  });

  // ①：不帶 `targetBoardId` 時後端就地複製回原看板，畫面照樣成功。
  it("直接確認送出清單現址的看板 id", async () => {
    await mockGet();
    const { dialog, onConfirm } = renderDialog();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());

    fireEvent.click(confirmButton(dialog));

    expect(onConfirm).toHaveBeenCalledWith({ projectId: "p1", boardId: "b1" });
  });

  // ②：下拉顯示 P2 的看板、送出的仍是 P1 的看板。
  it("換專案後清空看板並停用，選了新看板才送出新目標", async () => {
    await mockGet({ permissions: { p1: ["board.edit"], p2: ["board.edit"] } });
    const { dialog, onConfirm } = renderDialog();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());

    await pick(dialog, "目標專案", "P2");

    // 換上層一律清下層：看板必須重新選，確認鈕跟著停用
    await waitFor(() => expect(confirmButton(dialog)).toBeDisabled());

    await pick(dialog, "目標看板", "B2");
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());
    fireEvent.click(confirmButton(dialog));

    expect(onConfirm).toHaveBeenCalledWith({ projectId: "p2", boardId: "b2" });
  });

  // 換上層一律清下層，**切回原專案也不會把舊看板還原成已選**（D3）。
  // 這是 `setSelectedBoardId("")` 唯一的判別點：切換當下分不出來——那時的停用是由
  // 「選中的必須在可見選項裡」擋下的（來源與目標的看板集合不同），把那一行拿掉，
  // 上面那一支照樣綠。切回來時才顯形：舊 id 若還在，它又是「可見的」，確認鈕就跟著亮了。
  it("切回原專案時下層仍為空，必須重新選看板", async () => {
    await mockGet({ permissions: { p1: ["board.edit"], p2: ["board.edit"] } });
    const { dialog } = renderDialog();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());

    await pick(dialog, "目標專案", "P2");
    await pick(dialog, "目標專案", "P1");

    expect(within(dialog).getByLabelText("目標看板")).toHaveTextContent("選擇看板");
    await waitFor(() => expect(confirmButton(dialog)).toBeDisabled());
  });

  // ③：來源看板封存 ⇒ 它不列在選項中；少了「選中的必須可見」這一條就會送出
  // 畫面上看不到的目標（而後端照樣成功）。
  it("來源看板已封存時確認鈕停用", async () => {
    await mockGet({ boards: { p1: [{ id: "b1", name: "B1", isArchived: true }] } });
    const { dialog, onConfirm } = renderDialog();

    await waitFor(() => expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1"));
    await waitFor(() => expect(confirmButton(dialog)).toBeDisabled());
    fireEvent.click(confirmButton(dialog));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("CopyListDialog 目標側權限", () => {
  // ④：清單複製的後端授權看**目標看板所屬專案**的 board.edit（不是 list.create——沒有這個碼）。
  it("目標專案缺 board.edit 時確認鈕停用並顯示說明", async () => {
    await mockGet({ permissions: { p2: ["board.read"] } });
    const { dialog, onConfirm } = renderDialog();
    await pick(dialog, "目標專案", "P2");

    await waitFor(() =>
      expect(within(dialog).getByText("你沒有在該專案編輯看板的權限")).toBeInTheDocument(),
    );
    expect(confirmButton(dialog)).toBeDisabled();
    fireEvent.click(confirmButton(dialog));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // 正向對照：少了這一支，上面那支在「查詢根本沒回來」時也會綠。
  it("目標專案有 board.edit 時確認鈕可用且不顯示說明", async () => {
    await mockGet();
    const { dialog } = renderDialog();
    await waitFor(() => expect(within(dialog).getByLabelText("目標看板")).toHaveTextContent("B1"));

    expect(confirmButton(dialog)).toBeEnabled();
    expect(within(dialog).queryByText("你沒有在該專案編輯看板的權限")).toBeNull();
  });
});

describe("CopyListDialog 載入失敗", () => {
  // 失敗必須說出來：少了這一行的話，它長得跟「沒有東西可選」一模一樣
  // （空的選項 ＋ 停用的確認鈕），而 `showNoPermission` 只在 isSuccess 時顯示。
  it("看板清單載入失敗時顯示錯誤訊息，而不是靜默停用", async () => {
    await mockGet({
      boardsError: axiosStatus(404, { code: "board.notFound", message: "SERVER-RAW" }),
    });
    const { dialog } = renderDialog();

    await waitFor(() =>
      expect(within(dialog).getByText("載入失敗：找不到這個看板，可能已被刪除")).toBeInTheDocument(),
    );
    expect(confirmButton(dialog)).toBeDisabled();
  });
});

describe("CopyListDialog 收尾", () => {
  it("送出中吞掉關閉請求", async () => {
    await mockGet();
    const { dialog, onOpenChange } = renderDialog({ pending: true });
    await waitFor(() => expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1"));

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
