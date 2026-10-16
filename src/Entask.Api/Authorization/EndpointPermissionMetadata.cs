namespace Entask.Api.Authorization;

// 這兩個標記的唯一用途是**讓權限守衛在端點圖上看得見**。
//
// `RequireProjectPermission` 與 `RequirePermission` 是篩選器擴充方法而不是 attribute
// ——它們直接換掉 `RequestDelegate`（見各自檔案裡 `builder.Add(...)` 那一段），
// 端點圖上不留任何痕跡。於是「這個端點被誰守著」沒有任何工具問得出來，只能靠人記得寫；
// 忘了掛權限守衛的端點只會被 `EndpointAuthorizationGuardTests` 逼著補一句話當理由，而那句話
// **機器驗不了**（該檔的盲區⑥）。2026-10-10 起 `Program.cs` 有 fallback policy，但它只要求
// 「已認證」——代價由「匿名可用」降成「任何已登入的人可用」，並沒有消失。
//
// 這兩個 record 本身**不參與執行期判斷**——判斷仍然在篩選器的委派裡。
// 它們只是 metadata。目前唯一的消費者是 `EndpointAuthorizationGuardTests`。
//
// 隔壁的 `RequireProjectPermissionAttribute` / `RequirePermissionAttribute`（掛
// `[AttributeUsage(AttributeTargets.Method)]` 的**另一個**類別，與這裡的 record 無關）
// 實查（2026-09-23）：全庫沒有任何 `[RequireProjectPermission(...)]` 套用，也沒有任何
// 地方讀它——兩個都是活的死碼。**留意它的形狀**：把那個 attribute 套在具名 handler 方法
// （例如 `ProjectCardEndpoints.GetProjectCards`）上**曾經**是可以編譯的，而且**什麼都不會做**
// ——端點看起來被守著，實際上是匿名的。2026-09-23 起那兩個類別各掛了 `[Obsolete(error: true)]`
// ⇒ 同樣的寫法當場 `CS0619`（訊息直接指向該用的擴充方法），而守門員是 `DeadAttributeGuardTests`
// ——它守的是那道防線本身，因為 `[Obsolete]` 只有反射看得見。這一類正是本檔要消滅的
// 「守衛是 opt-in」的同型缺陷，而它會被 `EndpointAuthorizationGuardTests` 抓到（沒有 metadata ⇒ 紅）。

/// <summary>專案範圍權限（`RequireProjectPermission`）；`Codes` 是「任一成立即放行」的那組碼。</summary>
public sealed record ProjectPermissionMetadata(IReadOnlyList<string> Codes);

/// <summary>團隊範圍權限（`RequirePermission`）。</summary>
public sealed record TeamPermissionMetadata(string Code);
