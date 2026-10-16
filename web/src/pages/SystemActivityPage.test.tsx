import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemActivityPage } from "./SystemActivityPage";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SystemActivityPage />
    </QueryClientProvider>
  );
}

describe("SystemActivityPage", () => {
  beforeEach(() => vi.clearAllMocks());

  // 這一支同時釘住兩件事：端點**不帶 teamId**（系統範圍，與活動牆的
  // `/audit-logs?teamId=…` 不同源），以及動作識別碼被翻成譯文（`user.deactivated`
  // 的譯文在 `team:audit.user.*`——標籤表兩頁共用）。少了後半，「原樣印出識別碼」
  // 這種不會讓 tsc、parity 或任何既有測試變紅的退化就沒有守門員。
  it("打系統範圍端點（不帶 teamId）並翻出動作標籤與操作者", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [{
          id: "1", action: "user.deactivated", entityType: "user", entityTitle: "王小明",
          createdAt: "2026-10-10T00:00:00Z", userDisplayName: "系統管理員",
        }],
        nextCursor: null,
      },
    });
    renderPage();

    // 頁標題：`useTranslation` 的清單漏掉 `admin`、或 key 改名時，畫面會印出裸 key
    // （`admin:activity.title`），而下面每一條斷言**照樣全綠**——與動作標籤同一個靜默家族。
    expect(await screen.findByRole("heading", { name: "系統活動" })).toBeInTheDocument();
    const actor = await screen.findByText("系統管理員");
    expect(screen.getByText("停用帳號：王小明")).toBeInTheDocument();
    // 文字流的**分界**（與活動牆同一條）：`gap-2` 只有視覺效果、DOM 裡看不到，少了那
    // 個空白，`textContent` 上操作者與動作會黏成一句（本 fixture 的動作是
    // `user.deactivated`，en 值 `"Deactivated account"` 在 `en/team.json:45`）。它是
    // **DOM 文字流的分界、不是無障礙樹的分界**（2026-10-10 瀏覽器探針：有它沒它，
    // `innerText` 都是換行、AX 樹都是兩個獨立 `StaticText`；探針量的是 Chrome 的 AX
    // 樹、不是 NVDA 的語音）。
    expect(actor.parentElement!.textContent).toContain("系統管理員 停用帳號：王小明");
    expect(api.get).toHaveBeenCalledWith("/audit-logs/system");
  });

  // fallback：`userDisplayName` 為 null（或整欄缺席）時退回 `common:audit.actorUnknown`
  // ——與活動牆是同一個 key。不顯示 `null` 那一行是這支的重點：`?? ` 寫成字串樣板
  // （或 `String(null)`）時畫面會印出 "null"，而上面那一支照樣綠。
  it("查不到操作者名稱時退回 fallback 文案（不顯示 null）", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [{
          id: "2", action: "user.created", entityType: "user", entityTitle: "newbie",
          createdAt: "2026-10-10T00:00:00Z", userDisplayName: null,
        }],
        nextCursor: null,
      },
    });
    renderPage();

    expect(await screen.findByText("未知使用者")).toBeInTheDocument();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("沒有紀錄時顯示空狀態", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { items: [], nextCursor: null } });
    renderPage();

    expect(await screen.findByText("尚無系統活動")).toBeInTheDocument();
  });

  // ★ 與活動牆同一條守門員，但**這一頁是另一份實作**（兩顆按鈕各自寫一次）——
  //   少了它，系統頁的「永遠顯示載入更多」不會有任何測試變紅。
  it("沒有下一頁時不渲染『載入更多』", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [{
          id: "3", action: "user.created", entityType: "user", entityTitle: "newbie",
          createdAt: "2026-10-10T00:00:00Z", userDisplayName: null,
        }],
        nextCursor: null,
      },
    });
    renderPage();

    await screen.findByText("已建立使用者：newbie");
    expect(screen.queryByRole("button", { name: "載入更多" })).toBeNull();
  });

  it("有下一頁時按下『載入更多』帶著編碼過的 cursor 打第二趟", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({
        data: {
          items: [{
            id: "4", action: "user.created", entityType: "user", entityTitle: "newbie",
            createdAt: "2026-10-10T00:00:00Z", userDisplayName: null,
          }],
          nextCursor: "2026-01-01T00:00:00.0000000Z|abc",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{
            id: "5", action: "user.deleted", entityType: "user", entityTitle: "oldie",
            createdAt: "2026-10-09T00:00:00Z", userDisplayName: null,
          }],
          nextCursor: null,
        },
      });
    renderPage();

    await screen.findByText("已建立使用者：newbie");
    fireEvent.click(screen.getByRole("button", { name: "載入更多" }));

    expect(await screen.findByText("刪除帳號：oldie")).toBeInTheDocument();
    // 首頁 URL 逐字不變（上面那一支的 `toHaveBeenCalledWith` 也盯著它）
    expect(vi.mocked(api.get).mock.calls[0][0]).toBe("/audit-logs/system");
    // 續頁帶著**編碼過**的 cursor（`:`、`|`、`Z` 都是 URL 特殊字元）
    expect(vi.mocked(api.get).mock.calls[1][0]).toBe(
      "/audit-logs/system?cursor=2026-01-01T00%3A00%3A00.0000000Z%7Cabc"
    );
    expect(screen.queryByRole("button", { name: "載入更多" })).toBeNull();
  });
});
