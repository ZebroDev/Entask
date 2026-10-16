import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "./LoginPage";
import { useAuth } from "@/stores/auth";

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  // 真 store 的 login 會打網路；本檔只驗表單，不送出。
  useAuth.setState({ login: vi.fn() });
});

afterEach(() => {
  // 語系以外的 env 由本檔自己收乾淨——setup.ts 只還原 locale。
  vi.unstubAllEnvs();
});

describe("LoginPage 展示帳號填入", () => {
  it("開發環境：填入鈕存在，點擊後帶入 dev 種子帳密", () => {
    renderLogin();

    fireEvent.click(screen.getByRole("button", { name: "填入預設管理員帳號 (Admin)" }));

    expect(screen.getByLabelText("帳號")).toHaveValue("admin");
    expect(screen.getByLabelText("密碼")).toHaveValue("Entask@Dev2026");
  });

  it("production 建置：填入鈕與其提示都不渲染，dev 帳密不進 bundle", () => {
    // 注意：vitest 的 `_envBooleans` 會把布林轉成字串（`env[name] = value ? "1" : ""`，
    // vitest/dist/chunks/test.*.js），所以這裡存進去的是 `""` 而不是 `false`。
    // 兩者在 `&&` 之下等價、本測試有效；但若把閘門改成 `=== false` 之類的嚴格比較，
    // 測試環境與 production（真的 false）就會分岔。
    vi.stubEnv("DEV", false);

    renderLogin();

    // 兩者必須一起消失：只留提示會是半句話（「快速體驗 / 開發者預設帳號」配一顆不存在的鈕）。
    expect(screen.queryByRole("button", { name: "填入預設管理員帳號 (Admin)" })).toBeNull();
    expect(screen.queryByText("快速體驗 / 開發者預設帳號")).toBeNull();
    // 對照組：表單本體不受閘門影響。
    expect(screen.getByRole("button", { name: "登入系統" })).toBeInTheDocument();
  });
});

describe("LoginPage 的 Source offer（AGPL-3.0 §13）", () => {
  it("頁腳提供一條指向對應原始碼的連結", () => {
    renderLogin();

    const link = screen.getByRole("link", { name: "原始碼 (AGPL-3.0)" });

    // 預期值刻意寫死字面 URL，不 import `SOURCE_URL`：把常數 import 進來，常數本身
    // 寫錯時斷言會跟著一起錯、測試照樣綠——這一支要防的正是那個（改常數應該逼人
    // 做一次刻意的決定，而不是安靜地跟著改）。
    expect(link).toHaveAttribute("href", "https://github.com/ZebroDev/Entask");
    // `noreferrer` 不是防 reverse tabnabbing（現代瀏覽器對 target=_blank 已預設 noopener），
    // 是防把**自架實例的內部 URL** 從 Referer 標頭漏給 GitHub。
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
