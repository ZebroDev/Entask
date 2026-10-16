import { Component, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { LazyFallback } from "@/components/LazyFallback";

/**
 * `<Suspense>` ＋ 錯誤邊界，兩層合成一個元件——全庫的 lazy 站點一律用它。
 *
 * **為什麼需要**（2026-09-28 實機走查場景 F）：`React.lazy` 的 `import()` 失敗時
 * （重新部署之後，還開著的分頁去點一條新路由就是這個情形），React 找不到最近的
 * 錯誤邊界，於是**卸載整棵樹**。實測 body 文字 60 → 0：連 `AppLayout` 那個靜態
 * import 的側欄一起消失，畫面上不留一個字、也沒有任何提示，唯一的自救是按 F5。
 * `<Suspense>` 只管「還沒好」，完全不管「失敗了」——那個缺口就是這一支補的。
 *
 * **必須是 class**：`getDerivedStateFromError` 沒有 hook 等價物（React 19 亦然）。
 * 這是 `web/src` 底下唯一一個 class 元件。
 *
 * **文案刻意中性**（`common:state.unavailable`）：這一層攔的是**子樹的任何渲染錯誤**，
 * 不只是 chunk 失敗。寫成「載入失敗」的話，一個一般的渲染 bug 會顯示一句關於下載的謊。
 *
 * **`fallback` 的「沒給」與「明確給 null」是兩件事**：分頁與看板的巢狀路由邊界
 * 刻意傳 `null`（fallback 渲染在頁面流裡，那兩處不該多出一塊 50vh 的載入區塊）。
 * 用 `??` 收斂會讓那四處全部長出載入區塊，所以判準是 `=== undefined`。
 *
 * **長命的邊界要靠呼叫端的 `key` 重掛**：`AppLayout` 那一層橫跨每一次路由切換、
 * `ProjectPage` 的分頁層橫跨每一次切換分頁。`key` 一變就是一個新的實例，錯誤狀態
 * 自然清掉——少了它，一次 chunk 失敗會讓那一區**永久停在錯誤畫面**，連下一條本來
 * 沒問題的路由都進不去。用 prop ＋ `componentDidUpdate` 也做得到，但那多觸發一次
 * render（`react(no-did-update-set-state)` 擋的就是那個形狀），而重掛用的是 React
 * 自己的重置機制，不必為此多一個 prop。**兩個呼叫端是契約，不是裝飾**。
 */
interface LazyBoundaryProps {
  children: ReactNode;
  /** 未給時用 `<LazyFallback />`；明確給 `null` 時留白。 */
  fallback?: ReactNode;
  /** 錯誤區塊那顆鈕的動作。預設重新載入整頁；可注入是為了在 jsdom 裡斷言。 */
  onReload?: () => void;
}

interface LazyBoundaryState {
  /** 與 `error` 分開：React 允許 `throw null`／`throw undefined`，用 error 本身當旗標會漏掉那兩種。 */
  hasError: boolean;
  error: unknown;
}

export class LazyBoundary extends Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): Partial<LazyBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown): void {
    // 開發者診斷：印**整顆 error 物件**，不是 message 字串（`check:error-paths` 對
    // console 的放行就是這一條）。元件堆疊由 React 自己印，這裡不重複。
    console.error("區塊渲染失敗:", error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <LazyBoundaryError onReload={this.props.onReload ?? reloadPage} />;
    }
    const { fallback, children } = this.props;
    return (
      <Suspense fallback={fallback === undefined ? <LazyFallback /> : fallback}>
        {children}
      </Suspense>
    );
  }
}

function LazyBoundaryError({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation(["common"]);

  // `role="alert"` 在**外層**：`EmptyState` 不收任意 props，而這個區塊是
  // 「內容換成錯誤」而不是「頁面多了一段」，所以它必須自己是一個 live region。
  return (
    <div role="alert" className="p-6">
      <EmptyState
        title={t("common:state.unavailable")}
        actionText={t("common:action.retry")}
        onAction={onReload}
      />
    </div>
  );
}

function reloadPage(): void {
  window.location.reload();
}
