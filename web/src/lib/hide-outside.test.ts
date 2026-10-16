import { afterEach, describe, expect, it } from "vitest";
import { hideOutside } from "./hide-outside";

// 這個 helper 的契約是「走多高、標誰、還原成什麼」，與心智圖無關 ⇒ 這裡自己搭樹。
// 「接進浮層、而且真的離開無障礙樹」那一半在 `mindmap-tab.test.tsx`（屬性）與
// 瀏覽器探針（無障礙樹本身，jsdom 看不到）——三層各守一段。
const mount = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("hideOutside", () => {
  it("每一層的兄弟節點都變成惰性，root 自己與它的祖先鏈不動", () => {
    const host = mount(`
      <div id="siblingA"></div>
      <div id="branch">
        <div id="siblingB"></div>
        <div id="overlay"></div>
      </div>`);
    const overlay = host.querySelector<HTMLElement>("#overlay")!;

    hideOutside(overlay);

    for (const id of ["#siblingA", "#siblingB"]) {
      const el = host.querySelector(id)!;
      // 兩者一起下：`inert` 擋焦點與指標事件、`aria-hidden` 給還不認得它的 AT
      expect(el.getAttribute("inert"), id).toBe("");
      expect(el.getAttribute("aria-hidden"), id).toBe("true");
    }
    // 往上每一層都只標「兄弟」⇒ 祖先鏈（branch、host）不是「外」
    expect(overlay.hasAttribute("inert")).toBe(false);
    expect(host.querySelector("#branch")!.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("走到 App 根就停：body 的其他子節點（Radix 的 portal）不被標記", () => {
    const host = mount(`<div id="branch"><div id="siblingB"></div><div id="overlay"></div></div>`);
    // 模擬 Radix：抽屜／對話框是 portal 到 **body** 的，而它們可以從浮層**裡面**開
    // ⇒ 它們是浮層的前景、不是背景。標到 body 那一層會把它們一起弄成惰性。
    const portal = document.createElement("div");
    portal.id = "portal";
    portal.innerHTML = `<button id="drawerButton">抽屜</button>`;
    document.body.append(portal);

    hideOutside(host.querySelector<HTMLElement>("#overlay")!);

    // ★ 對照組先確立「這一跑真的有標到東西」，否則下面那條在「什麼都沒標」時也綠
    expect(host.querySelector("#siblingB")!.getAttribute("inert"), "同層兄弟有被標").toBe("");
    expect(portal.hasAttribute("inert"), "body 的 portal 不該被標").toBe(false);
    expect(portal.querySelector("#drawerButton")!.hasAttribute("aria-hidden")).toBe(false);
  });

  it("還原成原本的值，不是一律移除", () => {
    const host = mount(`
      <div id="kept" aria-hidden="false"></div>
      <div id="alreadyInert" inert></div>
      <div id="branch"><div id="plain"></div><div id="overlay"></div></div>`);
    const restore = hideOutside(host.querySelector<HTMLElement>("#overlay")!);

    restore();

    // 本來就有的值回到原值（`false` 與 `""` 都與「移除」分得開）
    expect(host.querySelector("#kept")!.getAttribute("aria-hidden")).toBe("false");
    expect(host.querySelector("#alreadyInert")!.hasAttribute("inert")).toBe(true);
    // 本來沒有的才移除
    const plain = host.querySelector("#plain")!;
    expect(plain.hasAttribute("inert")).toBe(false);
    expect(plain.hasAttribute("aria-hidden")).toBe(false);
  });

  it("反覆開關兩次之後背景仍是乾淨的（還原 read-modify-write，不是把上次的標記寫回去）", () => {
    // 這是畫面上真實的循環（進全螢幕 → 退出 → 再進）：第二次若把「已經被標過的值」
    // 當成原值存下來，退出時寫回的就是 `inert=""`——背景**永久**留在惰性狀態，
    // 而畫面上只有「整個 app 點不動、讀不到」這個症狀。
    const host = mount(`<div id="branch"><div id="siblingB"></div><div id="overlay"></div></div>`);
    const overlay = host.querySelector<HTMLElement>("#overlay")!;

    hideOutside(overlay)();
    hideOutside(overlay)();

    expect(host.querySelector("#siblingB")!.hasAttribute("inert")).toBe(false);
  });

  it("root 沒有父節點時不拋，還原函式是 no-op", () => {
    // 未掛載的節點（例如 effect 跑之前就被卸載）不該讓整條路徑炸掉
    const orphan = document.createElement("div");
    orphan.innerHTML = `<div id="child"></div>`;

    const restore = hideOutside(orphan);

    expect(() => restore()).not.toThrow();
    expect(orphan.hasAttribute("inert")).toBe(false);
    expect(orphan.querySelector("#child")!.hasAttribute("inert")).toBe(false);
  });
});
