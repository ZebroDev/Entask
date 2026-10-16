// `check-error-paths.mjs` 的測試（2026-09-19）。
//
// **為什麼要有這一支**——它存在的三個理由，也就是它要抓的三個突變：
//
//   1. **走 sink 的捷徑**（第 2 群④）。規則 A 的**唯一**難處是「`.message` 不一定出現在
//      `toast` 的引數裡」——`const loadErrorDetail = error instanceof Error ? error.message : …`
//      那一行**沒有任何 sink**，一個寫成「找 `toast.error(…)` 再看引數」的閘門看不到它。
//      那一支測試就是為了讓「走 sink 的捷徑」當場變紅。
//   2. **寫成不存在的節點種類**（第 2 群②）。`ts.SyntaxKind.PropertyAccessChain` 在
//      typescript 6 是 `undefined`（實測）——照 5.0 以前的寫法寫的規則**什麼都match不到、
//      而且是靜默綠的**。選填鏈 `err?.response?.data?.message` 那一支專門釘住它。
//   3. **拿掉 bail**（第 5 群①）。`ts.createSourceFile` 不拋錯；把 `parseDiagnostics` 那道
//      bail 刪掉之後，語法錯誤的檔案**照樣數得到錯誤點之前的節點**——掃不到的檔案看起來
//      像沒問題。第 5 群同時斷言「有反應」與「反應來自哪一條」。
//
// **做法**：在系統暫存目錄造一個沙箱 `web/`，把閘門本體複製進去，放自己的 `src/`，
// `node_modules` 用 junction 連回本 repo。閘門的 root 由 `import.meta.url` 推導，所以沙箱副本
// 只看得到**沙箱的** `src/`——版控裡的檔案一個都沒碰。閘門以 spawn 跑子行程：CWD 顯式給
// `os.tmpdir()`（與沙箱、與 repo 都無關，證明它不吃 CWD）、不連網。
//
// 沙箱的 `web/node_modules` 是必要的：閘門有一行靜態 `import ts from "typescript"`，
// 少了它子行程會在模組載入階段就 `ERR_MODULE_NOT_FOUND`——那會讓「exit 1」來自錯的理由。
// 第 1 群的正向對照就是為了擋這種事。
//
// **斷言只認標頭與具名的 `file:line`，不認數字**：任何寫死的計數都會跟著掃描碼腐爛
// （AGENTS.md 的維護規則）。印出來的數字是掃描器自己量到的。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url)); // web/scripts
const webDir = join(scriptsDir, "..");

/** 沙箱：`web/scripts/check-error-paths.mjs` ＋ 空的 `web/src/` ＋ node_modules 連結。 */
const makeSandbox = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "entask-error-paths-gate-"));
  mkdirSync(join(sandbox, "web", "scripts"), { recursive: true });
  mkdirSync(join(sandbox, "web", "src"), { recursive: true });
  copyFileSync(
    join(scriptsDir, "check-error-paths.mjs"),
    join(sandbox, "web", "scripts", "check-error-paths.mjs"),
  );
  symlinkSync(join(webDir, "node_modules"), join(sandbox, "web", "node_modules"), "junction");
  return sandbox;
};

/** 測試失敗時也要刪：先解掉 node_modules 連結再遞迴刪沙箱（實測 rmSync 不會走進連結的目標）。 */
const cleanup = (sandbox) => {
  try {
    unlinkSync(join(sandbox, "web", "node_modules"));
  } catch {
    // 連結已經不在了（或平台不允許 unlink 目錄連結）——rmSync 會收掉它。
  }
  rmSync(sandbox, { recursive: true, force: true });
};

const withSandbox = (run) => {
  const sandbox = makeSandbox();
  try {
    return run(sandbox);
  } finally {
    cleanup(sandbox);
  }
};

/** 寫一個檔進沙箱的 `web/src/`。`rel` 可以帶子目錄，例如 `lib/utils.ts`。 */
const write = (sandbox, rel, lines) => {
  const full = join(sandbox, "web", "src", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
};

/** 跑沙箱裡的閘門本體。回傳 spawnSync 的結果（`status`／`stdout`／`stderr`）。 */
const runGate = (sandbox) =>
  spawnSync(process.execPath, [join(sandbox, "web", "scripts", "check-error-paths.mjs")], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

// 兩條規則的標頭（測試靠它們分辨「紅在哪一條」；閘門的訊息改了這裡要跟著改）。
const RULE_A = "直讀傳輸層字串";
const RULE_B = "巢狀 t()";
const BAIL = "無法完成";
const PASS = "錯誤路徑檢查通過";

/** 一個乾淨的檔：只有 sanctioned 寫法、console 診斷、以及註解／字串裡的 `.message`。 */
const CLEAN = [
  'import { apiErrorMessage } from "@/lib/utils";',
  "export function Clean({ error, t }: any) {",
  '  // 這一行註解提到 error.message，但它不是程式碼',
  '  const note = "error.message 不是節點";',
  "  console.error(\"save failed\", error);",
  "  const detail = apiErrorMessage(error, t(\"common:error.tryLater\"));",
  "  return t(\"common:error.loadDetail\", { detail }) + note;",
  "}",
];

describe("check-error-paths：exit code 的契約", () => {
  // **正向對照，先寫、必須綠**：少了這一步，「exit 1」可能來自任何原因（路徑打錯、node 版本、
  // 複製失敗、模組解析失敗）——整支測試就沒有判別力。
  it("乾淨沙箱 ⇒ exit 0、印出成功訊息（正向對照）", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
      expect(result.stderr).not.toContain(BAIL);
      expect(result.stderr).not.toContain(RULE_A);
      expect(result.stderr).not.toContain(RULE_B);
    });
  });

  it("乾淨沙箱再加一處 family A ⇒ exit 1、指名它、不指名乾淨檔、stdout 不印通過", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Dirty.tsx", [
        "export function Dirty({ error, toast, t }: any) {",
        '  toast.error(error instanceof Error ? error.message : t("common:error.save"));',
        "}",
      ]);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(RULE_A);
      expect(result.stderr).toContain("src/Dirty.tsx:2");
      // 乾淨檔沒有違規，不該被指名——「有紅燈」不等於「紅對了地方」。
      expect(result.stderr).not.toContain("Clean.tsx");
      expect(result.stdout).not.toContain(PASS);
      // 這一支不該驚動規則 B。
      expect(result.stderr).not.toContain(RULE_B);
    });
  });
});

describe("check-error-paths：規則 A 認得的四種形狀", () => {
  // ①③④ 是「`.message` 不一定長在 sink 的引數裡」的三種落點；② 同時釘住 typescript 6 的
  // 選填鏈節點種類（寫成 `PropertyAccessChain` 會靜默綠）；⑤⑥ 是非 `.` 的兩種存取形狀。
  //
  // ④ 是**判別力最強的一支**：那一行**沒有任何 sink**，一個「找 `toast.error(…)` 再看引數」
  // 的閘門對它完全看不到——而它正是本階段真實修掉的形狀（`MyTasksPage.tsx:83`）。
  it.each([
    [
      "① 三元式的 error.message（有 sink）",
      ['toast.error(error instanceof Error ? error.message : t("common:error.save"));'],
    ],
    [
      "② 選填鏈 err?.response?.data?.message（TS 6 的節點種類）",
      ["toast.error(err?.response?.data?.message || t(\"common:error.operation\"));"],
    ],
    [
      "③ 轉型後的 (x.error as Error).message",
      ['const d = (x.error as Error).message;'],
    ],
    [
      "④ 提成陳述式、完全沒有 sink（走 sink 的捷徑看不到它）",
      ['const loadErrorDetail = error instanceof Error ? error.message : t("common:error.tryLater");'],
    ],
    ["⑤ 括號存取 err[\"message\"]", ['const d = err["message"];']],
    ["⑥ 解構 const { message } = err", ["const { message } = err;"]],
  ])("%s ⇒ exit 1、指名該檔", (_name, body) => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Shape.tsx", ["export function Shape(err: unknown, t: any) {", ...body.map((l) => "  " + l), "}"].join("\n").split("\n"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(RULE_A);
      expect(result.stderr).toContain("src/Shape.tsx:2");
      expect(result.stdout).not.toContain(PASS);
    });
  });

  // 反向：陣列解構**不是**屬性讀取，不該被旗標（`ts.isBindingElement` 對它一樣為真，
  // 所以那條 `ObjectBindingPattern` 守衛是必要的）。
  it("陣列解構 const [message] = x ⇒ 綠（ObjectBindingPattern 守衛）", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Array.tsx", ["export function Array(x: any) {", "  const [message] = x;", "  return message;", "}"].join("\n").split("\n"));

      expect(runGate(sandbox).status).toBe(0);
    });
  });
});

describe("check-error-paths：近誤一律綠", () => {
  it.each([
    ["sanctioned 寫法 apiErrorMessage(error, t(…))", ['toast.error(apiErrorMessage(error, t("common:error.save")));']],
    ["console 的引數（開發者診斷）", ["console.error(\"save failed\", e.message);"]],
    ["行註解裡的 .message", ["// console.error(e.message) 是唯一的例外"]],
    ["區塊註解裡的 .message", ["/* const d = e.message; 這整段都不是程式碼 */"]],
    ["字串字面值裡的 .message", ['const s = "toast.error(e.message)";']],
    ["模板文字的**文字**部分（不是代換）", ["const s = `請搜尋 error.message 這個字串`;"]],
    ["提成變數再傳進 t() 的 options（不巢狀）", ['const detail = apiErrorMessage(x, t("common:error.tryLater"));', 'return t("common:error.loadDetail", { detail });']],
    ["兄弟不是巢狀 cond ? t(\"a\") : t(\"b\")", ['const label = cond ? t("common:error.load") : t("common:error.tryLater");']],
  ])("%s ⇒ 綠", (_name, body) => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Near.tsx", ["export function Near(error: any, e: any, x: any, t: any, cond: any) {", ...body.map((l) => "  " + l), ...body.some((l) => l.trim().startsWith("return")) ? [] : ["  return null;"], "}"].join("\n").split("\n"));

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(PASS);
    });
  });

  // 範圍宣告的兩半，放在同一支裡——因為判別點是**差別**，不是任何單一結果：
  // `src/lib/` 是錯誤翻譯管線的家（`utils.ts` 是契約本體），整個排除；但排除規則不准吞掉
  // sink，所以 `notificationStore.ts`（它會 `toast(title, …)`）單獨收回來。
  // 只放前者的話，「什麼都沒掃」也會綠；只放後者的話，看不出排除規則存在。
  it("範圍宣告：src/lib/utils.ts 排除、src/lib/notificationStore.ts 收回 ⇒ 只指名後者", () => {
    withSandbox((sandbox) => {
      write(sandbox, "lib/utils.ts", ["export function apiErrorMessage(error: unknown, fallback: string) {", "  return error instanceof Error ? error.message : fallback;", "}"]);
      write(sandbox, "lib/notificationStore.ts", ["export function show(error: any, toast: any) {", "  toast(error.message);", "}"]);
      write(sandbox, "Clean.tsx", CLEAN);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("src/lib/notificationStore.ts:2");
      expect(result.stderr).not.toContain("src/lib/utils.ts");
    });
  });
});

describe("check-error-paths：規則 B（巢狀 t()）", () => {
  // ① 是**本階段真實修掉的形狀**：query 錯誤的內嵌渲染。照最直覺的寫法改的話，
  //    `t("common:error.tryLater")` 會落在外層 `t()` 的 options 物件裡。
  //    用**多行**寫，才能證明閘門報的是**內層**那一行的位置，而不是外層的。
  it("① 內層 fallback 落在 t() 的 options 裡 ⇒ exit 1、指名內層那一行", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Nested.tsx", [
        "export function Nested({ boards, t }: any) {",
        "  if (boards.isError)",
        "    return (",
        '      <p className="text-destructive">',
        '        {t("common:error.loadDetail", {',
        '          detail: apiErrorMessage(boards.error, t("common:error.tryLater")),',
        "        })}",
        "      </p>",
        "    );",
        "}",
      ]);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(RULE_B);
      // 內層在**第 6 行**（外層在第 5 行）——這一格就是「報內層」的判別點。
      expect(result.stderr).toContain("src/Nested.tsx:6");
      expect(result.stderr).not.toContain("Nested.tsx:5");
      // 這一支不該驚動規則 A（沒有 .message）。
      expect(result.stderr).not.toContain(RULE_A);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("② i18n.t 包 i18n.t ⇒ exit 1、指名內層", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Nested.ts", [
        'export const a = i18n.t("a", {',
        '  x: i18n.t("b"),',
        "});",
      ]);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(RULE_B);
      expect(result.stderr).toContain("src/Nested.ts:2");
      expect(result.stderr).not.toContain(RULE_A);
    });
  });

  it("③ 再深一層（三層）⇒ 兩層內層都被指名", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Deep.ts", [
        'export const a = t("a", {',
        '  x: t("b", {',
        '    y: t("c"),',
        "  }),",
        "});",
      ]);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("src/Deep.ts:2");
      expect(result.stderr).toContain("src/Deep.ts:3");
      expect(result.stderr).not.toContain("Deep.ts:1");
    });
  });
});

describe("check-error-paths：認不得就大聲（bail）", () => {
  // **這一支守的是「把 parseDiagnostics 那道 bail 刪掉」那個突變。**
  //
  // 檔案刻意讓 `.message` 出現在**語法錯誤之前**：實測顯示 `ts.createSourceFile` 不拋錯，
  // 而**錯誤點之前的節點照樣數得到**——所以「數到節點」不是「讀過這個檔」的證據。
  // 把 bail 拿掉之後，這個檔會貢獻一筆命中，於是：
  //   - stderr 會出現規則 A 的標頭（下面的 not.toContain 當場變紅），且
  //   - stdout 仍不印通過（下面的 not.toContain 守住「兩個方向都不能靜默」）。
  // 單看 exit code 沒有判別力（違規分支也是 1），所以判別依據是**標頭**。
  it("① 語法錯誤 ⇒ exit 1、「無法完成」、且不落到規則 A 那條", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Broken.ts", [
        "const a = (e as Error).message;",
        "const b = ;",
      ]);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BAIL);
      expect(result.stderr).toContain("src/Broken.ts");
      // 大聲，不是「掃到一半就報」：壞檔的命中不准流出來當結果。
      expect(result.stderr).not.toContain(RULE_A);
      expect(result.stderr).not.toContain(RULE_B);
      expect(result.stdout).not.toContain(PASS);
    });
  });

  it("② src/ 底下一個 .js ⇒ exit 1、「無法完成」", () => {
    withSandbox((sandbox) => {
      write(sandbox, "Clean.tsx", CLEAN);
      write(sandbox, "Legacy.js", ["export const x = 1;"]);

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BAIL);
      expect(result.stderr).toContain("src/Legacy.js");
      expect(result.stdout).not.toContain(PASS);
    });
  });
});
