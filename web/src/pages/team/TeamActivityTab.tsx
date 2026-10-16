import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { useTranslation } from "react-i18next";
import { AuditLogRow } from "@/components/AuditLogRow";
import type { AuditPageResponse } from "@/lib/audit-labels";
import { Button } from "@/components/ui/button";

export function TeamActivityTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation(["common", "team"]);
  const teamIdFromStore = useAuth((s) => s.teamId);
  // 形狀逐字照 `CardActivityTab.tsx:141-153`：`pageParam` 是 `string | null`，
  // `getNextPageParam` 直接回傳伺服器的 `nextCursor`。
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError } = useInfiniteQuery({
    queryKey: ["audit", teamId],
    queryFn: async ({ pageParam }) => {
      // 首頁的 URL 逐字不變（`cursor` 只在續頁出現）——`SystemActivityPage.test.tsx`
      // 有斷言盯著這件事。
      const url = pageParam
        ? `/audit-logs?teamId=${teamId}&cursor=${encodeURIComponent(pageParam)}`
        : `/audit-logs?teamId=${teamId}`;
      return (await api.get(url, {
        headers: { "X-Team-Id": teamIdFromStore ?? teamId },
      })).data as AuditPageResponse;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const logs = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-2">
      {isLoading && <p className="text-muted-foreground">{t("common:state.loading")}</p>}
      {!isLoading && isError && <p className="text-destructive">{t("common:error.loadRetry")}</p>}
      {!isLoading && !isError && logs.map((l) => <AuditLogRow key={l.id} log={l} />)}
      {!isLoading && !isError && logs.length === 0 && <p className="text-muted-foreground">{t("team:activity.empty")}</p>}
      {/* 「被截斷」的可見性**就是這顆按鈕**：`hasNextPage` 為真才渲染。
          刻意不加「只顯示最近 N 筆」那類文案——那是新 key × 6 個語系，
          而按鈕已經是誠實的指示（設計 §4.4）。 */}
      {hasNextPage && (
        <div className="pt-2 text-center">
          <Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? t("common:state.loading") : t("common:action.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
