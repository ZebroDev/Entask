import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoleEditDialog } from "./RoleEditDialog";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

/** 開對話框並等 `/permissions` 落地（第一組標題出現即代表渲染完成）。 */
async function openWith(permissions: unknown[], firstLabel: string) {
  vi.mocked(api.get).mockResolvedValue({ data: permissions });
  render(<RoleEditDialog teamId="t1" />, { wrapper: makeWrapper() });
  fireEvent.click(screen.getByRole("button", { name: "新增角色" }));
  await screen.findByText(firstLabel);
}

describe("RoleEditDialog 權限分類", () => {
  beforeEach(() => vi.clearAllMocks());

  it("分組標題由權限碼的分類決定", async () => {
    await openWith(
      [
        { code: "team.read", category: "團隊", description: "檢視團隊" },
        { code: "card.read", category: "卡片", description: "檢視卡片" },
      ],
      "團隊",
    );

    expect(screen.getByText("團隊")).toBeInTheDocument();
    expect(screen.getByText("卡片")).toBeInTheDocument();
  });

  // 後端 `Permission.Category` 是寫進 DB 的顯示字。它在 P-C 在地化之後會隨語系改變
  // ——若前端拿它當分組鍵，切一次語系就會多出一組分組，而 zh-TW 的測試看不出來
  // （GanttTab 的 UNASSIGNED 同一個坑）。這支釘住的是「鍵與標題都跟著權限碼走」。
  it("後端換掉分類顯示字也不影響分組", async () => {
    await openWith([{ code: "card.read", category: "Cards", description: "檢視卡片" }], "卡片");

    expect(screen.getByText("卡片")).toBeInTheDocument();
    expect(screen.queryByText("Cards")).not.toBeInTheDocument();
  });
});

describe("RoleEditDialog 權限說明", () => {
  beforeEach(() => vi.clearAllMocks());

  // 23 筆權限說明的迴歸鎖。zh-TW 逐字沿用 PermissionSeed 的 Description（可見輸出變化為零），
  // 但**這一支不與 seed 綁定**——它驗的是「每個 code 都渲染得出來、非空、且不是裸 key」，
  // 所以文案日後可以自由改寫（把值綁進測試等於禁止改字）。
  //
  // fixture **刻意省略 `description`**：舊程式碼渲染的正是後端 `PermissionDto.description`，
  // 餵了它這 23 支在改動前就會是綠的——那驗到的是「後端有回什麼」，不是「前端讀了什麼」。
  // 等待條件用分組標題（由權限碼第一段經 categoryLabel 產生），改動前後都存在，
  // RED 與 GREEN 兩態都等得到。
  it.each([
    ["team.read", "檢視團隊", "團隊"],
    ["team.member.manage", "管理團隊成員", "團隊"],
    ["team.role.manage", "定義團隊角色", "團隊"],
    ["project.read", "檢視專案", "專案"],
    ["project.create", "建立專案", "專案"],
    ["project.edit", "編輯專案", "專案"],
    ["project.delete", "刪除專案", "專案"],
    ["project.member.manage", "管理專案成員", "專案"],
    ["board.read", "檢視看板", "看板"],
    ["board.create", "建立看板", "看板"],
    ["board.edit", "編輯看板", "看板"],
    ["board.delete", "刪除看板", "看板"],
    ["card.read", "檢視卡片", "卡片"],
    ["card.create", "建立卡片", "卡片"],
    ["card.edit", "編輯卡片", "卡片"],
    ["card.delete", "刪除卡片", "卡片"],
    ["card.assign", "指派卡片", "卡片"],
    ["card.review", "審查卡片", "卡片"],
    ["card.rate", "填寫審查評分", "卡片"],
    ["card.comment", "留言", "卡片"],
    ["card.effort.update", "更新工時與進度", "卡片"],
    ["mindmap.edit", "編輯心智圖節點", "心智圖"],
    ["report.view", "檢視績效報表", "報表"],
  ])("%s 的說明渲染為譯文", async (code, label, group) => {
    await openWith([{ code, category: group }], group);

    expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(`permission:${code}`)).not.toBeInTheDocument();
  });
});
