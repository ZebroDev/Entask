// 背景惰性化：把 `root` 以外的內容從無障礙樹與 Tab 順序裡拿掉（2026-09-28）。
//
// 為什麼需要它：心智圖的全螢幕浮層是**純 div、不是 Radix 模態**，它對 AT 宣告了
// `aria-modal="true"`（`MindMapCanvas.tsx` 的 return），而**宣告的另一半是實作**
// ——宣告只說「外頭的東西現在不算數」，真正讓它們不算數的是這裡。少了這一半，
// 螢幕閱讀器的**瀏覽模式虛擬游標**照樣讀得到浮層後面的內容（第十批的焦點環繞
// 只擋得住鍵盤焦點那一半，見 `docs/STATE.md`〈心智圖全螢幕浮層〉）。
//
// ★ **走到 `document.body` 就停、不碰 body 的其他子節點**是刻意的取捨，不是省事：
//   Radix 的對話框與抽屜是**portal 到 body** 的，而它們可以從全螢幕浮層**裡面**開
//   （卡片抽屜）⇒ 它們是浮層的**前景**、不是背景。標到 body 那一層會把它們一起弄成
//   惰性（點不到、也讀不到），而那個破壞在 jsdom 裡看不出來。
//   ⇒ 判準：停的那一層＝「應用程式的根」；body 的其他子節點一律不屬於這次的「外」。
//
// ★ 還原時**寫回原本的值**、不是一律移除：有些節點本來就帶著 `aria-hidden`
//   （Radix 在它自己的模態上會設），一律移除等於把別人的狀態改掉。
interface Hidden {
  el: Element;
  inert: string | null;
  ariaHidden: string | null;
}

export function hideOutside(root: HTMLElement): () => void {
  const touched: Hidden[] = [];
  let node: HTMLElement | null = root;
  while (node) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent || parent === document.body) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      touched.push({
        el: sibling,
        inert: sibling.getAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      // `inert` 擋住焦點與指標事件，`aria-hidden` 是給還不認得 `inert` 的 AT 的
      // ——兩者一起下，缺一個就有一種 AT 讀得到背景。
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    node = parent;
  }
  return () => {
    for (const { el, inert, ariaHidden } of touched) {
      if (inert === null) el.removeAttribute("inert");
      else el.setAttribute("inert", inert);
      if (ariaHidden === null) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", ariaHidden);
    }
  };
}
