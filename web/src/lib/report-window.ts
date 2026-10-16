/**
 * 報表窗框（時間範圍）的共用語意——團隊報表與專案報表走同一份。
 *
 * 三個模式對應 `<select>` 的三種 option value：`"all"`（全期）、年份（`String(year)`）、
 * `"custom"`（自訂區間）。**option 的 value 一律是哨兵值或數字，永遠不是譯文**——拿譯文
 * 當 value 的話，切一次語系選中值就對不到任何選項，原生 `<select>` **靜默變空白**
 * （`GanttTab` 的「未指派」踩過同一類；AGENTS.md 的 i18n 節）。同理，`Number(value)`
 * 這種寫法要留 `"custom"` 的分支，否則 `Number("custom")` 是 `NaN` ⇒ 一樣空白。
 *
 * ★ **上界排他，而 UI 的結束日含當日。** wire 窗是 `[from, to)`（`ReportWindow.cs` 的檔頭；
 * 守門員 `TeamReportTests.WindowBoundary_IsExclusiveAtTo`：恰在 `from` 交付**算**、恰在 `to`
 * 交付**不算**）。所以 UI 的「到 6/30」要送**隔天**的午夜——漏掉這一步會讓 6/30 整天消失，
 * 而起始日行為正常，不對稱的少一天讀起來像資料有問題。守門員是本模組的
 * 「年 ≡ 等效區間」不變量：`windowParams({kind:"year",year:Y})` 與
 * `windowParams({kind:"range",from:"Y-01-01",to:"Y-12-31"})` **必須逐位元相同**。
 *
 * 時間一律以**本地日**（`yyyy-MM-dd`，`<input type="date">` 的值）表達，送出去才轉 UTC ISO。
 * 本地日 → ISO 走「本地午夜再 `toISOString()`」；**不要**用 `new Date("2026-03-01")`——那被
 * 解讀成 UTC 午夜，UTC 以西的時區會退到前一天（`format.ts` 的 `parseIsoDay` 就是為此存在）。
 *
 * 已知且刻意接受（與年份模式同一個性質，非本模組新增）：`new Date(y, m-1, d)` 若落在日光
 * 節約的春季跳躍日，某些時區會得到當地 01:00，`toISOString()` 因此與其他日子差一小時。
 * 它不改變「哪一天」的判定，而修掉它要引入真正的時區曆法依賴。
 */

export type ReportWindowValue =
  | { kind: "all" }
  | { kind: "year"; year: number }
  | { kind: "range"; from: string; to: string };

/** `<select>` 的兩個非年份 option value。哨兵，不是文案。 */
export const WINDOW_ALL = "all";
export const WINDOW_CUSTOM = "custom";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function toDayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * `"2026-06-30"` → 本地時區的 `Date`。
 *
 * **壞值當場拋（fail closed）**，不退回「今天」也不退回「全期」——靜默退回是這個 repo
 * 反覆記錄的失敗模式：使用者以為在看某個期間，其實看的是另一個，而畫面上沒有任何異狀。
 * 空字串是使用者打字途中的正常狀態，**由呼叫端擋掉**（`withFrom`／`withTo`），不是這裡。
 */
export function parseDay(day: string): Date {
  if (!DAY.test(day)) throw new Error(`不是 yyyy-MM-dd 形狀的日期：${day}`);
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  // 來回檢查：`new Date(2026, 1, 31)` 會被正規化成 3/3，那不是使用者選的日子。
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d)
    throw new Error(`不是真實存在的日期：${day}`);
  return date;
}

/** 本地日 → 該**本地**日午夜的 UTC ISO 字串。 */
export function dayToIso(day: string): string {
  return parseDay(day).toISOString();
}

/** `"2026-06-30"` → `"2026-07-01"`（`Date` 會正規化跨月／跨年）。 */
export function nextDay(day: string): string {
  const d = parseDay(day);
  return toDayString(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
}

/**
 * 窗框的 query string 片段（`from=…&to=…`），**刻意不含前導的 `?`／`&`**。
 *
 * 報表與 CSV 是路徑後的第一個參數，而團隊的 xls 那顆自己已經帶著 `?locale=`（要接 `&`）
 * ——把分隔符留給各呼叫端，就不會在那裡生出第二個 `?`（`TeamReportTab` 的既有行為，
 * `TeamReportTab.test.tsx` 逐字斷言那個 URL）。
 *
 * 全期＝**空字串**：兩個界線都不送，後端把「兩個都 null」讀成全期。
 */
export function windowParams(v: ReportWindowValue): string {
  switch (v.kind) {
    case "all":
      return "";
    case "year":
      return `from=${encodeURIComponent(new Date(v.year, 0, 1).toISOString())}` +
        `&to=${encodeURIComponent(new Date(v.year + 1, 0, 1).toISOString())}`;
    case "range":
      // `to` 送**隔天**：上界排他，UI 的結束日含當日（見檔頭）。
      return `from=${encodeURIComponent(dayToIso(v.from))}` +
        `&to=${encodeURIComponent(dayToIso(nextDay(v.to)))}`;
  }
}

/** 帶前導 `?` 的版本；全期＝空字串。 */
export function windowQuery(v: ReportWindowValue): string {
  const params = windowParams(v);
  return params ? `?${params}` : "";
}

/**
 * 窗框在 query key 的第三格。**它必須進 key**：少了它，切換期間只會拿到前一格的快取，
 * 而畫面只會「數字不變」——沒有任何紅燈。
 *
 * react-query 5 的失效比對是**前綴比對**（`partialMatchKey`），既有的 2 元素失效
 * （`["report", projectId]`）仍然命中這個 3 元素 key。
 */
export function windowKey(v: ReportWindowValue): string {
  return windowParams(v);
}

/**
 * 匯出檔名裡的期間後綴：`""`（全期）／`-2026`／`-20260301-20260630`。
 *
 * 檔名由**前端**決定：`a.download` 會覆蓋伺服器的 `Content-Disposition`。
 * 年份取**使用者選的本地值**（不是由窗框的 UTC 界線推導）——UTC 以東的使用者選 2026 時，
 * 後端從窗框左界看到的會是 2025。全期不帶後綴，與後端 `YearSuffix` 的空字串規則同一個語意。
 */
export function windowSuffix(v: ReportWindowValue): string {
  switch (v.kind) {
    case "all":
      return "";
    case "year":
      return `-${v.year}`;
    case "range":
      return `-${v.from.replace(/-/g, "")}-${v.to.replace(/-/g, "")}`;
  }
}

/** 自訂模式的**播種值**：選了「自訂」時先給一個完整的那一年，使用者再改兩個欄位。 */
export function rangeOfYear(year: number): ReportWindowValue {
  return { kind: "range", from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * 期間的文字（考評表的「考核期間」、報表的期間欄）。
 *
 * **不進 `useMemo`**：那會把當下語系凍結住——切換語系之後那格還是舊的，而 zh-TW 的斷言、
 * `tsc -b`、parity 全都不會紅（AGENTS.md 的凍結類陷阱）。呼叫端在 render 裡呼叫它。
 *
 * 格式化由呼叫端傳進來的 `range` 回呼負責：`format.ts` 是全站唯一的格式化出口（R11），
 * 這個模組是純函式、不碰 `Intl`。
 */
export function reportWindowLabel(
  v: ReportWindowValue,
  labels: { all: string; range: (from: string, to: string) => string },
): string {
  switch (v.kind) {
    case "all":
      return labels.all;
    // 年份是**識別碼**不是數量：不經 `format.ts`，加了千分位會變成「2,026」。
    case "year":
      return String(v.year);
    case "range":
      return labels.range(v.from, v.to);
  }
}

/**
 * 改起始日。`""`（打字途中的暫時值）**忽略**——`parseDay("")` 會拋，而它會在 render 或
 * 事件處理裡當場把畫面炸掉。
 *
 * 越過結束日時**把結束日一起帶走**，使用者看到另一個欄位跟著動；**不能**改成「讓後端 400」
 * ——夾住是唯一對兩頁都成立的規則（團隊路由的 400 是 2026-09-22 才補上的，而夾住本來就
 * 讓那個請求送不出去）。UI 因此**永遠送不出顛倒的窗框**。
 */
export function withFrom(v: ReportWindowValue, from: string): ReportWindowValue {
  if (!from) return v;
  parseDay(from);
  const to = v.kind === "range" && v.to >= from ? v.to : from;
  return { kind: "range", from, to };
}

/** 改結束日，規則同 `withFrom`（越過起始日時把起始日一起帶走）。 */
export function withTo(v: ReportWindowValue, to: string): ReportWindowValue {
  if (!to) return v;
  parseDay(to);
  const from = v.kind === "range" && v.from <= to ? v.from : to;
  return { kind: "range", from, to };
}

/**
 * 年份下拉的選項＝`availableYears` 的**本地年候選** ∪ {今年} ∪ {選定的年份}，由大到小。
 *
 * 三個來源各自擋掉一種**沒有紅燈**的失敗（理由一字不改地搬自 `TeamReportTab`）：
 *   * **今年必須由前端併入**（設計 §6.2）：後端不得讀時鐘判定年份（D3），所以它的
 *     `availableYears` 不含今年。
 *   * **選定的年份必須永遠在選項裡**：沒有對應 option 時 `<select>` **靜默顯示成空白**
 *     （`value` 對不到任何選項）。取數失敗時 `availableYears` 是空的——少了併入選定年
 *     這一步，那個唯一能救回畫面的下拉會在**失敗當下**變成空白。
 *   * **`availableYears` 是 UTC 曆年，而這裡的標籤與窗框都是本地年**（後端對
 *     `CreatedAt`／`CompletedAt` 取 `.Year`）。UTC 以東（本機就是 UTC+8）時兩者會差一年：
 *     台北 2026-01-01 02:00 交付 ＝ 2025-12-31T18:00Z ⇒ 那一年的標籤是 2025，但它落在
 *     使用者的 **2026** 窗裡。少了候選這一步，真正含資料的 2026 選不到、而標著 2025 的
 *     那一年開起來是空的——**數字永遠沒錯，導覽錯了**。
 *     （後端那兩處仍是 UTC 年：年份抽取與匯出檔名的後綴，殘餘見 `docs/STATE.md`。）
 *
 * 時鐘讀取留在函式內（不是參數）：既有的 `getTimezoneOffset` spy 測試因此不必改。
 */
export function yearOptions(v: ReportWindowValue, availableYears?: number[]): number[] {
  const offsetMin = new Date().getTimezoneOffset();   // UTC+8 ⇒ -480
  const localYearCandidates = (y: number) =>
    offsetMin < 0 ? [y, y + 1] : offsetMin > 0 ? [y - 1, y] : [y];

  return Array.from(
    new Set([
      new Date().getFullYear(),
      ...(v.kind === "year" ? [v.year] : []),
      ...(availableYears ?? []).flatMap(localYearCandidates),
    ]),
  ).sort((a, b) => b - a);
}
