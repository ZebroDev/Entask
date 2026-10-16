import { describe, expect, it } from "vitest";
import { errorMessage, serverMessage } from "@/lib/error-messages";
import { apiErrorMessage } from "@/lib/utils";
import { axios400, axiosStatus, axiosNetworkError } from "@/test/http-errors";

describe("errorMessage：安全閥", () => {
  // 這一條是整個設計的安全閥（設計 §6.1）。後端加了 code 而前端忘了補時，
  // 後果必須是「顯示伺服器的 message」，不是「把 key 印在畫面上」。
  it("認不得的 code 回 null，不得回 key 本身", () => {
    expect(errorMessage("nope.notACode")).toBeNull();
    expect(errorMessage("")).toBeNull();
  });

  // 上面那一條只驗了安全閥的**前半**（`errorMessage` 回 null）。使用者真正體驗到的
  // 是後半——`serverMessage` 在 code 認不得時**必須退回 `message`**。少了這一條，
  // 「回 null 之後改回傳 key」這種修法可以讓上面的斷言照過，而畫面上會出現
  // `error:board.nameRequired`。
  //
  // 認不得的 code 與「已宣告但前端忘了補 case」走的是**同一條路徑**
  // （`errorMessage` 兩者都回 null），所以這一條就是那個情境的常駐版本；
  // §11 的案例 4 另以「暫時註解掉一個真 case」做一次負向實測。
  it("認不得的 code → 顯示伺服器的 message，不是 key 本身", () => {
    const key = "error:nope.notACode";
    expect(serverMessage({ code: "nope.notACode", message: "伺服器原文" })).toBe("伺服器原文");
    expect(serverMessage({ code: "nope.notACode", message: "伺服器原文" })).not.toBe(key);
    expect(apiErrorMessage({ response: { data: { code: "nope.notACode", message: "伺服器原文" } } }, "備援")).toBe(
      "伺服器原文",
    );
  });
});

describe("errorMessage：params 路徑", () => {
  // 這條路徑的守門員只有這幾支斷言。閘門一比的是 code 集合、閘門二比的是原始碼形狀，
  // 而 parity 的檢查 6 比的是**語系之間**的佔位名集合——三者都不管「後端有沒有真的供值」。
  // 少了參數，畫面上就是未代換的 `{{max}}`，上面每一道都看不到。
  //
  // 期望值刻意寫成**該站點的後端字面值**，所以這幾條同時把「帶參數的 key 渲染
  // 與後端字面值逐字相同」從紙上論證變成可執行的事實。對應的站點：
  // `AttachmentEndpoints.cs`、`UserEndpoints.cs` 兩處、`WorkLogEndpoints.cs`、
  // `CustomFieldEndpoints.cs`。
  it("attachment.tooLarge 帶 max（後端上限 20MB）", () => {
    expect(errorMessage("attachment.tooLarge", { max: 20 })).toBe("檔案超過 20MB 上限");
  });

  it("user.displayNameTooLong 帶 max（後端上限 100 字元）", () => {
    expect(errorMessage("user.displayNameTooLong", { max: 100 })).toBe("顯示名稱不可超過 100 字元");
  });

  it("query.rangeTooLong 帶 max（後端上限 366 天）", () => {
    expect(errorMessage("query.rangeTooLong", { max: 366 })).toBe("查詢的期間不可超過 366 天");
  });

  it("user.avatarTooLarge 帶 max（後端上限 5MB）", () => {
    expect(errorMessage("user.avatarTooLarge", { max: 5 })).toBe("檔案大小不可超過 5MB");
  });

  it("card.fieldTextTooLong 帶 max（後端上限 1000 字元）", () => {
    expect(errorMessage("card.fieldTextTooLong", { max: 1000 })).toBe("文字欄位須為 1000 字元以內的字串");
  });

  // 2026-10-10 公開前硬化（T5）：13 個站點的集合上限共用這個碼與這個 `{{max}}`——上限值
  // 由後端的 `@params.max` 來（`RequestLimits.MaxReferenceIds`，這一站的 500 就是它）。
  // **不帶 `params` 的後果**：畫面原樣印出 `{{max}}`（閘門 C 的 R3b 守的是 C# 那一側，
  // 前端這一側只有這裡釘得住）。
  it("request.collectionTooLarge 帶 max（後端上限 500）", () => {
    expect(errorMessage("request.collectionTooLarge", { max: 500 })).toBe("清單的項目數超過上限 500");
  });

  // ---- 以下四條不屬上面那一組（2026-09-19，403 錯誤碼補完）----
  //
  // 差別有兩個：它們是**新增的** code（沒有「遷移前的後端字面值」可寫），而且**不帶參數**
  // ——以不傳 `params` 呼叫，就是計畫要求的「`params` 不適用時的行為」。
  //
  // **判別力**：期望值必須是**譯文本身**。只斷言 `not.toBeNull()` 或
  // `not.toBe("error:…")` 是分不出好壞的——`errorMessage` 認不得 code 時回 `null`，
  // 而「實作正確」與「根本沒走到這個 case」在弱斷言下長得一樣（本階段的前一批
  // 錯誤路徑收斂實際踩過這一型）。
  it("permission.denied 不帶參數（真的沒權限與資源不可見共用同一個 code）", () => {
    expect(errorMessage("permission.denied")).toBe("你沒有存取這個資源的權限");
  });

  it("comment.notOwner 不帶參數", () => {
    expect(errorMessage("comment.notOwner")).toBe("只有留言作者本人可以編輯或刪除留言");
  });

  it("review.notReviewer 不帶參數", () => {
    expect(errorMessage("review.notReviewer")).toBe("只有被指派的審查者可以提交這筆審查");
  });

  it("team.notMember 不帶參數", () => {
    expect(errorMessage("team.notMember")).toBe("你不是這個團隊的成員，無法檢視績效報表");
  });
});

describe("serverMessage：伺服器文字的提取", () => {
  it("裸字串（舊後端）原樣回傳", () => {
    expect(serverMessage("看板名稱不可為空")).toBe("看板名稱不可為空");
  });

  it("ProblemDetails 的 detail（過渡期形狀）", () => {
    expect(serverMessage({ detail: "並發更新衝突，請重試" })).toBe("並發更新衝突，請重試");
  });

  it("新契約的 message", () => {
    expect(serverMessage({ code: "board.nameRequired", message: "看板名稱不可為空" })).toBe("看板名稱不可為空");
  });

  // 上面那一條的 `message` 與 `board.nameRequired` 的 zh-TW 譯文**逐字相同**，
  // 所以它分不出「走 code 拿到譯文」與「原樣轉送 message」——把 `errorMessage` 的
  // 呼叫整段拿掉，它照樣是綠的。這一條讓兩者不同，才真的釘住「code 優先於 message」。
  it("code 認得時以譯文為準，即使 message 不一樣", () => {
    expect(serverMessage({ code: "board.nameRequired", message: "伺服器自己的說法" })).toBe("看板名稱不可為空");
  });

  it("Identity 的 string[] 取第一筆（與改動前 data[0] 一致）", () => {
    expect(serverMessage(["Passwords must be at least 8 characters."])).toBe(
      "Passwords must be at least 8 characters.",
    );
  });

  it("空字串與空白字串不算訊息", () => {
    expect(serverMessage("   ")).toBeNull();
    expect(serverMessage({ message: "" })).toBeNull();
    expect(serverMessage(null)).toBeNull();
    expect(serverMessage(undefined)).toBeNull();
  });
});

// `apiErrorMessage` 的契約住在這個檔而不是 `utils.test.ts`（它才是實作所在的檔）：
// 出口的行為＝「錯誤訊息管線」的一部分，而 `error-messages.ts` 與 `utils.ts` 是同一個
// 管線的兩半。兩邊各留一份會變成同一份契約的兩個副本——改一邊忘一邊，而且兩個都會綠。
describe("apiErrorMessage：唯一錯誤出口的契約", () => {
  it("物件帶 code → 走譯文（優先於伺服器原文與傳輸層字串）", () => {
    expect(
      apiErrorMessage(axios400({ code: "board.nameRequired", message: "SERVER-RAW" }), "備援"),
    ).toBe("看板名稱不可為空");
  });

  it("裸字串 → 原樣回傳", () => {
    expect(apiErrorMessage(axios400("舊後端的訊息"), "備援")).toBe("舊後端的訊息");
  });

  it("連 Error 都不是 → fallback", () => {
    expect(apiErrorMessage({}, "備援")).toBe("備援");
  });

  // ---- 伺服器沒說話時**不得**退回 `error.message`（2026-09-19，final review 的 F-1）----
  //
  // 對 axios 而言 `error.message` 是**傳輸層字串**（`Request failed with status code 403`
  // ／`Network Error`）。會走到最後一行的是**伺服器沒說話**的那些回應：
  //   ① 空 body 的 401（`Results.Unauthorized()` 與認證中介層的結構性 401）——最常撞到的一種；
  //   ② 網路層失敗（`Network Error`）；
  //   ③ 路由層的 404（打到沒有註冊的路徑）——**只在開發版面成立**，部署映像裡
  //      `MapFallbackToFile("index.html")` 會回 200（`utils.ts` 那段有完整說明）。
  // 帶 code 的錯誤一律走上面的譯文分支，不會到最後一行。
  // **判別依據**：把 `utils.ts` 的 `return fallback;` 還原成
  // `return error instanceof Error ? error.message : fallback;` ⇒ 下面四支當場變紅，
  // 其餘照綠。（這一組原本有一支叫「都沒有 → Error.message」的**舊契約鎖**，F-1 修正時
  // 一併反轉成下面那支「Error 實例本身也不退回 error.message」——紅燈會自己說明原因。）
  it("空 body 的回應 → fallback，不是傳輸層字串", () => {
    const message = apiErrorMessage(axiosStatus(403), "備援");

    expect(message).toBe("備援");
    expect(message).not.toMatch(/Request failed with status code/);
  });

  it("有 response 但沒有 message／detail → fallback", () => {
    expect(apiErrorMessage(axiosStatus(500, {}), "備援")).toBe("備援");
  });

  it("網路層失敗（沒有 response）→ fallback，不是 Network Error", () => {
    expect(apiErrorMessage(axiosNetworkError(), "備援")).toBe("備援");
  });

  it("Error 實例本身也不退回 error.message", () => {
    expect(apiErrorMessage(new Error("boom"), "備援")).toBe("備援");
  });

  // ---- NotFound 錯誤碼契約（2026-09-19 起，逐碼一條）----
  //
  // 這組走的是**完整管線**（axios 形狀 → 伺服器原文 → code 譯文），與上面
  // `errorMessage` 那組直接呼叫的層級不同：它們同時釘住「`error-messages.ts` 有 case」
  // 與「`error.json` 有值」，而 `t()` 在 key 不存在時會**靜默回傳 key 本身**——所以
  // 期望值一律是**譯文**，不是 key（`check:labels` 只比集合，看不到這種失敗）。
  //
  // fixture 用 `axios400` 而不是裸 `Error`（判別力，見 AGENTS.md）：body 的 `message`
  // 刻意是「伺服器原文」，與譯文不同，所以「只讀伺服器原文」的實作會當場變紅。
  it.each([
    ["card.notFound", "找不到這張卡片，可能已被刪除"],
    ["card.fieldNotFound", "找不到這個自訂欄位，可能已被刪除"],
    ["list.notFound", "找不到這個列表，可能已被刪除"],
    ["board.notFound", "找不到這個看板，可能已被刪除"],
    ["project.notFound", "找不到這個專案，可能已被刪除"],
    ["team.memberNotFound", "找不到這位團隊成員"],
    ["team.notFound", "找不到這個團隊，可能已被刪除"],
    ["teamRole.notFound", "找不到這個角色，可能已被刪除"],
    ["checklist.notFound", "找不到這個檢查清單，可能已被刪除"],
    ["checklistItem.notFound", "找不到這個項目，可能已被刪除"],
    ["label.notFound", "找不到這個標籤，可能已被刪除"],
    ["attachment.notFound", "找不到這個附件，可能已被刪除"],
    ["comment.notFound", "找不到這則留言，可能已被刪除"],
    ["mindmap.nodeNotFound", "找不到這個節點，可能已被刪除"],
    ["review.notFound", "找不到這筆審查，可能已被刪除"],
    ["notification.notFound", "找不到這則通知"],
    ["user.avatarNotFound", "找不到這個大頭貼"],
  ])("404 錯誤碼 %s 有 zh-TW 譯文", (code, expected) => {
    expect(apiErrorMessage(axios400({ code, message: "伺服器原文" }), "fallback")).toBe(expected);
  });

  // ---- 401 錯誤碼契約（2026-09-20 起，逐碼一條）----
  //
  // 與上面那組逐條對應，差別在 2026-09-20 之前 **401 一律是空 body**——`Results.Unauthorized()`
  // 與 auth middleware 都不帶 body，所以這三條的期望值當時根本取不到，`fallback` 是唯一顯示
  // 得出的字串。fixture 用 `axiosStatus(401, …)` 而不是 `axios400`：`error-messages.ts` 的 case
  // 只認 `code`、與狀態碼無關，用錯的狀態碼會讓這一組看起來像在驗 400（而它驗的是 401 的形狀）。
  it.each([
    ["auth.unauthenticated", "尚未登入，或登入已過期"],
    ["auth.sessionInvalid", "登入狀態已失效，請重新登入"],
    ["auth.invalidCredentials", "帳號或密碼錯誤"],
  ])("401 錯誤碼 %s 有 zh-TW 譯文", (code, expected) => {
    expect(apiErrorMessage(axiosStatus(401, { code, message: "伺服器原文" }), "fallback")).toBe(expected);
  });

  // ---- 500 錯誤碼契約（2026-09-21 起，逐碼一條）----
  //
  // 這一組在 2026-09-21 之前**取不到期望值**：未處理的例外沒有 body（`fallback` 是唯一顯示得出來
  // 的字串），而四個原本帶 body 的 500 站點還在内嵌字面值、不經 `error-messages.ts` 的 case。
  // 中介層 ＋ 收斂之後兩半都成立，`server.internalError` 這條才驗得動。
  // fixture 用 `axiosStatus(500, …)`，理由與上面 401 那組相同：case 只認 `code`、與狀態碼無關。
  it.each([["server.internalError", "系統發生錯誤，請稍後再試"]])(
    "500 錯誤碼 %s 有 zh-TW 譯文",
    (code, expected) => {
      expect(apiErrorMessage(axiosStatus(500, { code, message: "伺服器原文" }), "fallback")).toBe(expected);
    },
  );
});
