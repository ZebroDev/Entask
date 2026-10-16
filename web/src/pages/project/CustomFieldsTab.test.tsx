import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomFieldsTab } from "./CustomFieldsTab";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fieldFixture = {
  id: "f1", scopeType: "project", scopeId: "p1", name: "優先級", type: "select",
  options: ["高", "中", "低"], position: "a",
};
const boardFieldFixture = {
  id: "f2", scopeType: "board", scopeId: "b9", name: "期限", type: "date",
  options: null, position: "b",
};

function renderTab(canEditProject = true, canEditBoard = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CustomFieldsTab projectId="p1" canEditProject={canEditProject} canEditBoard={canEditBoard} />
    </QueryClientProvider>,
  );
  return { qc };
}

/** 依表格列上的欄位名稱取得該列的「編輯」按鈕，避免多列時抓到別列 */
function editButtonOf(fieldName: string) {
  const row = screen.getByText(fieldName).closest("tr")!;
  return within(row).getByRole("button", { name: "編輯" });
}

async function openCreateDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "新增欄位" }));
  return screen.findByRole("dialog");
}

/** Radix Select：點 trigger（role=combobox）開啟 popup，再點選 option */
async function chooseType(label: string) {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

// ===== P3 Task 5：#20 刪欄位確認流程 =====
describe("CustomFieldsTab 刪欄位確認", () => {
  beforeEach(() => vi.clearAllMocks());

  it("刪除前顯示確認對話框且明示後果，取消不呼叫 API", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [fieldFixture] });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/將刪除所有卡片上的此欄位值/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(api.delete).not.toHaveBeenCalled());
  });

  it("確認後才呼叫 DELETE 刪除欄位", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [fieldFixture] });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/projects/p1/custom-fields/f1"));
  });
});

// ===== 編輯：逐列對話框（原本共用頂部表單，按了編輯看不到在改哪一列） =====
describe("CustomFieldsTab 編輯欄位", () => {
  beforeEach(() => vi.clearAllMocks());

  it("點編輯開啟對話框，標題帶出欄位名稱並預填內容", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [fieldFixture] });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "編輯" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("編輯欄位「優先級」")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("名稱")).toHaveValue("優先級");
    // 下拉選單的既有選項以 chip 呈現
    expect(within(dialog).getByText("高")).toBeInTheDocument();
    expect(within(dialog).getByText("中")).toBeInTheDocument();
  });

  it("取消後改開另一列，顯示的是該列內容而非前一列的未儲存變更", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [fieldFixture, boardFieldFixture] });
    renderTab(true, true);

    await screen.findByText("優先級"); // 等查詢完成再取列，否則還在「載入中…」
    fireEvent.click(editButtonOf("優先級"));
    fireEvent.change(await screen.findByLabelText("名稱"), { target: { value: "改到一半" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(editButtonOf("期限"));
    expect(await screen.findByText("編輯欄位「期限」")).toBeInTheDocument();
    expect(screen.getByLabelText("名稱")).toHaveValue("期限");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("專案範疇欄位以 PUT 專案路由更新，成功後關閉對話框並失效快取", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [fieldFixture] });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    const { qc } = renderTab();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    fireEvent.click(await screen.findByRole("button", { name: "編輯" }));
    fireEvent.change(await screen.findByLabelText("名稱"), { target: { value: "優先級別" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/projects/p1/custom-fields/f1", {
        name: "優先級別",
        type: "select",
        options: ["高", "中", "低"],
      }),
    );
    // 失效呼叫發生於 mutation onSuccess，隨完成鏈排程——同置 waitFor 避免依賴內部時序
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["custom-fields", "p1"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["card"] });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("看板範疇欄位走 PUT 看板路由（scopeId）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [boardFieldFixture] });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    renderTab(false, true);

    fireEvent.click(await screen.findByRole("button", { name: "編輯" }));
    fireEvent.click(await screen.findByRole("button", { name: "儲存變更" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/boards/b9/custom-fields/f2", {
        name: "期限",
        type: "date",
        options: null,
      }),
    );
  });

  it("變更型態在對話框內顯示新舊型態與後果，確認後才 PUT 且選項一併清除", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [fieldFixture] });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "編輯" }));
    await chooseType("文字");

    // 同在一個對話框內說明，不再疊一層確認框；按下前不得送出
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("由「下拉選單」改為「文字」")).toBeInTheDocument();
    expect(screen.getByText(/原本的選項清單也會一併清除/)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "確認變更並清除值" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/projects/p1/custom-fields/f1", {
        name: "優先級",
        type: "text",
        options: null,
      }),
    );
  });
});

// ===== 新增：對話框 + chip 選項輸入 =====
describe("CustomFieldsTab 新增欄位", () => {
  beforeEach(() => vi.clearAllMocks());

  it("建立成功後保留對話框並清空名稱，可連續新增", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    renderTab();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "工時" } });
    fireEvent.click(screen.getByRole("button", { name: "建立欄位" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/custom-fields", {
        name: "工時",
        type: "text",
        options: null,
      }),
    );
    expect(await screen.findByText("新增自訂欄位")).toBeInTheDocument();
    expect(screen.getByLabelText("名稱")).toHaveValue("");
  });

  it("下拉選單尚無選項時不可儲存，補上選項後才可送出", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    renderTab();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "嚴重度" } });
    await chooseType("下拉選單");

    expect(screen.getByText("下拉選單至少需要一個選項")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "建立欄位" })).toBeDisabled();

    const optionInput = screen.getByLabelText("選項");
    fireEvent.change(optionInput, { target: { value: "高" } });
    fireEvent.keyDown(optionInput, { key: "Enter" });
    expect(screen.getByRole("button", { name: "建立欄位" })).toBeEnabled();
  });

  it("選項可用半形或全形逗號一次拆成多個並去除重複", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    renderTab();

    await openCreateDialog();
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "嚴重度" } });
    await chooseType("下拉選單");

    const optionInput = screen.getByLabelText("選項");
    // 貼上一整串（半形逗號）
    fireEvent.change(optionInput, { target: { value: "高,中,低" } });
    fireEvent.keyDown(optionInput, { key: "Enter" });
    expect(screen.getByText("高")).toBeInTheDocument();
    expect(screen.getByText("中")).toBeInTheDocument();
    expect(screen.getByText("低")).toBeInTheDocument();

    // 全形逗號同樣可拆，且重複的「低」不會再新增一個 chip
    fireEvent.change(optionInput, { target: { value: "低，很高" } });
    fireEvent.keyDown(optionInput, { key: "Enter" });
    expect(screen.getByText("很高")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^移除選項 /)).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "建立欄位" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/custom-fields", {
        name: "嚴重度",
        type: "select",
        options: ["高", "中", "低", "很高"],
      }),
    );
  });

  it("輸入法組字中的 Enter 不會新增選項（中文選字不誤觸）", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    renderTab();

    await openCreateDialog();
    await chooseType("下拉選單");
    const optionInput = screen.getByLabelText("選項");

    fireEvent.change(optionInput, { target: { value: "高" } });
    fireEvent.keyDown(optionInput, { key: "Enter", isComposing: true });

    expect(screen.queryByLabelText("移除選項 高")).not.toBeInTheDocument();
    expect(optionInput).toHaveValue("高");
  });
});
