import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  MY_TEAM_PERMISSIONS_QUERY_KEY,
  useCanManageTeam,
} from "@/hooks/use-has-team-management";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export function RequireTeamManagement({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation(["common"]);
  const { teamId } = useParams<{ teamId: string }>();
  const { canManage, isLoading, isError } = useCanManageTeam(teamId);
  const queryClient = useQueryClient();
  const sessionTeamId = useAuth((s) => s.teamId);
  const setTeamId = useAuth((s) => s.setTeamId);
  // route 與 session 團隊不一致（如新分頁開書籤後登入導回）時，請求會帶錯／無 X-Team-Id
  const needsTeamSwitch = !!teamId && sessionTeamId !== teamId;

  useEffect(() => {
    if (canManage && needsTeamSwitch) setTeamId(teamId!);
  }, [canManage, needsTeamSwitch, teamId, setTeamId]);

  // 權限清單未回來前（data 尚為 undefined）不可判定無權限，否則合法管理者會被彈走
  if (isLoading) return null;

  // 閘門：X-Team-Id 歸位前不得渲染 children——passive effect 子先父後，
  // 少了這道閘門 TeamPage 的 query 會先帶舊／無 header 打出去（403／400）並污染快取
  if (canManage && needsTeamSwitch) return null;

  // transient 失敗不重導（重導會把合法管理者鎖在門外），僅提供重試；後端仍是 authority
  if (isError) {
    return (
      <div className="flex-1 bg-background p-8">
        <p className="text-center text-muted-foreground">{t("common:error.load")}</p>
        <div className="mt-4 text-center">
          <Button
            variant="outline"
            onClick={() => {
              queryClient.refetchQueries({ queryKey: MY_TEAM_PERMISSIONS_QUERY_KEY });
            }}
          >
            {t("common:action.retry")}
          </Button>
        </div>
      </div>
    );
  }

  // 落點 /teams 即 TeamSelectPage 既有的非管理者引導卡，不另做 UI
  if (!canManage) return <Navigate to="/teams" replace />;

  return <>{children}</>;
}
