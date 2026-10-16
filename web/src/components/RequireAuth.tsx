import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/stores/auth";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
