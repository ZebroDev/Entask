// 示範資料集（`web/seed-data.<locale>.cjs`）的工時不變量（2026-10-08 批次 T8）。
//
// **為什麼要有這一支**：`seed_demo.cjs` 送出的工時條目是 `[who, hours, note, daysAgo]`，
// `daysAgo` 決定那一筆落在幾天前。少了閘門，兩件事會靜默壞掉：
//
//   1. **條目退化成三個元素** ⇒ 解構出的 `daysAgo` 是 `undefined` ⇒
//      `localDayString(undefined)` 走 `daysAgo ?? 0` 落回「今天」。看起來一切正常，
//      實際上整批工時又全部堆回 seed 執行的那一天——那正是本批次要修掉的缺陷本身
//      （`docs/state/32-demo-seed-defects-2026-10-04.md` 第四條）。
//   2. **同一人同一天超過 8 小時** ⇒ 工作日誌上會出現「一天 30.5 小時」這種數字，
//      而畫面不會有任何錯誤訊息。這條規則在資料層看不出來是錯的——只有把
//      「人 × 天」加總起來才看得到，所以判準寫在這裡。
//
// `daysAgo` 一律相對 seed 執行當天 ⇒ 重跑仍新鮮（`seed_demo.cjs` 的三個刻意的性質之一）。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// 去重鍵的單一來源（2026-10-11，`docs/state/42`）：與 `seed_demo.cjs` 吃同一個函式。
const { effortKey } = require("./lib/effort-key.cjs");
const LOCALES = ["zh-TW", "en"];

describe.each(LOCALES)("seed 資料集 %s 的工時不變量", (locale) => {
  const DATA = require(`../seed-data.${locale}.cjs`);
  // 走訪的是**頂層的 `cards`／`secondaryCards`**，不是 `projects`：`projects.main`
  // 只有 `{ name, description, board, lists }`——卡片是另外兩個鍵（見該檔檔尾的
  // `module.exports`，`PROJECT2` 的 `cards` 在同處被拆出去）。
  // 這一組留在**原始條目**上（`{ card, e }`）而不是接上標題的衍生陣列：長度要量的是
  // 條目本身的四個元素（見下面那一條註解）。
  const raws = [...DATA.cards, ...DATA.secondaryCards]
    .flatMap((c) => (c.effort || []).map((e) => ({ card: c.title, e })));
  it("每筆四個元素、hours > 0、daysAgo 是 0..60 的整數", () => {
    // 先確認真的走訪到了條目：卡片鍵或 `effort` 改名時，上面那個 `|| []` 會讓整支閘門
    // **空轉而全綠**——綠燈在「資料都對」與「根本沒撿到東西」兩種情況下長得一樣。
    expect(raws.length).toBeGreaterThan(0);
    for (const { card, e } of raws) {
      // **元素數要比對**（標題說「四個元素」就得真的量它）：五個元素的原條目會讓
      // `daysAgo` 與 `title` 各往前位移一格，而位移後的第 5 個位置仍是字串 ⇒ 沒有這一條
      // 就會**靜默通過**。訊息指名是哪一張卡。
      expect(e.length, `${card} 的工時條目應是 [who, hours, note, daysAgo]：${JSON.stringify(e)}`).toBe(4);
      const [who, hours, , daysAgo] = e;
      expect(typeof who).toBe("string");
      expect(hours).toBeGreaterThan(0);
      expect(Number.isInteger(daysAgo)).toBe(true);
      expect(daysAgo).toBeGreaterThanOrEqual(0);
      expect(daysAgo).toBeLessThanOrEqual(60);
      expect(card).toBeTruthy();
    }
  });
  it("同一人同一天 <= 8 小時（這是這條缺陷的判準本身）", () => {
    const perDay = new Map();
    for (const { e } of raws) {
      const [who, hours, , daysAgo] = e;
      const key = `${who}|${daysAgo}`;
      perDay.set(key, (perDay.get(key) || 0) + hours);
    }
    for (const [key, total] of perDay) expect(total, key).toBeLessThanOrEqual(8);
  });
  it("標籤名互異（同一看板只種一輪；重名會在 DB 唯一約束上撞 400）", () => {
    const names = DATA.labels.map(([name]) => name);
    // 空陣列會讓下面那條恆真——與上面工時兩條同一個防呆形狀（先證明撿到了東西）。
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
  // seed 的去重鍵是 `who|hours|note`（`seed_demo.cjs` 的集合——**在迴圈之前只建一次**，
  // 來源是該卡當下的 effort 端點回傳）；命中就 `continue`——**跳過、不更新、不搬日期**。
  // 所以同卡兩筆只要三元組相同，後一筆會被**靜默吃掉**：seed 照樣綠、`verify-seed-data.cjs`
  // 也看不到（它比的是兩份資料集，不是 seed 的碰撞集合）。
  //
  // ★ 前提是**已經有一筆命中該鍵**（重跑，或第一次跑中斷後再跑——此時兩筆都命中同一個集合
  // 成員，後一筆**永遠**補不回來）。全新卡的**第一次**跑兩筆都會被 POST（集合是空的）——
  // 不要把它讀成「第一跑就會少一筆」。
  //
  // 下面的 `key` **不是**在這裡拼的：它與 `seed_demo.cjs` 的兩處呼叫點共用
  // `scripts/lib/effort-key.cjs` 的 `effortKey()`（2026-10-11，`docs/state/42`——在那之前
  // 這個鍵有三份手寫副本，改一處而另一處不動時，**這支閘門會靜默地不再測真正的契約、
  // 而且維持綠**）。同一趟也收斂掉了成員資格那一行的 `${note}`：它不正規化 `null`
  // ⇒ 字串 "null" 對不上伺服器端的 `l.note ?? ''` ⇒ **重跑會多寫一列**
  // （今天兩份資料集都沒有 null 的 note，所以那是潛伏的、不是現行症狀）。
  it("同一張卡的工時三元組 who|hours|note 互異（seed 去重鍵的閘門）", () => {
    const byCard = new Map();
    for (const { card, e } of raws) {
      const [who, hours, note] = e;
      const key = effortKey(who, hours, note);
      byCard.set(card, [...(byCard.get(card) || []), key]);
    }
    for (const [card, keys] of byCard) {
      expect(new Set(keys).size, `卡片「${card}」的三元組有重複：${keys.join(" / ")}`).toBe(keys.length);
    }
  });
});
