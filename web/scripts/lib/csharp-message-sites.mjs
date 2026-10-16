// 設計 §4.2 的閘門 C（`check-message-values.mjs`）的抽取層：把 C# 裡的
// `{ code, message }` 站點抽成資料，交給 `message-value-compare.mjs` 比對。
//
// **它只做抽取，不比對、不碰磁碟**：檔案內容與 `ErrorCodes` 的對照表（`codes`）都由呼叫端
// 注入。認不得的形狀一律拋 `LabelTableParseError`（與 `label-table-extract.mjs` 同一族的
// 失敗模式）——「回半張表」會讓比對的訊息指錯方向（說「值不一致」而不是「抽取器認不得」）。
//
// ## 站點是什麼（**結構性**的定義，不是檔名或行號白名單）
//
// 一個「**帶 `message` 成員的匿名物件**」，而且它是 `Results.*(…)`／`TypedResults.*(…)`／
// `…WriteAsJsonAsync(…)` 的引數——那正是 HTTP 錯誤 body 的形狀。其餘形狀各有名字：
//
//   - `delegated`：`message = ErrorMessages.For(code)`——**交給閘門 B**（`check-error-messages.mjs`
//     就是為那張表而生的），這裡不重複驗。
//   - `mapper`：物件是 `=> new { … }`（表達式主體的成員），不是 HTTP body。實例：
//     `NotificationPayloads.Push`——它的 `message = n.Message` 是**通知的欄位**，不是錯誤訊息。
//     判準是**語法位置**（往前一個非空白字元是 `=>`），不是那個檔案的名字。
//   - `identity`：`code = IdentityErrorCodes.Map(e.Code)`——`identity.*` 那 10 個碼的訊息來自
//     ASP.NET Identity 自己的 describer，**兩邊在語法上不可比**（已知盲區，見驅動程式的檔頭）。
//   - `producer`：生產者的三元組回傳 `(false, ErrorCodes.X, "字面值")`——**不是** HTTP 站點，
//     但值要在這裡比（呼叫端只是把它轉發出去）。生產者的辨識特徵是回傳型別
//     `(bool X, string? Y, string? Z)`，**不是**方法名。
//   - `forward`：`{ code, message }`／`{ code = v.Code, message = v.Message }`——值來自生產者，
//     這裡只確認它接到了**認得的**生產者（沒有接到就拋），比對由生產者那一側負責。
//     帶 `@params` 的轉發站點另外要求**守衛歸屬**（緊鄰上一行的 `if (code == ErrorCodes.X)`），
//     否則參數對不到碼、R3 就退化成一條無從判別的規則。
//
// ## 為什麼「往前一個非空白字元」就分得出 HTTP body 與 DTO
//
// 這個判準不會隨時間腐爛（不動檔名、不動行號），而且**兩邊都不是預設值**：認不得就走
// `bail`。今天的三個實例各自落在三條分支上（`(`＝HTTP、`=>`＝DTO、其餘大聲）。

import { LabelTableParseError, maskCSharp } from "./label-table-extract.mjs";

const bail = (message) => {
  throw new LabelTableParseError(message);
};

/**
 * 生產者的辨識特徵：回傳型別 `(bool X, string? Y, string? Z)`。
 *
 * 用**回傳型別**而不是方法名，是因為方法名可以在別處再長一個；型別是「code 與 message
 * 分開回傳」這個契約本身。今天兩個生產者（`CustomFieldValidator.ValidateValue`、
 * `CustomFieldEndpoints.ValidateDefinition`）都是這個形狀。
 */
const PRODUCER_SIGNATURE = /\(bool\s+\w+\s*,\s*string\?\s+\w+\s*,\s*string\?\s+\w+\)/g;

/** 認得的 HTTP 回應產生器。比對的是呼叫式的最左段（`Results.BadRequest` 的 `Results`）。 */
const RESULT_RECEIVERS = new Set(["Results", "TypedResults"]);

const IDENT = /^[A-Za-z_]\w*$/;
const SPACE = /\s/;

/** 位移 → 行號。換行位置只算一次。 */
const makeLineOf = (source) => {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

/** 往回跳過空白（含換行），回傳第一個非空白字元的索引；沒有就回 -1。 */
const skipBack = (text, from) => {
  let i = from;
  while (i >= 0 && SPACE.test(text[i])) i--;
  return i;
};

/** 往**前**跳過空白（含換行），回傳第一個非空白字元的索引；沒有就回 `text.length`。 */
const skipFwd = (text, from) => {
  let i = from;
  while (i < text.length && SPACE.test(text[i])) i++;
  return i;
};

/**
 * `masked` 的 `at`（一個 `open` 字元）配對到的索引；配不到就拋。
 *
 * `at` 與 `open` 是**兩個不同的參數**：只給索引的話，深度計數會拿「字元 === 數字」去比，
 * 恆為 false ⇒ 第一個收尾字元就把它算成「多出來的一個」。那個版本的失敗訊息讀起來像
 * 「括號沒配對」，而真正的成因是**這個函式自己**——2026-09-20 實測踩到，全部 28 支紅。
 */
const matchPair = (masked, at, open, close, label, lineOf) => {
  if (masked[at] !== open) {
    bail(
      `${label}:${lineOf(at)} 的索引 ${at} 指向 \`${masked[at] ?? ""}\` 而不是 \`${open}\`——` +
        `本檢查不猜（呼叫端傳錯位置）。`,
    );
  }
  let depth = 0;
  for (let i = at; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  bail(`${label}:${lineOf(at)} 的 \`${open}\` 沒有配對的 \`${close}\`——本檢查不猜（fail closed）。`);
  return at;
};

/** 由 `from`（含）到 `to`（不含）之間、深度 0 的分隔符切開；回傳 `[start, end)` 陣列。 */
const splitTopLevel = (masked, from, to, separator, label, lineOf) => {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === separator && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  if (depth !== 0) bail(`${label}:${lineOf(from)} 的括號沒有配對——本檢查不猜（fail closed）。`);
  parts.push([start, to]);
  return parts.filter(([a, b]) => masked.slice(a, b).trim() !== "");
};

/**
 * `a ? b : c` ⇒ `{ cond: {text, at}, then: …, else: … }`（`at` 是**相對於 `text` 起點**的位移）；
 * 不是三元式回 `null`。`??`／`?.` 不是三元式；`then` 分支裡的三元式靠 `nested` 跳過。
 */
const splitTernary = (text) => {
  let depth = 0;
  let question = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?") {
      if (text[i + 1] === "?" || text[i + 1] === ".") i++;
      else {
        question = i;
        break;
      }
    }
  }
  if (question < 0) return null;
  let nested = 0;
  for (let i = question + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?") {
      if (text[i + 1] === "?" || text[i + 1] === ".") i++;
      else nested++;
    } else if (depth === 0 && c === ":") {
      if (nested > 0) {
        nested--;
        continue;
      }
      const at = (from, to) => {
        let k = from;
        while (k < to && SPACE.test(text[k])) k++;
        return { text: text.slice(k, to).trimEnd(), at: k };
      };
      return { cond: at(0, question), then: at(question + 1, i), else: at(i + 1, text.length) };
    }
  }
  return null;
};

/** `open` 前面那個被呼叫的名稱（`Results.BadRequest(` ⇒ `Results.BadRequest`）。 */
const calleeBefore = (masked, open) => {
  let i = skipBack(masked, open - 1);
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_.]/.test(masked[i])) i--;
  return masked.slice(i + 1, end);
};

/**
 * 讀一個字串值。
 *
 * - 非內插 ⇒ `{ kind: "literal", text }`（解碼過的值由 `strings` 提供）。
 * - 內插（`$"…"`）⇒ `{ kind: "template", shape }`——洞換成 `\u0000`，其餘字元取自**原文**
 *   （遮罩只有導航用途：字面部分在遮罩裡是空白，拿它當內容會得到一串空白）。
 * - 不是字串 ⇒ `null`（由呼叫端決定那是什麼）。
 *
 * **`$@"…"`／`@$"…"` 到不了這裡**：`maskCSharp` 對它們就 fail closed 了（見該檔檔頭）。
 */
const readStringValue = (raw, masked, strings, abs, label, lineOf) => {
  const c = masked[abs];
  // 原始字串（`"""…"""`）在遮罩層是**整段白掉的**（連前綴也在內）
  // —— 所以 `masked[abs]` 看起來像空白，不是字串。要認它得回到**原文**。
  if (raw.startsWith('"""', abs) || raw.startsWith('$"""', abs) || raw.startsWith('@"""', abs)) {
    bail(
      `${label}:${lineOf(abs)} 的訊息是原始字串（\`"""…"""\`）——` +
        `遮罩層把它整段遮掉了，本檢查讀不到它的值。` +
        `本檢查不猜。請改寫該檔（改用一般字串或逐字字串），` +
        `或更新 web/scripts/lib/csharp-message-sites.mjs。`,
    );
  }
  const start =
    c === '"'
      ? { quoteIndex: abs, interp: false }
      : c === "@" && masked[abs + 1] === '"'
        ? { quoteIndex: abs + 1, interp: false }
        : c === "$" && masked[abs + 1] === '"'
          ? { quoteIndex: abs + 1, interp: true }
          : null;
  if (start === null) return null;
  if (!start.interp) {
    const record = strings.get(start.quoteIndex);
    if (record === undefined) {
      // 原始字串（`"""…"""`）不進 `strings`。今天的訊息裡一條都沒有——認不得就大聲。
      bail(
        `${label}:${lineOf(abs)} 的字串字面值不在遮罩層的字串表裡（原始字串 \`"""…"""\` ` +
          `不在其中）——本檢查不猜。請改寫該檔，或更新 web/scripts/lib/csharp-message-sites.mjs。`,
      );
    }
    return { kind: "literal", text: record.value };
  }
  // 內插字串：在**遮罩**上導航（洞的括號是配對的；洞裡的巢狀字串、字元字面值與註解
  // 都已被遮成空白，所以深度計數不会被它們干擾），內容取自原文。
  let j = start.quoteIndex + 1;
  let shape = "";
  while (j < raw.length) {
    if (masked[j] === '"') return { kind: "template", shape };
    if (masked[j] === "{") {
      shape += "\u0000";
      j = matchPair(masked, j, "{", "}", label, lineOf) + 1;
      continue;
    }
    shape += raw[j];
    j++;
  }
  bail(`${label}:${lineOf(start.quoteIndex)} 的內插字串沒有收尾——本檢查不猜（fail closed）。`);
  return null;
};

/** `new` 之後的第一個 `{`；不是 `new {` 就回 -1。 */
const braceOfNew = (masked, at) => {
  if (masked.slice(at, at + 3) !== "new") return -1;
  if (at > 0 && /[A-Za-z0-9_]/.test(masked[at - 1])) return -1;
  let i = at + 3;
  while (i < masked.length && SPACE.test(masked[i])) i++;
  return masked[i] === "{" ? i : -1;
};

/**
 * 解析一個匿名物件的成員：`name = expr` 或 `name`（簡寫）。
 *
 * `source` 是**原文**，只用來跳空白：遮罩把字串換成空白，看遮罩跳會跳過
 * **整個被遮掉的字串**，降落在它後面的逗點上。
 */
const parseMembers = (source, masked, brace, close, label, lineOf) => {
  const members = [];
  for (const [a, b] of splitTopLevel(masked, brace + 1, close, ",", label, lineOf)) {
    const raw = masked.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trimEnd();
    // `=` 但不能是 `=>`／`==`／`!=`／`<=`／`>=`。
    let eq = -1;
    let depth = 0;
    for (let i = lead; i < text.length; i++) {
      const c = text[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "=" && depth === 0 && text[i + 1] !== ">" && text[i - 1] !== "=" &&
               text[i - 1] !== "!" && text[i - 1] !== "<" && text[i - 1] !== ">") {
        eq = i;
        break;
      }
    }
    const from = eq < 0 ? text.length : eq + 1;
    let valueStart = a + from;
    while (valueStart < b && SPACE.test(source[valueStart])) valueStart++;
    members.push({
      name: masked.slice(a + lead, a + (eq < 0 ? text.length : eq)).trim().replace(/^@/, ""),
      value: masked.slice(valueStart, b).trimEnd(),
      valueStart,
      shorthand: eq < 0,
    });
  }
  return members;
};

/**
 * 生產者：`{ name, open, close }`（方法名與主體範圍）。
 *
 * 順序是 **回傳型別 → 方法名 → 參數列 → 主體**：那個回傳型別**就是**簽章的第一段，
 * 所以「緊接在 `(` 前面的識別碼」在這條路上是 `static`（修飾詞），不是方法名。
 */
const findProducers = (masked, label, lineOf) => {
  const producers = [];
  PRODUCER_SIGNATURE.lastIndex = 0;
  let match;
  while ((match = PRODUCER_SIGNATURE.exec(masked)) !== null) {
    const returnTypeEnd = matchPair(masked, match.index, "(", ")", label, lineOf);
    const nameStart = skipFwd(masked, returnTypeEnd + 1);
    let nameEnd = nameStart;
    while (nameEnd < masked.length && /[A-Za-z0-9_]/.test(masked[nameEnd])) nameEnd++;
    const name = masked.slice(nameStart, nameEnd);
    if (!IDENT.test(name)) {
      bail(
        `${label}:${lineOf(match.index)} 的回傳型別 \`(bool, string?, string?)\` 後面不是方法名` +
          `（讀到 \`${name}\`）——本檢查不猜。`,
      );
    }
    const paramsOpen = skipFwd(masked, nameEnd);
    if (masked[paramsOpen] !== "(") {
      bail(`${label}:${lineOf(nameStart)} 的生產者 \`${name}\` 後面不是參數列——本檢查不猜。`);
    }
    const paramsClose = matchPair(masked, paramsOpen, "(", ")", label, lineOf);
    const open = skipFwd(masked, paramsClose + 1);
    if (masked[open] !== "{") {
      bail(
        `${label}:${lineOf(nameStart)} 的生產者 \`${name}\` 沒有區塊主體（\`{ … }\`）——` +
          `本檢查不猜。請改寫該檔，或更新 web/scripts/lib/csharp-message-sites.mjs。`,
      );
    }
    producers.push({ name, open, close: matchPair(masked, open, "{", "}", label, lineOf) });
  }
  return producers;
};

/** 生產者主體裡的三元組站點：`(false, ErrorCodes.X, "字面值")`。 */
const findTupleSites = (raw, masked, strings, producer, label, lineOf, resolveCode) => {
  const sites = [];
  for (let i = producer.open + 1; i < producer.close; i++) {
    if (masked[i] !== "(") continue;
    const tupleAt = i;
    const close = matchPair(masked, i, "(", ")", label, lineOf);
    const parts = splitTopLevel(masked, i + 1, close, ",", label, lineOf);
    i = close;
    if (parts.length !== 3) continue;
    const [okText, codeText] = parts.map(([a, b]) => masked.slice(a, b).trim());
    if (!/^(true|false)$/.test(okText) || !/^(null|ErrorCodes\.\w+)$/.test(codeText)) continue;
    // 沒有碼就沒有訊息契約：`(true, null, null)` 是成功回傳，**不是**站點
    // （也不是「值為空」）。到這裡還看不出來的只剩「有碼卻沒訊息」——那就大聲。
    if (codeText === "null") continue;
    const [messageStart, messageEnd] = parts[2];
    let abs = messageStart;
    while (abs < messageEnd && SPACE.test(raw[abs])) abs++;
    const value = readStringValue(raw, masked, strings, abs, label, lineOf);
    if (value === null) {
      bail(`${label}:${lineOf(tupleAt)} 的生產者三元組第三個元素不是字串字面值——本檢查不猜。`);
    }
    sites.push({
      file: label,
      line: lineOf(tupleAt),
      kind: "producer",
      producer: producer.name,
      code: resolveCode(codeText, tupleAt, "生產者三元組"),
      codeExpr: codeText,
      value: value.kind === "literal" ? value.text : null,
      shape: value.kind === "template" ? value.shape : null,
      params: null,
      root: null,
      guard: null,
    });
  }
  return sites;
};

/**
 * 找 `var (` … `)` … `= Name(` 的解構綁定，以及 `var v = Name(` 的單一綁定。
 * 兩者都會被後續的 `var`／`out var`（`TryGetValue(…, out var x)`）踩到，所以後面的
 * 形狀檢查（`=` 與呼叫式）是必要的，不是防禦性的。
 */
const findBindings = (masked, label, lineOf) => {
  const bindings = [];
  const pattern = /\bvar\s+/g;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    let i = match.index + match[0].length;
    if (masked[i] === "(") {
      const close = matchPair(masked, i, "(", ")", label, lineOf);
      const names = masked
        .slice(i + 1, close)
        .split(",")
        .map((s) => s.trim());
      let j = skipFwd(masked, close + 1);
      if (masked[j] !== "=" || masked[j + 1] === "=") continue;
      j = skipFwd(masked, j + 1);
      let end = j;
      while (end < masked.length && /[A-Za-z0-9_.]/.test(masked[end])) end++;
      bindings.push({ kind: "tuple", names, producer: masked.slice(j, end), at: match.index });
      continue;
    }
    let end = i;
    while (end < masked.length && /[A-Za-z0-9_]/.test(masked[end])) end++;
    const name = masked.slice(i, end);
    let j = skipFwd(masked, end);
    if (masked[j] !== "=" || masked[j + 1] === "=") continue;
    j = skipFwd(masked, j + 1);
    let callEnd = j;
    while (callEnd < masked.length && /[A-Za-z0-9_.]/.test(masked[callEnd])) callEnd++;
    const callee = masked.slice(j, callEnd);
    if (callee === "" || masked[callEnd] !== "(") continue;
    bindings.push({ kind: "single", name, producer: callee, at: match.index });
  }
  return bindings;
};

/**
 * 掃一個 `.cs` 檔。回傳 `{ sites, producers, bindings }`。
 *
 * `codes` 是 `Map<常數名, 錯誤碼字串>`（由 `extractBackendValues` 產生）——**注入**，
 * 所以本層不需要知道 `ErrorCodes.cs` 在哪裡。
 */
export function scanCSharpFile(source, { label, codes }) {
  const { masked, strings } = maskCSharp(source, label);
  const lineOf = makeLineOf(source);
  const lines = masked.split("\n");
  const sites = [];
  const producers = findProducers(masked, label, lineOf);

  const resolveCode = (expr, at, what) => {
    const m = /^ErrorCodes\.(\w+)$/.exec(expr);
    if (m === null || !codes.has(m[1])) {
      bail(`${label}:${lineOf(at)} 的${what} \`${expr}\` 不是 ErrorCodes.cs 的常數——本檢查不猜。`);
    }
    return codes.get(m[1]);
  };

  /** 值運算式的絕對起點（去掉前置空白）。 */
  // 跳過空白要看**原文**：遮罩會把字串與註解换成空白，看遮罩會一路跳過
  // **整個被遮掉的原始字串**（它的開引號也在內），降落在它後面的 `}` 上。
  const absOf = (valueStart, offset) => {
    let abs = valueStart + offset;
    while (abs < masked.length && SPACE.test(source[abs])) abs++;
    return abs;
  };

  /** 站點前面緊鄰的守衛（`if (code == ErrorCodes.X)`），沒有一律回 `null`。 */
  const guardOf = (at) => {
    let li = lineOf(at) - 2;
    while (li >= 0 && lines[li].trim() === "") li--;
    if (li < 0) return null;
    const m = /^\s*if\s*\(\s*code\s*==\s*ErrorCodes\.(\w+)\s*\)\s*$/.exec(lines[li]);
    return m === null ? null : resolveCode(`ErrorCodes.${m[1]}`, at, "守衛");
  };

  let i = 0;
  while (i < masked.length) {
    const at = masked[i] === "n" && braceOfNew(masked, i) !== -1 ? i : -1;
    if (at === -1) {
      i++;
      continue;
    }
    const brace = braceOfNew(masked, at);
    const close = matchPair(masked, brace, "{", "}", label, lineOf);
    const members = parseMembers(source, masked, brace, close, label, lineOf);
    i = close + 1;
    const message = members.find((m) => m.name === "message");
    if (message === undefined) continue;
    const code = members.find((m) => m.name === "code");
    const where = `${label}:${lineOf(at)}`;

    const paramsMember = members.find((m) => m.name === "params");
    let paramsNames = null;
    if (paramsMember !== undefined) {
      const paramsBrace = braceOfNew(masked, paramsMember.valueStart);
      if (paramsBrace === -1) {
        bail(`${where} 的 \`@params\` 不是 \`new { … }\`——本檢查不猜。`);
      }
      paramsNames = parseMembers(
        source,
        masked,
        paramsBrace,
        matchPair(masked, paramsBrace, "{", "}", label, lineOf),
        label,
        lineOf,
      ).map((m) => m.name);
    }
    const base = { file: label, line: lineOf(at), params: paramsNames };

    // ① 語法位置：往前一個非空白字元。`(` ＝HTTP body；`=>` ＝DTO；其餘大聲。
    //    **必須排在「有沒有 `code`」之前**：DTO 那個形狀（`NotificationPayloads.Push`）
    //    本來就沒有 `code` 成員，順序顛倒會讓它紅在錯的理由上。
    const prev = skipBack(masked, at - 1);
    if (masked[prev] === ">" && masked[prev - 1] === "=") {
      sites.push({ ...base, kind: "mapper", root: null, guard: null });
      continue;
    }
    if (masked[prev] !== "(") {
      bail(
        `${where} 的匿名物件帶 \`message\`，但它前面的字元是 \`${masked[prev] ?? ""}\`，既不是` +
          `呼叫引數（\`(\`）也不是運算式主體（\`=>\`）——本檢查不猜。請改寫該檔，或更新 ` +
          `web/scripts/lib/csharp-message-sites.mjs 的語法位置判準。`,
      );
    }
    const callee = calleeBefore(masked, prev);
    if (!RESULT_RECEIVERS.has(callee.split(".")[0]) && callee.split(".").pop() !== "WriteAsJsonAsync") {
      bail(
        `${where} 的匿名物件是 \`${callee}(\` 的引數——那不是認得的 HTTP 錯誤 body 產生器` +
          `（\`Results.*\`／\`TypedResults.*\`／\`…WriteAsJsonAsync\`）。本檢查不猜。`,
      );
    }
    // 到這裡才要求 `code`——HTTP 錯誤 body 沒有它就無從比起，而那不是「猜得出」的東西。
    if (code === undefined) bail(`${where} 的匿名物件有 \`message\` 而沒有 \`code\`——本檢查不猜。`);

    // ② 排除：`code = IdentityErrorCodes.Map(…)`。
    if (/^\w*IdentityErrorCodes\.Map\(/.test(code.value)) {
      sites.push({ ...base, kind: "identity" });
      continue;
    }
    // ③ 排除：`message = ErrorMessages.For(code)`——交給閘門 B。
    if (/^ErrorMessages\.For\(/.test(message.value)) {
      sites.push({ ...base, kind: "delegated" });
      continue;
    }
    // ④ 轉發：`code`／`message` 同一個來源。
    const asMember = (expr, suffix) => {
      const m = /^([A-Za-z_]\w*)\.(\w+)$/.exec(expr);
      return m !== null && m[2] === suffix ? m[1] : null;
    };
    const codeRoot = code.shorthand ? "$shorthand" : asMember(code.value, "Code");
    const messageRoot = message.shorthand ? "$shorthand" : asMember(message.value, "Message");
    if (codeRoot !== null || messageRoot !== null) {
      if (codeRoot === null || messageRoot === null || codeRoot !== messageRoot) {
        bail(
          `${where} 的 \`code = ${code.value}\` 與 \`message = ${message.value}\` 不是同一個` +
            `來源的轉發——本檢查不猜。`,
        );
      }
      const guard = guardOf(at);
      if (paramsNames !== null && guard === null) {
        bail(
          `${where} 的轉發站點帶 \`@params\`，但它的上一行不是 \`if (code == ErrorCodes.X)\` ` +
            `守衛——參數對不到碼，本檢查不猜。請在站點前補上守衛，或更新 ` +
            `web/scripts/lib/csharp-message-sites.mjs。`,
        );
      }
      sites.push({ ...base, kind: "forward", root: codeRoot, guard });
      continue;
    }

    // ⑤ 直接站點：code 必須是常數，或與 message 成對的三元式。
    const codeTernary = splitTernary(code.value);
    const messageTernary = message.shorthand ? null : splitTernary(message.value);
    if (codeTernary !== null || messageTernary !== null) {
      if (codeTernary === null || messageTernary === null) {
        bail(`${where} 的 \`code\`／\`message\` 只有一邊是三元式——本檢查不猜。`);
      }
      if (codeTernary.cond.text !== messageTernary.cond.text) {
        bail(
          `${where} 的兩個三元式條件不同（\`${codeTernary.cond.text}\` 對 ` +
            `\`${messageTernary.cond.text}\`）——本檢查不猜。`,
        );
      }
      for (const arm of ["then", "else"]) {
        const value = readStringValue(
          source,
          masked,
          strings,
          absOf(message.valueStart, messageTernary[arm].at),
          label,
          lineOf,
        );
        if (value === null) {
          bail(`${where} 的三元式分支 \`${messageTernary[arm].text}\` 不是字串字面值——本檢查不猜。`);
        }
        sites.push({
          ...base,
          kind: value.kind,
          code: resolveCode(codeTernary[arm].text, at, "三元式分支"),
          codeExpr: codeTernary[arm].text,
          value: value.kind === "literal" ? value.text : null,
          shape: value.kind === "template" ? value.shape : null,
          root: null,
          guard: null,
        });
      }
      continue;
    }

    const value = readStringValue(source, masked, strings, absOf(message.valueStart, 0), label, lineOf);
    if (value === null) {
      bail(`${where} 的 \`message\` 既不是字串字面值也不是認得的轉發——本檢查不猜。`);
    }
    sites.push({
      ...base,
      kind: value.kind,
      code: resolveCode(code.value, at, "`code`"),
      codeExpr: code.value,
      value: value.kind === "literal" ? value.text : null,
      shape: value.kind === "template" ? value.shape : null,
      root: null,
      guard: null,
    });
  }

  for (const producer of producers) {
    sites.push(...findTupleSites(source, masked, strings, producer, label, lineOf, resolveCode));
  }

  return { sites, producers, bindings: findBindings(masked, label, lineOf) };
}

/**
 * 把每個 `forward` 站點接到它真正的生產者上（跨檔案，所以由驅動程式彙整之後呼叫）。
 *
 * `producerNames` 是**所有檔案**認得的生產者方法名（`Set`）。接不到就拋——接不到意味著
 * 那條鏈的下游沒有被比對過，而「靜默放行」正是這道閘門要消滅的東西。
 */
export function resolveForwards({ files, producerNames }) {
  for (const { result } of files) {
    for (const site of result.sites) {
      if (site.kind !== "forward") continue;
      const { bindings } = result;
      const where = `${site.file}:${site.line}`;
      const candidates =
        site.root === "$shorthand"
          ? bindings.filter((b) => b.kind === "tuple" && b.names.includes("code") && b.names.includes("message"))
          : bindings.filter((b) => b.kind === "single" && b.name === site.root);
      if (candidates.length === 0) {
        bail(`${where} 的轉發來源 \`${site.root}\` 在本檔對到 0 個綁定——本檢查不猜。`);
      }
      // 同名的區域變數可以在**同一個檔的多個方法裡各宣告一次**（實例：
      // `CustomFieldEndpoints.cs` 的四個 `validation`）。這裡**不做 C# 的作用域分析**，
      // 只要求候選指向**同一個生產者**：那樣「哪一個綁定才是它」對本檢查的結果沒有影響
      // （能流到這個站點的值，就是那個生產者的三元組），而候選分屬不同生產者時仍然大聲
      // ——那才是真的猜不出來。
      const producers = new Set(candidates.map((b) => b.producer.split(".").pop()));
      if (producers.size !== 1) {
        bail(
          `${where} 的轉發來源 \`${site.root}\` 在本檔對到 ${candidates.length} 個綁定、` +
            `指向 ${producers.size} 個不同的生產者（${[...producers].sort().join("、")}）——本檢查不猜。`,
        );
      }
      const name = [...producers][0];
      if (!producerNames.has(name)) {
        bail(
          `${where} 的轉發來源 \`${candidates[0].producer}\` 不是認得的生產者（回傳型別 ` +
            `\`(bool, string?, string?)\` 的方法）——那條鏈的下游沒有被比對過。本檢查不猜。`,
        );
      }
      site.producer = name;
    }
  }
  return files;
}
