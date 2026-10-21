import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api } from "@/lib/api";
import { AuditLogRow } from "@/components/AuditLogRow";
import type { AuditPageResponse } from "@/lib/audit-labels";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * 系統活動（admin-only）：`TeamId` 為 null 的稽核列——使用者生命週期的五個動作
 * （建立／停用／復原／刪除／重設密碼）。團隊活動牆看不到它們（那是刻意的範圍劃分），
 * 端點是 `GET /api/audit-logs/system`。
 *
 * 這個頁面**不做**權限判斷：後端每一條都自己驗 admin，路由由 `RequireAdmin` 守
 * （與 `/users` 同一個形狀）。
 *
 * `queryKey` 用 `["audit", "system"]`——**不得**與活動牆的 `["audit", teamId]` 共用。
 * 「撞不上」是**實務上的**結論、不是結構保證：兩邊型別都是 string，型別上分不開；
 * 撐住它的是「真實的團隊 id 是**伺服器產生的 GUID**」（`Team.Id` 是 `Guid`，
 * `src/Entask.Core/Entities/Team.cs:5`）＋該路由外層的 `RequireTeamManagement`
 * （`web/src/App.tsx:46`）。但仍要一眼看得出兩者不同源。
 */
export function SystemActivityPage() {
  const { t } = useTranslation(["common", "admin"]);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError } = useInfiniteQuery({
    queryKey: ["audit", "system"],
    queryFn: async ({ pageParam }) => {
      // 首頁的 URL 逐字不變（`cursor` 只在續頁出現）——`SystemActivityPage.test.tsx`
      // 的 `toHaveBeenCalledWith("/audit-logs/system")` 盯著這件事。
      const url = pageParam
        ? `/audit-logs/system?cursor=${encodeURIComponent(pageParam)}`
        : "/audit-logs/system";
      return (await api.get(url)).data as AuditPageResponse;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const logs = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    // 頁面自己帶容器（`AppLayout` 的 `<main>` 不帶 padding），而且與「使用者管理」
    // 「我的日誌」「個人工作台」同一組頁殼（2026-10-21 使用者回報畫風不一致）：
    // 原本是滿版 `p-6` ＋ `text-lg` 標題、沒有副標，在寬螢幕上像另一個系統。
    <div className="container max-w-6xl space-y-6 px-4 py-6 md:px-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          {t("admin:activity.title")}
          <Activity className="h-5 w-5 text-primary" />
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">{t("admin:activity.subtitle")}</p>
      </div>
      <div className="space-y-2">
        {isLoading && <p className="text-muted-foreground">{t("common:state.loading")}</p>}
        {!isLoading && isError && <p className="text-destructive">{t("common:error.loadRetry")}</p>}
        {!isLoading && !isError && logs.map((l) => <AuditLogRow key={l.id} log={l} />)}
        {!isLoading && !isError && logs.length === 0 && (
          <p className="text-muted-foreground">{t("admin:activity.empty")}</p>
        )}
      </div>
      {/* 與活動牆同一顆按鈕、同一組 key（`hasNextPage` 為真才渲染）——
          「被截斷」的可見性就是它。 */}
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
