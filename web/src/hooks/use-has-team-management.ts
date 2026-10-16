import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";

interface TeamPermissionsDto {
  teamId: string;
  codes: string[];
}

// 兩個 hook 共用同一 queryKey／queryFn（同快取、零額外請求），避免各自演化
export const MY_TEAM_PERMISSIONS_QUERY_KEY = ["my-team-permissions"] as const;

function useTeamPermissions() {
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;

  const query = useQuery({
    queryKey: MY_TEAM_PERMISSIONS_QUERY_KEY,
    queryFn: async () =>
      (await api.get("/teams/my-permissions")).data as TeamPermissionsDto[],
    enabled: !!user && !isAdmin,
  });

  return { isAdmin, query };
}

export function useHasTeamManagement() {
  const { isAdmin, query } = useTeamPermissions();

  const canManageTeams =
    isAdmin || (query.data ?? []).some((p) => p?.codes?.includes("team.read"));

  return {
    canManageTeams,
    isLoading: isAdmin ? false : query.isLoading,
  };
}

// per-team 語意：必須是「這一隊」有 team.read；若沿用「任一隊」，
// A 隊經理手打 /teams/B 會被前端放行，再被後端以 route teamId ≠ header teamId 擋成整頁 403
export function useCanManageTeam(teamId: string | undefined): {
  canManage: boolean;
  isLoading: boolean;
  isError: boolean;
} {
  const { isAdmin, query } = useTeamPermissions();

  const canManage =
    isAdmin ||
    (query.data ?? []).some(
      (p) => p?.teamId === teamId && p?.codes?.includes("team.read"),
    );

  return {
    canManage,
    isLoading: isAdmin ? false : query.isLoading,
    // admin 時 query 為 disabled，快取殘留的錯誤狀態不可外洩（否則管理員會看到載入失敗）
    isError: isAdmin ? false : query.isError,
  };
}

// per-team 語意同 `useCanManageTeam`，但閘的是**管理成員**而不是「看得到團隊」。
// 兩者刻意分開：`RequireTeamManagement` 閘的是 `team.read` ⇒ 只有 team.read 的成員
// **進得去** `/teams/:teamId`（看得見成員清單）；而成員異動與 `GET /api/auth/users`
// 要的是 `team.member.manage`。少了這一支，那一頁會出現一個按下去必 403 的入口。
export function useCanManageTeamMembers(teamId: string | undefined): {
  canManageMembers: boolean;
} {
  const { isAdmin, query } = useTeamPermissions();

  const canManageMembers =
    isAdmin ||
    (query.data ?? []).some(
      (p) => p?.teamId === teamId && p?.codes?.includes("team.member.manage"),
    );

  return { canManageMembers };
}

// per-team 語意同 `useCanManageTeam`，但閘的是**改動工作日曆**而不是「看得到團隊」。
// 這一碼會改動全團隊的報表數字，所以與 team.member.manage 一樣只給團隊經理。
export function useCanManageWorkCalendar(teamId: string | undefined): {
  canManageWorkCalendar: boolean;
} {
  const { isAdmin, query } = useTeamPermissions();

  const canManageWorkCalendar =
    isAdmin ||
    (query.data ?? []).some(
      (p) => p?.teamId === teamId && p?.codes?.includes("team.workcalendar.manage"),
    );

  return { canManageWorkCalendar };
}
