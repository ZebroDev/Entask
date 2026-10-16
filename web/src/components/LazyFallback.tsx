import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * lazy 載入中的外觀——`<Suspense>` 的 fallback（每一次等待某個 chunk 的瞬間）。
 *
 * **兩個層級共用**：路由層（`App.tsx` 的登入頁、`AppLayout.tsx` 的 `<Outlet />`）
 * 與分頁層（`ProjectPage.tsx` 的九個分頁）。原名 `RouteFallback`——分頁層加進來
 * 之後那個名字就只指涉了其中一個站點，本專案的命名規則是「名字指涉了站點，
 * 站點變多，名字就錯」（`CARD_DRAWER_PAGE_SIZE` → `CARD_SIDE_LIST_PAGE_SIZE` 那次），
 * 2026-09-27 更名。
 *
 * 刻意用既有的 `common:state.loading` 而不是新增 key：這條路徑會出現在每一個
 * 尚未下載完的路由與分頁上，而新增 key 只會多一次語系檔同步。
 *
 * `className` 走 `cn()`（其 `twMerge` 對同一個 tailwind 群組只留最後一個）
 * ⇒ 它是**覆寫**而不是附加：呼叫端給的 `min-h-[240px]` 會取代預設的 `min-h-[50vh]`，
 * 其餘預設樣式照舊。分頁那一格若不該佔到 50vh，用它微調即可，不必為此另開一個
 * fallback 元件（那正是名字會開始指涉站點的地方）。
 */
export function LazyFallback({ className }: { className?: string }) {
  const { t } = useTranslation(["common"]);

  return (
    <div
      role="status"
      className={cn(
        "flex min-h-[50vh] flex-1 items-center justify-center gap-2 p-8 text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">{t("common:state.loading")}</span>
    </div>
  );
}
