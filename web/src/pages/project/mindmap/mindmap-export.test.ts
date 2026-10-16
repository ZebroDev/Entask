import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { generateMindMapSvg } from "./mindmap-export";
import type { MindMapNodeData } from "./MindMapCustomNode";
import i18n from "@/i18n";

const callbacks = {
  onAddChild: () => {},
  onBindCard: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onOpenCard: () => {},
};

function node(id: string, card: MindMapNodeData["card"]): Node<MindMapNodeData> {
  return {
    id,
    type: "mindmapNode",
    position: { x: 0, y: 0 },
    data: { ...callbacks, id, title: "節點", note: null, card, isRoot: false, depth: 1, branchColor: "#3b82f6", canEdit: false },
  };
}

const card = (completedAt: string | null) => ({ id: "c1", title: "卡A", completedAt, reviewState: null });
const cardWithReview = (
  reviewState: "pending" | "approved" | "rejected" | null,
  completedAt: string | null = null,
) => ({ id: "c1", title: "卡A", completedAt, reviewState });

// 匯出圖若與畫布所述不一致，使用者拿到的檔案就是錯的——故在此釘住完成狀態的呈現
describe("generateMindMapSvg 綁定卡片完成狀態", () => {
  it("已完成時卡片副標加註綠色 ✓，刪節線只落在標題上", () => {
    const { svgString } = generateMindMapSvg([node("n1", card("2026-09-10T00:00:00Z"))], [], "專案");
    expect(svgString).toContain('<tspan fill="#16a34a">✓ </tspan>');
    expect(svgString).toContain('<tspan text-decoration="line-through">卡A</tspan>');
    // 刪節線掛在 <text> 上會連勾一起劃掉——僅標題那個 tspan 可帶刪節線
    expect(svgString.match(/text-decoration="line-through"/g)).toHaveLength(1);
    expect(svgString).not.toContain('text-decoration="line-through">✓');
  });

  it("未完成時不加註記也不套刪節線", () => {
    const { svgString } = generateMindMapSvg([node("n1", card(null))], [], "專案");
    expect(svgString).toContain(">卡A<");
    expect(svgString).not.toContain("line-through");
    expect(svgString).not.toContain("✓");
  });

  it("未綁定卡片時不產生卡片副標", () => {
    const { svgString } = generateMindMapSvg([node("n1", null)], [], "專案");
    expect(svgString).not.toContain("卡A");
  });
});

// 使用者 2026-09-18 裁定「匯出的應該要和畫面一樣」——畫布節點的綁卡晶片有審查狀態，
// 匯出圖（SVG 與由它轉出的 PNG）原本只帶完成狀態，兩邊說法不一致。
describe("generateMindMapSvg 綁定卡片審查狀態", () => {
  it.each<["pending" | "approved" | "rejected", string, string]>([
    ["pending", "#d97706", "待審查"],
    ["approved", "#16a34a", "通過"],
    ["rejected", "#ef4444", "退回"],
  ])("審查狀態為 %s 時，卡片副標以同色狀態詞加註", (reviewState, color, label) => {
    const { svgString } = generateMindMapSvg([node("n1", cardWithReview(reviewState))], [], "專案");
    expect(svgString).toContain(`<tspan fill="${color}"> · ${label}</tspan>`);
  });

  it("審查狀態為 null 時不加註", () => {
    const { svgString } = generateMindMapSvg([node("n1", cardWithReview(null))], [], "專案");
    expect(svgString).not.toContain(" · ");
  });

  it("完成與審查狀態並存時兩者都在，且刪節線仍只落在標題", () => {
    const { svgString } = generateMindMapSvg([node("n1", cardWithReview("rejected", "2026-09-10T00:00:00Z"))], [], "專案");
    expect(svgString).toContain('<tspan fill="#16a34a">✓ </tspan>');
    expect(svgString).toContain('<tspan fill="#ef4444"> · 退回</tspan>');
    expect(svgString.match(/text-decoration="line-through"/g)).toHaveLength(1);
  });

  // 來源那一條：狀態詞取自 common:state.*（`reviewStateLabel` 的 switch 字面值），
  // 不是匯出模組自己另寫的一份字面值。少了它，兩邊各自漂移時畫面那幾條仍會相等。
  it("狀態詞的來源是 common:state.*", () => {
    expect(i18n.t("common:state.pending")).toBe("待審查");
    expect(i18n.t("common:state.approved")).toBe("通過");
    expect(i18n.t("common:state.rejected")).toBe("退回");
  });
});
