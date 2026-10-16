// 兩份資料模組的**同構斷言**：鍵路徑、陣列長度、純量型別都必須相同，只有字串值可以不同。
// 為什麼要有這一支：兩份資料形狀一不同，兩條鏈就會拍到不同的畫面——
// 而「畫面不同」不會有任何錯誤訊息，只會是 24 張看起來合理的圖。
// 跑法：node web/verify-seed-data.cjs（不需瀏覽器、不需 DB、不需後端）
//
// ★ 這支刻意**不叫** *.test.cjs：web/vite.config.ts 的 test 區塊沒有覆寫 include，
//   vitest 用預設樣式會把它撿走、算進前端全量。
const assert = require("assert");
const zh = require("./seed-data.zh-TW.cjs");
const en = require("./seed-data.en.cjs");

function shape(v, path, out) {
  if (Array.isArray(v)) {
    out.push(`${path}[] len=${v.length}`);
    v.forEach((e, i) => shape(e, `${path}[${i}]`, out));
  } else if (v !== null && typeof v === "object") {
    out.push(`${path}{}`);
    for (const k of Object.keys(v).sort()) shape(v[k], `${path}.${k}`, out);
  } else {
    out.push(`${path}:${typeof v}`);
  }
  return out;
}

/**
 * 同構的判準：**結構**相同、**字串值**可以不同。
 * 但有一個例外要當場擋下：`users[].role` 是**跨語系共用的識別碼**（SystemRoleCodes），
 * 改了就會指到不存在的角色。
 *
 * ★ `mindMap.branches[].card` **不在**這個例外裡——它是**同一語系內的卡片標題參照**，
 *   英文那份的卡片標題本來就是英文（計畫原本把它跟 role 一起寫成「必須逐字相同」，
 *   但那與下面「每次參照都要指得到」互相矛盾：兩個語系的標題必然不同）。
 *   它的守衛在下面那一組「指得到」的檢查，而且**兩個語系各自驗**。
 */
function structural(v) {
  if (typeof v === "string") return "<string>";
  if (Array.isArray(v)) return v.map(structural);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, structural(v[k])]));
  }
  return v;
}

assert.deepStrictEqual(structural(en), structural(zh), "兩份資料的結構不同");
assert.deepStrictEqual(shape(en, "", []), shape(zh, "", []), "兩份資料的形狀不同");
assert.notStrictEqual(en, zh);

// 識別碼必須逐字相同（不是「結構相同」就夠）
assert.deepStrictEqual(en.users.map(u => u.role), zh.users.map(u => u.role));
// 帳號**刻意不共用**（2026-10-04 改）：兩條鏈各有自己的一組示範帳號，而且必須**互不相交**。
// ★ 舊版這裡斷言的是「兩份的 username 逐字相同」，那正是病灶本身：同一批六個帳號同時屬於
//   兩個團隊 ⇒ 英文那條鏈的「團隊選擇／專案清單／我的任務／通知」上出現中文示範資料
//   （實測 5/24 張含 CJK，見 docs/history/）。共用帳號不是同構，是**耦合**。
// 角色的 `code`（上一行）仍然共用——那是系統常數，不是誰的資料。
const enNames = new Set(en.users.map(u => u.username));
const zhNames = new Set(zh.users.map(u => u.username));
assert.strictEqual(enNames.size, en.users.length, "en 名冊裡有重複的 username");
assert.strictEqual(zhNames.size, zh.users.length, "zh 名冊裡有重複的 username");
const sharedUsers = [...enNames].filter(n => zhNames.has(n));
assert.deepStrictEqual(sharedUsers, [],
  `兩條鏈共用帳號：${sharedUsers.join(", ")}——共用會讓兩邊的示範資料漏到對方的畫面上`);
// 兩邊人數仍要一致：一個使用者對一個使用者，只是帳號不同一個。
assert.strictEqual(en.users.length, zh.users.length, "兩份名冊的人數不同");

// 截圖時用哪個帳號登入（`captureAs`）也要指得對：
// ① 它必須是**這份資料集自己**的示範帳號（或 admin）；
// ② 它**不可以**是對方那條鏈的帳號——那正是漏資料的形狀：登入者屬於對方那個團隊
//    ⇒ 對方團隊的專案與卡片就上了這本手冊（2026-10-04 的病灶就是這個形狀）。
// 打錯一個字元的症狀是「登入失敗」，那很大聲；指到對方帳號卻會**安靜地**拍出混合的畫面。
for (const [tag, mine, theirs] of [["en", en, zh], ["zh-TW", zh, en]]) {
  assert.strictEqual(typeof mine.captureAs, "string", `[${tag}] 沒有 captureAs`);
  assert.ok(mine.captureAs.length > 0, `[${tag}] captureAs 是空字串`);
  assert.ok(
    mine.captureAs === "admin" || mine.users.some(u => u.username === mine.captureAs),
    `[${tag}] captureAs「${mine.captureAs}」不在這份資料集的名冊裡，也不是 admin`,
  );
  assert.ok(
    !theirs.users.some(u => u.username === mine.captureAs),
    `[${tag}] captureAs「${mine.captureAs}」是另一條鏈的帳號——截圖會拍到對方的示範資料`,
  );
}
assert.strictEqual(en.notificationTargets.length, zh.notificationTargets.length);
assert.deepStrictEqual(en.mindMap.branches.map(b => b.children.length), zh.mindMap.branches.map(b => b.children.length));

// 每一條「指向別處的字串」都要指得到：通知目標必須是既有的卡片標題，
// 心智圖分支的 card 也一樣，清單名必須在該專案的 lists 裡。
function assertResolves(data, tag) {
  const titles = new Set([...data.cards, ...data.secondaryCards].map(c => c.title));
  for (const t of data.notificationTargets) assert.ok(titles.has(t), `[${tag}] 通知目標 ${t} 不是任何卡片標題`);
  for (const b of data.mindMap.branches) assert.ok(titles.has(b.card), `[${tag}] 心智圖分支的 card ${b.card} 不是任何卡片標題`);
  for (const c of data.cards) assert.ok(data.projects.main.lists.includes(c.list), `[${tag}] 卡片 ${c.title} 的清單 ${c.list} 不在 main.lists`);
  for (const c of data.secondaryCards) assert.ok(data.projects.secondary.lists.includes(c.list), `[${tag}] 卡片 ${c.title} 的清單 ${c.list} 不在 secondary.lists`);
  for (const l of [...data.cards, ...data.secondaryCards].flatMap(c => c.labels || [])) {
    assert.ok(data.labels.some(([n]) => n === l), `[${tag}] 標籤 ${l} 不存在`);
  }
  for (const c of data.cards) assert.ok(data.customFields.priority.options.includes(c.priority), `[${tag}] 卡片 ${c.title} 的 priority ${c.priority} 不在選項裡`);
  // 指派與審查者、工時登記、留言作者都必須是名冊裡的帳號
  const usernames = new Set([...data.users.map(u => u.username), "admin"]);
  for (const c of data.cards) {
    for (const u of [...(c.assignees || []), ...(c.reviewers || [])]) assert.ok(usernames.has(u), `[${tag}] ${c.title} 指到不存在的使用者 ${u}`);
    for (const [who] of c.comments || []) assert.ok(usernames.has(who), `[${tag}] ${c.title} 的留言作者 ${who} 不在名冊`);
    for (const [who] of c.effort || []) assert.ok(usernames.has(who), `[${tag}] ${c.title} 的工時登記人 ${who} 不在名冊`);
    if (c.review) assert.ok(usernames.has(c.review.by), `[${tag}] ${c.title} 的審查者 ${c.review.by} 不在名冊`);
  }
  for (const c of data.secondaryCards) {
    for (const u of [...(c.assignees || []), ...(c.reviewers || [])]) assert.ok(usernames.has(u), `[${tag}] ${c.title} 指到不存在的使用者 ${u}`);
  }
  // 角色名冊要覆蓋 users[].role 的每一個 code
  for (const u of data.users) assert.ok(u.role in data.roleNames, `[${tag}] ${u.username} 的 role ${u.role} 不在 roleNames`);
  assert.strictEqual(Object.keys(data.roleNames).length, 6, `[${tag}] roleNames 應該 6 個`);
}

assertResolves(en, "en");
assertResolves(zh, "zh-TW"); // 回歸：搬家沒搬壞

// 兩種語系真的不同（不然「同構」會退化成「同一份」）
assert.notDeepStrictEqual(en.cards.map(c => c.title), zh.cards.map(c => c.title));
assert.strictEqual(en.locale, "en");
assert.strictEqual(zh.locale, "zh-TW");

console.log(`OK：結構相同；en 卡片 ${en.cards.length + en.secondaryCards.length} 張、指涉全部指得到`);
