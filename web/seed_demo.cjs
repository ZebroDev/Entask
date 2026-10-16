#!/usr/bin/env node
/**
 * 示範資料產生器——手冊截圖的資料來源（純 HTTP，不碰 DB）。
 *
 * 用途：手冊與簡報內嵌的截圖由 `web/capture_all.cjs` 走訪畫面產生（截圖素材與手冊
 * 產生器未包含於本 repo）。畫面要有東西才拍得成，這支就是那個「東西」。
 *
 * 用法（dev server 要先起來）：
 *   node web/seed_demo.cjs
 *
 * 三個刻意的性質：
 *   1. **相對日期**：所有到期日／起始日／**工時登記日**都由「執行當下」推算（工時的
 *      `daysAgo` 在資料集裡，見 `seed-data.<locale>.cjs` 的 `effort` 第四個元素），所以
 *      隔幾個月重跑，月曆與工作日誌仍落在當月，不必手改資料。
 *   2. **重跑安全**：同名物件已存在就不再建立；子資源（留言／審查／工時）每次都會
 *      比對現況、只補不足的——所以跑到一半失敗時，**直接重跑就會補齊**，而且不會
 *      灌出重複留言。附帶的效果是可以拿它來「補一個後來的欄位」：改完資料定義再跑一次
 *      即可，不必清庫。
 *   3. **不刪任何東西**：沒有 reset／clean 模式。要重來請自己清庫。
 *
 * 這一支會建立示範用的使用者帳號，密碼一律 ENTASK_DEMO_PASSWORD（預設同 seed admin）。
 * 只在 dev 庫執行。
 */
const BASE = process.env.ENTASK_API || 'http://localhost:5088';
const PASSWORD = process.env.ENTASK_DEMO_PASSWORD || 'Entask@Dev2026';

// --- 示範資料集 --------------------------------------------------------------
// 一個入口：ENTASK_DEMO_LOCALE。其餘（專案名／團隊名／admin 顯示名／角色名）都由
// 資料模組推導——它們若各自有預設值，與 locale 不一致時會**靜默找錯專案**。
const LOCALES = ['zh-TW', 'en'];
const LOCALE = process.env.ENTASK_DEMO_LOCALE || 'zh-TW';
if (!LOCALES.includes(LOCALE)) {
  console.error(`不支援的 ENTASK_DEMO_LOCALE=${JSON.stringify(LOCALE)}；允許值：${LOCALES.join(' / ')}`);
  process.exit(1);
}
const DATA = require(`./seed-data.${LOCALE}.cjs`);
// 工時去重鍵的**單一來源**（2026-10-11，`docs/state/42`）：這個鍵原本在下面兩處各寫一份
// （伺服器端集合／成員資格檢查），而閘門 `web/scripts/seed-data.test.mjs` 還有第三份。
const { effortKey } = require('./scripts/lib/effort-key.cjs');

// 後端建立專案時種下的自訂欄位名（ProjectEndpoints.cs:69,70 的字面值）。
// **不是資料**——是後端的常數。查詢時與資料集的顯示名一起試（spec §5.1.1），
// 因為第一次建立時欄位叫這個名字、改過名之後叫資料集給的那個。
const BACKEND_FIELD_NAMES = { priority: '優先級', requester: '提出需求者' };

// ---------------------------------------------------------------- HTTP

const sessions = new Map();

async function raw(path, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed, text };
}

/** 以 username 登入並快取 token（admin 與示範使用者共用這一條路徑）。 */
async function session(username) {
  if (sessions.has(username)) return sessions.get(username);
  const r = await raw('/api/auth/login', {
    method: 'POST',
    body: { username, password: PASSWORD },
  });
  if (!r.ok) {
    throw new Error(
      `登入失敗 ${username}（${r.status}）。admin 的密碼若已改過，請設 ENTASK_DEMO_PASSWORD。\n${r.text.slice(0, 200)}`
    );
  }
  const s = { token: r.body.accessToken, userId: r.body.userId };
  sessions.set(username, s);
  return s;
}

async function api(path, { method = 'GET', body, as = 'admin', headers } = {}) {
  const s = await session(as);
  const r = await raw(path, { method, body, token: s.token, headers });
  if (!r.ok) {
    throw new Error(
      `${method} ${path} → ${r.status}\n${typeof r.text === 'string' ? r.text.slice(0, 300) : JSON.stringify(r.text).slice(0, 300)}`
    );
  }
  return r.body;
}

// ---------------------------------------------------------------- 日期

/** 相對今天偏移 n 天、指定當地時刻的 ISO 字串（後端收 UTC，前端還原成當地）。 */
function at(offsetDays, hour = 18) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/**
 * 本地日字串（yyyy-MM-dd）——**不得**走 `toISOString()`：UTC 以西會少一天
 * （與 `web/src/lib/local-day.ts` 的 `localDayString` 同一條理由）。
 * 工時的 `localDate` 吃這個格式。
 */
const localDayString = (daysAgo = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

/**
 * 發起人時區（2026-10-08 批次）：工時那一站是**必填**（缺漏／空白 ⇒ 400
 * `request.timeZoneInvalid`），成員／專案三站是選填（缺漏 ⇒ 後端當 UTC）。四個站點都帶，
 * 因為這條鏈要的正是「資料落在**跑 seed 的這台機器**的當地日」。
 *
 * 值直接取 Node 的 IANA ID，**不做映射、不做 fallback**：認不得的 ID 由後端以 400 擋下
 * （`TimeZones.TryResolve` 刻意不猜）——那比安靜地算錯日界線好。
 */
const timeZoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------------------------------------------------------------- 建立流程

const created = { users: [], team: false, projects: [], projectMembers: [], boards: [], cards: [], nodes: [] };
// 「改名」與「新建」是**兩件不同的事**，分開記：新建是可加性的，改名是**覆寫另一條鏈的值**。
const renamed = { users: [] };
const removed = { members: [] };

async function ensureUsers() {
  // `/api/admin/users`（不是 `/api/auth/users`）：後者是**可指派池**，2026-10-07 起
  // 排除已停用與已刪除者。這支腳本要的是「每一個使用者，含已停用的」——用池子會讓
  // 一個已停用的帳號被判為不存在，於是它會嘗試用同一個 username 再建一次。
  const existing = await api('/api/admin/users');
  const byName = new Map(existing.map(u => [u.username, u]));
  for (const u of DATA.users) {
    if (byName.has(u.username)) continue;
    await api('/api/auth/users', {
      method: 'POST',
      body: { username: u.username, password: PASSWORD, displayName: u.displayName },
    });
    created.users.push(u.username);
  }

  // 顯示名是**每使用者一個的全域值**。六個示範帳號已於 2026-10-04 拆成兩組
  // （各自一組、互不相交），所以它們不再互相覆蓋；**仍然共用的是 `admin` 那一個帳號**
  // （兩份資料集的 `adminDisplayName` 不同）⇒ 先跑的那條鏈決定了它的名字，
  // 另一條不自己改回來就永遠停在對方的值。這正是「重跑一次中文 seed 就回復」的對象。
  // 沒有「改別人顯示名」的端點（實查：AuthEndpoints 只有 POST /users，
  // UserEndpoints 只有 /profile、/password、/avatar，都是自己改自己）
  // ⇒ 用該使用者自己的密碼登入，走 `PUT /api/me/profile`。密碼本來就是這支腳本建的。
  // ★ 走 `api()` 而**不是** `raw()`：`raw()` 不看 `r.ok`，400／403 會被吞掉而
  //   下面那行照樣 push ⇒ 報告會說「顯示名改寫 N」而實際上一個都沒改。
  for (const u of DATA.users) {
    const cur = byName.get(u.username);
    if (cur && cur.displayName === u.displayName) continue;
    await api('/api/me/profile', { method: 'PUT', body: { displayName: u.displayName }, as: u.username });
    renamed.users.push(u.username);
  }

  const all = await api('/api/admin/users');
  // `userId` 而非 `id`：`AdminUserResponse` 的第一個欄位叫 `UserId`，
  // `UserSummaryResponse` 的才叫 `Id`（兩支端點的回應形狀不同）。
  return new Map(all.map(u => [u.username, u.userId]));
}

async function ensureTeam() {
  const teams = await api('/api/teams');
  const found = teams.find(t => t.name === DATA.team.name);
  if (found) return found.id;
  const t = await api('/api/teams', { method: 'POST', body: DATA.team });
  created.team = true;
  return t.id;
}

/**
 * 角色：回傳 code → roleId。
 *
 * zh-TW：直接用 `RoleSeed` 種下的六個**全域系統角色**（TeamId = null，兩條鏈共用）。
 * en　　：系統角色的名字改不動（TeamRoleEndpoints.cs:55 的查詢要求 r.TeamId == teamId，
 *         而系統角色的 TeamId 是 null ⇒ 永遠比不中 ⇒ 404），所以**自建六個團隊自訂角色**
 *         ——POST 的重名檢查是逐團隊的（:28），英文名與中文名並存不衝突。
 *
 * ★ 權限碼**從對應的系統角色複製**，不要自己重寫：重寫會讓英文團隊的權限與中文那組不同，
 *   於是畫面上按鈕的顯隱不同，截圖內容跟著不同——而那是靜默的。
 */
async function ensureMembers(teamId) {
  const roles = await api(`/api/teams/${teamId}/roles`);
  const systemByCode = new Map(roles.filter(r => r.code).map(r => [r.code, r]));
  const roleIdByCode = new Map();
  for (const [code, displayName] of Object.entries(DATA.roleNames)) {
    const system = systemByCode.get(code);
    if (!system) throw new Error(`找不到系統角色 ${code}（團隊 ${teamId}）`);
    if (system.name === displayName) {
      roleIdByCode.set(code, system.id);
      continue;
    }
    const existing = roles.find(r => r.code === null && r.name === displayName);
    if (existing) {
      roleIdByCode.set(code, existing.id);
      continue;
    }
    const created = await api(`/api/teams/${teamId}/roles`, {
      method: 'POST',
      body: { name: displayName, description: null, permissionCodes: system.permissionCodes },
    });
    roleIdByCode.set(code, created.id);
  }
  for (const u of DATA.users) {
    // PUT 是整批覆寫，重跑安全。
    await api(`/api/teams/${teamId}/members`, {
      method: 'PUT',
      body: { username: u.username, roleIds: [roleIdByCode.get(u.role)], timeZoneId },
    });
  }

  // 別的語系的示範帳號不該掛在這個團隊裡。
  // ★ 為什麼需要這一步：帳號是全域的，而兩條鏈在 2026-10-04 之前**共用同一批 username**
  //   ⇒ 舊帳號（那時被加進這個團隊）會與新帳號並存，名冊變成 12 位。只加不減的寫法
  //   **看不出來**——多出來的那幾位照樣有徽章、徽章也照樣是那六個。
  // 只動「別的語系資料集裡的那幾個 username」：admin 與任何真人帳號都不在名單裡。
  const foreign = new Set();
  for (const l of LOCALES) {
    if (l === LOCALE) continue;
    for (const u of require(`./seed-data.${l}.cjs`).users) foreign.add(u.username);
  }
  const detail = await api(`/api/teams/${teamId}`);
  for (const m of detail.members || []) {
    if (!foreign.has(m.username)) continue;
    await api(`/api/teams/${teamId}/members/${m.userId}`, { method: 'DELETE' });
    removed.members.push(m.username);
  }
  return roleIdByCode;
}

async function ensureProject(teamId, def) {
  const list = await api('/api/projects');
  const found = list.find(p => p.name === def.name);
  if (found) return found;
  // X-Team-Id 即使 admin 也一定要帶，且必須是合法的團隊 GUID。
  const p = await api('/api/projects', {
    method: 'POST',
    body: { name: def.name, description: def.description, timeZoneId },
    headers: { 'X-Team-Id': teamId },
  });
  created.projects.push(def.name);
  return p;
}

/**
 * 專案成員是獨立於團隊成員的另一份名冊：建立專案只把建立者加進去。少了這一段，
 * 卡片對話框的「成員」「審查者」下拉與專案的成員頁簽都會只剩建立者 admin——
 * 而計數來自卡片自己的名冊、下拉來自專案名冊，畫面上就會出現「審查者 2、下拉只有 1」
 * 這種對不上的狀態（卡片可以合法持有不在專案名冊裡的人：兩個 PUT 都只驗「使用者存在」）。
 *
 * `POST …/members` 是逐使用者的 diff（補上缺少的角色、移除不在清單裡的角色），
 * 與團隊成員的 PUT 同型 ⇒ 重跑安全。**只同步示範成員，不動 admin**：admin 不在團隊裡，
 * 他在專案裡那一列是建立專案時以「團隊經理」補上的；拿空的 roleIds 同步他等於把他踢出專案。
 */
async function ensureProjectMembers(projectId, users, roleIdByCode) {
  const current = await api(`/api/projects/${projectId}/members`);
  const roleByUser = new Map(current.map(m => [m.userId, (m.roleIds || []).map(r => String(r).toLowerCase())]));
  for (const u of DATA.users) {
    const userId = users.get(u.username);
    const roleId = roleIdByCode.get(u.role);
    const have = roleByUser.get(userId);
    if (have && have.length === 1 && have[0] === String(roleId).toLowerCase()) continue;
    await api(`/api/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId, roleIds: [roleId], timeZoneId },
    });
    if (!have) created.projectMembers.push(u.username);
  }
}

async function ensureBoard(projectId, name) {
  const boards = await api(`/api/projects/${projectId}/boards`);
  const found = boards.find(b => b.name === name);
  if (found) return found;
  const b = await api(`/api/projects/${projectId}/boards`, {
    method: 'POST',
    body: { name, description: null },
  });
  created.boards.push(name);
  return b;
}

async function ensureLabels(boardId) {
  // 2026-10-09：舊寫法讀 `GET /api/boards/{id}`，而 BoardDetailResponse 不含 labels
  // ⇒ byName 恆為空、每次 seed 重新 POST 一輪同名標籤（示範庫因此累積 5 名 × 13 份）。
  // 權威來源是 labels 端點（LabelResponse 陣列）。
  const labels = await api(`/api/boards/${boardId}/labels`);
  const byName = new Map(labels.map(l => [l.name, l.id]));
  for (const [name, color] of DATA.labels) {
    if (byName.has(name)) continue;
    const l = await api(`/api/boards/${boardId}/labels`, {
      method: 'POST',
      body: { name, color },
    });
    byName.set(name, l.id);
  }
  return byName;
}

async function ensureLists(boardId, names) {
  const board = await api(`/api/boards/${boardId}`);
  const byName = new Map((board.lists || []).map(l => [l.name, l.id]));
  for (const name of names) {
    if (byName.has(name)) continue;
    const l = await api(`/api/boards/${boardId}/lists`, { method: 'POST', body: { name } });
    byName.set(name, l.id);
  }
  return byName;
}

/**
 * 自訂欄位查詢：資料集的顯示名 ＋ 後端種下的原名，兩個都試。
 * 第一次建立專案時欄位叫後端那個名字，改過名之後叫資料集這個——各罩一半。
 * （不能用 SystemKey：它不在任何 API 回應裡，見 spec §5.1.1。）
 *
 * ★ `key` 是**邏輯名**（`'priority'`／`'requester'`），不是顯示名：
 *   `BACKEND_FIELD_NAMES` 與 `DATA.customFields` 都是以它為鍵的。拿顯示名去查會得到
 *   `undefined`，於是 en 那條鏈永遠比不中後端原名（中文那條只是剛好同名才看起來正常）。
 */
function findSeedField(fields, key) {
  const displayed = DATA.customFields[key].name;
  return fields.find(f => f.name === displayed || f.name === BACKEND_FIELD_NAMES[key]) || null;
}

async function ensurePriorityField(projectId) {
  const fields = await api(`/api/projects/${projectId}/custom-fields`);
  // 建立專案時會 seed 一個 systemKey=priority、名稱「優先級」的 select 欄位；
  // 回應不含 systemKey，所以以名稱找（改名後叫資料集那個名字，見 findSeedField）。
  return findSeedField(fields, 'priority');
}

/** 兩個集合是否為同一組（順序不計）。 */
function sameSet(a, b) {
  const s = new Set(a), t = new Set(b);
  return s.size === t.size && [...s].every(x => t.has(x));
}

/**
 * 把後端種下的兩個自訂欄位改成資料集的名字（與選項）。
 *
 * ★ 這一支**必須在 seedBoardCards 之前跑**：寫入卡片的自訂欄位值會經
 *   CustomFieldValidator.ValidateValue(def.Type, value, options) 對**當下的選項**驗證
 *   （CustomFieldEndpoints.cs:262）⇒ 選項還是 ["高","中","低"] 時寫 'High' 會被 400 擋下。
 *
 * 中文那條鏈呼叫它是 no-op（資料集的名字與後端原名相同），所以不需要分支。
 */
async function ensureSeedCustomFields(projectId) {
  const fields = await api(`/api/projects/${projectId}/custom-fields`);
  const want = [
    { key: 'priority', options: DATA.customFields.priority.options },
    { key: 'requester', options: undefined },
  ];
  for (const { key, options } of want) {
    const displayed = DATA.customFields[key].name;
    const field = findSeedField(fields, key);
    if (!field) {
      throw new Error(
        `專案 ${projectId} 找不到自訂欄位 ${key}（試過 ${displayed} 與 ${BACKEND_FIELD_NAMES[key]}；` +
        `現有：${fields.map(f => f.name).join('、') || '（一個都沒有）'}）`
      );
    }
    // 名字與選項都已是資料集那一組就別送 PUT——重跑時這一步不該產生任何寫入。
    if (field.name === displayed && (options === undefined || sameSet(field.options || [], options))) continue;
    await api(`/api/projects/${projectId}/custom-fields/${field.id}`, {
      method: 'PUT',
      body: { name: displayed, options },
    });
  }
}

/**
 * 子資源一律「先比對現況、只補不足的」，所以重跑安全——留言／工時／審查歷程都是
 * append-only，重複寫會留下假歷史。順序有意義：交付要排在審查之前（交付會把審查立場
 * 重設為 pending），所以下面每寫完一段就重取一次 full。
 */
async function applyCardDetail(cardId, def, ctx) {
  const { users, labelIds, priorityField } = ctx;

  const patch = {};
  if (def.description) patch.description = def.description;
  if (def.start !== undefined) patch.startAt = at(def.start, 9);
  if (def.due !== undefined) patch.dueAt = at(def.due);
  if (def.estimate !== undefined) patch.estimatedHours = def.estimate;
  if (Object.keys(patch).length) {
    await api(`/api/cards/${cardId}`, { method: 'PUT', body: patch });
  }

  const assigneeIds = (def.assignees || []).map(u => users.get(u)).filter(Boolean);
  if (assigneeIds.length) {
    await api(`/api/cards/${cardId}/members`, { method: 'PUT', body: { userIds: assigneeIds } });
  }

  const ids = (def.labels || []).map(n => labelIds.get(n)).filter(Boolean);
  if (ids.length) {
    await api(`/api/cards/${cardId}/labels`, { method: 'PUT', body: { labelIds: ids } });
  }

  if (def.priority && priorityField) {
    await api(`/api/cards/${cardId}/custom-fields`, {
      method: 'PUT',
      body: { [priorityField.id]: def.priority },
    });
  }

  let full = await api(`/api/cards/${cardId}`);

  // 交付是單向的，且會把審查立場重設為 pending（設計如此）⇒ 已交付過就不再送，
  // 否則每次重跑都會把下面剛補好的審查立場打回待審。
  if (def.completed && !full.completedAt) {
    await api(`/api/cards/${cardId}/completion`, { method: 'PUT', body: { isCompleted: true } });
    full = await api(`/api/cards/${cardId}`);
  }

  const logged = new Set((full.effort?.logs || []).map(l => effortKey(l.username, l.hours, l.note)));
  for (const [who, hours, note, daysAgo] of def.effort || []) {
    if (logged.has(effortKey(who, hours, note))) continue;
    // ★ 去重鍵**不含日期**：工時是 append-only，重跑不該偽造歷史。已存在的那一筆保留它
    //   當初寫下的日期（隔天重跑不會把它搬到今天），只有**新補的**才用新的 `daysAgo`。
    //   `localDate` 相對「跑 seed 的當天」⇒ 隔幾個月重跑仍然新鮮。
    await api(`/api/cards/${cardId}/effort`, {
      method: 'POST',
      body: { hours, note, localDate: localDayString(daysAgo ?? 0), timeZoneId },
      as: who,
    });
  }

  const feed = await api(`/api/cards/${cardId}/activity?filter=comments_only&limit=100`);
  const said = new Set((feed.items || []).map(a => `${a.userId}|${a.text}`));
  for (const [who, text] of def.comments || []) {
    if (said.has(`${users.get(who)}|${text}`)) continue;
    await api(`/api/cards/${cardId}/comments`, { method: 'POST', body: { text }, as: who });
  }

  // 只補不刪：`PUT …/reviews` 是整批覆寫，直接把 def 送出去會把 seedNotifications
  // 後加的審查者（admin）踢掉，下一輪再被加回來——每跑一次就換一輪列。
  const reviewerIds = (def.reviewers || []).map(u => users.get(u)).filter(Boolean);
  const current = (full.reviews || []).map(r => r.reviewerUserId);
  const wanted = [...new Set([...current, ...reviewerIds])];
  if (reviewerIds.length && !sameSet(current, wanted)) {
    await api(`/api/cards/${cardId}/reviews`, { method: 'PUT', body: { reviewerUserIds: wanted } });
    full = await api(`/api/cards/${cardId}`);
  }

  if (def.review) {
    const row = (full.reviews || []).find(r => r.reviewerUserId === users.get(def.review.by));
    if (!row) throw new Error(`「${def.title}」找不到 ${def.review.by} 的審查列`);
    const score = def.review.score ?? null;
    const comment = def.review.comment ?? null;
    // 已是最終立場就跳過——提交會寫一筆審查歷程（append-only），重送等於偽造歷史。
    if (row.status === def.review.status && (row.score ?? null) === score && (row.comment ?? null) === comment) return;
    await api(`/api/cards/${cardId}/reviews/${row.id}`, {
      method: 'PUT',
      body: { status: def.review.status, score, comment },
      as: def.review.by, // 只有被指派的審查者本人能提交（403）；admin 沒有這層豁免
    });
  }
}

async function seedBoardCards(boardId, defs, ctx) {
  const board = await api(`/api/boards/${boardId}`);
  const existing = new Map();
  for (const l of board.lists || []) for (const c of l.cards || []) existing.set(c.title, c.id);

  for (const def of defs) {
    const listId = ctx.listIds.get(def.list);
    if (!listId) throw new Error(`「${def.title}」指到不存在的清單 ${def.list}`);
    let cardId = existing.get(def.title);
    if (cardId === undefined) {
      const card = await api(`/api/lists/${listId}/cards`, {
        method: 'POST',
        body: { title: def.title, description: null },
      });
      created.cards.push(def.title);
      cardId = card.id;
    }
    // 既有的卡也走一次：子資源只補不足的，所以跑到一半失敗時重跑就會補齊。
    await applyCardDetail(cardId, def, ctx);
  }
}

async function seedMindMap(projectId, ctx) {
  let mm = await api(`/api/projects/${projectId}/mindmap`);
  // 標題 → 節點。用 Map 而不是 Set：分支已存在但子節點沒建完時，還是要靠它拿 parentId。
  const byTitle = new Map((mm.nodes || []).map(n => [n.title, n]));

  // POST 節點的回應是**整棵樹**（MindMapResponse），不是剛建立的那個節點——
  // 直接拿回應的 `id` 會拿到 mapId，下一個子節點就會以它為 parentId 而 404。
  const addNode = async (title, parentId) => {
    const tree = await api(`/api/projects/${projectId}/mindmap/nodes`, {
      method: 'POST',
      body: { title, parentId, cardId: null },
    });
    const node = (tree.nodes || []).find(n => n.title === title);
    if (!node) throw new Error(`建立心智圖節點「${title}」之後在回應裡找不到它`);
    byTitle.set(title, node);
    created.nodes.push(title);
    return node;
  };

  // 後端**不會**自動建根節點：新專案沒有圖（id 為 Guid.Empty 的空樹），圖與第一個節點
  // 是「第一次 POST 節點」時 lazily 建立的（MindMapEndpoints 的註解，spec §2）。
  // 前端也是在使用者按「新增節點」時送 parentId: null——這裡比照辦理。
  let root = (mm.nodes || []).find(n => n.parentId === null);
  if (!root) root = await addNode(DATA.mindMap.root, null);

  for (const branch of DATA.mindMap.branches) {
    // 分支已存在也要往下走：跑到一半失敗時剩下的子節點才補得齊。
    const branchNode = byTitle.get(branch.title) || (await addNode(branch.title, root.id));
    for (const childTitle of branch.children) {
      const childNode = byTitle.get(childTitle) || (await addNode(childTitle, branchNode.id));
      // 每個分支的第一個子節點綁一張卡，畫布上才看得到綁定與審查狀態。
      // 綁定與「節點存不存在」是兩件事——節點早就在、綁定卻沒做過的重跑情境要在這裡補。
      if (childTitle === branch.children[0] && branch.card) {
        const cardId = ctx.cardIdByTitle.get(branch.card);
        if (cardId && childNode.cardId !== cardId) {
          const tree = await api(`/api/projects/${projectId}/mindmap/nodes/${childNode.id}`, {
            method: 'PUT',
            body: { cardId },
          });
          const updated = (tree.nodes || []).find(n => n.id === childNode.id);
          if (updated) byTitle.set(childTitle, updated);
        }
      }
    }
  }
}

/** #24 通知彈窗的內容：由別人觸發，截圖的那個登入者才會收到（伺服器排除自我觸發事件）。 */
async function seedNotifications(projectId, boardId, ctx) {
  const targets = DATA.notificationTargets;
  // 收件者是**資料集指名的截圖登入者**（`captureAs`），不是寫死的 admin：
  // 24_NotificationPopover 拍的就是那個人的通知中心。
  // 觸發者必須另有其人，而且要持有 card.assign ⇒ 由資料集的 eng_lead 擔任
  // （en ⇒ kevin.chen、zh-TW ⇒ lead.chen）。
  // ★ 這裡原本寫死 `as: 'lead.chen'`——那是 **zh-TW 資料集**的帳號。兩條鏈的帳號拆開之後
  //   （2026-10-04），英文鏈在**乾淨的庫**上會死在這裡（`session()` 登入 401），
  //   而它跑得過只因為這個 dev 庫裡同時裝著中文示範資料——正是本階段在別的站點修掉的
  //   同一個形狀（兩條鏈互相依賴）。從資料集推導之後，兩條鏈各自獨立。
  const actor = DATA.users.find(u => u.role === 'eng_lead' && u.username !== DATA.captureAs);
  if (!actor) throw new Error('資料集裡找不到可當觸發者的 eng_lead（且不能是 captureAs 本人）');
  for (const title of targets) {
    const cardId = ctx.cardIdByTitle.get(title);
    if (!cardId) continue;
    const full = await api(`/api/cards/${cardId}`);
    const already = (full.reviews || []).some(r => r.reviewerUserId === ctx.viewerId);
    if (already) continue;
    // `${actor.username} 有 card.assign，由他指派登入者當審查者 → 登入者收到「審查邀請」通知。`
    const reviewerIds = [...(full.reviews || []).map(r => r.reviewerUserId), ctx.viewerId];
    await api(`/api/cards/${cardId}/reviews`, {
      method: 'PUT',
      body: { reviewerUserIds: reviewerIds },
      as: actor.username,
    });
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const admin = await session('admin');
  console.log(`admin 已登入（userId ${admin.userId}）  API: ${BASE}`);

  // admin 的顯示名是**全域單一值**（AdminSeed.cs:30 只在使用者不存在時寫入），
  // 而它出現在幾乎每一張截圖的頁首 ⇒ 兩條鏈輪流設定它。
  // ★ 副作用（刻意、已載明）：跑完英文那條之後，中文那條若重跑，頁首會是 Administrator，
  //   除非先跑一次中文 seed。寫在這裡以免日後被當成 bug。
  await api('/api/me/profile', { method: 'PUT', body: { displayName: DATA.adminDisplayName } });

  const users = await ensureUsers();
  users.set('admin', admin.userId);
  console.log(`使用者：${users.size} 位（新建 ${created.users.length}，顯示名改寫 ${renamed.users.length}）`);

  const teamId = await ensureTeam();
  const roleIdByCode = await ensureMembers(teamId);
  console.log(`團隊「${DATA.team.name}」就緒（${created.team ? '新建' : '既有'}）`);

  const project1 = await ensureProject(teamId, DATA.projects.main);
  await ensureProjectMembers(project1.id, users, roleIdByCode);
  const board1 = await ensureBoard(project1.id, DATA.projects.main.board);
  const labelIds = await ensureLabels(board1.id);
  const listIds = await ensureLists(board1.id, DATA.projects.main.lists);
  await ensureSeedCustomFields(project1.id); // ★ 必須在 seedBoardCards 之前
  const priorityField = await ensurePriorityField(project1.id);

  // 截圖時的登入者由**資料集**指名（`captureAs`），不是寫死的 admin。
  // 06 我的工作台／19 我的日誌／24 通知中心 三張看的就是這個人 ⇒ 資料集要餵他資料
  // （指派、工時、通知），否則那三張是空狀態而且不會有任何錯誤訊息。
  // 守門員：`web/verify-demo-data.cjs` 的 ⑤。
  const viewer = DATA.captureAs;
  const viewerId = users.get(viewer) ?? (viewer === 'admin' ? admin.userId : undefined);
  if (!viewerId) throw new Error(`captureAs「${viewer}」在 /api/admin/users 裡找不到 id`);

  const ctx = { users, labelIds, listIds, priorityField, adminId: admin.userId, viewerId, cardIdByTitle: new Map() };
  await seedBoardCards(board1.id, DATA.cards, ctx);

  // 卡片 id 對照表（心智圖綁定與通知都要用）
  const board = await api(`/api/boards/${board1.id}`);
  for (const l of board.lists || []) for (const c of l.cards || []) ctx.cardIdByTitle.set(c.title, c.id);

  await seedMindMap(project1.id, ctx);
  await seedNotifications(project1.id, board1.id, ctx);
  console.log(`專案「${project1.name}」：看板 1、卡片 ${DATA.cards.length}、心智圖節點 ${DATA.mindMap.branches.length * 3 + 1}`);

  const project2 = await ensureProject(teamId, DATA.projects.secondary);
  await ensureProjectMembers(project2.id, users, roleIdByCode);
  const board2 = await ensureBoard(project2.id, DATA.projects.secondary.board);
  // 回傳值要接：`ctx.labelIds` 是 **board1 的**映射，跨看板的 labelId 會讓帶 labels 的
  // 卡片在 `CardEndpoints` 被擋成 400。今天無害（兩份資料集的 PROJECT2 卡片都沒有 labels 鍵），
  // 但那是「回傳值／使用端不一致」的同型第二處（第一處是上面修掉的 ensureLabels 端點）。
  const labelIds2 = await ensureLabels(board2.id);
  const listIds2 = await ensureLists(board2.id, DATA.projects.secondary.lists);
  await ensureSeedCustomFields(project2.id); // ★ 必須在 seedBoardCards 之前
  const priority2 = await ensurePriorityField(project2.id);
  await seedBoardCards(board2.id, DATA.secondaryCards, {
    ...ctx,
    labelIds: labelIds2,
    listIds: listIds2,
    priorityField: priority2,
  });
  console.log(`專案「${project2.name}」：看板 1、卡片 ${DATA.secondaryCards.length}`);

  console.log('\n本次新建：');
  console.log(`  使用者 ${created.users.length}｜團隊 ${created.team ? 1 : 0}｜專案 ${created.projects.length}` +
    `｜專案成員 ${created.projectMembers.length}｜看板 ${created.boards.length}` +
    `｜卡片 ${created.cards.length}｜心智圖節點 ${created.nodes.length}`);
  // ★ 這一條**必須印在最後**：`ensureMembers` 在收尾報告之後才跑（呼叫點在它下面）。
  //   放在「使用者：…」那一行後面的話，`removed.members` 那時還是空的——
  //   移除**真的發生了**（名冊 12 → 6），而報告印的是 0，日誌會反過來騙人。
  if (removed.members.length) {
    console.log(`  移出本團隊的別語系示範帳號（${removed.members.length}）：${removed.members.join(', ')}`);
  }
  console.log('\n接著跑：node web/capture_all.cjs');
}

main().catch(err => {
  console.error('\n示範資料建立失敗：');
  console.error(err.message);
  process.exit(1);
});
