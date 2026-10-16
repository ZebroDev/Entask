import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { serverMessage } from "@/lib/error-messages";
import { roleNameLabel } from "@/lib/role-labels";
import { usePermissions } from "@/hooks/use-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RoleEditDialog } from "./RoleEditDialog";
import { useTranslation } from "react-i18next";

// `code` 是 `TeamRoleResponse.Code`（後端本來就有送）；**顯示走 `roleNameLabel`，
// 編輯表單（`RoleEditDialog`）不走**——那裡預填的是要寫回 DB 的值。
interface TeamRoleDto { id: string; name: string; code?: string | null; description?: string | null; isSystem: boolean; permissionCodes: string[]; }

export function TeamRolesTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation(["common", "team"]);
  const qc = useQueryClient();
  const { data: roles, isError } = useQuery({
    queryKey: ["team-roles", teamId],
    queryFn: async () => (await api.get(`/teams/${teamId}/roles`)).data as TeamRoleDto[],
  });

  const { data: mine } = usePermissions();
  const canManage = mine?.includes("team.role.manage");
  const [deleteTarget, setDeleteTarget] = useState<TeamRoleDto | null>(null);

  const remove = async (role: TeamRoleDto) => {
    try {
      await api.delete(`/teams/${teamId}/roles/${role.id}`);
      await qc.invalidateQueries({ queryKey: ["team-roles", teamId] });
      toast.success(t("team:role.delete.success"));
    } catch (error) {
      const detail = isAxiosError(error) ? serverMessage(error.response?.data) : null;
      toast.error(detail ? t("common:error.deleteDetail", { detail }) : t("team:role.delete.error"));
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t("team:role.heading")}</CardTitle>
        {canManage && <RoleEditDialog teamId={teamId} />}
      </CardHeader>
      <CardContent className="space-y-3">
        {isError && <p className="text-destructive">{t("common:error.loadRetry")}</p>}
        {!isError && (roles ?? []).map((r) => (
          <div key={r.id} className="flex items-center justify-between rounded border p-3">
            <div>
              <div className="flex items-center gap-2 font-medium">
                {roleNameLabel(r.code, r.name)}
                {r.isSystem ? <Badge variant="outline">{t("team:role.system.badge")}</Badge> : <Badge>{t("team:role.custom.badge")}</Badge>}
              </div>
              {/* 同 CustomFieldsTab 的清單分隔符：走語系檔，不用 Intl.ListFormat */}
              <div className="text-xs text-muted-foreground">{r.permissionCodes.join(t("common:separator.list"))}</div>
            </div>
            {!r.isSystem && canManage && (
              <div className="flex gap-2">
                <RoleEditDialog teamId={teamId} role={r} />
                <Button variant="outline" size="sm" onClick={() => setDeleteTarget(r)}>{t("common:action.delete")}</Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
      {/* 刪除角色確認（spec #20）：確認才呼叫 API */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("team:role.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("team:role.delete.confirm", { name: deleteTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteTarget) remove(deleteTarget); }}>
              {t("common:action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
