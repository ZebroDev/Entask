import { useTranslation } from "react-i18next";
import { auditActionLabel, type AuditDto } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format";

/**
 * 稽核列：**活動牆與系統活動頁共用**（2026-10-10 由兩頁逐字相同的 JSX 抽出）。
 * 兩頁的差別只有容器、`empty` 文案與 query，列本身沒有第二種形狀——抽出來的理由與
 * `lib/audit-labels.ts` 同型：同一個形狀有第二個消費端，兩份 markup 會各自腐爛
 * （本批已經為它付過兩次：`105e5b7` 一次改了 4 個檔——兩頁＋兩支測試、跑了兩顆突變）。
 */
export function AuditLogRow({ log }: { log: AuditDto }) {
  const { t } = useTranslation(["common"]);
  return (
    <div className="flex items-center justify-between rounded border p-3 text-sm">
      {/* 標籤與值之間的分隔符也是語系的性質（zh-TW 全形、en 半形）。
          `log.entityTitle` 為 null 時退回 entityType——那是後端識別碼，但唯一的
          可達路徑（移除成員時查不到使用者）已在後端改為退回 userId，其餘呼叫點
          都傳非 null 的名稱。 */}
      <span className="flex items-center gap-2">
        {/* actor 是**另一個節點**：既有那一串「動作＋分隔符＋對象」是 4 支測試的
            整串比對目標（`TeamActivityTab.test.tsx`），併進去會讓它們紅——那不是
            斷言該改，是形狀不該動。
            `log.userDisplayName` 為 null 時退回 `common:audit.actorUnknown`——兩頁共用
            同一個 key，這裡不另開同義 key。
            兩個節點之間那個 `{" "}` 是 **DOM 文字流的分界**，**不是無障礙樹的分界**：
            flex 的 `gap-2` 只有視覺效果，`{" "}` 讓 `textContent` 讀得到那個空白
            （＝本批兩支測試斷言的東西；以 `textContent` 為準的工具看到的也是它。
            ★ **不含複製貼上**——瀏覽器複製走的是**渲染後**的文字，而探針量到的
            `innerText` 兩個變體相同，不支持那一句）。en 的動作標籤 `User created`
            少了它，`textContent` 裡會與前面的顯示名稱黏成一句。原本這裡寫「少了它，
            螢幕閱讀器會把兩者讀成一句」——那是**推論、已被瀏覽器探針推翻**
            （2026-10-10，Chrome ＋ CDP `Accessibility.getFullAXTree`）：同一個列、
            只差那一個空白文字節點，`innerText` **都是換行**、AX 樹**都是兩個獨立
            `StaticText`** ⇒ 那個空白從來沒進過無障礙樹。探針量的是 **Chrome 的 AX
            樹、不是 NVDA 的實際語音**。純空白文字節點在 flex 容器裡**不生成匿名
            flex item**（CSS Flexbox §4.1）⇒ 版面零變化（span rect 與容器寬逐值相同）。 */}
        <span className="text-muted-foreground">{log.userDisplayName ?? t("common:audit.actorUnknown")}</span>{" "}
        <span>{auditActionLabel(log.action)}{t("common:separator.label")}{log.entityTitle ?? log.entityType}</span>
      </span>
      <span className="text-xs text-muted-foreground">{formatDateTime(log.createdAt)}</span>
    </div>
  );
}
