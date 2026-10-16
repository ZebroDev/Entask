// HTTP 錯誤的測試 fixture（2026-09-19）。
//
// **為什麼要有它**：錯誤路徑的斷言若拿裸 `new Error("…")` 當 fixture，**分不出實作好壞**
// ——寫成裸 `Error` 時「直接讀 `error.message`」與走 `apiErrorMessage` 會顯示同一個字串，
// 測試恆綠。2026-09-19 收斂錯誤路徑時，四支既有測試就是這樣（改成這裡的形狀之前，
// 它們對新舊兩種實作都通過）。
//
// **空 body 的形狀要另外造**（`axiosStatus`）——這是 review 的 F-1 抓到的洞：只有
// `axios400` 時，誰都造不出「伺服器沒說話」的失敗，而那正是 `fallback` 唯一會被用到的
// 情境（「伺服器沒說話」的回應今天仍在，見 `axiosStatus` 的說明），於是「退回傳輸層
// 字串」的實作**沒有任何測試看著**。
//
// `axios400` 造的是 axios **實際丟出來的**形狀：`Error.message` 是**傳輸層字串**
// （`Request failed with status code 400`），伺服器說的話在 `response.data` 裡。
// 斷言時要讓 body 的 `message` **與譯文不同**（慣例值 `"SERVER-RAW"`），三種實作才會分開：
//
//   直接讀 `error.message`  → "Request failed with status code 400"
//   只讀伺服器原文          → body.message
//   走 `apiErrorMessage`    → 錯誤碼的譯文（`src/lib/error-messages.ts`）
//
// **譯文不要憑記憶寫**：查 `src/i18n/locales/zh-TW/error.json`（它是巢狀的，
// `checklistItem.textRequired` 是 `{"checklistItem":{"textRequired": …}}`）或
// `src/lib/error-messages.ts` 的 switch。
import { AxiosError, type AxiosResponse } from "axios";

/** 帶 `{ code, message }` body 的 400——P-C 之後後端錯誤回應的統一形狀。 */
export function axios400(body: unknown): AxiosError {
  return new AxiosError("Request failed with status code 400", undefined, undefined, undefined, {
    status: 400,
    statusText: "Bad Request",
    data: body,
    headers: {},
    config: { headers: undefined },
  } as unknown as AxiosResponse);
}

/**
 * **沒有 body** 的回應——「伺服器沒說話」的形狀之一。403（2026-09-19）、404（2026-09-20）、
 * **401（2026-09-20）**、以及**未處理的 500（2026-09-21，`Program.cs` 的中介層）**都已全數
 * 補上 `{code, message}`；今天還會走到 `fallback` 的是**網路層失敗**與中介層刻意不寫的
 * 那兩條路徑（回應已開始／請求已中止，見 `src/lib/utils.ts` 的 ①）——所以 `apiErrorMessage`
 * 的 `fallback` 必須留著，這支 fixture 也還用得到。
 *
 * **這一格腐爛過一次，別再寫死**：原本這裡寫的是「未處理的 500（`Program.cs` 沒有例外
 * 中介層）」，而那個中介層 2026-09-21 就補上了——`axiosStatus` 的用途沒變，變的是
 * **列舉出來的殘餘種類**。要複驗就當場看 `src/lib/utils.ts` 的 `apiErrorMessage` 檔頭。
 *
 * 預設 `data: ""` 就是 axios 對空 body 的實際值（`serverMessage` 對空白字串回 `null`）。
 * 傳 `{}` 可以造「有 body 但沒有 message／detail」這個**同樣走到 fallback** 的變體；
 * 傳 `{ code, message }` 則是帶 body 的形狀——**狀態碼可以不是 400**
 * （`error-messages.test.ts` 的 401 那組就是 `axiosStatus(401, { … })`）。
 */
export function axiosStatus(status: number, data: unknown = ""): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    undefined,
    undefined,
    undefined,
    {
      status,
      statusText: "",
      data,
      headers: {},
      config: { headers: undefined },
    } as unknown as AxiosResponse,
  );
}

/** 網路層失敗：axios 根本沒有拿到 `response`，`message` 是 `Network Error`。 */
export function axiosNetworkError(): AxiosError {
  return new AxiosError("Network Error");
}
