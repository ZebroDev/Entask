// 「重設密碼」對話框的測試（2026-10-08 admin 密碼重置階段，Task 2）。
//
// 形狀照 `DeleteUserDialog.test.tsx`：同一個 `api` mock 寫法、同一個
// `QueryClientProvider` 包法。**失敗 fixture 走 `src/test/http-errors.ts` 的
// `axios400`**，不用裸 `new Error`——裸 `Error.message` 與 `apiErrorMessage`
// 可能回傳同一個字串，三種實作分不開、測試恆綠（該檔檔頭有完整的實測理由）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { axios400 } from "@/test/http-errors";
import { ResetPasswordDialog } from "./ResetPasswordDialog";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const USER = { userId: "u3", displayName: "王大明" };

type Userish = { userId: string; displayName: string } | null;

/**
 * 受控外殼：把 `onOpenChange` 的回報真的接回 `user`（框真的會關），同時記進外面的 spy。
 *
 * **`if (!open) setUser(null)` 那一行不是裝飾。** Radix 的 `AlertDialogAction` 就是
 * `Dialog.Close`，少了 `e.preventDefault()` 的實作會回報 `onOpenChange(false)`；
 * 回寫 state 之後，「失敗時對話框不關閉」那一格量到的**是 DOM**——框還在不在。
 * 不回寫的話 `open` 永遠是 `true`，那一格恆真，只剩 `onOpenChange` 那一行斷言在擋。
 *
 * 實測（突變：拿掉 `e.preventDefault()`，見 task-2-report.md）：突變後 `<body>`
 * 只剩一個空 `<div>`，紅燈是 `Unable to find an accessible element with the role
 * "alertdialog"`——本檔那一格量到的確實是框的去留。
 */
function Harness({ initialUser, onOpenChange }: { initialUser: Userish; onOpenChange: (open: boolean) => void }) {
  const [user, setUser] = useState<Userish>(initialUser);
  return (
    <ResetPasswordDialog
      user={user}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (!open) setUser(null);
      }}
    />
  );
}

function renderDialog(initialUser: Userish, onOpenChange: (open: boolean) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness initialUser={initialUser} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

describe("ResetPasswordDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("沒有使用者時不顯示；給定使用者時顯示標題與說明", () => {
    const empty = renderDialog(null);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    empty.unmount();

    renderDialog(USER);
    expect(screen.getByText("重設密碼")).toBeTruthy();
    expect(screen.getByText("將為 王大明 設定一組臨時密碼。")).toBeTruthy();
  });

  it("送出臨時密碼後 POST 到 reset-password；成功時跳 toast 並關閉對話框", async () => {
    vi.mocked(api.post).mockResolvedValue({});
    const onOpenChange = vi.fn();
    renderDialog(USER, onOpenChange);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Temp1234" } });
    fireEvent.click(screen.getByRole("button", { name: "確認重設" }));

    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith("/admin/users/u3/reset-password", {
        newPassword: "Temp1234",
      }),
    );

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已重設密碼"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  // 這一格與上一格合起來才是「成敗分岔」：兩支都只證明「有跳 toast」的話，
  // 把失敗路徑寫成成功路徑（或反過來）也全綠。
  it("送出失敗時走 apiErrorMessage 的譯文，且對話框不關閉", async () => {
    vi.mocked(api.post).mockRejectedValue(
      axios400({ code: "identity.passwordTooShort", message: "SERVER-RAW" }),
    );
    const onOpenChange = vi.fn();
    renderDialog(USER, onOpenChange);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "確認重設" }));

    const { toast } = await import("sonner");
    // 三種實作分得開的那個字串：直接讀 `error.message` 會是
    // "Request failed with status code 400"、只讀伺服器原文會是 "SERVER-RAW"、
    // 退回 fallback 會是 "重設密碼失敗，請稍後再試"——三者都不是這一個。
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("密碼長度不足"));
    expect(toast.success).not.toHaveBeenCalled();

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
