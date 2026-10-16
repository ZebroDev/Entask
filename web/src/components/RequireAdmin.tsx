import { Navigate } from "react-router-dom";
import { useAuth } from "@/stores/auth";

// 形狀照 `RequireAuth.tsx`（`user` 的訂閱方式逐字相同）。
//
// 落點是 `/projects` 而不是 `/login`：這一條閘門是在 `RequireAuth` **之內**跑的
// （路由表把它掛在 `<RequireAuth><AppLayout /></RequireAuth>` 底下），能走到這裡的人
// 一定已經登入，只是不是 admin。彈去登入頁會把他登出一個他明明進得去的 session。
//
// 非 admin 走 `isAdmin` 為 falsy 的預設落點即可，不另外分辨 undefined（`user` 缺席時
// 由外層的 `RequireAuth` 先處理）。後端仍是 authority——`/api/admin/users` 每條路由
// 都自己再驗一次 admin（`AdminUserEndpoints.cs` 的 `RequireAdminAsync`）。
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  if (!user?.isAdmin) return <Navigate to="/projects" replace />;
  return <>{children}</>;
}
