// 看板複製（跨專案目標選擇）的測試。
//
// 這一檔守的是**三條「看起來成功、其實做錯事」的路**——它們全都不會有紅燈，
// 除非有斷言精確盯著送出的 body 與確認鈕的停用條件：
//
//   ① 沒帶 `targetProjectId`（或鍵名寫錯）⇒ 後端 `req.TargetProjectId ?? board.ProjectId`
//      複製回**原專案**，而畫面照樣 toast 成功。
//   ② 下拉顯示 P2 而送出的仍是 P1 ⇒ 同上，且使用者以為自己複製過去了。
//   ③ 目標專案沒有 `board.create` 卻仍可按確認 ⇒ 只換來一個 403（後端授權看目標專案）。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyBoardDialog } from "./CopyBoardDialog";
import { axiosStatus } from "@/test/http-errors";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const P1 = { id: "p1", name: "P1" };
const P2 = { id: "p2", name: "P2" };

async function mockGet(
  opts: {
    permissions?: Record<string, string[]>;
    projects?: { id: string; name: string }[];
    /** 讓 `/projects` 失敗——用來驗「載入失敗要說出來」。 */
    projectsError?: unknown;
  } = {},
) {
  const { api } = await import("@/lib/api");
  const permissions = opts.permissions ?? { p1: ["board.read", "board.create"] };
  const projects = opts.projects ?? [P1, P2];
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/projects") {
      if (opts.projectsError) return Promise.reject(opts.projectsError);
      return Promise.resolve({ data: projects });
    }
    const projectPerms = /^\/projects\/([^/]+)\/permissions\/mine$/.exec(url);
    if (projectPerms) return Promise.resolve({ data: permissions[projectPerms[1]] ?? [] });
    return Promise.resolve({ data: [] });
  });
  return api;
}

function renderDialog(props: Partial<Parameters<typeof CopyBoardDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CopyBoardDialog
        board={{ id: "b1", name: "B1" }}
        defaults={{ projectId: "p1" }}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        pending={false}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onConfirm, dialog: screen.getByTestId("copy-board-dialog") };
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

describe("CopyBoardDialog 目標選擇", () => {
  it("開啟後目標專案預填來源專案", async () => {
    await mockGet();
    const { dialog } = renderDialog();
    await waitFor(() => expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1"));
  });

  // ①：不帶 `targetProjectId` 時後端會複製回原專案而畫面照樣成功。
  // 逐字比對（`expect.anything()` 會讓「忘了帶 body」綠）。
  it("不輸入名稱時送出 { targetProjectId, name: \"\" }", async () => {
    await mockGet();
    const { dialog, onConfirm } = renderDialog();
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());

    fireEvent.click(confirmButton(dialog));

    expect(onConfirm).toHaveBeenCalledWith({ projectId: "p1", name: "" });
  });

  it("名稱為空白字元時 trim 後送出", async () => {
    await mockGet();
    const { dialog, onConfirm } = renderDialog();
    fireEvent.change(within(dialog).getByLabelText("看板名稱（選填）"), { target: { value: "  新板  " } });
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());

    fireEvent.click(confirmButton(dialog));

    expect(onConfirm).toHaveBeenCalledWith({ projectId: "p1", name: "新板" });
  });

  // ②：下拉顯示 P2、送出的仍是 P1 —— 後端只看目標專案的權限，這種錯不會有任何紅燈。
  it("換目標專案後送出新專案", async () => {
    await mockGet({ permissions: { p1: ["board.create"], p2: ["board.create"] } });
    const { dialog, onConfirm } = renderDialog();
    await pick(dialog, "目標專案", "P2");
    await waitFor(() => expect(confirmButton(dialog)).toBeEnabled());

    fireEvent.click(confirmButton(dialog));

    expect(onConfirm).toHaveBeenCalledWith({ projectId: "p2", name: "" });
  });
});

describe("CopyBoardDialog 目標側權限", () => {
  // ③：沒有目標專案的 board.create ⇒ 停用並說明，而不是送出後吃 403。
  it("目標專案缺 board.create 時確認鈕停用並顯示說明", async () => {
    await mockGet({ permissions: { p2: ["board.read"] } });
    const { dialog, onConfirm } = renderDialog();
    await pick(dialog, "目標專案", "P2");

    await waitFor(() => expect(within(dialog).getByText("你沒有在該專案建立看板的權限")).toBeInTheDocument());
    expect(confirmButton(dialog)).toBeDisabled();
    fireEvent.click(confirmButton(dialog));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // 「選中的專案必須在可見選項裡」——少了這一條，trigger 是一片空白而確認鈕照樣可按。
  // （`CopyListDialog` 的同一條由「來源看板已封存」那一支釘住；這一邊沒有封存的概念，
  //   形狀是「來源專案不在 `/projects` 的回應裡」。）
  it("目標專案不在可見選項裡時 trigger 回到 placeholder 且確認鈕停用", async () => {
    await mockGet({ projects: [P2] });
    const { dialog, onConfirm } = renderDialog();

    // Radix 對「有值、但沒有對應選項」的顯示是一片空白 ⇒ 交還 placeholder
    await waitFor(() =>
      expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("選擇專案"),
    );
    await waitFor(() => expect(confirmButton(dialog)).toBeDisabled());
    fireEvent.click(confirmButton(dialog));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // 正向對照：少了這一支，上面那支在「查詢根本沒回來」時也會綠。
  it("目標專案有 board.create 時確認鈕可用且不顯示說明", async () => {
    await mockGet({ permissions: { p1: ["board.create"] } });
    const { dialog } = renderDialog();

    await waitFor(() => expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1"));
    expect(confirmButton(dialog)).toBeEnabled();
    expect(within(dialog).queryByText("你沒有在該專案建立看板的權限")).toBeNull();
  });
});

describe("CopyBoardDialog 載入失敗", () => {
  // 失敗必須說出來：少了這一行的話，它長得跟「沒有東西可選」一模一樣
  // （空的選項 ＋ 停用的確認鈕），而 `showNoPermission` 只在 isSuccess 時顯示。
  // 這一支與 `CopyListDialog` 的同一支是**兩份**：M10 的突變只拿掉這一邊時，
  // 另一邊的測試對它是全盲的（實測：只有一邊時該突變 0 支紅）。
  it("目標專案清單載入失敗時顯示錯誤訊息，而不是靜默停用", async () => {
    await mockGet({
      projectsError: axiosStatus(404, { code: "project.notFound", message: "SERVER-RAW" }),
    });
    const { dialog } = renderDialog();

    await waitFor(() =>
      expect(within(dialog).getByText("載入失敗：找不到這個專案，可能已被刪除")).toBeInTheDocument(),
    );
    expect(confirmButton(dialog)).toBeDisabled();
  });
});

describe("CopyBoardDialog 收尾", () => {
  it("送出中吞掉關閉請求", async () => {
    await mockGet();
    const { dialog, onOpenChange } = renderDialog({ pending: true });
    await waitFor(() => expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1"));

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("未送出時取消會關閉", async () => {
    await mockGet();
    const { dialog, onOpenChange } = renderDialog();
    await waitFor(() => expect(within(dialog).getByLabelText("目標專案")).toHaveTextContent("P1"));

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
