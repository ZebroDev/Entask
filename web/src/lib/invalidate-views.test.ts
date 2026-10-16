import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { invalidateProjectViews } from "./invalidate-views";

/** 用真的 QueryClient ＋ spy，不造假物件——被鎖住的是「實際送出的 queryKey」本身。 */
function spyClient() {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries").mockImplementation(() => Promise.resolve());
  return { qc, spy };
}

function invalidatedKeys(spy: MockInstance) {
  return spy.mock.calls.map((call: unknown[]) =>
    JSON.stringify((call[0] as { queryKey: unknown[] }).queryKey),
  );
}

describe("invalidateProjectViews", () => {
  // 這支是**契約鎖**：它把 8 個 key 逐一釘住。日後新增第 9 個檢視而忘了加進來時，
  // 這一支會紅——沒有它，新增的檢視就是「永遠不會失效」而沒有任何紅燈。
  it("帶 projectId 與 boardId 時，失效的正好是這 8 個檢視", () => {
    const { qc, spy } = spyClient();

    invalidateProjectViews(qc, { projectId: "p1", boardId: "b1" });

    expect(invalidatedKeys(spy)).toEqual([
      '["board","b1"]',
      '["project-cards-table","p1"]',
      '["project-cards","p1"]',
      // 月曆「無截止日」側欄：陣列首元素不同，前綴比對不會命中 project-cards ⇒ 必須自己一項
      '["project-cards-nodue","p1"]',
      '["mindmap","p1"]',
      '["report","p1"]',
      '["project-cards-drawer","p1"]',
      '["my-work"]',
    ]);
  });

  it("只有 projectId 時不碰任何看板鍵，專案側仍全數失效", () => {
    const { qc, spy } = spyClient();

    invalidateProjectViews(qc, { projectId: "p1" });

    expect(invalidatedKeys(spy)).toEqual([
      '["project-cards-table","p1"]',
      '["project-cards","p1"]',
      '["project-cards-nodue","p1"]',
      '["mindmap","p1"]',
      '["report","p1"]',
      '["project-cards-drawer","p1"]',
      '["my-work"]',
    ]);
  });

  it("只有 boardId 時只失效該看板與跨專案工作台", () => {
    const { qc, spy } = spyClient();

    invalidateProjectViews(qc, { boardId: "b1" });

    expect(invalidatedKeys(spy)).toEqual(['["board","b1"]', '["my-work"]']);
  });

  // 空的 scope 不是錯誤用法：`CardDialog` 在專案／看板尚未解析出來時就是這個形狀。
  // 「跨專案工作台」與 scope 無關，一律失效。
  it("空 scope 仍失效跨專案工作台", () => {
    const { qc, spy } = spyClient();

    invalidateProjectViews(qc, {});

    expect(invalidatedKeys(spy)).toEqual(['["my-work"]']);
  });
});
