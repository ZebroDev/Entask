import type { Node, Edge } from "@xyflow/react";
import type { MindMapNodeData } from "./MindMapCustomNode";
import { toast } from "sonner";
import i18n from "@/i18n";
import { reviewStateLabel, type ReviewVerdict } from "@/lib/review-badge";

// 匯出的底色固定是淺色（`#f8fafc`），所以取畫布**淺色主題**那一組色——即
// `review-badge.ts` 的 `REVIEW_ICON_CLASS`：amber-600／green-600／`text-destructive`
// （`--destructive: 0 84.2% 60.2%` ＝ #ef4444，**不是約等**）。approved 與完成勾同一個 green-600。
//
// ★ 這一組與 `REVIEW_ICON_CLASS` 之間的對應**由測試釘住**（`review-badge.test.ts` 的
//   〈匯出底色與圖示色階的契約〉）：SVG 的 `fill` 只能吃色值、不能吃 utility ⇒ 它**必須**
//   是第二份；閘門把「淺色 token →（Tailwind 色票 ／ `--destructive`）→ hex」那條鏈接起來
//   ⇒ 改色階而匯出沒跟上會當場紅，不是靜默（`docs/STATE.md` 的 INFO-1）。
//   `export` 就是為了讓那個測試碰得到它——在此之前它是模組私有的。
export const REVIEW_EXPORT_COLOR: Record<ReviewVerdict, string> = {
  pending: "#d97706",
  approved: "#16a34a",
  rejected: "#ef4444",
};

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}

export function generateMindMapSvg(
  nodes: Node<MindMapNodeData>[],
  edges: Edge[],
  projectName: string = i18n.t("project:mindMap.export.title")
): { svgString: string; width: number; height: number } {
  if (nodes.length === 0) {
    return {
      // 中文夾在一整段 SVG 骨架中間，所以是手改而不是整段抽換——
      // 整段換成 t() 會把 SVG 一起換掉。這是使用者拿到的檔案上的字，算文案。
      svgString: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="400" y="300" text-anchor="middle" font-family="sans-serif" fill="#64748b">${i18n.t("project:mindMap.export.empty")}</text></svg>`,
      width: 800,
      height: 600,
    };
  }

  const NODE_WIDTH = 200;
  const NODE_HEIGHT = 56;
  const PADDING = 100;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    if (n.position.x < minX) minX = n.position.x;
    if (n.position.y < minY) minY = n.position.y;
    if (n.position.x + NODE_WIDTH > maxX) maxX = n.position.x + NODE_WIDTH;
    if (n.position.y + NODE_HEIGHT > maxY) maxY = n.position.y + NODE_HEIGHT;
  }

  const width = Math.max(900, Math.ceil(maxX - minX + PADDING * 2));
  const height = Math.max(600, Math.ceil(maxY - minY + PADDING * 2));
  const offsetX = -minX + PADDING;
  const offsetY = -minY + PADDING;

  const nodeMap = new Map<string, Node<MindMapNodeData>>();
  for (const n of nodes) nodeMap.set(n.id, n);

  let pathsSvg = "";
  for (const e of edges) {
    const s = nodeMap.get(e.source);
    const t = nodeMap.get(e.target);
    if (!s || !t) continue;

    const x1 = s.position.x + NODE_WIDTH + offsetX;
    const y1 = s.position.y + NODE_HEIGHT / 2 + offsetY;
    const x2 = t.position.x + offsetX;
    const y2 = t.position.y + NODE_HEIGHT / 2 + offsetY;
    const dx = Math.abs(x2 - x1) * 0.5;

    const strokeColor = (e.style?.stroke as string) || "#94a3b8";
    pathsSvg += `<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" />\n`;
  }

  let nodesSvg = "";
  for (const n of nodes) {
    const x = n.position.x + offsetX;
    const y = n.position.y + offsetY;
    const color = n.data.branchColor || "#3b82f6";
    const isRoot = n.data.isRoot;
    const title = escapeXml(n.data.title || i18n.t("project:mindMap.untitledNode"));
    const cardTitle = n.data.card?.title ? escapeXml(n.data.card.title) : null;
    // 完成狀態須與畫布一致，否則匯出圖與畫面所述不符。
    // ✓ 拆為獨立 tspan：line-through 掛在 <text> 上會連勾一起劃掉，綠勾亦比照畫布不上刪節線。
    const cardDone = n.data.card?.completedAt != null;
    // 審查狀態同樣須與畫面一致（使用者 2026-09-18：「匯出的應該要和畫面一樣」）。
    // 文字走 `reviewStateLabel`——三態的唯一來源（switch ＋ 字面值 key），
    // 不在這裡另寫一份。匯出是靜態圖、沒有 hover，所以用同色系的狀態詞接在標題後，
    // 而不是畫布那顆 10px 的圖示（tspan 順流排版，不需要量測文字寬度）。
    const reviewState = n.data.card?.reviewState ?? null;
    const reviewSuffix = reviewState
      ? `<tspan fill="${REVIEW_EXPORT_COLOR[reviewState]}"> · ${escapeXml(reviewStateLabel(i18n.t, reviewState))}</tspan>`
      : "";
    const cardText = cardTitle
      ? cardDone
        ? `<tspan fill="#16a34a">✓ </tspan><tspan text-decoration="line-through">${cardTitle}</tspan>${reviewSuffix}`
        : `${cardTitle}${reviewSuffix}`
      : null;

    nodesSvg += `
      <g transform="translate(${x}, ${y})">
        <rect width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="10" fill="${isRoot ? color : "#ffffff"}" stroke="${color}" stroke-width="${isRoot ? "0" : "2"}" filter="url(#drop-shadow)" />
        <text x="16" y="${cardTitle ? 24 : 33}" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="${isRoot ? "bold" : "600"}" fill="${isRoot ? "#ffffff" : "#1e293b"}">${title}</text>
        ${cardText ? `<text x="16" y="42" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="${isRoot ? "#e2e8f0" : "#64748b"}">${cardText}</text>` : ""}
      </g>
    `;
  }

  const svgString = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="drop-shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.12" />
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="#f8fafc" />
  <text x="24" y="36" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="bold" fill="#334155">${escapeXml(projectName)}</text>
  <g>${pathsSvg}</g>
  <g>${nodesSvg}</g>
</svg>`;

  return { svgString, width, height };
}

export function exportMindMapAsSvg(
  nodes: Node<MindMapNodeData>[],
  edges: Edge[],
  filename: string = "mindmap.svg"
) {
  try {
    const { svgString } = generateMindMapSvg(nodes, edges);
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
    toast.success(i18n.t("project:mindMap.export.svg.success"));
  } catch (err) {
    console.error("SVG 匯出失敗:", err);
    toast.error(i18n.t("project:mindMap.export.svg.error"));
  }
}

export function exportMindMapAsPng(
  nodes: Node<MindMapNodeData>[],
  edges: Edge[],
  filename: string = "mindmap.png"
) {
  try {
    const { svgString, width, height } = generateMindMapSvg(nodes, edges);
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const scale = 2; // High-resolution 2x retina
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        toast.error(i18n.t("project:mindMap.export.canvasError"));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      canvas.toBlob((pngBlob) => {
        if (!pngBlob) {
          toast.error(i18n.t("project:mindMap.export.blobError"));
          return;
        }
        const pngUrl = URL.createObjectURL(pngBlob);
        const a = document.createElement("a");
        a.href = pngUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(pngUrl);
        a.remove();
        toast.success(i18n.t("project:mindMap.export.png.success"));
      }, "image/png");

      URL.revokeObjectURL(url);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast.error(i18n.t("project:mindMap.export.imageError"));
    };

    img.src = url;
  } catch (err) {
    console.error("PNG 匯出失敗:", err);
    toast.error(i18n.t("project:mindMap.export.png.error"));
  }
}
