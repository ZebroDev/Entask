// AGENTS.md 的常駐預算。CI 與本機皆可跑：node scripts/check-doc-budget.mjs
//
// 為什麼需要這支：`CLAUDE.md`（11 bytes）只有一行 `@AGENTS.md` ⇒ `AGENTS.md` 對**每個 session
// 的每個請求**都是常駐前綴，也是壓縮後被**逐字重新注入**的那一份。本 repo 記載 session 在約
// **270K tokens** 處撞上 `Request too large`（推導見
// `docs/history/2026-09-18-context-ceiling-diagnosis.md`）——常駐檔案佔掉的是視窗空間，
// 與每一個 tool result 搶同一塊。**它自己不會喊痛，只會讓別的東西比較早死。**
//
// 為什麼是位元組、不是行數：這份文件的平均行密度可以到 755 bytes/行
// （`.superpowers/sdd/README.md` 就是這個密度），**行數綁不住東西**。位元組是實查得到的量。
//
// **★ 這支閘門不守「敘事有沒有堆在錯的地方」——不要把它讀成那個。**
// 它只回答「常駐檔有沒有超過上限」。2026-09-21 的外移批次原本設計了一個形狀閘門
// （`grep -c '以下是稍早'`）要守敘事堆疊，**壓力測試當場證明它是假綠燈**：它回 11，
// 而檔裡有 16 個日期標記區塊，三個繞得過的形狀（`以下是同日稍早（`／`同日稍後（`／
// `以下是上一階段（`）此刻就在檔案裡。**那個設計已經被明確否決，改採「語意規則 ＋ 位元組上限」**
// ——語意規則在 `AGENTS.md` 接手流程的步驟 3，位元組上限就是這一支。
// ⇒ **兩者是互補的兩半：這一支守得住「又長回來了」，守不住「為什麼長」；單獨拿掉任一半，
// 另一半都會看起來像通過了。** 要重新加形狀閘門之前先讀上面那三個形狀。
//
// **★ 它現在有四個檢查，不是一個**（①②③ 2026-09-21 Batch 2 起；④ 2026-09-30 Batch 3 起）：
// ① `AGENTS.md` 的大小上限；② 常駐指標那一行還在（`POINTER_NEEDLE`）；
// ③ 指標指的 `docs/STATE.md` 存在；④ **索引區**（`index:invariants` ＋ `index:symptoms`
// 兩段標記之間）**合計 ≤ `INDEX_MAX_BYTES`**。
// ②③ 是**雙向契約**的兩半：未結項目自 2026-09-21 起搬出本檔，入口只剩那一行，
// 而**它消失時本檔看起來完全正常**（大小沒超、檔案在）——所以要有東西守著它。
// 判別力是當場取到的：這兩條在 `docs/STATE.md` 建起來之前是**紅的**。
//
// **④ 為什麼要有**（2026-09-30 Batch 3 的裁定）：內容移出去之後，**索引就是留下來的那一份**，
// 而索引的天性就是「再加一行」。**超標的索引沒有任何徵兆**——閘門與全部測試都不會紅，
// 只有常駐前綴慢慢長回去。6,000 是裁定值（落地當天實測 4,944＝不變量 3,405 ＋ 症狀 1,539），
// 留的是「再收幾條」的餘裕、不是留給整節成長的。**標記少一個、多一個都 exit 1**：
// 「量到 0」與「量不到」在這裡必須分得開（少了標記而靜默通過，正是這支要防的那種失敗）。
//
// **2026-10-10 改形（索引兩層化）**：索引區只留**路由 ＋ 觸發詞**（識別碼為主）與症狀速記；
// 各條短摘要移入 `docs/invariants/` 各檔頭，規則全文與解釋本來就在檔內——常駐不再逐條抄。
// 上限值未動（6,000 仍是裁定值）；超標訊息照新形狀改寫。**標記外**那段「索引怎麼讀」的散文
// 不計入，它放的是規則、不是索引條目（已記入下方盲區第 7 條）。
//
// **已知盲區（誠實記載，別當它完備）**：
//   1. **只對 `AGENTS.md` 設上限**：`docs/STAGES.md`（敘事的出口）與 `docs/STATE.md`
//      （活狀態的出口）**都刻意不設上限**——成長在那裡是預期行為，不是失控。
//      本支對後者**只看它在不在**，不看它多大。其他常駐檔（`~/.claude/rules/*.md`、
//      skills）也不在範圍內，而它們一樣吃同一個視窗。
//   1b. **②是子字串比對，很弱**：那句話被搬到本檔別的位置、或被寫進一段註解，它照樣綠。
//      它擋的是「整句不見了」，不是「那句話還在對的地方」。
//   2. **位元組不是 tokens**：CJK 約 1 token/字元，但這是估算，**本檔全篇唯一沒有實測支撐的
//      換算**。上限是位元組，因為位元組是實查的。
//   3. **它不告訴你「該搬什麼」**：超標時的訊息只會指向 `docs/STAGES.md`，
//      不會、也不能判斷哪一段是死的。
//   4. **上限是政策數字，不是量出來的懸崖**：270K 是量出來的死亡點，而 160,000 是
//      Batch 1 外移後（當時 153,935）留約 4% 成長空間的**裁定值**。**那個 4% 已經不成立**
//      （Batch 2 之後餘裕大得多），但上限**沒有跟著調**——因為調它是裁定、不是算術。
//      ⇒ 留下這段是為了讓「這個數字是哪來的」可考，**不要讀成「今天只剩 4%」**。
//      要改它要先有裁定，不是隨手調。
//      **2026-09-30（Batch 3）**：裁定把上限改為 **40,000**（內容進 `docs/`、常駐只留
//      規則 ＋ 索引；落地當天實測 38,119）。**40,000 一樣是裁定值、不是量出來的懸崖。**
//   5. **④ 量的是標記之間的位元組、不是索引的品質**：它擋不住「索引寫得沒人要讀」，
//      也擋不住「索引指向的檔爛掉」——那兩半靠人與複閱。
//   6. **找不到 `AGENTS.md` 時整支跳過（exit 0；2026-10-06 裁定）**：公開匯出樹沒有該檔
//      （公開庫要能直接跑 npm 腳本）⇒ 跳過，四個檢查一起不跑。**私有主庫把該檔刪掉也走同一條路**
//      ——差別只在它會把跳過訊息印出來；那條常駐指標因此不再有人守，看到跳過訊息要去確認原因。
//   7. **標記外的散文不計入**（2026-10-10 兩層化起）：兩區標記**外**的引言段放的是「索引怎麼讀」的
//      規則（本來就不該進索引），不受 ④ 管——但**索引條目不得搬去那裡**：那是繞過 ④，不是遵守它。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..'); // web/scripts -> repo root

const TARGET = 'AGENTS.md';
const MAX_BYTES = 40_000; // 裁定值（2026-09-30 Batch 3），見檔頭第 4 條
const EXIT_DEST = 'docs/STAGES.md';
const STATE_FILE = 'docs/STATE.md'; // 活狀態的外移目的地（2026-09-21 Batch 2）
const POINTER_NEEDLE = '未結項目在 `docs/STATE.md`'; // 常駐指標的指紋
// ④ 索引區（2026-09-30 Batch 3）：標記成對出現，內容合計不得超過 INDEX_MAX_BYTES。
const INDEX_MAX_BYTES = 6_000; // 裁定值（2026-09-30 Batch 3），見檔頭第 4 條與 ④ 的理由
const INDEX_REGIONS = [
  ['<!-- index:invariants:start -->', '<!-- index:invariants:end -->'],
  ['<!-- index:symptoms:start -->', '<!-- index:symptoms:end -->'],
];

const abs = join(REPO_ROOT, TARGET);

// 2026-10-06 裁定：這棵樹沒有 AGENTS.md ＝ 公開匯出樹的正常情形（公開庫要能直接跑
// npm 腳本、不報錯）⇒ 跳過檢查並 exit 0，且把「跳過」這件事印出來。
if (!existsSync(abs)) {
  console.log(
    `找不到 ${TARGET}（預期在 ${abs}）：這棵樹沒有常駐預算可守——公開匯出樹的正常情形 ⇒ 跳過（exit 0）。\n` +
      `  私有主庫若看到這一行：那是 ${TARGET} 被刪了，先把它找回來（見檔頭「已知盲區」第 6 條）。`,
  );
  process.exit(0);
}
const bytes = statSync(abs).size;

if (bytes > MAX_BYTES) {
  console.error(
    `${TARGET} 常駐預算超標：實測 ${bytes} bytes，上限 ${MAX_BYTES} bytes` +
      `（超出 ${bytes - MAX_BYTES}）。\n`,
  );
  console.error(
    `  ${TARGET} 是**每個請求**的常駐前綴（\`CLAUDE.md\` 只有一行 \`@AGENTS.md\`），` +
      `它佔的是與每個 tool result 同一個視窗。\n` +
      `  純歷史敘事（階段沿革、被取代的舊基準、已結案的追蹤條目）請搬到 ${EXIT_DEST}；` +
      `未結項目在 ${STATE_FILE}（2026-09-21 起）；現行規則、程式碼不變量留在原處。\n` +
      `  搬完記得：被取代的舊基準是**刪掉**，不是往後堆（接手流程步驟 3）。`,
  );
  process.exit(1);
}

// ② 常駐指標必須在（2026-09-21 Batch 2 起）。少了它，新 session 不知道活狀態在哪，
//    而本檔**看起來完全正常**（大小沒超、檔案在）——那句話不見了沒有任何徵兆，是靜默失敗。
const agentsText = readFileSync(abs, 'utf8');
if (!agentsText.includes(POINTER_NEEDLE)) {
  console.error(
    `${TARGET} 找不到常駐指標：預期含有「${POINTER_NEEDLE}」。\n` +
      `  那一行是 ${STATE_FILE} 唯一的入口（未結項目自 2026-09-21 起不在本檔），` +
      `\n  它消失時沒有任何徵兆，所以由這支閘門守。`,
  );
  process.exit(1);
}

// ③ 指標指的檔必須存在（同批）。**指向不存在的東西**正是外移批次要消滅的缺陷類別，
//    而指標與標的是**雙向契約**：任一邊單獨看都正常，所以要一起驗。
const stateAbs = join(REPO_ROOT, STATE_FILE);
if (!existsSync(stateAbs)) {
  console.error(
    `${TARGET} 的常駐指標指向不存在的檔案：${STATE_FILE}（預期在 ${stateAbs}）。\n` +
      `  這不是「沒有未結項目」，是缺陷——回報它，不要當它不存在。`,
  );
  process.exit(1);
}

// ④ 索引區合計上限（2026-09-30 Batch 3 起）。**少了標記不可以靜默通過**：那個時候
//    「索引區 0 bytes」與「根本沒有索引區」量到的是同一個數字——所以先驗標記恰好一對，
//    而且要在算 bytes **之前**驗（先算再驗的話，缺標記的那一段會先被判成 0 而通過）。
let indexBytes = 0;
const indexParts = [];
for (const [open, close] of INDEX_REGIONS) {
  const label = open.replace('<!-- index:', '').replace(':start -->', '');
  const opens = agentsText.split(open).length - 1;
  const closes = agentsText.split(close).length - 1;
  if (opens !== 1 || closes !== 1) {
    console.error(
      `${TARGET} 的索引標記不成立：${label} 的 start ${opens} 處、end ${closes} 處（各須恰好 1 處）。\n` +
        `  索引是內容外移後**留在常駐的那一份**，少了標記就沒有東西守著它，` +
        `而且量到的會是 0 bytes、看起來像通過。`,
    );
    process.exit(1);
  }
  const from = agentsText.indexOf(open) + open.length;
  const to = agentsText.indexOf(close);
  const size = Buffer.byteLength(agentsText.slice(from, to), 'utf8');
  indexParts.push(`${label} ${size}`);
  indexBytes += size;
}

if (indexBytes > INDEX_MAX_BYTES) {
  console.error(
    `${TARGET} 索引區超標：實測 ${indexBytes} bytes（${indexParts.join(' ＋ ')}），` +
      `上限 ${INDEX_MAX_BYTES} bytes（超出 ${indexBytes - INDEX_MAX_BYTES}）。\n`,
  );
  console.error(
    `  索引是內容外移後留在常駐的那一份，而它的天性就是「再加一行」。\n` +
      `  動手前先問：這個**觸發詞**不進路由會怎樣？答得出來（例：它只在被改壞時才有用）` +
      `就別加；真要加，先看有沒有舊的觸發詞可以換掉（規則細則留檔內，不佔常駐）。`,
  );
  process.exit(1);
}

console.log(
  `${TARGET} 常駐預算檢查通過：${bytes} / ${MAX_BYTES} bytes` +
    `（餘裕 ${MAX_BYTES - bytes}，超出時的目的地是 ${EXIT_DEST}）；` +
    `常駐指標與 ${STATE_FILE} 俱在；` +
    `索引區 ${indexBytes} / ${INDEX_MAX_BYTES} bytes（${indexParts.join(' ＋ ')}）。`,
);
