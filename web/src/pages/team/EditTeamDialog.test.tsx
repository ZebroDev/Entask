import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AxiosError, type AxiosResponse } from "axios";
import { toast } from "sonner";
import { EditTeamDialog } from "./EditTeamDialog";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn(), get: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const TEAM = { id: "t1", name: "核心研發團隊", description: null };

// P-C 之後的錯誤 body：{ code, message }。用真的 AxiosError 帶 response，
// 與 axios 在 400 時實際丟出來的形狀一致（同 board-ux.test.tsx 的 axios400）。
function axios400(body: unknown): AxiosError {
  return new AxiosError(
    "Request failed with status code 400",
    undefined,
    undefined,
    undefined,
    {
      status: 400,
      statusText: "Bad Request",
      data: body,
      headers: {},
      config: { headers: undefined },
    } as unknown as AxiosResponse,
  );
}

// 崩潰類回歸。錯誤 body 自 P-C 起是 { code, message } 物件，而 sonner 的
// toast.error 收 ReactNode——把整個 body 傳進去 tsc 不會紅，React 直到渲染才拋
// 「Objects are not valid as a React child」（全站無 ErrorBoundary，直接白畫面）。
// 這一支守住的是**崩潰**那一類（把 body 物件傳進 toast.error）；「onError 有沒有走
// apiErrorMessage、認得錯誤碼並顯示譯文」是另一類，前端還有很多站點沒走（見 AGENTS.md 殘餘）。
// 兩層斷言：字串斷言驗「譯文有沒有接上」，typeof 斷言驗「傳進去的是不是字串」
// ——後者才擋得住「換成另一個物件」與「換錯譯文」兩種改法。
describe("EditTeamDialog 錯誤處理", () => {
  beforeEach(() => vi.clearAllMocks());

  it("更新團隊失敗時 toast 收到譯文字串而非回應 body 物件", async () => {
    vi.mocked(api.put).mockRejectedValue(
      axios400({ code: "team.nameRequired", message: "團隊名稱不可為空" }),
    );

    render(<EditTeamDialog team={TEAM} trigger={<button>編輯團隊</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "編輯團隊" }));
    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/teams/t1", {
        name: "核心研發團隊",
        description: null,
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("團隊名稱不可為空"));
    expect(typeof vi.mocked(toast.error).mock.calls[0][0]).toBe("string");
  });
});
