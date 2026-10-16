import { afterEach, describe, expect, it } from "vitest";
import i18n, { setLocale } from "@/i18n";
import { DEFAULT_LOCALE, PSEUDO_LOCALE, SUPPORTED_LOCALES } from "@/i18n/locales";
import { LOCALE_STORAGE_KEY } from "@/lib/storage-keys";
import { resources } from "@/i18n/resources";
import { errorMessage, serverMessage } from "@/lib/error-messages";

describe("初始化", () => {
  it("測試環境（locale-pin 釘住）的語系是 zh-TW（R3：這是 2,344 行中文斷言不必改的前提）", () => {
    expect(i18n.resolvedLanguage).toBe("zh-TW");
  });

  // 產品預設語系（2026-10-07 公開版英文優先，由 zh-TW 改來；fallbackLng 也指向它）。
  // **這一支是全檔唯一盯著 DEFAULT_LOCALE 值的斷言**——其他支都跟著常數走，把值改回去
  // 不會變紅；而測試語系由 locale-pin 釘住，也與它無關。
  it("產品預設語系是 en（公開版英文優先）", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("document.documentElement.lang 同步為目前語系", () => {
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("zh-TW bundle 的內容就是既有的中文字面值", () => {
    expect(i18n.getResource("zh-TW", "common", "nav.logout")).toBe("登出");
    expect(i18n.getResource("zh-TW", "common", "nav.myTasks")).toBe("個人工作台");
  });

  // 這支必須走 t() 而不是 getResource()：getResource 要明講 namespace，所以它在
  // defaultNS 設錯時照樣會過。走 t() 才會踩到 defaultNS，而 defaultNS 一旦與
  // i18next-parser.config.js 的 defaultNamespace 不一致，每個 t() 都會靜默回傳
  // key 本身（畫面顯示 "nav.logout"），不拋錯也不警告。
  it("t() 走預設 namespace，回的是譯文而不是 key", () => {
    expect(i18n.t("nav.logout")).toBe("登出");
    expect(i18n.t("nav.myTasks")).toBe("個人工作台");
  });

  // P-B2 起，程式碼裡的 key 一律寫成 `<namespace>:<area>.<thing>`（設計 §4.1），
  // 連預設 namespace 也不例外——`common:error.load` 而不是 `error.load`。
  //
  // 這條約定押在三個地方，而**只有一個會被 type 檢查看到**：
  //   1. i18next 的 `nsSeparator`——**`init()` 並沒有顯式設定它**，用的是內建預設 `:`。
  //      這支測試釘的是行為，不是選項；不要為了讓這行敘述對上而在 init() 補一個選項。
  //   2. `i18next-parser.config.js` 的 `namespaceSeparator`（**不同名字**，同一個概念）
  //   3. 呼叫端的 `useTranslation([...])` namespace 陣列——這個才是 tsc 看得到的
  // 所以改壞 1 或 2 的話 `tsc -b` 照樣全綠，而畫面上每一個 t() 都會開始顯示
  // "common:error.load" 這串字。與上面那條 defaultNS 是同一類缺口，同樣用測試釘住。
  // （實測：把 nsSeparator 改成別的字串，這支會單獨變紅並直說原因。）
  it("t() 認得帶 namespace 前綴的 key（nsSeparator 的契約）", () => {
    expect(i18n.t("common:nav.logout")).toBe("登出");
    expect(i18n.t("common:error.load")).toBe("載入失敗");
  });
});

describe("儲存契約：R6 的兩個狀態（2026-09-13 裁定）", () => {
  it("setLocale(字串) 寫入鍵＝明確指定", async () => {
    await setLocale(PSEUDO_LOCALE);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(PSEUDO_LOCALE);
  });

  it("setLocale(null) 刪除鍵＝跟隨瀏覽器", async () => {
    await setLocale(PSEUDO_LOCALE);
    await setLocale(null);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it("改回跟隨瀏覽器時不得留下 'null' 字串", async () => {
    await setLocale(PSEUDO_LOCALE);
    await setLocale(null);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).not.toBe("null");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).not.toBe("undefined");
  });

  it("切換語系後 document.documentElement.lang 跟著改", async () => {
    await setLocale(PSEUDO_LOCALE);
    expect(document.documentElement.lang).toBe(PSEUDO_LOCALE);
  });

  it("setLocale(null) 之後回到 zh-TW（瀏覽器候選由 locale-pin 釘成 zh-TW）", async () => {
    await setLocale(PSEUDO_LOCALE);
    await setLocale(null);
    expect(i18n.resolvedLanguage).toBe("zh-TW");
  });
});

describe("偽語系只在 dev 存在，且內容是偽中文而非英文", () => {
  it("資源存在且在 dev 可取得", () => {
    expect(i18n.getResource(PSEUDO_LOCALE, "common", "nav.logout")).toBeTruthy();
  });

  it("內容由 zh-TW 變換而來——是 [!! 登出 !!] 而不是 Log out", () => {
    expect(i18n.getResource(PSEUDO_LOCALE, "common", "nav.logout")).toContain("登出");
    expect(i18n.getResource(PSEUDO_LOCALE, "common", "nav.logout")).toContain("[!! ");
  });

  it("偽語系下 t() 也走同一個預設 namespace", async () => {
    await i18n.changeLanguage(PSEUDO_LOCALE);
    expect(i18n.t("nav.logout")).toContain("登出");
    expect(i18n.t("nav.logout")).toContain("[!! ");
  });

  // 偽語系的鍵繼承自 zh-TW（只有 `_other`），但它的語言標籤是 `en-XA`，
  // `select(1)` 是 `one`——i18next 找不到 `_one` 時退回 fallback 語系（實測當時是
  // zh-TW、顯示真中文；2026-10-07 起 fallback 改 en），於是畫面出現**沒有 `[!! !!]`
  // 包住的未變換譯文**。那正是「漏抽字串」的長相，
  // 而 §12 的偽語系掃頁是 B2-7 的頭號驗收——這個假陽性會讓它追錯方向。
  it("偽語系的計數句在 count=1 時也帶著 [!! !!]，不是退回 zh-TW 的真中文", async () => {
    await i18n.changeLanguage(PSEUDO_LOCALE);
    const rendered = i18n.t("me:tab.inProgress", { count: 1 });
    expect(rendered).toContain("[!! ");
    expect(rendered).toContain("進行中");
  });

  it("偽語系不是預設、也不會被當成 fallback 語系", () => {
    // i18next 會把 fallbackLng 正規化成陣列
    expect(i18n.options.fallbackLng).toEqual([DEFAULT_LOCALE]);
    expect(i18n.resolvedLanguage).not.toBe(PSEUDO_LOCALE);
  });
});

describe("複數：目標語系必須自己補齊類別（2026-09-14，B2-2b 的 HIGH）", () => {
  // 這條缺口在 zh-TW 上永遠看不到（它只有 `other` 一個類別），391 條把
  // `navigator.languages` 釘在 zh-TW 的斷言也全數看不到。實測到的症狀是
  // **英文使用者在數量恰好為 1 時看到中文**：i18next 用 `Intl.PluralRules(lng)`
  // 選尾綴，選不到 `_one` 時**不會退回自己的 `_other`**，而是往下一個 fallback
  // 語系找（實測當時是 zh-TW，於是拿到中文的 `_other`；2026-10-07 起 fallback 改
  // en——同型破壞會顯示英文。這一組的判別力不變：它比對的是該語系自己的值）。
  //
  // 這支測試以 `en` 執行——它是整個檔案裡唯一不以 zh-TW 跑的一組斷言。
  // 斷言比對的是**該語系自己的值**而不是「不含中文」：後者太弱，缺 key 時
  // i18next 回傳的是裸鍵（`me:tab.inProgress`），它同樣不含中文。
  const pluralSuffix = /_(zero|one|two|few|many|other)$/;

  /** 走訪語系檔，收集「基底鍵 → 該族的所有類別值」。 */
  function collectFamilies(node: unknown, ns: string, path: string[] = [], out: Family[] = []): Family[] {
    if (node === null || typeof node !== "object") return out;
    for (const [key, value] of Object.entries(node)) {
      const suffix = key.match(pluralSuffix);
      if (value !== null && typeof value === "object") {
        collectFamilies(value, ns, [...path, key], out);
      } else if (suffix) {
        const base = key.slice(0, -suffix[0].length);
        const full = `${ns}:${[...path, base].join(".")}`;
        let family = out.find((f) => f.key === full);
        if (!family) {
          family = { key: full, values: new Map() };
          out.push(family);
        }
        if (typeof value === "string") family.values.set(suffix[1], value);
      }
    }
    return out;
  }

  type Family = { key: string; values: Map<string, string> };

  // 走 `resources` 而不是逐一 import 語系檔：逐一 import 會在**新增語系**或**新增 namespace**
  // 時靜默漏掉它。B2-3 就是這樣漏掉 `board:presence.online` 的（負向實測：刪掉它的 `_one`
  // 照樣全綠）。`resources` 是執行期真正的組裝點，用同一個來源就沒有第二份清單要維護。
  const familiesByLocale = Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [
      locale,
      Object.entries(resources[locale] as Record<string, unknown>).flatMap(([ns, tree]) =>
        collectFamilies(tree, ns),
      ),
    ]),
  );

  /**
   * 各語系的代表數量：**由 `Intl.PluralRules` 決定，不是我挑的**——但候選集必須涵蓋到 10⁶，
   * 因為 `es-419` 的 `many` 只在 10⁶ 以上選得到（10⁶−1 仍是 `other`，實測）。
   * 現行版本只掃到 200，直接一般化會在 L2 紅在「找不到能選中各類別的代表數量」。
   *
   * 按語系算**一次**（不是每個複數族算一次）：`es-419` 的代表搜尋會走到 10⁶ 那一格，
   * 寫在 `it.each` 裡的話是 39 族 × 10⁶ 次 `select()`。
   */
  const CANDIDATES = [
    ...Array.from({ length: 21 }, (_, n) => n),
    ...[1, 2, 3, 4, 5, 6].flatMap((e) => [10 ** e, 10 ** e + 1]),
  ];
  const representativesByLocale = Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => {
      const rules = new Intl.PluralRules(locale);
      const required = rules.resolvedOptions().pluralCategories;
      const found = new Map<string, number>();
      for (const n of CANDIDATES) {
        const category = rules.select(n);
        if (!found.has(category)) found.set(category, n);
      }
      return [locale, { rules, required, found }];
    }),
  );

  it("每一個語系都至少有一個複數鍵——否則那一格是空轉", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(familiesByLocale[locale].length, locale).toBeGreaterThan(0);
    }
  });

  it("每一個語系的複數類別都找得到代表數量（涵蓋到 10⁶）", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const { required, found } = representativesByLocale[locale];
      expect(found.size, `${locale} 找不到能選中各類別的代表數量`).toBe(required.length);
    }
  });

  // 走訪語系檔得到的 key 不是字面值，型別化的 t 認不得——那正是這支測試要看的東西
  // （「檔案裡有什麼」而不是「我記得有什麼」）。型別化的 key 由 tsc 在產品程式碼裡守。
  const translate = i18n.t.bind(i18n) as (key: string, options: { count: number }) => string;

  const cases = SUPPORTED_LOCALES.flatMap((locale) =>
    familiesByLocale[locale].map((f) => [locale, f.key, f] as const),
  );

  it.each(cases)(
    "[%s] %s 具備該語系需要的每一個複數類別，且各自解析到它自己的值",
    async (locale: string, key: string, family: Family) => {
      await setLocale(locale);
      const { required, found } = representativesByLocale[locale];
      expect([...family.values.keys()].sort(), `${locale} ${key} 的類別`).toEqual([...required].sort());

      for (const [category, n] of found) {
        const template = family.values.get(category) as string;
        const expected = template.replace("{{count}}", String(n));
        expect(translate(key, { count: n }), `${locale} ${key}（${category}, count=${n}）`).toBe(expected);
      }
    },
  );
});

// 活動牆的標籤是**接在人名之後的謂語**，不是一句獨立的話——`CardActivityTab` 把它渲染成
// 緊鄰人名的一個 span，讀起來是 `Alice archived the card`。所以該語系的每一條都必須小寫開頭。
//
// **`CardDialog.test.tsx` 有一支以 en 執行的斷言釘住渲染路徑，但那一支只走得到
// `activityType.create`**（fixture 裡只有一筆 `type: "create"` 的活動）——把其餘任一條
// 改回大寫，它照樣全綠（負向實測）。這一支補的就是那其餘的：它不看渲染，
// 只看語系檔裡的值，所以該語系的每一條全在射程內。
//
// 「每一條」不寫死數字是 2026-09-20 的更正：這裡原本寫「28 條／其餘 27 條」，
// 而 Task 15 量到 `card.activityType` 是 **29** 條（en 與 es-419 同數）——
// 計數會隨活動型別增減，寫死的數字只會在下一次新增型別時默默變成錯的。
// 要精確值就自己數：`node -e` 讀 `locales/<locale>/card.json` 的 `activityType`。
//
// 判準刻意寫成「以小寫 ASCII 字母開頭」而不是「不是大寫開頭」：這一族的語意就是謂語，
// 任何不以小寫字母開頭的形狀都是缺陷（包括打錯的 `_archived`）。
//
// **`CASE_LOCALES` 是逐一列出來的，不是推導的**——「這個語系有沒有大小寫」推導不出來，
// 而「逐一列」讓下一個人看到時知道要判斷什麼（與 B2-6b 的 `UNIT_PLURAL` 白名單同一個手法：
// 逐一列 key，不是關掉檢查）。**新增語系時要自己判斷並補上。**
//
// **`es-419` 於 Task 15（接線）補上**——在那之前 `resources["es-419"]` 是 `undefined`，
// 下面那行 `Object.entries(...)` 會當場爆掉，所以它刻意晚到這一步才進來。
const CASE_LOCALES = ["en", "es-419"];

describe("拉丁語系的活動型別標籤是小寫謂語", () => {
  type Tree = Record<string, Record<string, Record<string, string>>>;
  const cases = CASE_LOCALES.flatMap((locale) =>
    Object.entries((resources[locale] as unknown as Tree).card.activityType).map(
      ([key, value]) => [locale, key, value] as const,
    ),
  );

  it("至少有一條——否則這支測試是空轉", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("[%s] card:activityType.%s 以小寫字母開頭", (_locale, _key, value) => {
    expect(value).toMatch(/^[a-z]/);
  });
});

// 放在這個檔而不是新開 `error-messages.test.ts`：這一條驗的是「`error` namespace 的
// 譯文在 en 下拿得到、而且不是 Identity 的英文原文」，與上面那組同一類——
// **以 en 執行的斷言**，是這一類缺口唯一的守門員（zh-TW 的斷言只證明中文對了）。
describe("認證錯誤以 en 呈現（設計 §2.4 的缺陷一）", () => {
  afterEach(async () => {
    await setLocale(null);
  });

  // **這一類在 zh-TW 下的守門員是零**：zh-TW 的斷言只證明「中文對了」，
  // 擋不住「Identity 的英文原文被原樣顯示」——在中文畫面上它一眼可見是壞的，
  // 在英文畫面上則似是而非（更難察覺）；兩種都沒有斷言看著它。要驗的是
  // 「顯示的是我們的譯文，不是 Identity 的 Description」。
  it("PasswordTooShort 顯示 en 的譯文，不是 Identity 的英文原文", async () => {
    await setLocale("en");
    expect(errorMessage("identity.passwordTooShort")).toBe("Password is too short");
  });

  // 上一條只證明「查表查得到」。真正的契約是**取用順序**：伺服器把 Identity 的英文原文
  // 放在 `message`（除錯欄位）裡，畫面必須拿到 code 的譯文而不是那串英文——把順序調成
  // 「先讀 message」的實作，上一條照樣綠，這一條會紅。
  it("body 的 message 帶著 Identity 英文時，畫面拿到的仍是譯文", async () => {
    await setLocale("en");
    expect(
      serverMessage({
        code: "identity.passwordTooShort",
        message: "Passwords must be at least 8 characters.",
      }),
    ).toBe("Password is too short");
  });

  it("zh-TW 下同一條 code 是中文", async () => {
    expect(errorMessage("identity.passwordTooShort")).toBe("密碼長度不足");
  });
});

// en 的引號慣例是**彎引號** `“ ”`。這是一個**決定**，不是修正：全庫實測彎 14 : 直 12，
// 它沒有多數（2026-09-16，見設計文件 §4.2）。選彎引號是因為通知內文那類散文句是它的主要用例。
//
// 為何以 `en` 為範圍而不是全部語系：引號是**語系相關**的排版決定——`zh-TW` 用「」、
// `ja` 用「」、`ko` 用「」、`es-419` 用「」。把 en 的慣例套到其他語系上是錯的。
// 這一支釘的是「en 自己內部一致」，而那正是複閱抓到的缺陷（同一個 product 兩套排版）。
describe("en 的引號是彎引號", () => {
  const flat = (node: unknown, prefix = "", out: [string, string][] = []): [string, string][] => {
    if (node === null || typeof node !== "object") return out;
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object") flat(v, path, out);
      else if (typeof v === "string") out.push([path, v]);
    }
    return out;
  };
  const values = Object.entries(resources.en as Record<string, unknown>).flatMap(([ns, tree]) =>
    flat(tree).map(([k, v]) => [`${ns}:${k}`, v] as [string, string]),
  );

  it("至少有一條——否則這支測試是空轉", () => {
    expect(values.length).toBeGreaterThan(900);
  });

  it.each(values)("%s 不含 ASCII 直引號", (_key, value) => {
    expect(value).not.toContain('"');
  });
});
