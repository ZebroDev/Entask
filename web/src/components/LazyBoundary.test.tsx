import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComponentType, type ReactNode, lazy } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { LazyBoundary } from "./LazyBoundary";

// 這一支的來源是 2026-09-28 的實機走查（場景 F）：chunk 載入失敗時全庫沒有
// ErrorBoundary 可以攔，React 卸載**整棵樹**——連靜態 import 的側欄也一起消失
// （實測 body 文字 60 → 0），畫面上不留任何字、也沒有任何提示。jsdom 看不到那件事
// （沒有真的 chunk 可以失敗），所以這裡用 `lazy` 的 Rejected payload 重現同一個狀態。

// chunk 被拒：`import()` 失敗時 payload 進 Rejected，之後每次 render 都拋同一個錯誤。
const Rejected = lazy(
  () => Promise.reject(new Error("chunk 載入失敗")) as Promise<{ default: ComponentType }>,
);
// 永不解析：模擬「chunk 還沒下載完」——fallback 才會顯形。
const Never = lazy(() => new Promise<{ default: ComponentType }>(() => {}));
// 拒絕時**不帶理由的其中一種**：React 允許 throw 任何值，而 `null` 是唯一會讓
// 「用 error 本身當旗標」漏掉的那一個（`undefined !== null` 仍成立，`null !== null` 不成立）。
const RejectedNull = lazy(() => Promise.reject(null) as Promise<{ default: ComponentType }>);

function Buggy(): ReactNode {
  throw new Error("render bug");
}

beforeEach(() => {
  // 邊界會對開發者印出整顆 error（`componentDidCatch`），React 自己也印一大段
  // ——這裡收斂成間諜，T1 順便斷言「印的是物件、不是 message 字串」。
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("LazyBoundary", () => {
  it("子樹的 chunk 載入失敗時顯示錯誤區塊，而不是白畫面", async () => {
    render(
      <LazyBoundary>
        <Rejected />
      </LazyBoundary>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("common:state.unavailable"));
    // 防 t() 靜默回傳 key 字串本身——少了這一行，key 打錯時上面那行照樣綠。
    expect(alert).not.toHaveTextContent("common:state.unavailable");
    expect(
      screen.getByRole("button", { name: i18n.t("common:action.retry") }),
    ).toBeInTheDocument();
    // 開發者診斷印的是**整顆 error 物件**（不是 `message` 字串），與 `check:error-paths`
    // 對 console 的放行同一條規矩。改成印字串這一條會紅。
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it("按重新載入呼叫注入的 onReload 恰好一次", async () => {
    // 注入而不是碰真的 `window.location.reload`：jsdom 沒有實作它（會印
    // "Not implemented: navigation"，且不可能斷言「真的重新載入過」）。
    const onReload = vi.fn();
    render(
      <LazyBoundary onReload={onReload}>
        <Rejected />
      </LazyBoundary>,
    );

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("common:action.retry") }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("邊界外的外殼倖存——錯誤不會卸載整棵樹", async () => {
    // 這一支是走查 F 那一格的迴歸守門員：把邊界拿掉（或擺錯層級）時，
    // React 卸載的是**整棵樹**，那個「側欄」會一起消失——而畫面上什麼字都沒有。
    // 一定要先等到 alert：少了它，這支在「還在載入」的狀態下也會綠。
    render(
      <div>
        <nav>側欄</nav>
        <LazyBoundary>
          <Rejected />
        </LazyBoundary>
      </div>,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("側欄")).toBeInTheDocument();
  });

  it("lazy 以外的渲染錯誤也攔得住（措辭刻意不指涉 chunk）", async () => {
    // 邊界攔的是**子樹的任何渲染錯誤**，不只是 chunk 失敗。文案因此刻意中性
    // ——寫成「載入失敗」的話，這一格顯示的會是一句關於下載的謊。
    render(
      <LazyBoundary>
        <Buggy />
      </LazyBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("common:state.unavailable"));
  });

  it("換一個 key 就是一個乾淨的邊界（長命的呼叫端靠這個離開錯誤狀態）", async () => {
    // 重掛走的是 React 的 key 語意、不是這一支自己的程式碼 ⇒ 這一條守的是
    // **這個元件不留殘狀態**（把失敗記在模組層級、或讓初始 state 帶著上一次的
    // 錯誤，這裡會紅）；「呼叫端有沒有傳 key」它守不到，那一半在
    // `AppLayout.test.tsx` 與 `project-page-lazy.test.tsx`。
    const Child = ({ ok }: { ok: boolean }) => (ok ? <div>內容回來了</div> : <Rejected />);
    const { rerender } = render(
      <LazyBoundary key="a">
        <Child ok={false} />
      </LazyBoundary>,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    rerender(
      <LazyBoundary key="b">
        <Child ok />
      </LazyBoundary>,
    );

    expect(await screen.findByText("內容回來了")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("子樹拋出的不是 Error 物件時也攔得住", async () => {
    // `hasError` 與 `error` 之所以是兩個欄位：React 允許 `throw null`，而
    // 「error 本身當旗標」的寫法（`state.error !== null`）在那一格會直接穿過去
    // ⇒ 攔了卻還是白畫面。負向實測：把旗標換掉，這一支是唯一會紅的。
    render(
      <LazyBoundary>
        <RejectedNull />
      </LazyBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("common:state.unavailable"));
  });

  it("fallback 未給時用 LazyFallback；明確給 null 時留白", async () => {
    const first = render(
      <LazyBoundary>
        <Never />
      </LazyBoundary>,
    );
    expect(await screen.findByText(i18n.t("common:state.loading"))).toBeInTheDocument();
    first.unmount();

    // 分頁與看板的巢狀路由邊界傳的就是 `null`。「沒給」與「明確給 null」用
    // `??`／`||` 收斂的話，那四處會全部長出一塊 50vh 的載入區塊。
    render(
      <LazyBoundary fallback={null}>
        <Never />
      </LazyBoundary>,
    );
    expect(screen.queryByText(i18n.t("common:state.loading"))).not.toBeInTheDocument();
  });
});
