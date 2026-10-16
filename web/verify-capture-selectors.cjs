// 兩個語系都解析一遍並斷言。不需要瀏覽器、不需要 DB、不需要後端。
// 跑法：node web/verify-capture-selectors.cjs（exit 0 = 通過）
//
// ★ 這支刻意**不叫** *.test.cjs：web/vite.config.ts 的 test 區塊沒有覆寫 include，
//   vitest 用預設樣式會把它撿走、算進前端全量。
const assert = require("assert");
const { makeSelectors, SELECTOR_LOCALES, TABLE } = require("./capture-selectors.cjs");

const names = Object.keys(TABLE);
const byLocale = {};
for (const loc of SELECTOR_LOCALES) byLocale[loc] = makeSelectors(loc);

// ① 每個語意名在每個語系都解析出**非空**字串（makeSelectors 已經保證，這裡是回歸鎖）
for (const loc of SELECTOR_LOCALES) {
  for (const n of names) {
    assert.ok(typeof byLocale[loc][n] === "string" && byLocale[loc][n].length > 0,
      `${loc} / ${n} 解析失敗`);
  }
}

// ② 不支援的語系要**丟**，不是靜默退回
assert.throws(() => makeSelectors("ja"), /不支援的語系/);
assert.throws(() => makeSelectors("zh-cn"), /不支援的語系/);
assert.throws(() => makeSelectors(undefined), /不支援的語系/);

// ③ 被拍的那張卡片若只有 1 位審查者，en 的 needle 會對不上（複數形）。
//    這一條把它寫成斷言，而不是留給人記得。
assert.strictEqual(byLocale["en"].cardReviewerCount, "reviewers");
assert.strictEqual(byLocale["zh-TW"].cardReviewerCount, "審查者");
//    en 的單數形剝完是 "reviewer"，**不含** needle ⇒ 資料必須釘住人數 >= 2
assert.ok(!byLocale["en"].cardReviewerCount.includes("{{"));

// ④ team / project 的 worklog 必須是**兩個不同的語意名**（同值不同 key，見 spec §5.3）
assert.ok(byLocale["zh-TW"].teamTabWorklog === byLocale["zh-TW"].projectTabWorklog,
  "兩者今天同值——這個斷言是為了在它們**分岔時**提醒你去確認 L184 用的是 team 的");

// ⑤ 連線橫幅的 needle 必須與語系一致（它藏的是 en 的那句話）
assert.strictEqual(byLocale["en"].connectionRestored, "Live connection restored. Your data is up to date.");
assert.strictEqual(byLocale["zh-TW"].connectionRestored, "即時連線已恢復，最新資料已自動同步！");

console.log(`OK：${names.length} 個語意名 × ${SELECTOR_LOCALES.length} 個語系全部解析成功`);
