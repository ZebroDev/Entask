import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { TeamMembersTab } from "./TeamMembersTab";
import { api } from "@/lib/api";
import { setLocale } from "@/i18n";
import { useAuth } from "@/stores/auth";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TeamMembersTab teamId="t1" />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

const teamWithMember = {
  data: {
    id: "t1", name: "研發部",
    members: [{ userId: "u1", username: "carol", displayName: "陳助理", roles: [
      { id: "r1", name: "工程師", isSystem: true, permissionCodes: [] },
    ]}],
    roles: [],
  },
};

// 兩組測試共用：這一頁的兩個管理入口（「指派成員」與列內「移除」）吃**同一個**判準
// （`useCanManageTeamMembers`）⇒ 都需要「登入 ＋ 權限碼」才看得到。
function mockApi(codes: string[]) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.includes("/my-permissions")) return Promise.resolve({ data: [{ teamId: "t1", codes }] });
    if (url.includes("/roles")) return Promise.resolve({ data: [] });
    return Promise.resolve(teamWithMember);
  });
}

function signIn(isAdmin: boolean) {
  useAuth.setState({ user: { userId: "u9", username: "erin", displayName: "艾琳", isAdmin } });
}

// auth store 是模組層級的，不回歸會污染同檔後面（與別檔）的測試。
// 放在檔尾層級而不是某一個 describe 裡：**每一支**碰它的測試都適用。
afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

describe("TeamMembersTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("列出成員與其多個角色", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.includes("/roles")) {
        return Promise.resolve({
          data: [
            { id: "r1", name: "工程師", isSystem: true, permissionCodes: [] },
            { id: "r2", name: "專案助理", isSystem: true, permissionCodes: [] },
          ],
        });
      }
      return Promise.resolve({
        data: {
          id: "t1", name: "研發部",
          members: [{ userId: "u1", username: "carol", displayName: "陳助理", roles: [
            { id: "r1", name: "工程師", isSystem: true, permissionCodes: [] },
            { id: "r2", name: "專案助理", isSystem: true, permissionCodes: [] },
          ]}],
          roles: [],
        },
      });
    });

    renderTab();

    expect(await screen.findByText("陳助理（carol）")).toBeInTheDocument();
    expect(await screen.findByText("工程師")).toBeInTheDocument();
    expect(await screen.findByText("專案助理")).toBeInTheDocument();
  });

  it("載入失敗時顯示錯誤訊息", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("network error"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <TeamMembersTab teamId="t1" />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText("載入失敗，請稍後再試")).toBeInTheDocument();
  });
});

// ===== P3 Task 5：#20 移除成員確認流程 =====
describe("TeamMembersTab 移除成員確認", () => {
  beforeEach(() => vi.clearAllMocks());

  // 2026-09-23：列內「移除」鈕與「指派成員」入口吃**同一個**判準 ⇒ 這兩支要**先登入並具
  // team.member.manage**，否則按鈕不渲染、`findByRole` 只會逾時（原本這兩支沒有登入）。
  // 連帶：`AssignMemberDialog` 現在跟著渲染，而它在**掛載時**就會打 `/teams/t1/roles`
  // ⇒ 共用的 `mockApi` 那個分支重新有了消費者（在此之前是為了不動 mock 形狀才留著）。
  it("移除前顯示確認對話框，取消不呼叫 API", async () => {
    mockApi(["team.read", "team.member.manage"]);
    signIn(false);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(api.delete).not.toHaveBeenCalled());
  });

  it("確認後才呼叫 DELETE 移除該成員", async () => {
    mockApi(["team.read", "team.member.manage"]);
    signIn(false);
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/teams/t1/members/u1"));
  });
});

// ===== 2026-09-23：指派成員入口的權限閘門 =====
// `AssignMemberDialog` 唯一的資料來源是 `GET /api/auth/users`，而該端點已收緊為
// admin 或該團隊的 `team.member.manage`。**`RequireTeamManagement` 閘的是 `team.read`**
// ⇒ 只有 team.read 的成員進得來這一頁（看得見成員清單），卻不該看到這個入口。
// 這三支的分野就是「判準用 team.read 還是 team.member.manage」。
describe("TeamMembersTab 指派成員入口的權限閘門", () => {
  beforeEach(() => vi.clearAllMocks());

  it("只有 team.read 的成員看得到成員清單，但看不到指派入口", async () => {
    mockApi(["team.read"]);
    signIn(false);
    renderTab();

    expect(await screen.findByText("陳助理（carol）")).toBeInTheDocument();
    // 先確認權限查詢真的發生過，否則「按鈕不在」可能只是它還沒跑完
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/teams/my-permissions"));
    expect(screen.queryByRole("button", { name: "指派成員" })).not.toBeInTheDocument();
  });

  it("具 team.member.manage 的成員看得到指派入口", async () => {
    mockApi(["team.read", "team.member.manage"]);
    signIn(false);
    renderTab();

    expect(await screen.findByRole("button", { name: "指派成員" })).toBeInTheDocument();
  });

  it("admin 看得到指派入口（不需查權限）", async () => {
    mockApi([]);
    signIn(true);
    renderTab();

    expect(await screen.findByRole("button", { name: "指派成員" })).toBeInTheDocument();
  });
});

// ===== 2026-09-23：列內「移除」鈕的權限閘門 =====
// 與上面那一組**同一個判準**（`useCanManageTeamMembers`）：`DELETE
// /api/teams/{teamId}/members/{userId}` 要的是 `team.member.manage`，而進來這一頁的
// `RequireTeamManagement` 只閘 `team.read` ⇒ 只有 team.read 的成員**進得來、但看到的是
// 唯讀清單**（使用者 2026-09-23 裁定的產品行為，不是防禦性冗餘）。
describe("TeamMembersTab 移除鈕的權限閘門", () => {
  beforeEach(() => vi.clearAllMocks());

  it("只有 team.read 的成員看不到移除鈕", async () => {
    mockApi(["team.read"]);
    signIn(false);
    renderTab();

    expect(await screen.findByText("陳助理（carol）")).toBeInTheDocument();
    // 先確認權限查詢真的發生過，否則「按鈕不在」可能只是它還沒跑完
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/teams/my-permissions"));
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
  });
});

// ===== 2026-10-08：系統角色名走語系檔（state/31）=====
// 徽章的來源是 `GET /teams/{teamId}` 的 `members[].roles`（`TeamRoleResponse`，它**本來就有
// `Code`**）——所以這一頁的缺陷不是「後端沒送」，是「前端只拿 Name 渲染」。既有那 2,344 行
// 斷言全在 zh-TW 之下，而種子的 Name 就是中文 ⇒ 中文畫面看起來一直是對的，en 使用者看到的
// 卻是種子裡的中文。這一支是本檔（也是全庫）唯一以 en 執行這一頁的斷言。
describe("TeamMembersTab 系統角色名走語系檔", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  it("有 code 的系統角色在 en 之下顯示譯文；沒有 code 或 code 認不得的原樣顯示 DB 名", async () => {
    await setLocale("en");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.includes("/roles")) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: {
          id: "t1", name: "R&D",
          members: [{ userId: "u1", username: "carol", displayName: "Carol", roles: [
            { id: "r1", name: "工程師", code: "engineer", isSystem: true, permissionCodes: [] },
            { id: "r2", name: "資料科學家", code: null, isSystem: false, permissionCodes: [] },
            { id: "r3", name: "未來的角色", code: "future_role", isSystem: true, permissionCodes: [] },
          ]}],
          roles: [],
        },
      });
    });

    renderTab();

    // ① 六個系統 code 之一 ⇒ 走語系檔
    expect(await screen.findByText("Engineer")).toBeInTheDocument();
    // ② 自訂角色沒有 code ⇒ 走 default 回傳 DB 名（不得被翻成任何譯文）
    expect(screen.getByText("資料科學家")).toBeInTheDocument();
    // ③ code 存在但不在六個之內（後端先加了角色、語系還沒跟上）⇒ 同樣退回 DB 名
    expect(screen.getByText("未來的角色")).toBeInTheDocument();
    // 判別器：修好之前這三個徽章印的**都是** DB 名（上面那兩個中文），所以這一句會紅。
    expect(screen.queryByText("工程師")).not.toBeInTheDocument();
  });
});
