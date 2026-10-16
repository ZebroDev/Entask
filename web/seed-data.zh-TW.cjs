// 中文示範資料集（zh-TW）——示範資料產生器（web/seed_demo.cjs）的資料層。
//
// 六個資料常數是從 seed_demo.cjs 的資料區**逐位元組**抽出來的（抽取腳本在產生當下以
// 「來源切片必須原樣出現在本檔」＋「切片首尾必須是指定的宣告」雙重斷言過）。
// 要改資料就改這裡；seed_demo.cjs 已經不再持有任何資料。
//
// 形狀契約：與 seed-data.en.cjs 同構（鍵路徑、陣列長度、純量型別都相同，只有字串值可以
// 不同），守門員是 web/verify-seed-data.cjs。動這裡的形狀會讓那支驗證腳本紅。
//
// ★ `effort` 條目是**四個**元素 `[who, hours, note, daysAgo]`（2026-10-08 批次 T8）：
//   `daysAgo` 是「幾天前」（0＝seed 執行當天），`seed_demo.cjs` 用它換算出 `localDate`。
//   沒有第四個元素時，整批工時全部蓋在跑 seed 的那一天（`dev.lin` 一天 30.5 小時）。
//   兩條規則——散在最近 0..21 天、**同一人同一天 ≤ 8 小時**——的閘門是
//   `web/scripts/seed-data.test.mjs`；兩份資料集的**數字**必須逐字相同
//   （`verify-seed-data.cjs` 的 `structural()` 連數字一起比，只有字串值可以不同）。
//   ★ `daysAgo` 0..7 這一段把**七個星期幾各蓋到一次** ⇒ 不論 seed 跑在星期幾，都會有
//     條目落在週末（保留「週末加班」那個樣本），而多數仍落在工作日。
//   ★ 值的取法（**逐筆複驗 15 筆之後**的實際規則）：**不晚於該卡的 `due`**（15 筆全部成立）、
//     不早於該卡的 `start`——**唯一例外**是「附件上傳進度指示」：它的 `start: 6` 在**未來**，
//     而工時不得登記未來日（`effort.localDateInFuture`）⇒ 那張卡**不存在**合規的工時日，
//     那一筆是刻意留著的既有樣本、不是合規值。同一人的兩筆同日加總仍 ≤ 8。
//     （「越舊的卡工時越久以前」**不成立**——不要照著寫：`start: -20` 那張的工時 d18
//     比 `start: -25` 那張的 d16 更舊。）

const TEAM = { name: '產品研發部', description: 'Entask 平台與客戶專案的開發團隊' };

const USERS = [
  { username: 'manager.hsu', displayName: '許雅涵', role: 'team_manager' },
  { username: 'pm.huang', displayName: '黃思婷', role: 'project_manager' },
  { username: 'lead.chen', displayName: '陳冠宇', role: 'eng_lead' },
  { username: 'dev.lin', displayName: '林彥廷', role: 'engineer' },
  { username: 'dev.wu', displayName: '吳佩珊', role: 'engineer' },
  { username: 'qa.chang', displayName: '張家豪', role: 'qa_engineer' },
];

const LABELS = [
  ['前端', '#0079BF'],
  ['後端', '#519839'],
  ['UI/UX', '#CD5A91'],
  ['效能', '#D93F0B'],
  ['文件', '#F2D600'],
];

const CARDS = [
  {
    title: '通知中心支援批次已讀',
    list: '待辦事項',
    description:
      '目前通知只能逐筆標為已讀，累積十幾筆之後很難清理。\n\n- 標頭加上「全部標為已讀」\n- 未讀計數即時更新\n- 已讀狀態寫回伺服器，換裝置也一致',
    assignees: ['dev.lin', 'admin'],
    labels: ['後端', 'UI/UX'],
    priority: '高',
    start: -2,
    due: 2,
    estimate: 6,
    // ★ 與 en 那份同步（同一位第二審查者）：兩份資料必須同構，
    // `verify-seed-data.cjs` 比對的是**陣列長度**，單邊改會讓它當場紅。
    // 中文這條鏈本來就不受影響（zh 只有 count_other），改的是為了維持同構。
    reviewers: ['lead.chen', 'pm.huang'],
    review: null,
    comments: [
      ['lead.chen', '計數的即時更新要走既有的 collaboration hub，不要另開輪詢。'],
      ['dev.lin', '已經接上 hub，實測換裝置重新整理之後未讀數不會跳回來。'],
      ['pm.huang', '驗收條件就以「換裝置重新整理」為準，這條我會自己走一次。'],
      ['qa.chang', '我這邊補一組未讀數 0 與 99+ 的邊界測試。'],
    ],
    effort: [
      ['dev.lin', 3.5, 'hub 事件接線', 2],
      ['dev.lin', 2, '前端計數與已讀寫回', 1],
      // admin 也要有工作紀錄：手冊的截圖一律以 admin 登入，若 admin 沒有任何指派與工時，
      // 「我的工作台」是空狀態、「我的日誌」只剩別的專案（2026-09-19 實際踩到）。
      // ★ 其中一筆固定在 `daysAgo: 0`（今天）：19 我的日誌預設是**本週**檢視，
      //   而本週一定含今天——全部往後推的話那一張在週一會是空的。
      ['admin', 2, '規格與驗收條件確認', 0],
    ],
  },
  {
    title: '行動版導覽列收合動畫',
    list: '待辦事項',
    description: '斷點切換時側邊欄會瞬間跳開，補上過場。',
    assignees: ['dev.wu'],
    labels: ['前端', 'UI/UX'],
    priority: '中',
    start: 4,
    due: 7,
    estimate: 4,
  },
  {
    title: '附件上傳進度指示',
    list: '待辦事項',
    description: '大檔上傳時畫面沒有任何回饋，使用者會重複點擊。',
    assignees: ['dev.lin', 'admin'],
    labels: ['前端'],
    priority: '低',
    start: 6,
    due: 10,
    estimate: 5,
    effort: [['admin', 3, '與前端確認上傳流程與失敗重試', 1]],
  },
  {
    title: '匯出檔名依語系命名',
    list: '待辦事項',
    description: '匯出的 CSV 檔名固定是英文，非中文使用者看得懂、中文使用者一頭霧水。',
    assignees: ['dev.wu', 'pm.huang'],
    labels: ['文件'],
    priority: '低',
    start: 8,
    due: 13,
    estimate: 2,
  },
  {
    title: '看板封存與還原的批次操作',
    list: '待辦事項',
    description: '一次要封存多個看板時只能逐個點。',
    assignees: ['dev.lin'],
    labels: ['前端'],
    priority: '低',
    start: 9,
    due: 15,
    estimate: 3,
  },
  {
    title: '全域搜尋納入卡片描述',
    list: '進行中',
    description:
      '現在只搜標題，但很多關鍵字其實寫在描述裡。\n\n- 查詢要能命中描述\n- 結果要標出命中片段\n- 注意效能：描述欄位沒有索引，先用 ILIKE 就好，不要過早最佳化',
    assignees: ['dev.lin', 'dev.wu'],
    labels: ['後端', '效能'],
    priority: '高',
    start: -4,
    due: 3,
    estimate: 8,
    reviewers: ['lead.chen'],
    review: null,
    comments: [['lead.chen', '先量測再決定要不要加索引。']],
    effort: [['dev.lin', 4, '查詢改寫與 EXPLAIN 比對', 4]],
  },
  {
    title: '甘特圖里程碑標記',
    list: '進行中',
    description: '里程碑目前與一般卡片長得一樣，看不出來是節點。',
    assignees: ['dev.wu'],
    labels: ['前端', 'UI/UX'],
    priority: '中',
    start: -3,
    due: 5,
    estimate: 12,
    effort: [['dev.wu', 6, '里程碑樣式與圖例', 3]],
  },
  {
    title: '工作日誌月檢視彙總列',
    list: '進行中',
    description: '月檢視目前只列每日工時，缺少當月合計與人均。',
    assignees: ['dev.lin'],
    labels: ['後端'],
    priority: '高',
    start: -6,
    due: 1,
    estimate: 10,
    reviewers: ['pm.huang'],
    review: null,
    effort: [
      ['dev.lin', 5, '彙總查詢與 API', 6],
      ['pm.huang', 1.5, '需求確認與驗收', 5],
    ],
  },
  {
    title: '心智圖節點快速搜尋',
    list: '待審查',
    description: '節點數量一多就找不到，補一個畫布內的快速定位。',
    assignees: ['dev.wu'],
    labels: ['UI/UX'],
    priority: '中',
    start: -7,
    due: 0,
    estimate: 10,
    reviewers: ['lead.chen'],
    review: null,
    comments: [['lead.chen', '匯出的 SVG 也要跟著標出命中節點嗎？先不用，這次只做畫布內。']],
    effort: [['dev.wu', 7, '畫布搜尋與定位', 7]],
  },
  {
    title: '卡片審查狀態徽章',
    list: '已完成',
    description: '讓待審查／通過／退回在四個檢視裡長得一樣。',
    assignees: ['dev.lin'],
    labels: ['前端'],
    priority: '高',
    start: -12,
    due: -3,
    estimate: 8,
    reviewers: ['lead.chen'],
    review: { by: 'lead.chen', status: 'approved', score: 5 },
    completed: true,
    effort: [['dev.lin', 8, '四視圖徽章落點', 10]],
  },
  {
    title: '表格檢視批次指派',
    list: '已完成',
    description: '表格勾選多列之後可以直接指派負責人。',
    assignees: ['dev.wu'],
    labels: ['前端'],
    priority: '中',
    start: -18,
    due: -6,
    estimate: 6,
    reviewers: ['pm.huang'],
    review: { by: 'pm.huang', status: 'approved', score: 4 },
    completed: true,
    effort: [['dev.wu', 6, '批次操作列與指派', 12]],
  },
  {
    title: '登入頁品牌與語系切換',
    list: '已完成',
    description: '登入頁補上語系切換，順便把品牌區塊重排。',
    assignees: ['dev.wu', 'pm.huang'],
    labels: ['UI/UX'],
    priority: '中',
    start: -22,
    due: -9,
    estimate: 5,
    reviewers: ['lead.chen'],
    review: { by: 'lead.chen', status: 'approved', score: 5 },
    completed: true,
    effort: [['dev.wu', 4, '登入頁版面', 14], ['pm.huang', 1, '文案複閱', 13]],
  },
  {
    title: '留言分頁無限捲動',
    list: '已完成',
    description: '留言多起來之後一次載入全部會卡。',
    assignees: ['dev.lin'],
    labels: ['效能'],
    priority: '中',
    start: -25,
    due: -12,
    estimate: 6,
    reviewers: ['qa.chang'],
    review: { by: 'qa.chang', status: 'approved', score: null },
    completed: true,
    // 工時只能由持有 card.effort.update 的角色登記——qa_engineer 沒有這個權限
    // （RoleSeed 的範本如此），所以 QA 的回歸時數掛在開發者身上。
    effort: [['dev.lin', 5, '游標分頁與長列表回歸', 16]],
  },
  {
    title: '權限矩陣 CSV 匯出',
    // 被退回的卡**不能**同時是已交付——後端的提交端點對「退回」會清掉 CompletedAt
    // （設計如此），兩個都寫的話每跑一次都會重新交付、重新退回。
    list: '進行中',
    description: '主管要一份可以貼進會議紀錄的權限對照表。',
    assignees: ['dev.lin'],
    labels: ['文件', '後端'],
    priority: '低',
    start: -20,
    due: -4,
    estimate: 3,
    reviewers: ['pm.huang'],
    review: { by: 'pm.huang', status: 'rejected', score: null, comment: '欄位順序與角色管理頁不一致，請對齊後重送。' },
    effort: [['dev.lin', 3, 'CSV 匯出', 18]],
  },
];

const PROJECT2 = {
  name: '客戶入口網站',
  description: '外部客戶使用的入口與報表',
  board: '需求與排程',
  lists: ['待確認', '開發中', '已上線'],
  cards: [
    { title: '客戶報表頁載入時間', list: '開發中', priority: '高', assignees: ['dev.wu'], start: -2, due: 4 },
    { title: '單一登入（SSO）串接', list: '待確認', priority: '高', assignees: ['lead.chen'], start: 3, due: 12 },
    { title: '首頁文案調整', list: '已上線', priority: '低', assignees: ['pm.huang'], start: -9, due: -2, completed: true },
  ],
};

const MINDMAP = [
  { title: '使用者體驗', children: ['看板與多視圖', '行動版版面'], card: '行動版導覽列收合動畫' },
  { title: '後端服務', children: ['搜尋與索引', '通知與即時協作'], card: '全域搜尋納入卡片描述' },
  { title: '資料與報表', children: ['工作日誌彙總', '績效報表'], card: '工作日誌月檢視彙總列' },
  { title: '品質與流程', children: ['審查生命週期', '自動化測試'], card: '卡片審查狀態徽章' },
];

// PROJECT2 的 cards 是第二個專案的卡片；其餘四個欄位構成 projects.secondary。
// 這樣切是為了讓上面那塊 PROJECT2 逐位元組不變（抽取的斷言靠它）。
const { cards: secondaryCards, ...projectsSecondary } = PROJECT2;

module.exports = {
  locale: 'zh-TW',
  // 截圖時以哪個帳號登入。這條鏈**維持 admin**——那本手冊本來就是中文，而且換人會讓
  // 已經產出的中文截圖與之後重跑的版本不同調。en 那條鏈改成自己的 Team Manager，
  // 理由見 `seed-data.en.cjs` 的同名欄位（admin 會把另一條鏈的示範資料一起拍進來）。
  captureAs: 'admin',
  adminDisplayName: '系統管理員',
  team: TEAM,
  users: USERS,
  // code → 顯示名。zh-TW 的值與 RoleSeed 種下的系統角色同名（所以沿用系統角色即可）；
  // en 的值不同 ⇒ 那裡會自建六個團隊自訂角色（見 seed_demo.cjs 的 ensureMembers）。
  roleNames: {
    team_manager: '團隊經理',
    project_manager: '專案經理',
    project_assistant: '專案助理',
    eng_lead: '工程組長',
    engineer: '工程師',
    qa_engineer: '測試工程師',
  },
  labels: LABELS,
  projects: {
    // 主專案的四個欄位原本散在 seed_demo.cjs 的 main() 裡（:662 名稱與描述、:664 看板、:666 清單）。
    main: {
      name: 'Entask 平台開發',
      description: '平台本體的功能開發與技術債',
      board: 'Sprint 12',
      lists: ['待辦事項', '進行中', '待審查', '已完成'],
    },
    secondary: projectsSecondary,
  },
  cards: CARDS,
  secondaryCards,
  // 語系顯示名（後端建立專案時種下的原名是 BACKEND_FIELD_NAMES，見 seed_demo.cjs）。
  customFields: {
    priority: { name: '優先級', options: ['高', '中', '低'] },
    requester: { name: '提出需求者' },
  },
  mindMap: { root: '產品藍圖', branches: MINDMAP },
  notificationTargets: ['全域搜尋納入卡片描述', '工作日誌月檢視彙總列'],
};
