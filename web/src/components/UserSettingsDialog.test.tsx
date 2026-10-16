import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserSettingsDialog } from "./UserSettingsDialog";
import { useAuth } from "@/stores/auth";
import i18n, { setLocale } from "@/i18n";
import { LOCALE_STORAGE_KEY } from "@/lib/storage-keys";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn() },
}));

/**
 * 切到「語言」分頁。Radix 的分頁需要 mouseDown ＋ click（同 CardDialog.test.tsx）。
 * 分頁名稱是**譯文**，所以要跟著當下的語系給。
 */
function openLanguageTab(name = "語言") {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function renderDialog() {
  return render(<UserSettingsDialog open onOpenChange={() => {}} />);
}

/**
 * 點一個語系選項。**一定要包 act 並 await**：`setLocale` 是非同步的
 * （`i18n.changeLanguage` 回傳 promise），`fireEvent` 只等到事件處理器返回，
 * 之後才落地的重繪會落在 act 之外。
 */
async function chooseLocale(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name }));
  });
}

describe("個人設定：語系選單", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never);
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "王小明", isAdmin: false },
      tokens: null,
      teamId: null,
    });
  });

  // 切過語系的測試要還原，否則會污染同檔其餘測試（setup.ts 的 beforeEach 清的是
  // localStorage 鍵，這裡還原的是 i18n 的執行期狀態）。
  afterEach(async () => {
    await setLocale(null);
  });

  it("語系分頁列出跟隨瀏覽器與各語系的自稱名", () => {
    renderDialog();
    openLanguageTab();

    expect(screen.getByRole("radio", { name: "跟隨瀏覽器" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "繁體中文" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "English" })).not.toBeChecked();
  });

  it("選 English 會切換語系、寫入 localStorage，並同步 documentElement.lang", async () => {
    renderDialog();
    openLanguageTab();

    await chooseLocale("English");

    await waitFor(() => expect(i18n.resolvedLanguage).toBe("en"));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    // 選單自己也要跟著換——它走的是同一條 t() 路徑
    expect(screen.getByRole("tab", { name: "Language" })).toBeInTheDocument();
  });

  it("選回「跟隨瀏覽器」會刪除 localStorage 鍵，不是存一個代表空的值", async () => {
    await setLocale("en");
    renderDialog();
    openLanguageTab("Language");
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();

    await chooseLocale("Use browser language");

    await waitFor(() => expect(i18n.resolvedLanguage).toBe("zh-TW"));
    // 這一條才是 R6 的兩狀態契約：鍵必須**不存在**。存成 "null" 字串的話，
    // detect.ts 的 explicitLocale() 會回傳 "null"，匹配不到任何語系而落到產品
    // 預設語系（en）——與「跟隨瀏覽器」在測試環境解析出的 zh-TW 當場不同，而且
    // 狀態機多了一個錯誤狀態，再也回不去「跟隨瀏覽器」（下一次選它時鍵還在）。
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("radio", { name: "跟隨瀏覽器" })).toBeChecked();
  });

  it("明確指定過的語系在對話框開啟時就是選中的（讀的是儲存的值，不是目前解析出的語系）", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    renderDialog();
    openLanguageTab();

    // i18n 只在啟動時讀 localStorage，所以這一刻畫面仍是 zh-TW——重點是選單畫的是
    // 「使用者選了什麼」，不是「現在是什麼」。兩者要等重新載入之後才會一致。
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(i18n.resolvedLanguage).toBe("zh-TW");
  });
});

// L5（B2-7 review）：認不得的已存值要退成「跟隨瀏覽器」，不能讓選單一個都不選。
//
// 可達路徑：dev 在 localhost:5173 選了偽語系，同一個 origin 之後換成 release 建置
// （`PSEUDO_LOCALE_LABEL` 被常數折疊折成 null，偽語系選項整段消失），或鍵被手改。
// 留著它的時候三個 radio 都不會被選中——使用者看到一個空白的選單。
// 這裡用一個**不可能是任何語系**的值，而不是偽語系：後者在 dev 測試環境是真的
// 存在的選項，測不到「認不得」這一條。
describe("個人設定：認不得的已存語系值（B2-7 review L5）", () => {
  afterEach(async () => {
    await setLocale(null);
  });

  it("退成「跟隨瀏覽器」，不是一個都沒選中", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-Hans");
    renderDialog();
    openLanguageTab();

    expect(screen.getByRole("radio", { name: "跟隨瀏覽器" })).toBeChecked();
  });
});

// M1（B2-7 review）：切換語系會清掉同一個對話框裡**未送出的輸入**。
//
// 機制：react-i18next 的 `t` 在 languageChanged 時會**換身分**（`useTranslation`
// 在 lng 變動時重新 `getFixedT`），而「重設表單欄位」與「抓通知偏好」住在同一個以
// `[open, user, t]` 為相依的 effect 裡——於是切一次語系就等於把整個表單重設一次，
// 使用者剛打的顯示名稱與密碼無聲消失（通知分頁則閃一次載入）。
//
// 這條路徑在本批之前**不可從 UI 觸發**：`setLocale` 的產品呼叫端只有本批新增的
// 語系選單（已 grep 全 `src` 確認）。所以這支測試是本批新增行為的守門員。
describe("個人設定：切換語系的副作用（B2-7 review M1）", () => {
  it("切換語系不會清掉對話框裡未送出的輸入", async () => {
    renderDialog();
    fireEvent.change(screen.getByDisplayValue("王小明"), { target: { value: "王小明改" } });
    expect(screen.getByDisplayValue("王小明改")).toBeInTheDocument();

    // 與語系選單的 radio 走同一條路（handleLocaleChange → setLocale）。
    // 不經由分頁：Radix 的 TabsContent 會卸載未啟用的分頁，輸入框會先離開 DOM。
    await act(async () => { await setLocale("en"); });

    expect(screen.getByDisplayValue("王小明改")).toBeInTheDocument();
  });
});
