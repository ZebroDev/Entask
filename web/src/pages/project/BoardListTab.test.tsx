import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { BoardListTab } from "./BoardListTab";
import type { BoardSummaryResponse } from "@/lib/board-types";
import { axios400 } from "@/test/http-errors";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const boardsFixture: BoardSummaryResponse[] = [
  {
    id: "b1",
    projectId: "p1",
    name: "開發看板",
    description: "功能研發進度",
    position: "a",
    isArchived: false,
  },
  {
    id: "b2",
    projectId: "p1",
    name: "歷史看板",
    description: "已封存的舊資料",
    position: "b",
    isArchived: true,
  },
];

describe("BoardListTab 看板管理與操作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderTab = (canEdit = true, canDelete = true) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <BoardListTab
            projectId="p1"
            canCreateBoard={true}
            canReadBoard={true}
            canEditBoard={canEdit}
            canDeleteBoard={canDelete}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
  };

  it("渲染進行中看板與已封存看板清單", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: boardsFixture });

    renderTab();

    expect(await screen.findByText("開發看板")).toBeInTheDocument();
    expect(screen.getByText("功能研發進度")).toBeInTheDocument();
    expect(screen.getByText(/已封存看板（1）/)).toBeInTheDocument();
  });

  it("點選編輯資訊可修改看板名稱與描述並送出 PUT", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: boardsFixture });
    vi.mocked(api.put).mockResolvedValue({
      data: { ...boardsFixture[0], name: "新看板名", description: "新描述" },
    });

    renderTab(true, true);

    expect(await screen.findByText("開發看板")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "看板選單" }));

    const editBtn = await screen.findByRole("menuitem", { name: /編輯資訊/ });
    fireEvent.click(editBtn);

    expect(screen.getByText("編輯看板資訊")).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/看板名稱/);
    const descInput = screen.getByLabelText(/看板描述/);

    fireEvent.change(nameInput, { target: { value: "新看板名" } });
    fireEvent.change(descInput, { target: { value: "新描述" } });

    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/boards/b1", {
        name: "新看板名",
        description: "新描述",
      });
    });
  });

  it("點選封存看板送出 PUT isArchived true", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: boardsFixture });
    vi.mocked(api.put).mockResolvedValue({
      data: { ...boardsFixture[0], isArchived: true },
    });

    renderTab(true, true);

    expect(await screen.findByText("開發看板")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "看板選單" }));

    const archiveBtn = await screen.findByRole("menuitem", { name: /封存看板/ });
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/boards/b1", {
        isArchived: true,
      });
    });
  });

  it("點選刪除看板顯示確認對話框，確認後呼叫 DELETE", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: boardsFixture });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });

    renderTab(true, true);

    expect(await screen.findByText("開發看板")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "看板選單" }));

    const deleteMenuItem = await screen.findByRole("menuitem", { name: /刪除看板/ });
    fireEvent.click(deleteMenuItem);

    expect(await screen.findByText("確定要刪除看板嗎？")).toBeInTheDocument();
    expect(screen.getByText(/刪除「開發看板」將會一併移除/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "確定刪除" }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("/boards/b1");
    });
  });

  // 錯誤路徑收斂（2026-09-19）：載入失敗的內嵌文字走 `apiErrorMessage`，
  // 不是 `(boards.error as Error).message`（那對 axios 而言是傳輸層字串）。
  it("載入失敗時顯示錯誤碼的譯文，不是傳輸層字串", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockRejectedValue(
      axios400({ code: "board.nameRequired", message: "SERVER-RAW" }),
    );

    renderTab();

    expect(await screen.findByText("載入失敗：看板名稱不可為空")).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code/)).not.toBeInTheDocument();
  });

  // 這支是**巢狀 `t()` 地雷**的判別依據：fallback `t("common:error.tryLater")` 是內層呼叫，
  // 若它被 `i18next-parser` 漏抽、`keepRemoved: false` 再把它從語系檔刪掉，這裡就會
  // 逐字印出 `common:error.tryLater` 這串 key——畫面壞掉，而 `tsc -b`、vitest、parity 全綠。
  //
  // 餵普通物件是為了**直接**走到 fallback（沒有 `response` 就沒有伺服器訊息），
  // 不是在斷言「只有非 Error 才走得到」。原本的理由是「`AxiosError` **本身就是 `Error`**，
  // 會先被 `apiErrorMessage` 的 `error.message` 那一行接走」——那一行已於 2026-09-19 的
  // F-1 拿掉（見 `error-messages.test.ts` 的那一組），空 body 的 `AxiosError` 現在也走同一條路。
  it("認不得的失敗退回 fallback 譯文，不是 key 本身", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockRejectedValue({});

    renderTab();

    expect(await screen.findByText("載入失敗：請稍後重試")).toBeInTheDocument();
    expect(screen.queryByText(/common:error\.tryLater/)).not.toBeInTheDocument();
  });
});
