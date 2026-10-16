// 英文示範資料集（en）——示範資料產生器（web/seed_demo.cjs）的資料層。
//
// 由 seed-data.zh-TW.cjs 翻譯而來（一次性翻譯產生器保證「只在字串實字內替換」且
// 「沒有漏譯」；該腳本未包含於本 repo）。**形狀與 zh-TW 那份完全相同**，
// 只有字串值不同；守門員是 web/verify-seed-data.cjs。
//
// ★ users[].role 是 SystemRoleCodes 的識別碼（查找鍵），不是顯示名——不要翻譯它。
//   顯示名在 roleNames，en 的值與系統角色不同 ⇒ seed_demo.cjs 會自建六個團隊自訂角色。
//
// ★ `effort` entries have **four** elements `[who, hours, note, daysAgo]` (batch T8,
//   2026-10-08): `daysAgo` is "how many days ago" (0 = the day the seed runs) and
//   `seed_demo.cjs` turns it into `localDate`. Without that fourth element every hour
//   landed on the seed day (dev.lin: 30.5 hours in one day). The two rules — spread
//   across the last 0..21 days and **at most 8 hours per person per day** — are gated by
//   `web/scripts/seed-data.test.mjs`. The **numbers** must be identical in both data sets
//   (`verify-seed-data.cjs` compares numbers too via `structural()`; only string values
//   may differ).
//   ★ `daysAgo` 0..7 covers each of the seven weekdays once ⇒ whatever weekday the seed
//     runs on, some entries land on a weekend (keeps the "weekend overtime" sample) while
//     most still land on weekdays.
//   ★ How a value is picked (the rule that actually holds after re-checking all 15 entries):
//     **not later than that card's `due`** (true for all 15), not earlier than its `start`
//     — with **one exception**: "Attachment upload progress indicator" has `start: 6` in the
//     future and a worklog may not be dated in the future (`effort.localDateInFuture`) ⇒
//     that card has **no** compliant worklog day; its entry is a pre-existing sample kept on
//     purpose, not a compliant value. Two entries by the same person on the same day still
//     add up to <= 8. ("Older cards get older hours" does **not** hold — do not write it down:
//     the `start: -20` card is logged at d18, older than the `start: -25` card's d16.)

const TEAM = { name: 'Product Engineering', description: 'Entask platform and customer project development team' };

const USERS = [
  { username: 'hannah.hsu', displayName: 'Hannah Hsu', role: 'team_manager' },
  { username: 'tina.huang', displayName: 'Tina Huang', role: 'project_manager' },
  { username: 'kevin.chen', displayName: 'Kevin Chen', role: 'eng_lead' },
  { username: 'ian.lin', displayName: 'Ian Lin', role: 'engineer' },
  { username: 'sophie.wu', displayName: 'Sophie Wu', role: 'engineer' },
  { username: 'howard.chang', displayName: 'Howard Chang', role: 'qa_engineer' },
];

const LABELS = [
  ['Frontend', '#0079BF'],
  ['Backend', '#519839'],
  ['UI/UX', '#CD5A91'],
  ['Performance', '#D93F0B'],
  ['Docs', '#F2D600'],
];

const CARDS = [
  {
    title: 'Bulk mark-as-read for notifications',
    list: 'To do',
    description:
      'Notifications can only be marked read one at a time; clearing a dozen of them is painful.\n\n- Add a \"Mark all as read\" action to the header\n- Keep the unread count live\n- Persist read state on the server so it is consistent across devices',
    assignees: ['ian.lin', 'hannah.hsu'],
    labels: ['Backend', 'UI/UX'],
    priority: 'High',
    start: -2,
    due: 2,
    estimate: 6,
    // ★ 第二位審查者是**必要的**，不是裝飾：看板上第一張卡會被 capture_all.cjs 點開拍
    // 23_CardReviewers.png，而 en 的 `card:reviewer.count_one` ＝ "{{count}} reviewer"、
    // `count_other` ＝ "{{count}} reviewers" ⇒ 人數是 1 時畫面是「1 reviewer」，
    // 選擇器（剝掉佔位符後是 `reviewers`）就**找不到那顆按鈕**。
    // 兩份資料都必須是 2 人（verify-seed-data.cjs 比對陣列長度）。
    reviewers: ['kevin.chen', 'tina.huang'],
    review: null,
    comments: [
      ['kevin.chen', 'The live count should reuse the existing collaboration hub, not a new polling loop.'],
      ['ian.lin', 'Wired to the hub; reloading on another device no longer brings the unread count back.'],
      ['tina.huang', 'Acceptance is \"reload on another device\"; I will walk through it myself.'],
      ['howard.chang', 'I will add boundary tests for unread counts of 0 and 99+.'],
    ],
    effort: [
      ['ian.lin', 3.5, 'Hub event wiring', 2],
      ['ian.lin', 2, 'Frontend counter and read-state write-back', 1],
      // ★ **截圖的那個登入者本身要有資料**：06 我的工作台／19 我的日誌／24 通知中心
      // 都是「以登入者為主角」的頁面，登入者沒有指派與工時的話，那三張是**空狀態**
      // （2026-09-19 admin 踩過一次；2026-10-04 換成 `captureAs` 的人之後又踩一次
      // ——實測 24 張裡 3 張是 `All caught up`／`Total hours 0.0`／`No notifications yet`）。
      // 這條鏈的登入者是 `hannah.hsu`（見檔尾 `captureAs`），所以被指派與登記工時的是她；
      // zh-TW 那條鏈的登入者是 admin ⇒ 那裡這些位置就寫 `admin`。
      // 值不同、形狀相同——`verify-seed-data.cjs` 比的是形狀，兩邊各自成立。
      // 守門員是 `web/verify-demo-data.cjs` 的 ⑤（以該帳號本人登入，量三個端點）。
      // ★ `daysAgo: 0`（今天）留在其中一筆：19 我的日誌預設是**本週**檢視，而本週一定
      //   含今天——全部往後推的話那一張在週一會是空的。
      ['hannah.hsu', 2, 'Spec and acceptance criteria review', 0],
    ],
  },
  {
    title: 'Mobile nav collapse animation',
    list: 'To do',
    description: 'The sidebar snaps open when the breakpoint changes; add a transition.',
    assignees: ['sophie.wu'],
    labels: ['Frontend', 'UI/UX'],
    priority: 'Medium',
    start: 4,
    due: 7,
    estimate: 4,
  },
  {
    title: 'Attachment upload progress indicator',
    list: 'To do',
    description: 'Large uploads give no feedback, so people click again.',
    assignees: ['ian.lin', 'hannah.hsu'],
    labels: ['Frontend'],
    priority: 'Low',
    start: 6,
    due: 10,
    estimate: 5,
    effort: [['hannah.hsu', 3, 'Align the upload flow and retry-on-failure with the frontend', 1]],
  },
  {
    title: 'Localize export filenames',
    list: 'To do',
    description: 'Exported CSV filenames are always English: fine for some readers, confusing for others.',
    assignees: ['sophie.wu', 'tina.huang'],
    labels: ['Docs'],
    priority: 'Low',
    start: 8,
    due: 13,
    estimate: 2,
  },
  {
    title: 'Bulk archive and restore for boards',
    list: 'To do',
    description: 'Archiving several boards at once means clicking each one.',
    assignees: ['ian.lin'],
    labels: ['Frontend'],
    priority: 'Low',
    start: 9,
    due: 15,
    estimate: 3,
  },
  {
    title: 'Include card descriptions in global search',
    list: 'In progress',
    description:
      'Only titles are searched today, but many keywords live in descriptions.\n\n- Queries must match the description\n- Results must highlight the matching excerpt\n- Watch performance: the description column is not indexed, ILIKE is fine for now, do not optimize prematurely',
    assignees: ['ian.lin', 'sophie.wu'],
    labels: ['Backend', 'Performance'],
    priority: 'High',
    start: -4,
    due: 3,
    estimate: 8,
    reviewers: ['kevin.chen'],
    review: null,
    comments: [['kevin.chen', 'Measure first, then decide whether to add an index.']],
    effort: [['ian.lin', 4, 'Query rewrite and EXPLAIN comparison', 4]],
  },
  {
    title: 'Gantt milestone markers',
    list: 'In progress',
    description: 'Milestones look like ordinary cards, so you cannot tell they are nodes.',
    assignees: ['sophie.wu'],
    labels: ['Frontend', 'UI/UX'],
    priority: 'Medium',
    start: -3,
    due: 5,
    estimate: 12,
    effort: [['sophie.wu', 6, 'Milestone styling and legend', 3]],
  },
  {
    title: 'Summary row for the monthly worklog view',
    list: 'In progress',
    description: 'The monthly view lists daily hours but has no month total or per-person average.',
    assignees: ['ian.lin'],
    labels: ['Backend'],
    priority: 'High',
    start: -6,
    due: 1,
    estimate: 10,
    reviewers: ['tina.huang'],
    review: null,
    effort: [
      ['ian.lin', 5, 'Aggregate query and API', 6],
      ['tina.huang', 1.5, 'Requirements review and acceptance', 5],
    ],
  },
  {
    title: 'Quick search for mind map nodes',
    list: 'In review',
    description: 'Once there are many nodes you cannot find anything; add in-canvas quick navigation.',
    assignees: ['sophie.wu'],
    labels: ['UI/UX'],
    priority: 'Medium',
    start: -7,
    due: 0,
    estimate: 10,
    reviewers: ['kevin.chen'],
    review: null,
    comments: [['kevin.chen', 'Should the exported SVG highlight matches too? Not yet; in-canvas only this time.']],
    effort: [['sophie.wu', 7, 'Canvas search and positioning', 7]],
  },
  {
    title: 'Card review status badges',
    list: 'Done',
    description: 'Make pending, approved and rejected look the same across all four views.',
    assignees: ['ian.lin'],
    labels: ['Frontend'],
    priority: 'High',
    start: -12,
    due: -3,
    estimate: 8,
    reviewers: ['kevin.chen'],
    review: { by: 'kevin.chen', status: 'approved', score: 5 },
    completed: true,
    effort: [['ian.lin', 8, 'Badge placement across the four views', 10]],
  },
  {
    title: 'Bulk assignment in the table view',
    list: 'Done',
    description: 'After selecting several table rows, assign an owner directly.',
    assignees: ['sophie.wu'],
    labels: ['Frontend'],
    priority: 'Medium',
    start: -18,
    due: -6,
    estimate: 6,
    reviewers: ['tina.huang'],
    review: { by: 'tina.huang', status: 'approved', score: 4 },
    completed: true,
    effort: [['sophie.wu', 6, 'Bulk action bar and assignment', 12]],
  },
  {
    title: 'Login page branding and language switch',
    list: 'Done',
    description: 'Add a language switch to the login page and rearrange the branding block.',
    assignees: ['sophie.wu', 'tina.huang'],
    labels: ['UI/UX'],
    priority: 'Medium',
    start: -22,
    due: -9,
    estimate: 5,
    reviewers: ['kevin.chen'],
    review: { by: 'kevin.chen', status: 'approved', score: 5 },
    completed: true,
    effort: [['sophie.wu', 4, 'Login page layout', 14], ['tina.huang', 1, 'Copy review', 13]],
  },
  {
    title: 'Infinite scroll for paginated comments',
    list: 'Done',
    description: 'Loading every comment at once gets slow once there are many.',
    assignees: ['ian.lin'],
    labels: ['Performance'],
    priority: 'Medium',
    start: -25,
    due: -12,
    estimate: 6,
    reviewers: ['howard.chang'],
    review: { by: 'howard.chang', status: 'approved', score: null },
    completed: true,
    // 工時只能由持有 card.effort.update 的角色登記——qa_engineer 沒有這個權限
    // （RoleSeed 的範本如此），所以 QA 的回歸時數掛在開發者身上。
    effort: [['ian.lin', 5, 'Cursor pagination and long-list regression', 16]],
  },
  {
    title: 'Permission matrix CSV export',
    // 被退回的卡**不能**同時是已交付——後端的提交端點對「退回」會清掉 CompletedAt
    // （設計如此），兩個都寫的話每跑一次都會重新交付、重新退回。
    list: 'In progress',
    description: 'Managers want a permission table they can paste into meeting notes.',
    assignees: ['ian.lin'],
    labels: ['Docs', 'Backend'],
    priority: 'Low',
    start: -20,
    due: -4,
    estimate: 3,
    reviewers: ['tina.huang'],
    review: { by: 'tina.huang', status: 'rejected', score: null, comment: 'Column order does not match the roles page; please align it and resubmit.' },
    effort: [['ian.lin', 3, 'CSV export', 18]],
  },
];

const PROJECT2 = {
  name: 'Customer Portal',
  description: 'Portal and reports for external customers',
  board: 'Requirements & Scheduling',
  lists: ['To confirm', 'In development', 'Live'],
  cards: [
    { title: 'Customer report page load time', list: 'In development', priority: 'High', assignees: ['sophie.wu'], start: -2, due: 4 },
    { title: 'Single sign-on (SSO) integration', list: 'To confirm', priority: 'High', assignees: ['kevin.chen'], start: 3, due: 12 },
    { title: 'Home page copy update', list: 'Live', priority: 'Low', assignees: ['tina.huang'], start: -9, due: -2, completed: true },
  ],
};

const MINDMAP = [
  { title: 'User experience', children: ['Boards and multi-view', 'Mobile layout'], card: 'Mobile nav collapse animation' },
  { title: 'Backend services', children: ['Search and indexing', 'Notifications and realtime collaboration'], card: 'Include card descriptions in global search' },
  { title: 'Data and reports', children: ['Worklog summaries', 'Performance reports'], card: 'Summary row for the monthly worklog view' },
  { title: 'Quality and process', children: ['Review lifecycle', 'Automated testing'], card: 'Card review status badges' },
];

// PROJECT2 的 cards 是第二個專案的卡片；其餘四個欄位構成 projects.secondary。
// 這樣切是為了讓上面那塊 PROJECT2 逐位元組不變（抽取的斷言靠它）。
const { cards: secondaryCards, ...projectsSecondary } = PROJECT2;

module.exports = {
  locale: 'en',
  // 截圖時以哪個帳號登入。**兩條鏈刻意不同**：
  // 這條鏈跑的時候，dev 庫裡同時裝著中文那條鏈的示範資料（刻意的——那是中文手冊的輸入），
  // 而 **admin 不受團隊範圍限制**：`GET /api/projects` 對 admin 回全部、團隊清單也回全部
  // ⇒ 英文手冊上會出現中文團隊名／專案名／別人的中文卡片。實測（2026-10-04）24 張裡有 5 張
  // 帶著中文：02 團隊選擇、05 專案清單、06 我的任務、21 個人設定、24 通知中心。
  // 改用這條鏈自己的 Team Manager 之後，她只看得到自己的 1 個團隊、2 個專案（實測），全是英文。
  captureAs: 'hannah.hsu',
  adminDisplayName: 'Administrator',
  team: TEAM,
  users: USERS,
  // code → 顯示名。zh-TW 的值與 RoleSeed 種下的系統角色同名（所以沿用系統角色即可）；
  // en 的值不同 ⇒ 那裡會自建六個團隊自訂角色（見 seed_demo.cjs 的 ensureMembers）。
  roleNames: {
    team_manager: 'Team Manager',
    project_manager: 'Project Manager',
    project_assistant: 'Project Assistant',
    eng_lead: 'Engineering Lead',
    engineer: 'Engineer',
    qa_engineer: 'QA Engineer',
  },
  labels: LABELS,
  projects: {
    // 主專案的四個欄位原本散在 seed_demo.cjs 的 main() 裡（:662 名稱與描述、:664 看板、:666 清單）。
    main: {
      name: 'Entask Platform Development',
      description: 'Feature development and technical debt for the platform itself',
      board: 'Sprint 12',
      lists: ['To do', 'In progress', 'In review', 'Done'],
    },
    secondary: projectsSecondary,
  },
  cards: CARDS,
  secondaryCards,
  // 語系顯示名（後端建立專案時種下的原名是 BACKEND_FIELD_NAMES，見 seed_demo.cjs）。
  customFields: {
    priority: { name: 'Priority', options: ['High', 'Medium', 'Low'] },
    requester: { name: 'Requester' },
  },
  mindMap: { root: 'Product roadmap', branches: MINDMAP },
  notificationTargets: ['Include card descriptions in global search', 'Summary row for the monthly worklog view'],
};
