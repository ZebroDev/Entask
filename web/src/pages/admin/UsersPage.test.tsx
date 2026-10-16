import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import UsersPage from "./UsersPage";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const USERS = [
  { userId: "u1", username: "alice", displayName: "陳美惠", avatarUrl: null, isAdmin: true, deactivatedAt: null, deletedAt: null },
  { userId: "u2", username: "bob", displayName: "林大文", avatarUrl: null, isAdmin: false, deactivatedAt: "2026-10-01T00:00:00Z", deletedAt: null },
  // 已刪除者：兩個時間欄位都有值（後端刪除的前提是先停用）。username 在真實後端
  // 已被換成 `deleted-…` 佔位符，這裡留原帳號名不影響任何斷言。
  { userId: "u3", username: "carol", displayName: "張小華", avatarUrl: null, isAdmin: false, deactivatedAt: "2026-09-01T00:00:00Z", deletedAt: "2026-09-20T00:00:00Z" },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("UsersPage", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.delete).mockReset();
    vi.mocked(api.get).mockResolvedValue({ data: USERS });
  });

  it("列出全部使用者，含已停用的", async () => {
    renderPage();
    expect(await screen.findByText("陳美惠")).toBeTruthy();
    expect(screen.getByText("林大文")).toBeTruthy();
  });

  it("已停用者顯示徽章，且提供復原與刪除", async () => {
    renderPage();
    await screen.findByText("林大文");
    const row = screen.getByText("林大文").closest("tr")!;
    expect(row.textContent).toContain("已停用");
    expect(row.textContent).toContain("復原");
    expect(row.textContent).toContain("刪除");
  });

  it("啟用中者只有停用，沒有刪除", async () => {
    renderPage();
    await screen.findByText("陳美惠");
    const row = screen.getByText("陳美惠").closest("tr")!;
    expect(row.textContent).toContain("停用");
    expect(row.textContent).not.toContain("復原");
  });

  it("篩選已停用只留下已停用者", async () => {
    renderPage();
    await screen.findByText("陳美惠");
    screen.getByRole("button", { name: "已停用" }).click();
    await waitFor(() => expect(screen.queryByText("陳美惠")).toBeNull());
    expect(screen.getByText("林大文")).toBeTruthy();
  });

  // 設計 §4.9：「按鈕依狀態：啟用中 `[停用]`；已停用 `[復原]` `[刪除]`；已刪除 `—`」。
  // 已刪除的帳號資料已經清掉了，三個動作對它都是 400——把鈕留在畫面上就是三個必失敗的入口。
  it("已刪除者沒有任何動作鈕，動作欄是破折號", async () => {
    renderPage();
    await screen.findByText("張小華");
    const row = screen.getByText("張小華").closest("tr")!;
    expect(row.textContent).toContain("已刪除");
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(row.textContent).toContain("—");
  });

  // F-1 的迴歸鎖：成功之後框要關。少了 `setReactivating(null)` 的實作會停在
  // 「POST 送出了、框還開著」——畫面看起來像什麼都沒發生，再點一次就再送一次
  // （後端冪等，但會多跳一次 toast）。
  it("復原：確認後送出 POST 到 reactivate，而且對話框關閉", async () => {
    renderPage();
    const row = (await screen.findByText("林大文")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "復原" }));

    const dialog = await screen.findByRole("alertdialog");
    // 框裡的確認鈕（列上那一顆同名，所以查詢必須限定在框內）
    fireEvent.click(within(dialog).getByRole("button", { name: "復原" }));

    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith("/admin/users/u2/reactivate", {}));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  // B-1（複審，2026-10-08）＋ R2：Step 5 的**接線**原本零覆蓋——`ResetPasswordDialog.test.tsx`
  // 的三支只到對話框層級，列的按鈕接錯 state（例如誤接 `setDeleting`）或**整顆拿掉**時全綠。
  // 形狀照上面那一支 reactivate 的流程鎖。
  //
  // **兩個分支各一格，不是「一格的兩個斷言」**：brief 的 ★ 專門標了停用分支那一顆
  // （後端**允許**對停用者重置，UI 少了它就是 UI 與 API 不一致，而那個不一致沒有任何
  // 地方會響）。走 `it.each` 讓兩格各自是一支測試——**把停用分支那顆鈕拿掉時，紅的
  // 只有「已停用」那一格**（實測見 task-2-report.md 的 R2 段）；反過來也一樣。
  // 兩格都各自跑完整的 render→點→斷言，沒有任何一格的結果是另一格的分母。
  it.each([
    { row: "啟用中", name: "陳美惠", userId: "u1" },
    { row: "已停用", name: "林大文", userId: "u2" },
  ])(
    "重設密碼（$row）：列上那顆鈕為正確的那一列打開對話框，確認後送出 POST 且框關閉",
    async ({ name, userId }) => {
      renderPage();
      const row = (await screen.findByText(name)).closest("tr")!;
      fireEvent.click(within(row).getByRole("button", { name: "重設密碼" }));

      const dialog = await screen.findByRole("alertdialog");
      // 「接得對 state」的那一半：說明句帶的是**這一列**的名字。接成別的 state 時
      // （`setDeleting`／`setDeactivating`）這裡開的是別種對話框，這一格就紅。
      expect(within(dialog).getByText(`將為 ${name} 設定一組臨時密碼。`)).toBeTruthy();

      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Temp1234" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "確認重設" }));

      await waitFor(() =>
        expect(vi.mocked(api.post)).toHaveBeenCalledWith(`/admin/users/${userId}/reset-password`, {
          newPassword: "Temp1234",
        }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    },
  );
});
