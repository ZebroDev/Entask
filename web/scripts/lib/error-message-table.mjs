// `src/Entask.Core/ErrorMessages.cs`（錯誤碼的 zh-TW 後備訊息表）的抽取器。
//
// 為什麼要有這支（設計 §5 Gate B）：那些字面值與 `web/src/i18n/locales/zh-TW/error.json`
// 的同批 key 是**同一個語意的兩份副本**——一份給舊前端與日誌（`{code, message}` body 的
// `message`），一份給新前端（錯誤碼的譯文）。改了一邊沒改另一邊 ⇒ **新前端顯示新措辭、
// 舊前端顯示舊措辭**（版本 skew 的憑據失效），而**全部測試照綠**：測試斷言的是 C# 那份、
// `check:labels` 連的是 key、`check:errors` 只看形狀。
//
// **單向**（pre-flight 的 Ruling F1）：`ErrorMessages` 的每一條都要在語系檔找到同名 key、
// 且值逐字相等；**反向不驗，這是刻意的**——語系檔的葉節點遠多於訊息表（其餘是 400／403
// 那些**不走 `ApiResults.NotFound`**、由各站點內嵌字面值產生的碼）。寫成集合相等 ⇒ 這道
// 閘門第一天就紅一大片，而下一步就是白名單——一開白名單它就沒了。key 集合的相等**已經由
// `check:labels` 的第八張表守著**，本檔守的是**值**。
//
// 本檔**不碰磁碟**（與 `extractBackendValues` 同一個形狀：原始碼進、資料出）：讀檔與讀語系
// JSON 都在呼叫端 `check-error-messages.mjs`。`codes` 由呼叫端交進來是刻意的——單元測試的
// 輸入要能**完全由夾具決定**，而「自己去讀 `ErrorCodes.cs`」與「從常數名反推碼值」
// （`CardNotFound` → camelCase 拆成 `card.notFound`）兩種寫法都會讓那些測試**照樣綠**，
// 卻改變了「這份 codes 是誰的資料」（`ErrorCodes.cs` 的，不是命名慣例的）。
//
// **認不得的構件一律拋**（呼叫端是閘門，fail closed 是它的契約）：回一張空表或半張表，
// 閘門同樣 exit 1——但**訊息會指錯方向**（說「語系檔少了某個 key」而不是「抽取器認不得
// 這個檔」），那正是這一輪要消滅的失效模式。
//
// 守備範圍（可編譯的 C# 上正確或大聲；與 `label-table-extract.mjs` 同一條保證）：
//   - 遮罩後**恰好一個** `switch`，後面緊接 `{`（多一個就是多一條本檢查看不見的路）。
//   - 每一條臂的左邊是 `ErrorCodes.<常數名>` 或 `_`；右邊是**字面值字串**（`"…"`／`@"…"`
//     讀得出值，`$"…"` 讀不出 ⇒ fail closed）；`_` 那條的右邊必須是 `throw`。
//   - 恰好一條 `_` 臂（那條是「未知的 code 當場大聲」的實作本體）。
//   - 常數名一律拿呼叫端給的 `codes` 查（查不到 ⇒ 拋，**不從名字反推**）。
//   - 同一個碼有兩條臂 ⇒ 拋（重複的臂在 C# 是編譯錯誤，在這裡也不准靜默取後者）。

import { LabelTableParseError, maskCSharp } from "./label-table-extract.mjs";

const bail = (message) => {
  throw new LabelTableParseError(message);
};

/**
 * `ErrorMessages.For` 的 `code switch` ⇒ `Map<碼值, zh-TW 值>`。
 *
 * `codes` 是**必要**參數：`ErrorCodes.cs` 的 `Map<常數名, 碼值>`（由呼叫端用
 * `extractBackendValues(src, { withNames: true })` 取得）。沒給就當場 TypeError。
 */
export function extractErrorMessageTable(source, { codes, label = "ErrorMessages.cs" } = {}) {
  if (!(codes instanceof Map)) {
    throw new TypeError(
      `${label}：extractErrorMessageTable 需要 codes（ErrorCodes.cs 的 Map<常數名, 碼值>）` +
        `——由呼叫端從磁碟讀進來。本檔不碰磁碟，也不從常數名反推碼值（那會在命名慣例` +
        `失效的第一天開始說謊）。`,
    );
  }

  const { masked, strings } = maskCSharp(source, label);
  const lineAt = (at) => source.slice(0, at).split("\n").length;

  // ── 1. 定位 switch（恰好一個，且後面緊接 `{`）─────────────────────────────
  const switches = [...masked.matchAll(/\bswitch\b/g)];
  if (switches.length !== 1) {
    bail(
      `${label} 遮罩後有 ${switches.length} 個 \`switch\`（${switches
        .map((m) => `第 ${lineAt(m.index)} 行`)
        .join("、")}）——本檢查要求恰好一個：多一個就是多一條本檢查看不見的路，` +
        `而本檢查不猜（fail closed）。`,
    );
  }
  let open = switches[0].index + "switch".length;
  while (/\s/.test(masked[open] ?? "")) open++;
  if (masked[open] !== "{") {
    bail(
      `${label}:${lineAt(switches[0].index)} 的 \`switch\` 後面不是 \`{\`——` +
        `本檢查只認 \`… switch { … }\` 這個形狀（本檢查不猜）。`,
    );
  }
  let depth = 0;
  let close = -1;
  for (let j = open; j < masked.length; j++) {
    if (masked[j] === "{") depth++;
    else if (masked[j] === "}") {
      depth--;
      if (depth === 0) {
        close = j;
        break;
      }
    }
  }
  if (close < 0) bail(`${label}:${lineAt(open)} 的 \`switch\` 沒有收尾的 \`}\`——本檢查不猜（fail closed）。`);

  // ── 2. 切臂：深度 0 的逗號（洞裡的 `{…}` 也被遮罩保留，所以深度算得準）────────
  const segments = [];
  let from = open + 1;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let j = open + 1; j < close; j++) {
    const c = masked[j];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (c === "," && paren === 0 && bracket === 0 && brace === 0) {
      segments.push([from, j]);
      from = j + 1;
    }
  }
  segments.push([from, close]);

  // ── 3. 逐臂解析 ────────────────────────────────────────────────────────
  const table = new Map();
  let discards = 0;

  for (const [segFrom, segTo] of segments) {
    const text = masked.slice(segFrom, segTo);
    // 主體前後的空白、以及「只有註解」的間隙（註解被遮成空白）——兩者都不是臂。
    // 中間出現「只有空白」的臂在可編譯的 C# 上不可能（`,,` 編不過），故略過不猜。
    if (text.trim() === "") continue;
    // 臂的起點＝第一個非空白字元（行號要指在那裡，不是指在前一條臂的逗號後面）。
    const armAt = segFrom + (text.length - text.trimStart().length);
    const armLine = lineAt(armAt);

    const arrow = text.indexOf("=>");
    if (arrow < 0) bail(`${label}:${armLine} 的 switch 臂沒有 \`=>\`——本檢查不猜（fail closed）。`);
    const left = text.slice(0, arrow).trim();
    let k = segFrom + arrow + 2;
    while (/\s/.test(masked[k] ?? "")) k++;

    if (left === "_") {
      if (!/^throw\b/.test(masked.slice(k, segTo))) {
        bail(
          `${label}:${armLine} 的 \`_\` 臂右邊不是 \`throw …\`——那條臂是「未知的 code 當場` +
            `大聲」的實作本體，改成別的東西會讓未知的 code 靜默得到一個值（本檢查不猜）。`,
        );
      }
      discards++;
      continue;
    }

    const named = /^ErrorCodes\.([A-Za-z_]\w*)$/.exec(left);
    if (named === null) {
      bail(
        `${label}:${armLine} 的 switch 臂左邊是 \`${left}\`——本檢查只認 \`ErrorCodes.<常數名>\`` +
          ` 與 \`_\` 兩種。其他來源／形狀一律不猜（fail closed）：靜默略過它等於回一張` +
          `空表或半張表，而閘門的訊息會指錯方向。`,
      );
    }
    const name = named[1];
    const code = codes.get(name);
    if (code === undefined) {
      bail(
        `${label}:${armLine} 的 \`ErrorCodes.${name}\` 不在呼叫端給的 codes 裡——` +
          `本檢查不猜（碼值來自 ErrorCodes.cs，不從常數名反推）。`,
      );
    }

    // 右邊：與 `extractBackendValues` 同一個讀法（跳過 `@`／`$` 前綴、要看得見開引號）。
    let q = k;
    while (masked[q] === "@" || masked[q] === "$") q++;
    const literal = masked[q] === '"' ? strings.get(q) : undefined;
    if (literal === undefined) {
      bail(
        `${label}:${armLine} 的 \`${code}\` 右邊不是字面值字串（內插字串或認不得的形狀）` +
          `——本檢查不猜（fail closed）。`,
      );
    }
    if (masked.slice(literal.end, segTo).trim() !== "") {
      bail(`${label}:${armLine} 的 \`${code}\` 在字串之後還有別的構件——本檢查不猜（fail closed）。`);
    }
    if (table.has(code)) {
      bail(
        `${label}:${armLine} 有兩條臂指向同一個 code \`${code}\`——重複的臂在 C# 是編譯錯誤，` +
          `在這裡也不准靜默取後者（本檢查不猜）。`,
      );
    }
    table.set(code, literal.value);
  }

  // ── 4. 整張表的兩條不變量 ────────────────────────────────────────────────
  if (discards !== 1) {
    bail(
      `${label} 的 \`switch\` 有 ${discards} 條 \`_ => throw …\` 臂——本檢查要求恰好一條：` +
        `少了它，未知的 code 走的是編譯器的例外而不是這張表自己的（本檢查不猜）。`,
    );
  }
  if (table.size === 0) {
    bail(`${label} 的 \`switch\` 裡沒有任何 \`ErrorCodes.<常數名> => "…"\` 的臂——本檢查不猜（fail closed）。`);
  }
  return table;
}
