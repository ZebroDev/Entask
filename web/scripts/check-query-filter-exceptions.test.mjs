// `check-query-filter-exceptions.mjs` 的測試（2026-09-18，軟刪除 final fix 任務 4b）。
//
// **為什麼要有這一支**：閘門的檔頭自己宣告了「掃描器認不得的構件一律 exit 1（大聲，不是放行）」
// （那一類的完整清單與理由在 `lib/label-table-extract.mjs` 的 `maskCSharp`）。在這支之前，
// 那個分支**只有手動覆蓋**——把它改成「跳過就算了」（`continue` 掉、不進 `unreadable`、
// 不 exit 1），全套測試與其他閘門都不會響，而症狀是**靜默**的：掃不到的檔案看起來像沒問題，
// 正是這道閘門存在的理由（D2 的「預設正確」）。
//
// **做法**：在系統暫存目錄造一個**沙箱 repo root**，把閘門本體與它相依的 lib 逐檔複製進去
// （保留 `web/scripts/…` 與 `web/scripts/lib/…` 的相對路徑），再放一個自己的 `src/`。閘門的
// root 由 `import.meta.url` 推導，所以沙箱副本只看得到**沙箱的** `src/`——版控裡的檔案一個
// 都沒碰。閘門以 spawn 跑子行程：CWD 顯式給 `os.tmpdir()`（與沙箱、與 repo 都無關，證明它
// 不吃 CWD）、不連網。
//
// 沙箱的 `web/node_modules` 是指向本 repo `web/node_modules` 的連結：複製過去的 lib 有一行
// 靜態 `import ts from "typescript"`，少了它子行程會在模組載入階段就 ERR_MODULE_NOT_FOUND
// ——那會讓「exit 1」來自錯的理由，而下一個測試的正向對照正是為了擋這種事（實測：少了這一格，
// 正向對照拿到的是 exit 1 ＋ module not found）。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url)); // web/scripts
const webDir = join(scriptsDir, "..");

/** 沙箱 repo root：`web/scripts/…` ＋ `web/scripts/lib/…` ＋ 空的 `src/` ＋ node_modules 連結。 */
const makeSandbox = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "entask-query-filter-gate-"));
  mkdirSync(join(sandbox, "web", "scripts", "lib"), { recursive: true });
  mkdirSync(join(sandbox, "src"), { recursive: true });
  copyFileSync(
    join(scriptsDir, "check-query-filter-exceptions.mjs"),
    join(sandbox, "web", "scripts", "check-query-filter-exceptions.mjs"),
  );
  copyFileSync(
    join(scriptsDir, "lib", "label-table-extract.mjs"),
    join(sandbox, "web", "scripts", "lib", "label-table-extract.mjs"),
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

/** 寫一個 `.cs` 進沙箱的 `src/`。閘門只掃 `.cs`。 */
const writeCs = (sandbox, name, source) => {
  writeFileSync(join(sandbox, "src", name), source);
};

/** 跑沙箱裡的閘門本體。回傳 spawnSync 的結果（`status`／`stdout`／`stderr`）。 */
const runGate = (sandbox) =>
  spawnSync(process.execPath, [join(sandbox, "web", "scripts", "check-query-filter-exceptions.mjs")], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

describe("check-query-filter-exceptions：exit code 的契約", () => {
  // **正向對照，先寫、必須綠**：少了這一步，「exit 1」可能來自任何原因（路徑打錯、node 版本、
  // 複製失敗、模組解析失敗）——整支測試就沒有判別力。
  //
  // 沙箱的 `src/` 放的是**恰好一處**破例（模擬真的 `ProjectReportQueries` 的 FPY 分母）；
  // **不是零處**——零處的閘門會走「破例一處都沒有」那條 exit 1，正向對照就反了。
  it("沙箱 `src/` 恰好一處破例 ⇒ exit 0、印出成功訊息（正向對照）", () => {
    withSandbox((sandbox) => {
      writeCs(
        sandbox,
        "DemoReportQueries.cs",
        [
          "// 沙箱的正向對照：恰好一處破例，其餘照預設。",
          "var denominator = await db.Cards",
          "    .IgnoreQueryFilters()",
          "    .Where(c => c.Reviews.Any())",
          "    .ToListAsync();",
          "",
        ].join("\n"),
      );

      const result = runGate(sandbox);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("查詢篩選破例檢查通過");
      expect(result.stdout).toContain("恰好 1 處");
      // 那一處要真的是沙箱那個檔——不然「通過」可能來自別的檔案。
      expect(result.stdout).toContain("src/DemoReportQueries.cs");
      expect(result.stderr).not.toContain("無法完成");
    });
  });

  // **主案例**：同一個沙箱裡**再加一個**檔（正向對照那個留著，兩個檔缺一不可）。
  // 壞檔挑的是 fix round 2 那個形狀——**有洞的**逐字內插字串 `$@"…{…}"`：它是「認得卻處理
  // 錯」的那一類，而洞裡**正好可以放**本閘門要抓的那一行（所以「大聲」與「靜默吃掉」的差別
  // 在同一支測試裡）。
  //
  // 為什麼那個正常檔不能拿掉：只放壞檔的話，把 `unreadable` 那條改成靜默跳過之後，閘門會走
  // 「破例一處都沒有」⇒ **照樣 exit 1**，exit code 就不是判別點了。留著恰好一處的正常檔，
  // 靜默跳過會讓它 **exit 0**——突變才會**翻轉 exit code**。
  it("同一個沙箱再加一個掃描器認不得的形狀 ⇒ exit 1、訊息指名它（靜默跳過的守衛）", () => {
    withSandbox((sandbox) => {
      writeCs(
        sandbox,
        "DemoReportQueries.cs",
        ["var denominator = await db.Cards", "    .IgnoreQueryFilters()", "    .ToListAsync();", ""].join("\n"),
      );
      // 洞裡那一行就是被靜默吃掉的那一處：掃描器若把整段字面值當內容遮掉，這一處破例
      // 就從此消失（「掃不到的檔案看起來像沒問題」）。
      writeCs(sandbox, "UnreadableShape.cs", ['var q = $@"{db.Cards.IgnoreQueryFilters()}";', ""].join("\n"));

      const result = runGate(sandbox);

      expect(result.status).toBe(1);
      // exit 1 來自**掃描器那一條**，不是兩條計數的（那兩條在這裡都不成立：破例恰好一處）。
      expect(result.stderr).toContain("無法完成——掃描器遇到它認不得的形狀");
      expect(result.stderr).toContain("src/UnreadableShape.cs");
      expect(result.stderr).not.toContain("破例超過一處");
      expect(result.stderr).not.toContain("破例一處都沒有");
      // 靜默跳過的突變會讓它一路走到成功訊息（正常檔那一處照樣命中）。
      expect(result.stdout).not.toContain("查詢篩選破例檢查通過");
    });
  });
});
