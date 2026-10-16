// `cardEventQueryKeys` 的契約鎖。
//
// 為什麼抽這支出來測（2026-09-17，final whole-branch review 的 F-2）：卡片事件的失效
// 清單在此之前**沒有任何守門員**——實測刪掉 `card-review-history` 那一條，全量 54 檔／
// 1694 支測試全部通過、exit 0，而那個查詢只會在**別人**提交審查之後停在舊資料上。
// 實際的 `invalidateQueries` 迴圈需要一個 signalr 假物件才測得到，但會漏東西的是清單。
import { describe, expect, it } from "vitest";

import { cardEventQueryKeys } from "./collaboration";

describe("cardEventQueryKeys", () => {
  const data = { boardId: "b1", projectId: "p1", cardId: "c1" };

  it("逐條固定：增減任何一條都要在這裡有意識地改一次", () => {
    expect(cardEventQueryKeys(data)).toEqual([
      ["board", "b1"],
      ["project-cards-table", "p1"],
      ["project-cards", "p1"],
      ["project-cards-nodue", "p1"],
      ["card", "c1"],
      ["card-review-history", "c1"],
      ["mindmap", "p1"],
      ["report", "p1"],
      ["worklog"],
      ["my-work"],
    ]);
  });

  it("審查歷程帶的是 **cardId**，不是 `[\"card\", id]` 的子路徑", () => {
    // 這兩件事是分開的斷言：key 的前綴比對逐元素，`["card", cardId]` 匹配不到
    // `["card-review-history", cardId]`。Task 7 的 M-1 正是漏了這一條。
    const keys = cardEventQueryKeys({ boardId: "b", projectId: "p", cardId: "card-9" });
    expect(keys).toContainEqual(["card-review-history", "card-9"]);
    expect(keys).not.toContainEqual(["card-review-history"]);
  });
});
