import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { lazyPage, loadCardDialog } from "./lazy-route";

describe("lazyPage", () => {
  it("把具名匯出轉成 lazy 元件並渲染出內容", async () => {
    // 這一支守的是那個 `.then(m => ({ default: m[name] }))` 轉接層。
    // 拿掉它的症狀是**執行期** "Element type is invalid"——tsc -b 看不到，
    // 而畫面上是一整片空白（fallback 也不會出現，因為 lazy 根本沒拿到元件）。
    const Fake = lazyPage(async () => ({ Fake: () => <div>假頁面</div> }), "Fake");

    render(
      <Suspense fallback={<div>載入中</div>}>
        <Fake />
      </Suspense>,
    );

    expect(await screen.findByText("假頁面")).toBeInTheDocument();
  });
});

describe("loadCardDialog", () => {
  it("解析到含 CardDialog 具名匯出的模組", async () => {
    // 路徑與「它是具名匯出」這兩件事都是 lazyPage 的前提，而兩者都只在執行期顯形。
    const mod = await loadCardDialog();
    expect(typeof mod.CardDialog).toBe("function");
  });
});
