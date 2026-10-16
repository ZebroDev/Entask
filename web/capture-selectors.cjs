// 語意名 → i18n {ns, key} 的對照表，以及把 key 解析成「畫面上實際會出現的字」的解析器。
//
// 為什麼存 key 不存字：那些字就是 app 的 i18n 值。手寫第二份等於製造一份會漂移的副本。
// 存 key、值當場從語系 JSON 取 ⇒ 六個語系全部免費，譯文改了它自己跟上。
//
// 解析規則（兩條都是被實際的 bug 逼出來的，見 spec §5.3）：
//   1. 值裡有 {{...}} 時**移除全部佔位符再 trim**。不可以寫成「截到 {{ 為止」——
//      en 的 card:reviewer.count_other 是 '{{count}} reviewers'，佔位符在開頭，
//      截在 {{ 會得到空字串，而 includes('') 恆真 ⇒ 選擇器會默默點到掃到的第一個元素。
//   2. 解析結果不得為空。空的比對字串與「解析失敗」在 includes 底下長得一樣。
//
// ★ 語意名是「這顆按鈕在畫面上的位置」，不是它的字。同一個字可能有 7 個 key 同值，
//   而 team:tab.worklog 與 project:tab.worklog 更是**同值又同 en 值**（都是 Worklog）
//   ⇒ 寫錯 key 一樣解析成功、一樣比對成功，它不會紅。挑 key 只能靠「它在哪一頁」。

const path = require("path");
const fs = require("fs");

const SELECTOR_LOCALES = ["zh-TW", "en"];

// 語意名 → { ns, key }。key 是**語系 JSON 裡的字面路徑**（複數形就是 _other）。
const TABLE = {
  // 團隊選擇頁
  teamEnter: { ns: "team", key: "select.enter.action" },            // capture_all.cjs:130
  // 團隊頁（分頁）
  teamTabReport: { ns: "team", key: "tab.report" },                 // :183
  teamTabWorklog: { ns: "team", key: "tab.worklog" },               // :184 ★ 不是 project 的
  // 導覽
  navUserMenu: { ns: "common", key: "nav.aria.userMenu" },          // :205
  navUserSettings: { ns: "common", key: "nav.userSettings" },       // :209
  // 工作日誌的日／週／月三態
  worklogModeMonth: { ns: "worklog", key: "mode.month" },           // :118, :225
  // 專案頁（分頁）
  projectTabCalendar: { ns: "project", key: "tab.calendar" },       // :240
  projectTabTable: { ns: "project", key: "tab.table" },             // :243
  projectTabGantt: { ns: "project", key: "tab.gantt" },             // :255
  projectTabMindMap: { ns: "project", key: "tab.mindMap" },         // :256
  projectTabReport: { ns: "project", key: "tab.report" },           // :257
  projectTabWorklog: { ns: "project", key: "tab.worklog" },         // :258
  projectTabBoards: { ns: "project", key: "tab.boards" },           // :261 ★ 複數
  // 卡片對話框
  cardReviewerCount: { ns: "card", key: "reviewer.count_other" },   // :332 ★ 帶插值
  cardTabComments: { ns: "card", key: "tab.comments" },             // :343, :351
  // 標頭
  notificationBell: { ns: "me", key: "notification.bell.aria" },    // :375
  // 連線橫幅的 needle（唯一的非點擊用途）
  connectionRestored: { ns: "common", key: "connection.restored" }, // :48
};

const PLACEHOLDER = /\{\{[^}]*\}\}/g;

function readValue(locale, ns, key) {
  const file = path.resolve(__dirname, "src/i18n/locales", locale, ns + ".json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  let cur = json;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return null;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : null;
}

function makeSelectors(locale) {
  if (!SELECTOR_LOCALES.includes(locale)) {
    throw new Error(
      `不支援的語系 ${JSON.stringify(locale)}；允許值：${SELECTOR_LOCALES.join(" / ")}`
    );
  }
  const out = {};
  for (const [name, { ns, key }] of Object.entries(TABLE)) {
    const raw = readValue(locale, ns, key);
    if (raw === null) throw new Error(`${locale}：找不到 i18n key ${ns}:${key}（語意名 ${name}）`);
    const resolved = raw.replace(PLACEHOLDER, "").trim();
    if (resolved === "") {
      throw new Error(
        `${locale}：${ns}:${key}（語意名 ${name}）剝掉佔位符之後是空字串` +
        `（原值 ${JSON.stringify(raw)}）——空字串會讓 includes 恆真、選擇器默默點錯元素`
      );
    }
    out[name] = resolved;
  }
  return out;
}

module.exports = { makeSelectors, SELECTOR_LOCALES, TABLE };
