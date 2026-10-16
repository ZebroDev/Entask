// 斷言「四類後端寫死的中文都清掉了」。需要後端在跑（ENTASK_API）＋ dev 庫。
// 跑法：ENTASK_API=http://localhost:8080 ENTASK_DEMO_LOCALE=en node web/verify-demo-data.cjs
//
// ★ 正反兩半都要：只驗「沒有中文」的話，「根本沒建立」會以全綠通過。
//   所以正向一律用**與資料集嚴格相等**（徽章集合、欄位集合、選項集合），
//   中文掃描只是額外的一半、而且**只對 en 那條鏈有意義**（zh-TW 那條本來就全中文）。
//
// ★ 這支刻意**不叫** *.test.cjs：vitest 的預設樣式會把它撿進前端全量。
const assert = require("assert");

const BASE = process.env.ENTASK_API || "http://localhost:5088";
const LOCALE = process.env.ENTASK_DEMO_LOCALE || "zh-TW";
const DATA = require(`./seed-data.${LOCALE}.cjs`);
const ZH = /[一-鿿]/;
const ROLE_NAMES = Object.values(DATA.roleNames);

let token;
async function call(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const login = await call("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: process.env.ENTASK_DEMO_PASSWORD || "Entask@Dev2026" },
  });
  token = login.accessToken;

  const teams = await call("/api/teams");
  const teamId = teams.find(t => t.name === DATA.team.name)?.id;
  assert.ok(teamId, `找不到團隊「${DATA.team.name}」——${LOCALE} 這條鏈還沒 seed`);

  // ① 角色名
  const roles = await call(`/api/teams/${teamId}/roles`, { headers: { "X-Team-Id": teamId } });
  for (const name of ROLE_NAMES) {
    assert.ok(roles.some(r => r.name === name), `團隊裡沒有名為「${name}」的角色`);
  }
  const detail = await call(`/api/teams/${teamId}`, { headers: { "X-Team-Id": teamId } });
  const badgeNames = [];
  for (const m of detail.members) {
    assert.ok(m.roles.length > 0, `成員 ${m.username} 沒有角色徽章`);
    for (const r of m.roles) {
      badgeNames.push(r.name);
      // 正向且與語系無關：徽章上的名字**必須是資料集那六個之一**。
      // 這一條就足以抓到「英文那條鏈把中文系統角色掛上去了」——不必靠中文掃描。
      assert.ok(ROLE_NAMES.includes(r.name),
        `成員 ${m.username} 的角色徽章「${r.name}」不是資料集的六個角色名之一`);
    }
  }
  // 徽章集合**恰等於**資料集推得的那一組——比逐條 includes 強，而且與語系無關。
  // ★ 不要寫成「六個角色名每一個都要有成員掛著」：六位示範使用者只用到**五個** code
  //   （`project_assistant` 沒有人掛），那條斷言在兩種語系都會紅（實測過）。
  const expectedBadges = [...new Set(DATA.users.map(u => DATA.roleNames[u.role]))].sort();
  assert.deepStrictEqual([...new Set(badgeNames)].sort(), expectedBadges,
    "成員徽章的集合與資料集推得的不同（少建角色？掛錯角色？）");

  // ② 自訂欄位
  const projects = await call("/api/projects", { headers: { "X-Team-Id": teamId } });
  const proj = projects.find(p => p.name === DATA.projects.main.name);
  assert.ok(proj, `找不到專案「${DATA.projects.main.name}」`);
  const fields = await call(`/api/projects/${proj.id}/custom-fields`, { headers: { "X-Team-Id": teamId } });
  assert.strictEqual(fields.length, 2, `自訂欄位應該恰好 2 個，實際 ${fields.length}`);
  const pf = fields.find(f => f.name === DATA.customFields.priority.name);
  assert.ok(pf, `找不到自訂欄位「${DATA.customFields.priority.name}」`);
  assert.deepStrictEqual([...pf.options].sort(), [...DATA.customFields.priority.options].sort());
  const wantNames = [DATA.customFields.priority.name, DATA.customFields.requester.name].sort();
  assert.deepStrictEqual(fields.map(f => f.name).sort(), wantNames,
    "自訂欄位的名字不是資料集那兩個（後端原本種下的名字沒被改掉？）");

  // ③ admin 顯示名（**不吞例外**：吞掉的話這個端點哪天 404 了，這一條會靜默地不執行）
  const me = await call("/api/auth/me");
  assert.strictEqual(me.displayName, DATA.adminDisplayName, "admin 的顯示名不是資料集給的");

  // ③b 示範成員的顯示名也要等於資料集給的那六個。
  //   ★ 顯示名是**每使用者一個的全域值**。兩條鏈的六個示範帳號已於 2026-10-04 拆開
  //   （各自一組、互不相交，見 verify-seed-data.cjs）⇒ 這六位不再有互相覆蓋的問題。
  //   **仍然共用的是 `admin` 那一個帳號**（兩份資料集的 adminDisplayName 不同）——那才是
  //   目前唯一的跨鏈改名，也是「重跑一次中文 seed 就回復」的對象。
  //   這一條守的是原本那個缺陷：資料集有英文名，但沒有任何一步把它送出去。
  const byUsername = new Map(DATA.users.map(u => [u.username, u]));
  let renamed = 0;
  for (const m of detail.members) {
    const want = byUsername.get(m.username);
    if (!want) continue;   // 不在資料集裡的人（例如 admin）不強制
    assert.strictEqual(m.displayName, want.displayName,
      `成員 ${m.username} 的顯示名是「${m.displayName}」，資料集是「${want.displayName}」`);
    renamed++;
  }
  assert.strictEqual(renamed, DATA.users.length,
    `團隊裡只對上了 ${renamed} 位示範成員，資料集有 ${DATA.users.length} 位`);
  // 名冊必須**恰等於**資料集那六位——不是「至少包含那六位」。
  // ★ 這一條守的是「兩條鏈共用帳號」的殘骸：舊帳號還掛在同一個團隊裡時名冊會有 12 位，
  //   而上面那種「每一位都有徽章、徽章是那六個」的寫法**照樣全綠**（多的那幾位也合格）。
  assert.strictEqual(detail.members.length, DATA.users.length,
    `團隊成員應該恰好 ${DATA.users.length} 位，實際 ${detail.members.length} 位：` +
    detail.members.map(m => m.username).join(", "));

  // ④ 額外的一半：中文掃描。**只對 en 有意義**——zh-TW 那條鏈的預期值本身就是中文。
  //   ★ 不掃 `projects` 的清單：`GET /api/projects` 是「admin 看得到全部」
  //   （ProjectEndpoints.cs:21-24），**完全不理 X-Team-Id** ⇒ 清單裡混著中文那條鏈的專案。
  //   這個專案自己的名字已經由上面那條「找得到 `DATA.projects.main.name`」嚴格比對過了。
  let cjk = `（${LOCALE}：中文掃描不適用——這條鏈的預期值本來就是中文）`;
  if (LOCALE === "en") {
    for (const n of badgeNames) assert.ok(!ZH.test(n), `角色徽章含中文：${n}`);
    for (const f of fields) {
      assert.ok(!ZH.test(f.name), `自訂欄位名含中文：${f.name}`);
      for (const o of f.options || []) assert.ok(!ZH.test(o), `自訂欄位選項含中文：${o}`);
    }
    cjk = "（en：中文掃描已執行：徽章／欄位／選項）";
  }

  // ⑤ **截圖的那個登入者必須有東西可拍**（2026-10-04 的 C-1）。
  //   06 我的工作台／19 我的日誌／24 通知中心 三張是「以登入者為主角」的頁面：
  //   資料集把 `captureAs` 寫進去、卻沒有把任何指派／工時／通知給那個帳號的話，
  //   這三張會是**空狀態**——而空狀態**沒有任何錯誤訊息**，24 張看起來全都「成功」。
  //   實際發生過：改用 `hannah.hsu` 之後那三張全是 0（實測 DOM 快照：`All caught up`／
  //   `Total hours 0.0`／`No notifications yet`）。這一條把「資料集有沒有餵到那個帳號」
  //   變成當場會紅的斷言。
  //   ★ 以**那個帳號本人**登入才量得到——這三支端點都是「我是誰」的查詢。
  const viewer = DATA.captureAs;
  const viewerLogin = await call("/api/auth/login", {
    method: "POST",
    body: { username: viewer, password: process.env.ENTASK_DEMO_PASSWORD || "Entask@Dev2026" },
  });
  const asViewer = (path) =>
    call(path, { headers: { Authorization: "Bearer " + viewerLogin.accessToken } });

  const work = await asViewer("/api/me/work");
  assert.ok(work.stats.totalAssigned > 0,
    `[${viewer}] /api/me/work 沒有任何指派（06 我的工作台會是空狀態）`);
  assert.ok(work.stats.pendingReviews > 0,
    `[${viewer}] /api/me/work 沒有任何待審查（06 的「待審查」會是 0）`);

  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const wl = await asViewer(`/api/me/worklog?from=${from}&to=${to}`);
  assert.ok(wl.summary.totalHours > 0,
    `[${viewer}] /api/me/worklog 的總時數是 0（19 我的日誌會是空狀態）`);

  const notes = await asViewer("/api/notifications");
  assert.ok(notes.length > 0,
    `[${viewer}] /api/notifications 是空的（24 通知中心會是「No notifications yet」）`);

  // ⑥ **這條鏈的專案與卡片不准出現另一條鏈的帳號**（2026-10-04 實查到的殘骸）。
  //   兩條鏈的六個示範帳號在 R8-e（2026-10-04）拆開之前是**共用**的，而英文那兩個專案
  //   是在那之前建的 ⇒ 專案成員、卡片審查者、留言作者裡留著**中文那條鏈的六個帳號**
  //   （實測：專案成員 12 筆、卡片審查者 10 筆）。
  //   ★ 它**不會**被上面的中文掃描抓到：顯示名是每使用者一個的全域值，那六個帳號
  //     在英文 seed 跑完之後顯示名叫 `Ian Lin`——看起來完全正確。只有當中文 seed
  //     之後又跑過（＝顯示名被改回中文）才會在畫面上露出來。**缺陷一直都在**。
  //   ⇒ 判準是「帳號屬於哪一份資料集」，不是「看起來是不是中文」。
  const OTHER = LOCALE === "en" ? "zh-TW" : "en";
  const otherUsers = new Set(require(`./seed-data.${OTHER}.cjs`).users.map(u => u.username));
  const myProjects = [DATA.projects.main, DATA.projects.secondary];
  const foreignHits = [];
  for (const def of myProjects) {
    const all = await call("/api/projects", { headers: { "X-Team-Id": teamId } });
    const proj = all.find(p => p.name === def.name);
    assert.ok(proj, `找不到專案「${def.name}」——${LOCALE} 這條鏈還沒 seed`);
    // 專案成員：**admin 是允許的**（它不屬於任何一條鏈，是共用帳號）
    for (const m of await call(`/api/projects/${proj.id}/members`, { headers: { "X-Team-Id": teamId } })) {
      if (m.username !== "admin" && otherUsers.has(m.username)) foreignHits.push(`${def.name} 成員 ${m.username}`);
    }
    // 卡片上的審查者與成員
    for (const b of await call(`/api/projects/${proj.id}/boards`, { headers: { "X-Team-Id": teamId } })) {
      const detail = await call(`/api/boards/${b.id}`);
      for (const l of detail.lists || []) for (const c of l.cards || []) {
        const full = await call(`/api/cards/${c.id}`);
        for (const r of full.reviews || []) {
          if (r.reviewerUsername && otherUsers.has(r.reviewerUsername)) foreignHits.push(`${c.title} 審查者 ${r.reviewerUsername}`);
        }
        for (const m of full.members || []) {
          if (m.username && m.username !== "admin" && otherUsers.has(m.username)) foreignHits.push(`${c.title} 成員 ${m.username}`);
        }
      }
    }
  }
  assert.deepStrictEqual(foreignHits, [],
    `[${LOCALE}] 這條鏈的資料裡有「${OTHER}」那條鏈的帳號（${foreignHits.length} 筆）：` +
    `${foreignHits.slice(0, 6).join("、")}${foreignHits.length > 6 ? "…" : ""}`);

  console.log(`OK[${LOCALE}]：角色徽章 ${detail.members.length} 位、自訂欄位 ${fields.length} 個、` +
    `顯示名「${me.displayName}」${cjk}`);
  console.log(`  〔截圖登入者 ${viewer}〕指派 ${work.stats.totalAssigned}、待審查 ` +
    `${work.stats.pendingReviews}、工時 ${wl.summary.totalHours} 小時、通知 ${notes.length} 筆`);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
