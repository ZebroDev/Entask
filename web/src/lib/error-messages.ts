// 錯誤碼 → 顯示文字。與 `format.ts`／`custom-fields.ts`／`label-palette.ts` 同一個寫法：
// 非元件的模組直接呼叫 `i18n.t`，**在每次呼叫時求值**。
//
// 為什麼是 switch ＋ 字面值而不是查表（P-B2-2b 定案）：
// i18next-parser 只認字面值引數，而 i18next-parser.config.js 的 keepRemoved: false
// 會把「原始碼裡找不到」的 key 從語系檔刪掉——畫面只顯示 key 本身，沒有錯誤、
// 沒有警告、測試也不會紅。查表等於把整份錯誤訊息變成靜默失效。
//
// **這一類不在「譯文不得穿過不隨語系重算的邊界」的轄區**（設計 §6.3）：
// 錯誤訊息是事件不是狀態——toast 一旦顯示就是那個字串，切語系不會、也不該重繪它。
// 這個模組不在任何 useMemo／useCallback 內，與 B2-5a 的形狀長得像但不同源。
import i18n from "@/i18n";

/**
 * code → 譯文。認不得的 code 回 `null`。
 *
 * **`null` 是整個設計的安全閥**：後端加了 code 而前端忘了補時，呼叫端
 * （`apiErrorMessage`）會退回顯示伺服器送來的 `message`——而不是把
 * `error:board.nameRequired` 這串字印在畫面上。
 * 反過來說，這個 `default` 分支讓「閘門一」成為唯一擋得住漏補的東西。
 */
export function errorMessage(code: string, params?: Record<string, string | number>): string | null {
  switch (code) {
    case "attachment.notFound":
      return i18n.t("error:attachment.notFound");
    case "attachment.tooLarge":
      return i18n.t("error:attachment.tooLarge", params);
    case "attachment.unsupportedType":
      return i18n.t("error:attachment.unsupportedType");
    case "auth.adminGrantFailed":
      return i18n.t("error:auth.adminGrantFailed");
    // 401 家族。三者都**沒有** `params`：`unauthenticated` 是認證挑戰、`sessionInvalid` 是
    // token 有效但主體不可用、`invalidCredentials` 是登入失敗（三條登入失敗路徑共用它）。
    case "auth.invalidCredentials":
      return i18n.t("error:auth.invalidCredentials");
    case "auth.sessionInvalid":
      return i18n.t("error:auth.sessionInvalid");
    case "auth.unauthenticated":
      return i18n.t("error:auth.unauthenticated");
    case "auth.usernameRequired":
      return i18n.t("error:auth.usernameRequired");
    case "board.nameRequired":
      return i18n.t("error:board.nameRequired");
    case "board.notFound":
      return i18n.t("error:board.notFound");
    case "card.coverInvalid":
      return i18n.t("error:card.coverInvalid");
    case "card.estimateNotPositive":
      return i18n.t("error:card.estimateNotPositive");
    case "card.fieldMemberNotFound":
      return i18n.t("error:card.fieldMemberNotFound");
    case "card.fieldNotFound":
      return i18n.t("error:card.fieldNotFound");
    case "card.fieldTextTooLong":
      return i18n.t("error:card.fieldTextTooLong", params);
    case "card.fieldValueNotInOptions":
      return i18n.t("error:card.fieldValueNotInOptions");
    case "card.memberNotProjectMember":
      return i18n.t("error:card.memberNotProjectMember");
    case "card.notFound":
      return i18n.t("error:card.notFound");
    case "card.positionInvalid":
      return i18n.t("error:card.positionInvalid");
    case "card.startAfterDue":
      return i18n.t("error:card.startAfterDue");
    case "card.titleRequired":
      return i18n.t("error:card.titleRequired");
    case "checklist.notFound":
      return i18n.t("error:checklist.notFound");
    case "checklist.titleRequired":
      return i18n.t("error:checklist.titleRequired");
    case "checklistItem.notFound":
      return i18n.t("error:checklistItem.notFound");
    case "checklistItem.textRequired":
      return i18n.t("error:checklistItem.textRequired");
    case "comment.bodyRequired":
      return i18n.t("error:comment.bodyRequired");
    case "comment.notFound":
      return i18n.t("error:comment.notFound");
    case "comment.notOwner":
      return i18n.t("error:comment.notOwner");
    case "concurrency.conflict":
      return i18n.t("error:concurrency.conflict");
    case "effort.hoursNotPositive":
      return i18n.t("error:effort.hoursNotPositive");
    case "effort.localDateInFuture":
      return i18n.t("error:effort.localDateInFuture");
    case "identity.duplicateUserName":
      return i18n.t("error:identity.duplicateUserName");
    case "identity.invalidUserName":
      return i18n.t("error:identity.invalidUserName");
    case "identity.passwordMismatch":
      return i18n.t("error:identity.passwordMismatch");
    case "identity.passwordRequiresDigit":
      return i18n.t("error:identity.passwordRequiresDigit");
    case "identity.passwordRequiresLower":
      return i18n.t("error:identity.passwordRequiresLower");
    case "identity.passwordRequiresNonAlphanumeric":
      return i18n.t("error:identity.passwordRequiresNonAlphanumeric");
    case "identity.passwordRequiresUniqueChars":
      return i18n.t("error:identity.passwordRequiresUniqueChars");
    case "identity.passwordRequiresUpper":
      return i18n.t("error:identity.passwordRequiresUpper");
    case "identity.passwordTooShort":
      return i18n.t("error:identity.passwordTooShort");
    case "identity.unknown":
      return i18n.t("error:identity.unknown");
    case "label.colorInvalid":
      return i18n.t("error:label.colorInvalid");
    case "label.nameDuplicate":
      return i18n.t("error:label.nameDuplicate");
    case "label.nameRequired":
      return i18n.t("error:label.nameRequired");
    case "label.notFound":
      return i18n.t("error:label.notFound");
    case "list.notFound":
      return i18n.t("error:list.notFound");
    case "list.titleRequired":
      return i18n.t("error:list.titleRequired");
    case "mindmap.moveIntoSelf":
      return i18n.t("error:mindmap.moveIntoSelf");
    case "mindmap.nodeNotFound":
      return i18n.t("error:mindmap.nodeNotFound");
    case "mindmap.nodeTitleRequired":
      return i18n.t("error:mindmap.nodeTitleRequired");
    case "notification.notFound":
      return i18n.t("error:notification.notFound");
    case "permission.denied":
      return i18n.t("error:permission.denied");
    case "project.memberInUse":
      // 帶 `{{refs}}`：後端 `ProjectEndpoints` 的 409 送 `@params = new { refs }`
      // （幾張卡片還指派著他）。少了 `params` 這裡只會印出未代換的佔位名。
      return i18n.t("error:project.memberInUse", params);
    case "project.nameRequired":
      return i18n.t("error:project.nameRequired");
    case "project.notFound":
      return i18n.t("error:project.notFound");
    case "query.rangeTooLong":
      return i18n.t("error:query.rangeTooLong", params);
    case "request.bodyTooLarge":
      return i18n.t("error:request.bodyTooLarge");
    // 集合上限（2026-10-10 公開前硬化）。**帶 `params`**：後端在 `@params.max` 給上限值，
    // 而譯文的 `{{max}}` 是那個數字唯一會到畫面上的路徑（不帶參數 ⇒ 使用者看到未代換的
    // `{{max}}`；閘門 C 的 R3b 會擋，但那是最後一道，這一格才是真的餵值的那一格）。
    case "request.collectionTooLarge":
      return i18n.t("error:request.collectionTooLarge", params);
    case "request.invalid":
      return i18n.t("error:request.invalid");
    case "request.timeZoneInvalid":
      return i18n.t("error:request.timeZoneInvalid");
    // 429（2026-09-24）。**沒有 `params`**：`Retry-After` 是給機器看的 header，而這一族的
    // 措辭刻意不承諾具體秒數——把秒數寫進文案等於讓 UI 去解釋一個它沒有重新計算的數字
    // （窗是滑動的，那個秒數在你讀到的時候已經不準了）。要倒數就另外做，不在這一格。
    case "request.tooManyRequests":
      return i18n.t("error:request.tooManyRequests");
    case "review.ratingInvalid":
      return i18n.t("error:review.ratingInvalid");
    case "review.statusNotSubmittable":
      return i18n.t("error:review.statusNotSubmittable");
    case "review.scoreNotAllowedOnReject":
      return i18n.t("error:review.scoreNotAllowedOnReject");
    case "review.commentRequiredOnReject":
      return i18n.t("error:review.commentRequiredOnReject");
    case "review.notReviewer":
      return i18n.t("error:review.notReviewer");
    case "review.rateNotPermitted":
      return i18n.t("error:review.rateNotPermitted");
    case "review.reviewerNotProjectMember":
      return i18n.t("error:review.reviewerNotProjectMember");
    case "review.notFound":
      return i18n.t("error:review.notFound");
    // 500 家族。`server.internalError` 由後端的中介層產生（`ApiResults.WriteInternalErrorAsync`），
    // 它**刻意不帶任何例外資訊**——所以這裡也沒有 `params`，而且不該有：
    // 有 `params` 就代表 body 裡有東西可以代換，那正是這一族要擋的形狀。
    case "server.internalError":
      return i18n.t("error:server.internalError");
    case "team.memberNotFound":
      return i18n.t("error:team.memberNotFound");
    case "team.nameInvalid":
      return i18n.t("error:team.nameInvalid");
    case "team.nameRequired":
      return i18n.t("error:team.nameRequired");
    case "team.nameTooLong":
      return i18n.t("error:team.nameTooLong", params);
    case "team.notFound":
      return i18n.t("error:team.notFound");
    case "team.notMember":
      return i18n.t("error:team.notMember");
    case "team.roleAssigned":
      return i18n.t("error:team.roleAssigned");
    case "teamRole.nameDuplicate":
      return i18n.t("error:teamRole.nameDuplicate");
    case "teamRole.nameRequired":
      return i18n.t("error:teamRole.nameRequired");
    case "teamRole.notFound":
      return i18n.t("error:teamRole.notFound");
    case "teamRole.systemNotDeletable":
      return i18n.t("error:teamRole.systemNotDeletable");
    case "teamRole.systemNotEditable":
      return i18n.t("error:teamRole.systemNotEditable");
    case "user.avatarNotFound":
      return i18n.t("error:user.avatarNotFound");
    case "user.avatarTooLarge":
      return i18n.t("error:user.avatarTooLarge", params);
    case "user.avatarUnsupportedFormat":
      return i18n.t("error:user.avatarUnsupportedFormat");
    case "user.deleteFailed":
      return i18n.t("error:user.deleteFailed");
    case "user.displayNameRequired":
      return i18n.t("error:user.displayNameRequired");
    case "user.displayNameTooLong":
      return i18n.t("error:user.displayNameTooLong", params);
    case "user.updateFailed":
      return i18n.t("error:user.updateFailed");
    case "workCalendar.kindInvalid":
      return i18n.t("error:workCalendar.kindInvalid");
    case "workCalendar.nameTooLong":
      return i18n.t("error:workCalendar.nameTooLong");
    case "workCalendar.notFound":
      return i18n.t("error:workCalendar.notFound");
    // 新增 code 時這裡與 `ErrorCodes.cs` 必須同時補上——閘門一（`check-label-tables.mjs`
    // 的第八張表）比對兩邊的集合，只補一邊會當場變紅。
    default:
      return null;
  }
}

/**
 * 從回應 body 取出「伺服器想說的那句話」，取不到回 `null`。
 *
 * 四種形狀並存的理由：前三種是這一批的過渡期（舊後端、ProblemDetails、
 * Identity 的 string[]），第四種是本次的統一契約。耐受層刻意一次到位，
 * 這樣任何時刻的新舊前後端組合都不會退步（設計 §4.3）。
 *
 * **先走 code 譯文（i18n），認不得才回伺服器原文**：body 帶 `code` 而且
 * `errorMessage` 認得時，回的是**譯文**（切到 en 就是英文），認不得才退回
 * `message`／`detail`。它的職責是**共用的提取**、不負責呈現，供
 * `ProjectAssignMemberDialog` 這種要自己包句子的呼叫端使用（它的版面是
 * 「指派失敗：{{detail}}」）。一般呼叫端請用 `apiErrorMessage`。
 */
export function serverMessage(data: unknown): string | null {
  if (typeof data === "string") return data.trim() === "" ? null : data;
  if (Array.isArray(data)) return typeof data[0] === "string" ? serverMessage(data[0]) : null;
  if (data !== null && typeof data === "object") {
    const body = data as { code?: unknown; params?: unknown; message?: unknown; detail?: unknown };
    if (typeof body.code === "string") {
      // `params` 與 `code`／`message` 同一套：形狀不對就當作沒帶，不直接斷言伺服器來的資料。
      const params =
        typeof body.params === "object" && body.params !== null
          ? (body.params as Record<string, string | number>)
          : undefined;
      const translated = errorMessage(body.code, params);
      if (translated !== null) return translated;
    }
    if (typeof body.message === "string" && body.message.trim() !== "") return body.message;
    if (typeof body.detail === "string" && body.detail.trim() !== "") return body.detail;
  }
  return null;
}
