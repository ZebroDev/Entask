import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { serverMessage } from "@/lib/error-messages";
import { roleNameLabel } from "@/lib/role-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AssignMemberDialog } from "./AssignMemberDialog";
import { CreateUserDialog } from "./CreateUserDialog";
import { useCanManageTeamMembers } from "@/hooks/use-has-team-management";
import { useAuth } from "@/stores/auth";
import { useTranslation } from "react-i18next";

// `code` 是 `TeamRoleResponse.Code`（後端本來就有送）——六個系統角色的穩定識別碼，
// 自訂角色是 null。顯示端一律走 `roleNameLabel`（見 lib/role-labels.ts）。
interface TeamRoleDto { id: string; name: string; code?: string | null; isSystem: boolean; permissionCodes: string[]; }
interface MemberDto { userId: string; username: string; displayName: string; roles: TeamRoleDto[]; deactivated: boolean; }
interface TeamDetailDto { id: string; name: string; description?: string | null; members: MemberDto[]; roles: TeamRoleDto[]; }

export function TeamMembersTab({ teamId }: { teamId: string }) {
  // 「王小明（alice）」的人員格式原本借用 `card:member.display`（B2-6a 的第三個消費者），
  // CardDialog／MembersTab 已定案，團隊成員清單沿用同一條（B2-6a review 收斂，
  // 原本另立 team:member.usernameSuffix，同一種格式會有兩份真相）。
  const { t } = useTranslation(["common", "team"]);
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin;
  // 這一頁的**兩個管理入口**（「指派成員」與列內「移除」）吃同一個判準，因為它們的後端
  // 要的都是 team.member.manage：`PUT`／`DELETE /api/teams/{id}/members[...]` 與
  // `GET /api/auth/users`。進來這一頁的 `RequireTeamManagement` 閘的卻是 **team.read**
  // ⇒ 少了這個判準，只有 team.read 的成員會看到兩個按下去必 403 的入口。
  // 「這一頁對 team.read 成員應該長怎樣」＝**唯讀清單**（使用者 2026-09-23 裁定）。
  const { canManageMembers } = useCanManageTeamMembers(teamId);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["team", teamId],
    queryFn: async () => (await api.get(`/teams/${teamId}`)).data as TeamDetailDto,
  });
  const [removeTarget, setRemoveTarget] = useState<MemberDto | null>(null);

  const removeMember = async (userId: string) => {
    try {
      await api.delete(`/teams/${teamId}/members/${userId}`);
      await qc.invalidateQueries({ queryKey: ["team", teamId] });
      toast.success(t("team:member.remove.success"));
    } catch (error) {
      const detail = isAxiosError(error) ? serverMessage(error.response?.data) : null;
      toast.error(detail ? t("common:error.removeDetail", { detail }) : t("common:error.remove"));
    }
  };

  if (isError) return <p className="p-4 text-destructive">{t("common:error.loadRetry")}</p>;
  if (isLoading || !data)
    return (
      <div className="space-y-2 p-4" data-testid="team-members-skeleton">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );

  return (
    <Card>
      <CardHeader className="flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t("team:member.heading", { n: data.members.length })}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && <CreateUserDialog />}
          {canManageMembers && <AssignMemberDialog teamId={teamId} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.members.map((m) => (
          <div key={m.userId} className="flex items-center justify-between rounded border p-3">
            <div>
              <div className="font-medium">{t("common:member.display", { name: m.displayName, username: m.username })}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {/* 名冊保留停用者並標記（設計 D7）——不標的話，這一列與一個正常成員
                    長得一模一樣，而他能做的事少了一整批 */}
                {m.deactivated && <Badge variant="outline">{t("common:state.deactivated")}</Badge>}
                {m.roles.map((r) => <Badge key={r.id} variant="secondary">{roleNameLabel(r.code, r.name)}</Badge>)}
              </div>
            </div>
            {canManageMembers && (
              <Button variant="outline" size="sm" onClick={() => setRemoveTarget(m)}>{t("common:action.remove")}</Button>
            )}
          </div>
        ))}
        {data.members.length === 0 && <p className="text-muted-foreground">{t("team:member.empty")}</p>}
      </CardContent>
      {/* 移除成員確認（spec #20）：確認才呼叫 API */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("team:member.remove.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("team:member.remove.confirm", { name: removeTarget?.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (removeTarget) removeMember(removeTarget.userId); }}>
              {t("common:action.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
