import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeleteUserDialog } from "./DeleteUserDialog";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

// 顯示名稱帶**尾隨空白**——這是一個真的存得進去的值（後端建立帳號時只驗非空，
// 不 trim），而畫面上那個空白看不見。
const USER = { userId: "u3", displayName: "王大明 " };

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeleteUserDialog user={USER} onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

// 這一格守的是「送得出去」：比對若寫成逐字（`typed !== user.displayName`），
// 使用者照著畫面打「王大明」永遠不等於「王大明 」，確認鈕就**永遠**是 disabled 的
// ——而畫面上沒有任何東西可以讓他知道少了什麼。
describe("DeleteUserDialog 的打字確認", () => {
  it("打畫面上看得到的名字（去尾隨空白）就啟用確認鈕；打錯的名字不啟用", () => {
    renderDialog();
    const confirm = screen.getByRole("button", { name: "刪除" });
    const input = screen.getByRole("textbox");

    // 空字串不算打對（否則這一格在「比對被整個拿掉」的實作下也會過）
    expect(confirm).toBeDisabled();

    // 反例：只是**接近**不算——少了這一格，「trim 後相等」與「前綴就放行」分不開
    fireEvent.change(input, { target: { value: "王大明二" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: "王大明" } });
    expect(confirm).toBeEnabled();
  });
});
