import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { CreateTeamDialog } from "./CreateTeamDialog";
import { useAuth } from "@/stores/auth";
import { api } from "@/lib/api";
import { localTimeZoneId } from "@/lib/local-day";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn(), get: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const NEW_TEAM = { id: "t-new", name: "核心研發團隊", description: null };

/**
 * 建立一個團隊，走完「自動把建立者加為團隊經理」那一步。
 *
 * `roles` 是 `/teams/{id}/roles` 的回應。**測試裡刻意讓「團隊經理」的 name 不是中文**
 * ——正式環境的名稱來自 seed，會隨語系改變，而以 name 查正是這次修掉的缺陷：
 * 用 name 查會找不到，然後退回 `roles[0]`（一個由資料庫順序決定的任意角色）。
 */
function startCreate(roles: unknown[]) {
  vi.mocked(api.post).mockResolvedValue({ data: NEW_TEAM });
  vi.mocked(api.get).mockResolvedValue({ data: roles });
  vi.mocked(api.put).mockResolvedValue({ data: {} });

  render(<CreateTeamDialog />);
  fireEvent.click(screen.getByRole("button", { name: "建立團隊" }));
  fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "核心研發團隊" } });
  fireEvent.click(screen.getByRole("button", { name: "確認建立" }));
}

describe("CreateTeamDialog 自動指派團隊經理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "王小明", isAdmin: false },
      tokens: null,
      teamId: null,
    });
  });

  it("以穩定識別碼 team_manager 挑角色，不是以顯示名稱", async () => {
    // team_manager 排在**第二個**，而且 name 不是中文——用 name 查會落空並退回
    // roles[0]（工程師），用 code 查才會拿到 r2。
    startCreate([
      { id: "r1", name: "工程師", isSystem: true, code: "engineer" },
      { id: "r2", name: "Team Manager", isSystem: true, code: "team_manager" },
    ]);

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/teams/t-new/members", {
        username: "alice",
        roleIds: ["r2"],
        timeZoneId: localTimeZoneId(),
      }),
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("查不到 team_manager 時不指派任何角色，並發出警告", async () => {
    // 這是修掉的另一半：原本的 `|| roles[0]` 會把建立者指派成「工程師」，
    // 一個由資料庫順序決定的任意角色，而且完全靜默。
    startCreate([{ id: "r1", name: "工程師", isSystem: true, code: "engineer" }]);

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(api.put).not.toHaveBeenCalled();
  });

  it("指派失敗不阻斷團隊建立", async () => {
    startCreate([{ id: "r1", name: "工程師", isSystem: true, code: "engineer" }]);

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    // 團隊本身建立成功、對話框關閉——警告只是告知，不是失敗。
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/teams", {
      name: "核心研發團隊",
      description: null,
    });
  });
});
