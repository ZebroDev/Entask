// 「專案側**與複製相關**的檢視」的失效清單——**單一定義**。
//
// 為什麼要獨立成一支：這一組 key 漏掉任何一個都不會有紅燈。`CardDialog` 原本的註解寫著
// 「否則新卡不會出現在目標看板／報表上（而且沒有任何紅燈）」；而 2026-09-22 的看板／清單
// 複製要再做一次同樣的事（失效**目標**側）。不抽出來，`BoardPage` 就會出現第三份同樣的清單
// ——第三份漏掉第 9 個 key 時，沒有人會知道。
//
// 契約由 `invalidate-views.test.ts` 逐一釘住（含三種 scope 形狀）。
import type { QueryClient } from "@tanstack/react-query";

export interface ViewScope {
  projectId?: string;
  boardId?: string;
}

/**
 * 失效某個 scope 之下與複製相關的檢視。
 *
 * **它不宣稱完備**：`["projects"]`／`["project", id]` 的 `boardCount` 不在這份清單裡
 * （跨專案複製看板之後它會 +1），而那一格在「單純新增看板」時**早就會漂**
 * （`BoardListTab` 只 `setQueryData`）——屬既有形狀，不是這一支引進的。
 * 這一支釘住的是**下面這 8 個 key**，由 `invalidate-views.test.ts` 的契約鎖逐一守住。
 *
 * **呼叫端的規則**：複製類操作一律指向**目標**——複製沒有改到來源的任何一列，
 * 來源端不動（卡片複製自 2026-09-22 起就是這個形狀）。
 */
export function invalidateProjectViews(queryClient: QueryClient, scope: ViewScope) {
  if (scope.boardId) queryClient.invalidateQueries({ queryKey: ["board", scope.boardId] });
  if (scope.projectId) {
    queryClient.invalidateQueries({ queryKey: ["project-cards-table", scope.projectId] });
    queryClient.invalidateQueries({ queryKey: ["project-cards", scope.projectId] });
    // 月曆「無截止日」側欄（陣列首元素不同，前綴比對不會命中 project-cards）
    queryClient.invalidateQueries({ queryKey: ["project-cards-nodue", scope.projectId] });
    queryClient.invalidateQueries({ queryKey: ["mindmap", scope.projectId] });
    queryClient.invalidateQueries({ queryKey: ["report", scope.projectId] });
    queryClient.invalidateQueries({ queryKey: ["project-cards-drawer", scope.projectId] });
  }
  // 卡片變更亦影響跨專案工作台（與 scope 無關，一律失效）
  queryClient.invalidateQueries({ queryKey: ["my-work"] });
}
