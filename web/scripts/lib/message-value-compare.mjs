// 設計 §4.2 的閘門 C 的規則層：R1–R4 與三個粗粒度碼守衛。
//
// **純函式**：吃抽取層（`csharp-message-sites.mjs`）的站點與語系檔的值，吐錯誤字串。
// 不碰磁碟、不讀環境——沙箱測試因此可以在記憶體裡餵資料。
//
// ## 為什麼是「樣板當比對樣式」而不是「先剝樣板再比」
//
// 閘門 B 能剝（它的表一條佔位都沒有），這道不行：zh-TW `error.json` 有幾條值帶 `{{…}}`，
// 而那些 C# 站的**兩側形狀本來就不同**——語系值是樣板、C# 是**填好的成品**（或是
// `$"…{max}…"` 的內插字串）。剝完再比會讓那幾條**假紅**，而下一步就是「只白名單那幾條」
// ——偏偏那幾條正是漂移的代價最大的地方（使用者看得到的數字）。所以：
//
//   - **樣本就是比對樣式**：`{{x}}` ⇒ `(.*?)`，其餘逐字轉義、`^…$` 錨定。
//     沒有佔位時退化為**逐位元相等**（今天絕大多數的站點都走這條）。
//   - 內插字串（`$"…"`）⇒ 兩邊都化約成帶哨兵（U+0000）的形狀再比。
//
// ## 這道閘門**只抓措辭**，數字漂移不歸它
//
// `{{max}}` 那幾條能過，是因為 `(.*?)` 什麼都吃——**C# 送 1000、語系檔寫 2000 也照過**。
// 數字的一致性由**同源機制**擁有：`@params` 的值與 C# 的內插變數是同一個變數（W8），
// 不是兩份副本。R3／R3b 守的是**佔位名**對得上（名字錯了前端會印出未代換的 `{{…}}`），
// 不是值對得上。把數字也拉進來要另立一套契約，那不是本閘門的範圍。
//
// ## 三個粗粒度碼守衛（讓「宣告」不是橡皮圖章）
//
// 唯一被宣告的資料是**粗粒度碼的集合**（`request.invalid` 那一類：一句泛用訊息蓋住
// 幾十種具體情況，兩邊本來就不會逐字相等）。**沒有值白名單**——一開白名單這道閘門就沒了。
// 但光有宣告等於「這個碼不用比」，所以配三個機器守衛：
//
//   (a) 宣告了、卻只有 <=1 種字面值 ⇒ 紅（宣告過期了：只有一種就該正常比對）
//   (b) 沒宣告、卻有 >=2 種字面值   ⇒ 紅（逼你「統一措辭」或「宣告」，兩者都留下可審的 diff）
//   (c) 宣告了、而語系值與**每一個**字面值都不同 ⇒ 才放行；
//       只要有一個相同就紅——那代表兩邊其實已經統一，這個宣告是在放行一個不存在的例外。
//
// **(a) 與 (c) 是刻意的一對**：少了它們，宣告就只是「這個碼不用比」的橡皮圖章。
//
// 宣告了粗粒度的碼**跳過 R1／R2／R3**——那正是宣告的意思：C# 那一側是**具體的那一種**
// （「title 須為字串」），語系檔那一側是**泛用的那一句**（「請求內容不正確」），
// 兩邊本來就不是同一句話，逐字比會全紅、佔位名集合也不會相等。**R3b 不跳**：
// 它問的不是「兩邊像不像」，而是「語系值要的佔位名，這個站點餵不餵得出來」——
// 泛用訊息哪天真的帶了 `{{x}}`，餵不出來的站點仍然會讓畫面印出 `{{x}}`。

/** `{{name}}`。佔位名限 `\w`（與 i18next 的用法一致）。 */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 語系值 ⇒ `{ re, holes }`。`{{x}}` ⇒ `([\s\S]*?)`，沒有佔位時是逐位元相等的樣式。 */
const toPattern = (value) => {
  const holes = [];
  let body = "";
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER.exec(value)) !== null) {
    body += escapeRe(value.slice(last, match.index)) + "([\\s\\S]*?)";
    holes.push(match[1]);
    last = match.index + match[0].length;
  }
  body += escapeRe(value.slice(last));
  return { re: new RegExp(`^${body}$`), holes };
};

/** 語系值裡的佔位名集合（順序無關——詞序本來就可能不同）。 */
const placeholderNames = (value) => {
  const names = new Set();
  PLACEHOLDER.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER.exec(value)) !== null) names.add(match[1]);
  return names;
};

/** 語系值 ⇒ 形狀（佔位名換成哨兵），用來與 C# 內插字串的形狀直接比。 */
const toShape = (value) => value.replace(PLACEHOLDER, "\u0000");

/** 顯示用：站點的「值」——字面值是原文，內插字串是形狀。 */
const showValue = (site) => (site.kind === "template" ? site.shape : site.value);

/** 顯示用：`Set`／陣列 ⇒ 排序後的字串。 */
const showSet = (items) => [...items].sort().join("、");

const label = (site) => {
  if (site.kind === "producer") return `生產者 \`${site.producer}\` 的三元組`;
  if (site.kind === "forward") return "轉發站點";
  return site.kind === "template" ? "內插字串" : "字面值";
};

const siteWhere = (site) => `${site.file}:${site.line}`;

/**
 * 比對站點與語系值。
 *
 * @param {object} input
 * @param {Array} input.sites 抽取層的站點（`resolveForwards` 之後）。
 * @param {Map<string,string>} input.localeValues 碼 ⇒ zh-TW 的值。
 * @param {Iterable<string>} input.coarseCodes 被宣告為粗粒度的碼。
 * @returns {{ errors: string[], stats: object }}
 */
export function compareSites({ sites, localeValues, coarseCodes }) {
  const errors = [];
  const declared = new Set(coarseCodes);

  /** 可比值的三種站點；`forward` 的值在生產者那一側、其餘三種不比。 */
  const VALUED = new Set(["literal", "template", "producer"]);
  const EXCLUDED = new Set(["mapper", "delegated", "identity"]);

  /** 碼 ⇒ 相異值集合（守衛 a／b／c 的輸入；只有真正比過的站點進來）。 */
  const byCode = new Map();
  /** 同一個碼缺語系值時只報一次。 */
  const missingReported = new Set();

  for (const site of sites) {
    if (EXCLUDED.has(site.kind)) continue;
    const where = siteWhere(site);
    const code = site.code ?? site.guard ?? null;
    const isCoarse = code !== null && declared.has(code);

    // ---- R1／R2：值比對（轉發站點的值在生產者那一側，這裡不比） ----
    if (VALUED.has(site.kind)) {
      if (code === null) {
        errors.push(`${where} 的${label(site)}沒有可歸屬的碼——沒有碼就找不到語系值可比（R1／R2）。`);
        continue;
      }
      const localeValue = localeValues.get(code);
      if (localeValue === undefined) {
        if (!missingReported.has(code)) {
          missingReported.add(code);
          errors.push(
            `${where} 的碼 \`${code}\` 在 zh-TW \`error.json\` 裡沒有對應的值` +
              `（同一個碼的其餘站點一併受影響）。`,
          );
        }
        continue;
      }

      // 值一律進 `byCode`（守衛 a／b／c 的輸入），但宣告過的粗粒度碼不比 R1／R2。
      const bucket = byCode.get(code) ?? { values: new Set(), localeValue };
      bucket.values.add(showValue(site));
      byCode.set(code, bucket);

      // 粗粒度碼到這裡為止——但**不能 `continue`**：R3b 在下面，它不跳（見檔頭）。
      if (!isCoarse) {
        if (site.kind === "template") {
          // R2：兩邊都化約成帶哨兵的形狀。
          const localeShape = toShape(localeValue);
          if (localeShape !== site.shape) {
            errors.push(
              `${where} 的${label(site)}與 \`${code}\` 的語系值形狀不一致：\n` +
                `      C#（內插字串的形狀；下面是哨兵，代表插值洞）：${JSON.stringify(site.shape)}\n` +
                `      語系檔（佔位名換成哨兵）                      ：${JSON.stringify(localeShape)}\n` +
                `      兩邊是同一句話的兩份副本（設計 §4.2）：改哪一邊就同步另一邊。`,
            );
          }
        } else {
          // R1：語系值的 `{{x}}` 是 `(.*?)`，其餘逐字。
          const { re } = toPattern(localeValue);
          if (!re.test(site.value)) {
            errors.push(
              `${where} 的${label(site)}與 \`${code}\` 的語系值不一致：\n` +
                `      C#    ：${site.value}\n` +
                `      語系檔：${localeValue}\n` +
                `      兩邊是同一句話的兩份副本（設計 §4.2）：改哪一邊就同步另一邊。`,
            );
          }
        }
      }
    }

    // ---- R3：`@params` 的成員名集合 ＝ 語系值的佔位名集合（粗粒度碼不比：兩邊不同句） ----
    if (site.params !== null && !isCoarse) {
      if (code === null) {
        errors.push(
          `${where} 的${label(site)}帶 \`@params\` 卻沒有可歸屬的碼——參數對不到碼就無從比對（R3）。`,
        );
        continue;
      }
      const localeValue = localeValues.get(code);
      if (localeValue === undefined) continue; // 上面的缺值已報過
      const localeNames = placeholderNames(localeValue);
      const paramNames = new Set(site.params);
      if (showSet(localeNames) !== showSet(paramNames)) {
        errors.push(
          `${where} 的 \`@params\` 成員（${showSet(paramNames) || "（無）"}）與 \`${code}\` 的` +
            `佔位名（${showSet(localeNames) || "（無）"}）不一致——前端靠佔位名代換，對不上就會` +
            `**原樣印出 \`{{…}}\`**（R3）。`,
        );
      }
    }

    // ---- R3b：語系值帶佔位 ⇒ 站點必須宣告 `@params`（生產者三元組除外——它的值不是 body） ----
    if (site.kind === "literal" || site.kind === "template" || site.kind === "forward") {
      if (code === null) continue; // 無從歸屬
      const localeValue = localeValues.get(code);
      if (localeValue === undefined) continue;
      const localeNames = placeholderNames(localeValue);
      if (localeNames.size > 0 && site.params === null) {
        errors.push(
          `${where} 的語系值 \`${code}\` 帶佔位名（${showSet(localeNames)}），但這個站點沒有` +
            ` \`@params\`——前端只拿得到碼，代換不出來，畫面會印出未代換的 \`{{…}}\`（R3b）。`,
        );
      }
    }
  }

  // ---- 守衛 (a)／(b)／(c)：粗粒度碼的宣告 ----
  for (const [code, { values, localeValue }] of byCode) {
    const isDeclared = declared.has(code);
    if (!isDeclared && values.size >= 2) {
      errors.push(
        `\`${code}\` 有 ${values.size} 種不同的字面值，但它沒有被列進粗粒度碼宣告：\n` +
          [...values]
            .sort()
            .map((v) => `      ${v}`)
            .join("\n") +
          `\n      兩條路都留下可審的 diff：把 C# 的字面值統一成語系檔那一句，` +
          `或把它列進 \`check-message-values.mjs\` 的 \`COARSE_CODES\`（宣告要附理由）。`,
      );
    }
    if (isDeclared && values.size <= 1) {
      errors.push(
        `\`${code}\` 被宣告成粗粒度碼，但它只有 ${values.size} 種字面值——宣告已經過期：\n` +
          `      粗粒度碼的定義是「一句泛用訊息蓋住多種具體情況」，只有一種就該正常比對。\n` +
          `      把 \`${code}\` 從 \`COARSE_CODES\` 拿掉（順手就會發現它其實比得過）。`,
      );
    }
    if (isDeclared && values.has(localeValue)) {
      errors.push(
        `\`${code}\` 被宣告成粗粒度碼，但它的語系值與站點的字面值逐字相同：\n` +
          `      ${localeValue}\n` +
          `      兩邊其實已經統一了——那個宣告是在放行一個不存在的例外。把宣告拿掉。`,
      );
    }
  }

  for (const code of declared) {
    if (!byCode.has(code)) {
      errors.push(`\`${code}\` 被宣告成粗粒度碼，但全庫沒有任何站點用它——宣告已經過期（守衛 a）。`);
    }
  }

  return {
    errors,
    stats: {
      sites: sites.length,
      compared: [...byCode.values()].reduce((n, b) => n + b.values.size, 0),
      codes: byCode.size,
      coarse: declared.size,
    },
  };
}
