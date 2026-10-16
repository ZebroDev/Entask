import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { serverMessage } from "@/lib/error-messages";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 錯誤的唯一出口（設計 §6.2）。
 *
 * 順序：伺服器說的（code 譯文 → message → detail → 裸字串）→ 呼叫端的 fallback。
 *
 * 設計 §6.2 的四條舊路徑已全部收斂到這裡；`LoginPage` 刻意維持忽略伺服器訊息
 * （登入失敗不分「帳號不存在」與「密碼錯誤」是安全性質，不是遺漏）。
 *
 * **刻意不退回 `error.message`（2026-09-19，final review 的 F-1）**：對 axios 而言
 * 那是**傳輸層字串**（`Request failed with status code 403`／`Network Error`），
 * 正是這條管線要消滅的東西；退回它就等於讓使用者看到 HTTP 狀態碼。會走到最後一行的
 * 是**伺服器沒說話**的那些回應：
 *   ① **未處理的例外**（500）——**2026-09-21 起由 `Program.cs` 的中介層接手**
 *      （`ApiResults.WriteInternalErrorAsync`），所以它**已經不在最後一行**：body 是
 *      `{code, message}`（`server.internalError`），走上面的譯文分支。
 *      **剩下來的殘餘是那個中介層刻意不處理的兩種情形**——回應已經開始
 *      （`context.Response.HasStarted`，寫不進去了）與請求已中止——那兩條路徑
 *      **今天沒有任何測試走得到**（2026-09-21 的 M3 實測：拿掉 `HasStarted` 那一格，
 *      測試 6/6 照綠），所以「這裡還走得到」是**推論、未實測**。
 *      **上一版的敘述（「沒有例外中介層 ⇒ 空 body 的 500」）已隨該中介層失效**；
 *      它當時還有一個錯：在 Development 下 `WebApplication` 會隱式加
 *      `UseDeveloperExceptionPage`，未處理的例外其實是**整份型別＋訊息＋堆疊外洩**，
 *      不是空 body（2026-09-21 的 T6 先紅實測）。
 *   ② **網路層失敗**（`Network Error`，根本沒有 response）。
 *   ③ **路由層的 404**（請求打到沒有註冊的路徑）——**這一項只在開發版面成立**：
 *      本機沒有 `wwwroot/index.html`，所以它真的是空 body 的 404；部署映像裡
 *      `Dockerfile.fly` 把 `web/dist` 複製進 `wwwroot`，而 `Program.cs` 的
 *      `MapFallbackToFile("index.html")` 只被 `File.Exists` 守著、**沒有排除 `/api`**
 *      ⇒ 同一個請求回的是 index.html 的 200。
 * 帶 code 的錯誤一律走上面的譯文分支，不會到最後一行。**401 自 2026-09-20 起也在那一側**
 * ——`Results.Unauthorized()` 與 JwtBearer 的認證挑戰都改走 `ApiResults.Unauthorized`
 * 了，所以這一格原本列在第一位、被標成「實務上最常撞到的一種」的空 body 401 **已經不在這裡**
 * （`axiosStatus` 的檔頭原本也是拿 401 當那個例子，一併改掉了）。
 *
 * ⇒ `fallback` 是**最後一道**，不是「非 Error 專用」；呼叫端傳進來的必須是完整的
 * 譯文（全庫一律是 `t(...)`），因為它現在是「伺服器沒說話」時唯一的顯示字串。
 * 開發者要看的原始物件請走 `console.error("…", error)`，不要靠這條管線。
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error !== null && typeof error === "object") {
    const data = (error as { response?: { data?: unknown } }).response?.data;
    const fromServer = serverMessage(data);
    if (fromServer !== null) return fromServer;
  }
  return fallback;
}
