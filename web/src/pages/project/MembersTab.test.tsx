import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, type AxiosResponse } from "axios";
import { toast } from "sonner";
import { MembersTab } from "./MembersTab";
import { api } from "@/lib/api";
import { localTimeZoneId } from "@/lib/local-day";
import { setLocale } from "@/i18n";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// P-C 之後的錯誤 body：{ code, message }。用真的 AxiosError 帶 response，與 axios 在
// 409 時實際丟出來的形狀一致（同 EditTeamDialog.test.tsx 的 axios400）。`message` 是
// **傳輸層字串**——正是「讀 error.message 就看不到伺服器訊息」的陷阱所在。
function axios409(body: unknown): AxiosError {
  return new AxiosError(
    "Request failed with status code 409",
    undefined,
    undefined,
    undefined,
    {
      status: 409,
      statusText: "Conflict",
      data: body,
      headers: {},
      config: { headers: undefined },
    } as unknown as AxiosResponse,
  );
}

function renderTab(canManage = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MembersTab projectId="p1" canManage={canManage} />
    </QueryClientProvider>
  );
}

describe("MembersTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染成員名稱與指派角色徽章", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1/members") {
        return Promise.resolve({
          data: [
            {
              userId: "u1",
              username: "alice",
              displayName: "愛麗絲",
              roles: [
                { id: "r1", name: "專案經理" },
                { id: "r2", name: "工程師" },
              ],
              roleIds: ["r1", "r2"],
            },
          ],
        });
      }
      if (url === "/projects/p1") {
        return Promise.resolve({
          data: { id: "p1", teamId: "t1", name: "專案 1", memberCount: 1, boardCount: 1, createdAt: "" },
        });
      }
      return Promise.reject(new Error("not found"));
    });

    renderTab(true);

    expect(await screen.findByText("愛麗絲（alice）")).toBeInTheDocument();
    expect(screen.getByText("專案經理")).toBeInTheDocument();
    expect(screen.getByText("工程師")).toBeInTheDocument();
    expect(screen.getByText("編輯角色")).toBeInTheDocument();
  });

  // ===== 2026-10-08：系統角色名走語系檔（state/31）=====
  //
  // 這一支是**唯一**看得到 `ProjectMemberRoleDto.Code`（`GET /projects/{id}/members` 的
  // roles[]）有沒有真的從後端走到畫面的斷言：另外兩頁的角色來源是 `TeamRoleResponse`，
  // 那個 DTO 本來就有 `Code`。前端型別是 `as ProjectMemberResponse[]` 的斷言，後端少送
  // `code` 時 `tsc -b` 不會紅、`check:labels` 也只看得到六個 code ↔ 六條 case。
  //
  // 以 `en` 執行是刻意的：zh-TW 之下「譯文」與「種子 Name」逐字相同（`專案經理` 兩邊都是），
  // 這條路徑在那裡**分不出**修好與沒修好。
  it("系統角色的 code 在 en 之下渲染成譯文，自訂角色原樣顯示 DB 名", async () => {
    await setLocale("en");
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1/members") {
        return Promise.resolve({
          data: [
            {
              userId: "u1",
              username: "alice",
              displayName: "愛麗絲",
              roles: [
                { id: "r1", name: "專案經理", code: "project_manager" },
                { id: "r2", name: "資料科學家", code: null },
              ],
              roleIds: ["r1", "r2"],
            },
          ],
        });
      }
      return Promise.reject(new Error("not found"));
    });

    renderTab(false);

    // en 的人員格式是半形括號（`common:member.display`）——與 zh-TW 的全形括號不同，
    // 這一格同時證明語系真的切過去了。
    expect(await screen.findByText("愛麗絲 (alice)")).toBeInTheDocument();
    expect(screen.getByText("Project Manager")).toBeInTheDocument();
    // 自訂角色沒有 code ⇒ 走 default 分支回傳 DB 名，不得被翻成任何譯文
    expect(screen.getByText("資料科學家")).toBeInTheDocument();
    // 判別器：修好之前這一格印的是後端來的 Name（`專案經理`），而它與 en 的譯文不同。
    expect(screen.queryByText("專案經理")).not.toBeInTheDocument();
  });

  it("點擊編輯角色可調整角色並呼叫 PUT 更新", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1/members") {
        return Promise.resolve({
          data: [
            {
              userId: "u1",
              username: "alice",
              displayName: "愛麗絲",
              roles: [
                { id: "r1", name: "專案經理" },
              ],
              roleIds: ["r1"],
            },
          ],
        });
      }
      if (url === "/projects/p1") {
        return Promise.resolve({
          data: { id: "p1", teamId: "t1", name: "專案 1", memberCount: 1, boardCount: 1, createdAt: "" },
        });
      }
      if (url === "/teams/t1") {
        return Promise.resolve({
          data: {
            id: "t1",
            name: "團隊 1",
            members: [],
            roles: [
              { id: "r1", name: "專案經理", isSystem: true, permissionCodes: [] },
              { id: "r2", name: "工程師", isSystem: true, permissionCodes: [] },
            ],
          },
        });
      }
      return Promise.reject(new Error("not found"));
    });
    vi.mocked(api.put).mockResolvedValue({ data: {} });

    renderTab(true);

    const editBtn = await screen.findByText("編輯角色");
    fireEvent.click(editBtn);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("編輯成員角色")).toBeInTheDocument();
    expect(within(dialog).getByText("專案經理")).toBeInTheDocument();

    // 勾選工程師
    const checkboxes = within(dialog).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    // r1 已勾選
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();

    fireEvent.click(checkboxes[1]);
    expect(checkboxes[1]).toBeChecked();

    const saveBtn = within(dialog).getByText("儲存角色");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith("/projects/p1/members/u1", {
        roleIds: expect.arrayContaining(["r1", "r2"]),
        timeZoneId: localTimeZoneId(),
      });
    });
  });

  // 這條路是前端**唯一**到得了 `project.memberInUse` 那條 409 的路徑：另兩條（指派成員
  // 對話框、編輯角色對話框）都被前端自己的「角色不可為空」驗證先擋住。
  // 讀 `error.message` 的話，toast 顯示的是 axios 的傳輸層字串
  // （`Request failed with status code 409`），伺服器說的那句話永遠到不了使用者。
  it("移除成員被 409 擋下時 toast 收到譯文字串而非傳輸層訊息", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1/members") {
        return Promise.resolve({
          data: [
            {
              userId: "u1",
              username: "alice",
              displayName: "愛麗絲",
              roles: [{ id: "r1", name: "工程師" }],
              roleIds: ["r1"],
            },
          ],
        });
      }
      return Promise.reject(new Error("not found"));
    });
    // `params` 是這一條的重點：zh-TW 的譯文是樣板（`…本專案的 {{refs}} 張卡片…`），
    // 後端 409 送 `@params = new { refs }`。少了 params，`i18n.t` 會原樣印出 `{{refs}}`
    // ——下面的斷言就是那個實作的分辨器（`ProjectEndpoints.MemberInUseGuardAsync`）。
    vi.mocked(api.delete).mockRejectedValue(
      axios409({
        code: "project.memberInUse",
        message: "此成員仍指派於本專案的 3 張卡片，請先從卡片移除",
        params: { refs: 3 },
      }),
    );

    renderTab(true);

    fireEvent.click(await screen.findByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/projects/p1/members/u1"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("此成員仍指派於本專案的 3 張卡片，請先從卡片移除"));
    expect(typeof vi.mocked(toast.error).mock.calls[0][0]).toBe("string");
  });

  // T7 的五個寫入站點之一（`POST /projects/{id}/members`）：`timeZoneId` 是發起人時區，
  // 後端用它凍結新成員的到職本地日。這一站在本批之前**沒有任何斷言看得到**——少了這支，
  // 站點上那一行拿掉是全綠的（T3 審查對後端同型缺口（站 3 無斷言）裁定 Needs fixes）。
  it("指派成員時 body 帶發起人時區", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/projects/p1/members") return Promise.resolve({ data: [] });
      if (url === "/projects/p1") {
        return Promise.resolve({
          data: { id: "p1", teamId: "t1", name: "專案 1", memberCount: 0, boardCount: 0, createdAt: "" },
        });
      }
      if (url === "/teams/t1") {
        return Promise.resolve({
          data: {
            id: "t1",
            name: "團隊 1",
            members: [{ userId: "u1", username: "alice", displayName: "愛麗絲", roles: [], deactivated: false }],
            roles: [{ id: "r1", name: "專案經理", isSystem: true, permissionCodes: [] }],
          },
        });
      }
      return Promise.reject(new Error("not found"));
    });
    vi.mocked(api.post).mockResolvedValue({ data: {} });

    renderTab(true);

    fireEvent.click(await screen.findByRole("button", { name: "指派成員" }));
    const dialog = await screen.findByRole("dialog");

    // Radix Select：點 trigger（role=combobox）開啟 popup，再點 option（同 CustomFieldsTab.test.tsx）
    fireEvent.click(within(dialog).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "愛麗絲（alice）" }));
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "確認指派" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/members", {
        userId: "u1",
        roleIds: ["r1"],
        timeZoneId: localTimeZoneId(),
      }),
    );
  });
});
