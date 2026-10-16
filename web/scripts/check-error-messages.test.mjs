// Gate B 的測試。**測試在記憶體裡餵字串，不碰 repo 的檔案**（與 label-table-extract.test.mjs 同一條規則：
// 磁碟 I/O 留在閘門那一支，單元測試的輸入完全由夾具決定）。
//
// 為什麼 `codes` 是參數（2026-09-20 的計畫修正，見 task-6-brief 的裁定框）：`ErrorMessages.cs` 裡
// 沒有碼值的定義，要從 `ErrorCodes.CardNotFound` 得到 `card.notFound` 不可能只靠那一份原始碼。
// 由呼叫端把 `ErrorCodes.cs` 的 `Map<常數名, 碼值>` 交進來，本檔才能維持純函式，而這裡的
// `codes` 也才是**夾具自己的資料**、不是磁碟上那個檔案的當下內容。

import { describe, expect, it } from "vitest";

import { extractBackendValues } from "./lib/label-table-extract.mjs";
import { extractErrorMessageTable } from "./lib/error-message-table.mjs";

// `ErrorCodes.cs` 的 name→value 對照。真實那張由閘門從磁碟讀
// （`extractBackendValues(errorCodesSrc, { withNames: true })`）；這裡手寫兩條就夠。
const codes = new Map([
  ["CardNotFound", "card.notFound"],
  ["NotificationNotFound", "notification.notFound"],
]);

describe("extractErrorMessageTable", () => {
  it("抽出 code → 值的對照", () => {
    const src = `
public static class ErrorMessages
{
    public static string For(string code) => code switch
    {
        ErrorCodes.CardNotFound => "找不到這張卡片，可能已被刪除",
        ErrorCodes.NotificationNotFound => "找不到這則通知",
        _ => throw new ArgumentException($"錯誤訊息表沒有這個 code：{code}", nameof(code)),
    };
}
`;
    const table = extractErrorMessageTable(src, { codes });
    expect(table.get("card.notFound")).toBe("找不到這張卡片，可能已被刪除");
    expect(table.get("notification.notFound")).toBe("找不到這則通知");
    expect(table.size).toBe(2);
  });

  it("認不得的構件 fail closed（不是靜默略過）", () => {
    const src = `
    public static string For(string code) => code switch
    {
        SomeOtherSource.CardNotFound => "找不到這張卡片",
        _ => throw new ArgumentException("...", nameof(code)),
    };
`;
    expect(() => extractErrorMessageTable(src, { codes })).toThrow();
  });

  // 第二支的「為什麼」值得再拆成三支：空表也會讓閘門 exit 1，但訊息會指錯方向
  // （說「語系檔少了某個 key」而不是「抽取器認不得這個檔」）。以下每一支都是
  // 一條會靜默回空表（或半張表）的路徑。
  it("臂上的常數名不在 codes 裡 ⇒ 拋（不猜碼值）", () => {
    const src = `
    public static string For(string code) => code switch
    {
        ErrorCodes.CardNotfound => "找不到這張卡片",
        _ => throw new ArgumentException("...", nameof(code)),
    };
`;
    expect(() => extractErrorMessageTable(src, { codes })).toThrow(/CardNotfound/);
  });

  it("右邊不是字面值字串（內插字串）⇒ 拋", () => {
    const src = `
    public static string For(string code) => code switch
    {
        ErrorCodes.CardNotFound => $"找不到 {code}",
        _ => throw new ArgumentException("...", nameof(code)),
    };
`;
    expect(() => extractErrorMessageTable(src, { codes })).toThrow(/不是字面值字串/);
  });

  it("少了 `_` 的丟棄臂 ⇒ 拋（那條臂是「未知的 code 當場大聲」的實作本體）", () => {
    const src = `
    public static string For(string code) => code switch
    {
        ErrorCodes.CardNotFound => "找不到這張卡片",
    };
`;
    expect(() => extractErrorMessageTable(src, { codes })).toThrow();
  });

  it("同一個碼有兩條臂 ⇒ 拋（重複臂在 C# 是編譯錯誤，在這裡也不准靜默取後者）", () => {
    const src = `
    public static string For(string code) => code switch
    {
        ErrorCodes.CardNotFound => "找不到這張卡片",
        ErrorCodes.CardNotFound => "找不到",
        _ => throw new ArgumentException("...", nameof(code)),
    };
`;
    expect(() => extractErrorMessageTable(src, { codes })).toThrow(/重複/);
  });

  it("沒給 codes ⇒ 當場 TypeError（大聲，不是回一張空表）", () => {
    const src = `
    public static string For(string code) => code switch
    {
        ErrorCodes.CardNotFound => "找不到這張卡片",
        _ => throw new ArgumentException("...", nameof(code)),
    };
`;
    expect(() => extractErrorMessageTable(src, {})).toThrow(TypeError);
  });
});

// `extractBackendValues` 的 `withNames`：Step 3 說「選一個回傳風格並在測試裡釘住」。
// 釘在這裡而不是 label-table-extract.test.mjs，是為了讓那一支的 67 支**一字不動**
// （它們釘的是預設回傳形狀＝值的陣列；那一支不動本身就是「預設沒被改」的證據）。
describe("extractBackendValues 的 withNames", () => {
  const ERRORS = `public static class ErrorCodes
{
    public const string CardNotFound = "card.notFound";
    public const string NotificationNotFound = "notification.notFound";
}
`;

  const REVIEW = `public static class ReviewStatuses
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Rejected = "rejected";
    public static readonly string[] All = [Pending, Approved, Rejected];
    public static readonly string[] Submittable = [Approved, Rejected];
}
`;

  it("沒有 arrayName 時交出整張 Map<常數名, 值>（不是反過來的）", () => {
    const table = extractBackendValues(ERRORS, { label: "ErrorCodes.cs", withNames: true });
    expect(table).toEqual(
      new Map([
        ["CardNotFound", "card.notFound"],
        ["NotificationNotFound", "notification.notFound"],
      ]),
    );
  });

  it("有 arrayName 時是**同一個方向**、只留被引用的常數", () => {
    const table = extractBackendValues(REVIEW, { label: "x.cs", arrayName: "Submittable", withNames: true });
    expect(table).toEqual(
      new Map([
        ["Approved", "approved"],
        ["Rejected", "rejected"],
      ]),
    );
  });

  it("空集合的守衛仍然有效（Map 這一條路徑也要擋）", () => {
    expect(() => extractBackendValues(`public static class X { }`, { label: "x.cs", withNames: true })).toThrow(
      /解析不到任何 public const string/,
    );
  });
});
