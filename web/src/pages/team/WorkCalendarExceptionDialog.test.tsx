import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { WorkCalendarExceptionDialog } from "./WorkCalendarExceptionDialog";
import { api } from "@/lib/api";
import { axios400, axiosStatus } from "@/test/http-errors";
import type { WorkCalendarEntry } from "@/hooks/use-work-calendar";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// kind 刻意是 **Workday**——與元件的 `entry?.kind ?? "Holiday"` 預設不同。
// 若 fixture 也用 "Holiday"，「種類預填」這條路徑就沒有任何斷言分得出來（預設與預填同值）。
const EXISTING: WorkCalendarEntry = { date: "2026-10-05", kind: "Workday", name: "國慶日" };

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 開啟對話框：新增（entry === null）走「新增例外日」，編輯走列上的「編輯」 */
function openDialog(entry: WorkCalendarEntry | null) {
  render(<WorkCalendarExceptionDialog teamId="t1" entry={entry} defaultDate="2026-10-05" />, {
    wrapper,
  });
  fireEvent.click(screen.getByRole("button", { name: entry === null ? "新增例外日" : "編輯" }));
}

describe("WorkCalendarExceptionDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("新增時 PUT 的 body 是 kind 與 name，日期在 URL 裡", async () => {
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    render(<WorkCalendarExceptionDialog teamId="t1" entry={null} defaultDate="2026-10-05" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "新增例外日" }));
    fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "國慶日" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/teams/t1/work-calendar/2026-10-05", {
        kind: "Holiday",
        name: "國慶日",
      }),
    );
  });

  it("種類選「補班日」時送出的是列舉值 Workday，不是畫面文字", async () => {
    // 送畫面文字（"補班日"）會被後端判成 kindInvalid，而單位測試若只斷「有送出」看不出來。
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    openDialog(null);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "補班日" }));
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/teams/t1/work-calendar/2026-10-05", {
        kind: "Workday",
        name: null,
      }),
    );
  });

  it("儲存失敗時呼叫 toast.error，訊息來自 apiErrorMessage 的錯誤碼譯文", async () => {
    vi.mocked(api.put).mockRejectedValue(axios400({ code: "workCalendar.kindInvalid" }));
    openDialog(null);
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("工作日的種類不正確"));
  });

  it("伺服器沒說話（空 body）時退回 error.save，而不是傳輸層字串", async () => {
    // 空 body 是 fallback 唯一會被用到的情境（axios400 造不出「伺服器沒說話」）。
    // 少了這一支，「直接讀 error.message」的實作仍會全綠。
    vi.mocked(api.put).mockRejectedValue(axiosStatus(500));
    openDialog(null);
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("儲存失敗"));
  });

  it("編輯既有例外日：日期唯讀、種類預填，確認後才 DELETE", async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    openDialog(EXISTING);

    expect(screen.getByLabelText("日期")).toHaveValue("2026-10-05");
    expect(screen.getByLabelText("日期")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("名稱")).toHaveValue("國慶日");
    // 種類預填：斷言的是該語系的**標籤**（zh-TW 的 `workcalendar:kind.workday`），不是 key。
    // 拿掉 `entry?.kind ??` 寫死 "Holiday" 時，這裡會顯示「放假日」而紅。
    expect(screen.getByRole("combobox", { name: "種類" })).toHaveTextContent("補班日");

    fireEvent.click(screen.getByRole("button", { name: "刪除" }));

    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/teams/t1/work-calendar/2026-10-05"),
    );
    expect(confirmSpy).toHaveBeenCalledWith("確定要刪除這筆例外日嗎？");
    confirmSpy.mockRestore();
  });

  it("編輯既有 Workday 例外日時，儲存送出的是 entry 的 Workday 而非預設 Holiday", async () => {
    // 預填若退化成寫死的預設，改一筆補班日會被**靜默寫成放假日**（把上班日加回假日）。
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    openDialog(EXISTING);
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/teams/t1/work-calendar/2026-10-05", {
        kind: "Workday",
        name: "國慶日",
      }),
    );
  });

  it("確認框按取消時不呼叫 DELETE", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    openDialog(EXISTING);
    fireEvent.click(screen.getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("刪除失敗（伺服器沒說話）時退回 error.delete", async () => {
    vi.mocked(api.delete).mockRejectedValue(axiosStatus(500));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    openDialog(EXISTING);
    fireEvent.click(screen.getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("刪除失敗"));
    confirmSpy.mockRestore();
  });
});
