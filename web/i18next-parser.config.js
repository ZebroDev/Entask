// i18next-parser：從程式碼抽出 t() 的 key，寫進 locales/ 下的 JSON。
//
// CI 以 `i18next-parser --fail-on-update` 執行——locale 檔與程式碼不一致就非零退出。
// 這比「zh-TW 與 en 的 key 集合相等」有用：後者在只有一個語系時是空轉，
// 不會有任何失敗的可能（見 P-B1 設計文件 §6.3）。
export default {
  locales: ["zh-TW", "zh-CN", "es-419", "ja", "ko"],
  // 排除三類：測試檔（斷言譯文，不是定義文案）、測試基建、以及 i18n 基礎建設本身。
  //
  // 但真正需要提防的不是「測試裡有 t()」，而是這個實測到的行為：
  // **這個 lexer 會把「註解裡」的 t("...") 當成真的呼叫**。單行、區塊、JSDoc 註解
  // 都一樣；單引號、雙引號、反引號都一樣（t(x) 沒有引號則不會）。
  //
  // 後果：在掃描範圍內的檔案裡，只要有人用註解舉例寫出 t("board:foo")，
  // locale 檔就會多出一個幽靈 key，而 --fail-on-update 會紅在一個看起來毫無關聯的地方。
  //
  // 這個陷阱自 P-B1 就存在且一直沒被發現——因為當時唯一一處註解寫的是 t("nav.logout")，
  // 而那個 key 真的存在，於是幽靈與本尊無法區分。P-B2 的註解寫到一個不存在的 key 時才現形。
  //
  // 兩道處置：排除 i18n 基礎建設（它不該定義文案），並且**在掃描範圍內的檔案裡
  // 提到呼叫時一律不要加引號**（寫 t(board:foo) 而不是 t("board:foo")）。
  //
  // **補完（B2-3，2026-09-14）：不加引號只是半條規則。** 註解裡的呼叫只要引數是
  // 變數而不是字面值，lexer 就改印 `Key is not a string literal` 警告——不產生 key、
  // 不影響 `--fail-on-update`，但會讓下一個讀者以為「這個檔案的 key 沒被抽到」。
  // 實測：`custom-fields.ts`（B2-2b）與 `label-palette.ts`（B2-3）各中一次，兩處都是
  // 解釋「為什麼要寫成 switch」的註解。**完整規則是：掃描範圍內的註解不要寫出呼叫的形狀**
  // （連括號都不要），要用文字描述。修正後警告數歸零。
  //
  // **第三個陷阱（B2-4，2026-09-14）：`<Trans>` 的 `ns` prop 會被 `useTranslation` 蓋掉。**
  //
  // 機制（讀 `node_modules/i18next-parser/dist/lexers/` 的原始碼）：
  // jsx lexer 確實有讀 `ns` 並寫進 `entry.namespace`，但 javascript lexer 的
  // `setNamespaces` 之後會用
  //   `entry.ns ?? translationFunctionsWithArgs[functionName]?.ns ?? defaultNamespace`
  // **覆寫**它（解析不出值時才原樣保留）。而 `useTranslation(["a","b"])` 正是把
  // **`a`** 寫進後兩者。所以 `ns` 寫了不保證算數，**決定權在 `useTranslation` 的第一個元素**。
  // 一個檔案裡有多個 `useTranslation` 時，以最後寫入者為準——那種情況不要靠推論，
  // 直接跑 `npx i18next-parser --fail-on-update` 看它把 key 放去哪。
  //
  // 實測（2026-09-14）：`useTranslation(["common","card"])` ＋
  // `<Trans ns="card" i18nKey="create.hint">` → key 被寫進 `common.json`（值為空），
  // `card.json` 的那條同時被 `keepRemoved: false` 刪掉。執行期（react-i18next）
  // **是**看 `ns` 的，於是讀不到 key，**畫面直接印出 key 本身**。
  // zh-TW 的測試、`tsc`、parity 全都不會紅——唯一的守門員就是下面這支
  // `--fail-on-update`（CI 有跑），但它的訊息只會指向語系檔，不會指向肇因。
  //
  // **寫 `<Trans>` 的檔案：把該 `<Trans>` 的 namespace 排在 `useTranslation` 陣列第一個，
  // 而且該檔只留一個 `useTranslation` 呼叫。**
  //
  // **不要改成帶前綴的 `i18nKey="card:x.y"` 來繞開**：實測那個形狀不受型別檢查
  // （寫不存在的 key，`tsc -b` 照樣 exit 0），等於拿這個 key 的型別保護換安定。
  //
  // 全庫目前只有一處 `<Trans>`（`QuickCreateCardModal`），已按此調整。
  input: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}", "!src/test/**", "!src/i18n/**"],
  output: "src/i18n/locales/$LOCALE/$NAMESPACE.json",

  // 與 web/src/i18n/index.ts 的 init 選項一致——兩邊不一致會讓抽取出的 key 與
  // runtime 解析出的 key 不同，而且是靜默的。
  defaultNamespace: "common",
  keySeparator: ".",
  namespaceSeparator: ":",
  // 複數（key_one / key_other）與 context 用同一個分隔字元，屆時兩者不可同時使用。
  // 中文無複數、英文有——P-B2 抽計數句時要留意（評估 §4 的約束）。
  pluralSeparator: "_",
  contextSeparator: "_",

  // key 排序固定，避免抽取順序造成無意義的 diff
  sort: true,
  // 不再使用的 key 直接移除，否則 --fail-on-update 抓不到「有 key 沒人用」
  keepRemoved: false,
  createOldCatalogs: false,
  verbose: false,
};
