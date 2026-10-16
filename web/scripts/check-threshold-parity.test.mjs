// `check-threshold-parity.mjs` 的測試（2026-09-28，第 13 道閘門）。
//
// **為什麼要有這一支**——這道閘門的四個主張，沒有一支測試看著就只是紙上論證：
//
//   1. **後端要先遮罩**。`TeamReportEndpoints.cs` 的 XML 註解**刻意**寫著同一句
//      `fpy >= 0.80`（那是給下一個人的說明，見該檔的 `RatingFor` 段）。少了
//      `maskCSharp`，那一對會從「命中 1 次」變成「命中 2 次」而紅——下面第 1 支的
//      fixture **兩邊都放了一份同形的註解**，它綠就等於遮罩真的生效。
//   2. **前端走 TypeScript AST、不是 grep**。理由同上、另一半：TSX 的註解裡也有
//      一份同樣的形狀（fixture 寫了），正規表示式掃 TSX 會多命中一次。
//   3. **「恰好一次」是契約**。站點**消失**（改名／改形狀＝閘門靜默變成守著空氣）與
//      站點**重複**（同一句寫兩次＝不知道在比哪一個）都要大聲，兩個方向各一支。
//   4. **運算子屬於契約的一部分**。只比數值的話，`>=` 寫成 `>` 在邊界上差一個值，
//      而那是會動結果的差；`complementary` 那一對還多一層「方向必須互補」。
//
// 做法與 `check-error-codes.test.mjs` 同一個 harness：在系統暫存目錄造沙箱，把閘門
// 本體與它的 `lib/` 複製進去，`node_modules` 用 junction 連回本 repo，閘門以
// **子行程**跑（`cwd` 顯式給 `os.tmpdir()`）。閘門的 repo 根目錄由 `import.meta.url`
// 推導 ⇒ 沙箱副本只看得到**沙箱的**檔案，版控裡的檔案一個都沒碰。
//
// **斷言只認標頭與站點字串**（`file` 名），不認任何全庫計數——計數會跟著掃描碼腐爛
// （AGENTS.md 的維護規則）。fixture 裡的檔案路徑**必須與閘門表上的真實路徑逐字相同**：
// 閘門讀的是那條相對路徑，差一層就變成「找不到站點」。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url)); // web/scripts
const webDir = join(scriptsDir, "..");

const GATE = "check-threshold-parity.mjs";

// 閘門表上的四個路徑（兩邊各兩個檔）。測試**不從閘門 import 這份清單**——那會讓
// 「改了路徑卻忘了改 fixture」變成兩邊一起錯、一起綠。
const BACKEND_TEAM_REPORT = "src/Entask.Api/Endpoints/TeamReportEndpoints.cs";
const BACKEND_AUTH = "src/Entask.Api/Endpoints/AuthEndpoints.cs";
const FRONTEND_TEAM_REPORT = "web/src/pages/team/TeamReportTab.tsx";
const FRONTEND_ASSIGN = "web/src/pages/team/AssignMemberDialog.tsx";

/** 沙箱：`web/scripts/`（閘門 ＋ `lib/`）＋ repo 根目錄 ＋ node_modules 連結。 */
const makeSandbox = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "entask-threshold-gate-"));
  mkdirSync(join(sandbox, "web", "scripts", "lib"), { recursive: true });
  copyFileSync(join(scriptsDir, GATE), join(sandbox, "web", "scripts", GATE));
  copyFileSync(
    join(scriptsDir, "lib", "label-table-extract.mjs"),
    join(sandbox, "web", "scripts", "lib", "label-table-extract.mjs"),
  );
  symlinkSync(join(webDir, "node_modules"), join(sandbox, "web", "node_modules"), "junction");
  return sandbox;
};

/** 測試失敗時也要刪：先解掉 node_modules 連結再遞迴刪（rmSync 不走進連結的目標）。 */
const cleanup = (sandbox) => {
  try {
    unlinkSync(join(sandbox, "web", "node_modules"));
  } catch {
    // 連結已經不在了——rmSync 會收掉它。
  }
  rmSync(sandbox, { recursive: true, force: true });
};

const write = (sandbox, rel, lines) => {
  const full = join(sandbox, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
};

const runGate = (sandbox) =>
  spawnSync(process.execPath, [join(sandbox, "web", "scripts", GATE)], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

// ── fixture（每個欄位都留一個旋鈕，好讓突變只動一個地方）──────────────────────

/**
 * `TeamReportEndpoints.cs` 的縮影：`RatingFor` 的 fpy 條件 ＋ 調整項的樣本門檻。
 * **`///` 註解裡那句話刻意與程式碼同形**——它是第 1 支的判別點（遮罩失效 ⇒ 命中 2 次）。
 */
const backendTeamReport = ({ fpy = "0.80", samples = "3" } = {}) => [
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class TeamReportProbe",
  "{",
  "    /// <summary>",
  "    /// S 的第三個條件。**fpy 為 null ＝樣本不足＝這個條件不列入**，不是「不滿足」。",
  "    /// 寫成 `fpy >= 0.80` 的形狀在註解裡也有一份（遮罩沒生效時站點會命中 2 次）。",
  "    /// </summary>",
  "    public static string RatingFor(double completionRate, double? fpy)",
  `        => completionRate >= 0.85 && (fpy is null || fpy >= ${fpy}) ? "S" : "A";`,
  "",
  "    /// <summary>門檻（4.5／2.0）刻意設在兩端，讓「不動」是預設結果。</summary>",
  "    private static string ApplyScoreAdjustment(double? averageScore, int scoreSamples)",
  "    {",
  `        if (averageScore is null || scoreSamples < ${samples}) return "A";`,
  '        if (averageScore >= 4.5) return "B";',
  '        return "C";',
  "    }",
  "}",
];

/** `AuthEndpoints.cs` 的縮影：跨團隊搜尋的最短長度（`request.invalid` 的來源）。 */
const backendAuth = ({ search = "3" } = {}) => [
  "namespace Entask.Api.Endpoints;",
  "",
  "public static class AuthProbe",
  "{",
  "    public static bool IsSearchable(string text)",
  "    {",
  "        var trimmed = text.Trim();",
  `        if (trimmed.Length < ${search} || trimmed.Any(char.IsControl)) return false;`,
  "        return true;",
  "    }",
  "}",
];

/** `TeamReportTab.tsx` 的縮影：三格顏色／樣本判定。註解那一行是第 1 支的另一半判別點。 */
const tsxTeamReport = ({ fpy = "0.8", samples = "3", onTimeRate = "0.8" } = {}) => [
  "export function Probe({ m }: { m: Member }) {",
  "  return (",
  "    <div>",
  "      {/*",
  "        註解裡也有一份同樣的形狀：m.fpy >= 0.8（AST 不會把它當節點）與 m.onTimeRate >= 0.8。",
  "      */}",
  `      <span>{m.onTimeRate >= ${onTimeRate} ? "g" : "a"}</span>`,
  `      <span>{m.fpy >= ${fpy} ? "g" : "a"}</span>`,
  `      <span>{(m.scoreSamples ?? 0) < ${samples} ? "n/a" : "ok"}</span>`,
  "    </div>",
  "  );",
  "}",
];

/**
 * `AssignMemberDialog.tsx` 的縮影：**兩個**消費端（`enabled` 與「其他團隊」那一區的渲染
 * 條件）——真 repo 就是兩個，閘門表那一列宣告的 `count` 是 2。`second: false` 拿掉第二個，
 * 用來釘住「重數是宣告出來的、不是『至少一次』」。
 */
const tsxAssign = ({ search = "3", op = ">=", second = true } = {}) => [
  "export const useProbe = (open: boolean, searchTerm: string) => ({",
  `  enabled: open && searchTerm.length ${op} ${search},`,
  "});",
  "",
  "export const Section = ({ showOtherTeams, searchTerm }: Probe) =>",
  second
    ? `  showOtherTeams && searchTerm.length ${op} ${search} ? <div /> : null;`
    : "  showOtherTeams ? <div /> : null;",
];

/** 三對都相符的最小世界。 */
const writeAll = (sandbox, overrides = {}) => {
  write(sandbox, BACKEND_TEAM_REPORT, backendTeamReport(overrides.backendTeamReport));
  write(sandbox, BACKEND_AUTH, backendAuth(overrides.backendAuth));
  write(sandbox, FRONTEND_TEAM_REPORT, tsxTeamReport(overrides.tsxTeamReport));
  write(sandbox, FRONTEND_ASSIGN, tsxAssign(overrides.tsxAssign));
  return sandbox;
};

const withAll = (overrides, run) => {
  const sandbox = makeSandbox();
  try {
    writeAll(sandbox, overrides);
    return run(sandbox);
  } finally {
    cleanup(sandbox);
  }
};

const output = (result) => `${result.stdout}${result.stderr}`;

describe("門檻副本閘門", () => {
  // 這一支同時釘住「遮罩生效」與「AST 不是 grep」：fixture 的兩側註解裡都有一份
  // **同形**的比較，任一個機制失效都會讓某一對變成「命中 2 次」。
  it("三對都相符時 exit 0（兩側的註解各有一份同形比較，仍只算一次）", () => {
    withAll({}, (sandbox) => {
      const result = runGate(sandbox);
      expect(output(result)).toContain("門檻副本檢查通過");
      expect(result.status).toBe(0);
    });
  });

  it("前端數值漂移 ⇒ exit 1，訊息指名那一對與前端站點", () => {
    withAll({ tsxTeamReport: { fpy: "0.9" } }, (sandbox) => {
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("數值不同");
      expect(output(result)).toContain(FRONTEND_TEAM_REPORT);
    });
  });

  it("後端數值漂移 ⇒ exit 1（同一個方向的另一個入口）", () => {
    withAll({ backendTeamReport: { fpy: "0.70" } }, (sandbox) => {
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("數值不同");
      expect(output(result)).toContain(BACKEND_TEAM_REPORT);
    });
  });

  it("運算子漂移（`>=` 寫成 `>`）⇒ exit 1——數值相同但邊界差一個值", () => {
    withAll({ tsxTeamReport: { fpy: "0.8" }, tsxAssign: {} }, (sandbox) => {
      // 只動 fpy 那一對的運算子：0.8 不變、`>=` 換成 `>`。
      write(sandbox, FRONTEND_TEAM_REPORT, [
        "export function Probe({ m }: { m: Member }) {",
        '  return <span>{m.fpy > 0.8 ? "g" : "a"}</span>;',
        "}",
      ]);
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("運算子不同");
    });
  });

  it("complementary 那一對方向寫反（後端 `<` 配前端 `<=`）⇒ exit 1", () => {
    withAll({ tsxAssign: { op: "<=" } }, (sandbox) => {
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("運算子不同");
    });
  });

  it("站點消失（改名）⇒ exit 1 而不是靜默變成 0 對", () => {
    withAll({}, (sandbox) => {
      write(sandbox, FRONTEND_TEAM_REPORT, tsxTeamReport({ fpy: "0.8" }).map((l) => l.replace("m.fpy >=", "m.passRate >=")));
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("找不到站點");
    });
  });

  it("站點重複（同一句寫兩次）⇒ exit 1——「恰好一次」是契約", () => {
    withAll({}, (sandbox) => {
      const lines = tsxTeamReport({ fpy: "0.8" });
      write(sandbox, FRONTEND_TEAM_REPORT, [...lines, 'export const Extra = ({ m }: { m: Member }) => <b>{m.fpy >= 0.8 ? "g" : "a"}</b>;']);
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("必須恰好 1 次");
    });
  });

  // 重數是**宣告**出來的（`count`），不是「至少一次」：同一條界線在畫面上有兩個消費端
  // （真 repo 的 `enabled` 與「其他團隊」那一區），其中一個被刪掉時那半邊就沒人守了。
  it("宣告 count 2 的那一對少了一個站點 ⇒ exit 1（不能退化成『至少一次』）", () => {
    withAll({ tsxAssign: { second: false } }, (sandbox) => {
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("必須恰好 2 次");
    });
  });

  it("宣告為非副本的那一格被改名 ⇒ exit 1（宣告過期，不能腐爛成保護死碼）", () => {
    withAll({}, (sandbox) => {
      write(
        sandbox,
        FRONTEND_TEAM_REPORT,
        tsxTeamReport().map((l) => l.replace("m.onTimeRate >=", "m.punctualityRate >=")),
      );
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("宣告過期");
    });
  });

  // **這一支刻意記下宣告的極限**：非副本那一列只管「站點還在不在」，**不比對數值**。
  // 少了它，下一個讀者會以為那一列也在守門檻值（而它沒有——真正的界線是「後端沒有
  // 可比的對應物」，不是「值不同」）。
  it("非副本那一列的**值**改了仍然 exit 0（宣告只管站點存在，不比數值）", () => {
    withAll({ tsxTeamReport: { onTimeRate: "0.9" } }, (sandbox) => {
      const result = runGate(sandbox);
      expect(result.status).toBe(0);
    });
  });

  it("前端檔有語法錯誤 ⇒ exit 1（認不得就大聲，不猜）", () => {
    withAll({}, (sandbox) => {
      write(sandbox, FRONTEND_ASSIGN, ["export const broken = ;", ""]);
      const result = runGate(sandbox);
      expect(result.status).toBe(1);
      expect(output(result)).toContain("無法完成");
      expect(output(result)).toContain(FRONTEND_ASSIGN);
    });
  });
});
