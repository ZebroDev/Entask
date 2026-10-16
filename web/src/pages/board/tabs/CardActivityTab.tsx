import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { CardResponse, ActivityResponse, ActivityPageResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import i18n from "@/i18n";

interface Props { card: CardResponse; }

/**
 * 活動型別 → 標籤。
 *
 * **寫成 switch 而不是查表，是被 i18next-parser 逼的，不是風格偏好**——與
 * `lib/custom-fields.ts` 的 `typeLabel`、`pages/board/label-palette.ts` 的 `colorName`
 * 同一個形狀（設計 §6.1）。查表（key 放資料表、取出來才傳給 i18n 實例）的引數不是
 * 字面值，parser 掃不到，而 `keepRemoved: false` 會把「原始碼裡找不到」的 key
 * 直接從語系檔刪掉：畫面只顯示 key 本身，沒有錯誤、沒有警告、測試也不會紅。
 *
 * 函式每次呼叫才求值，所以切換語系一定拿得到新值——模組層級的常值會在 import 時
 * 就把文案凍結在當下的語系（那是這張表原本的形狀）。
 *
 * 英文用**過去式**：這些標籤接在使用者名稱後面（`王小明 建立卡片`），
 * 中文不需要時態，英文需要。
 */
const typeLabel = (type: string) => {
  switch (type) {
    case "comment":
      return i18n.t("card:activityType.comment");
    case "create":
      return i18n.t("card:activityType.create");
    case "move":
      return i18n.t("card:activityType.move");
    case "rename":
      return i18n.t("card:activityType.rename");
    case "description_change":
      return i18n.t("card:activityType.descriptionChange");
    case "due_change":
      return i18n.t("card:activityType.dueChange");
    case "start_change":
      return i18n.t("card:activityType.startChange");
    case "member_added":
      return i18n.t("card:activityType.memberAdded");
    case "member_removed":
      return i18n.t("card:activityType.memberRemoved");
    case "label_added":
      return i18n.t("card:activityType.labelAdded");
    case "label_removed":
      return i18n.t("card:activityType.labelRemoved");
    case "checklist_added":
      return i18n.t("card:activityType.checklistAdded");
    case "checklist_removed":
      return i18n.t("card:activityType.checklistRemoved");
    case "item_checked":
      return i18n.t("card:activityType.itemChecked");
    case "attachment_added":
      return i18n.t("card:activityType.attachmentAdded");
    case "attachment_removed":
      return i18n.t("card:activityType.attachmentRemoved");
    case "review_added":
      return i18n.t("card:activityType.reviewAdded");
    case "review_submitted":
      return i18n.t("card:activityType.reviewSubmitted");
    case "effort_logged":
      return i18n.t("card:activityType.effortLogged");
    case "custom_field_updated":
      return i18n.t("card:activityType.customFieldUpdated");
    case "cover_change":
      return i18n.t("card:activityType.coverChange");
    case "copy":
      return i18n.t("card:activityType.copy");
    case "archive":
      return i18n.t("card:activityType.archive");
    case "restore":
      return i18n.t("card:activityType.restore");
    // 以下 4 個是 B2-4 code review 抓到**既有**的漏網（不是本批造成的）：後端
    // `ActivityTypes` 共 28 種，原本的表（與改寫後的 switch）都只有 24 種，
    // 少了這 4 種——於是綁定心智圖或勾選完成時，活動牆直接印出原始型別字串
    // （`王小明 mindmap_bound`）。zh-TW 與 en 都一樣。已於 B2-4 的收尾 commit 補齊。
    case "mindmap_bound":
      return i18n.t("card:activityType.mindMapBound");
    case "mindmap_unbound":
      return i18n.t("card:activityType.mindMapUnbound");
    case "complete":
      return i18n.t("card:activityType.complete");
    case "uncomplete":
      return i18n.t("card:activityType.uncomplete");
    // 後端 `ActivityTypes` 的第 29 種（Task 7 補）：工程師在有審查者的卡片上按下完成，
    // 語意是「交付待審查」而不是「完成」。**這條與上面的 4 條不同**——那 4 條是既有漏網，
    // 這一條是後端本次新增的，`check-label-tables` 的第一張表在補上它之前一直是紅的。
    case "delivery_submitted":
      return i18n.t("card:activityType.deliverySubmitted");
    // 型別不認得時退回原字串，與改動前（查表落空再退回 type）一致
    default:
      return type;
  }
};

type ReviewDetail = { status?: string; score?: number | null; comment?: string | null };

/**
 * 活動列的細節。**只有審查家族有值得顯示的 detail**，其餘型別維持原樣——這一批
 * 刻意不擴大範圍（其餘型別的 detail 是給程式讀的，例如 `{ userId }`）。
 *
 * 與上面的 `typeLabel` 同一條規則：動態 key 一律是**條件分支 ＋ 字面值引數**，
 * 不查表（`i18next-parser` 只認字面值引數，查表抽不到，而 `keepRemoved: false`
 * 會把抽不到的 key 從語系檔刪掉）。這裡的分支是 `if`／`else if` 而不是 `switch`
 * ——`status` 有三種以上可能值，而只有兩種要顯示。
 *
 * `t` 由呼叫端於 render 時傳入，不是模組層級求值——切換語系才會重繪。
 *
 * 接法是 `parts.join("")`：每一段自帶自己的空白（`card:review.score` 的前導空白、
 * `card:review.comment` 的括號），這是本檔既有的形狀（`ItemDetailsTab` 的審查摘要列
 * 同樣是這三段的串接）。
 */
function activityDetail(t: TFunction<["common", "card"]>, a: ActivityResponse): string {
  if (a.type !== "review_submitted") return "";
  let d: ReviewDetail;
  try {
    d = a.detail ? (JSON.parse(a.detail) as ReviewDetail) : {};
  } catch {
    return ""; // detail 是自由格式欄位，壞掉不該讓整頁爆掉（JSON.parse 在 render 裡）
  }
  const parts: string[] = [];
  if (d.status === "rejected") parts.push(t("card:review.detail.rejected"));
  else if (d.status === "approved") parts.push(t("card:review.detail.approved"));
  if (d.score != null) parts.push(t("card:review.score", { score: d.score }));
  if (d.comment) parts.push(t("card:review.comment", { comment: d.comment }));
  return parts.join("");
}

export function CardActivityTab({ card }: Props) {
  const { t } = useTranslation(["common", "card"]);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
  } = useInfiniteQuery({
    queryKey: ["card-activity-log", card.id],
    queryFn: async ({ pageParam }) => {
      const url = pageParam 
        ? `/cards/${card.id}/activity?filter=activity_only&cursor=${encodeURIComponent(pageParam)}` 
        : `/cards/${card.id}/activity?filter=activity_only`;
      return (await api.get(url)).data as ActivityPageResponse;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const activities = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-4">
      
      {status === "pending" ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{t("common:state.loading")}</div>
      ) : status === "error" ? (
        <div className="py-6 text-center text-sm text-destructive">{t("common:error.load")}</div>
      ) : (
        <ul className="divide-y">
          {activities.map((a) => (
            <li key={a.id} className="flex gap-2 py-2 text-sm">
              <span className="font-semibold shrink-0">{a.displayName}</span>
              <span className="text-muted-foreground">
                {a.type === "comment" ? a.text : typeLabel(a.type)}
                {activityDetail(t, a)}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatDateTime(a.createdAt)}
              </span>
            </li>
          ))}
          {activities.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground border-none">{t("card:activity.empty")}</li>
          )}
        </ul>
      )}

      {hasNextPage && (
        <div className="pt-2 text-center">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => fetchNextPage()} 
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("common:state.loading") : t("common:action.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
