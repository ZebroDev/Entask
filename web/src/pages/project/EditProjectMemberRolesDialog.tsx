import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { localTimeZoneId } from "@/lib/local-day";
import { apiErrorMessage } from "@/lib/utils";
import { roleNameLabel } from "@/lib/role-labels";
import type { ProjectMemberResponse, ProjectResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

interface TeamRoleDto {
  id: string;
  name: string;
  /** `TeamRoleResponse.Code`；自訂角色是 null ⇒ 顯示退回 `name`。 */
  code?: string | null;
  description: string | null;
  isSystem: boolean;
  permissionCodes: string[];
}

interface TeamDetailDto {
  id: string;
  name: string;
  description: string | null;
  roles: TeamRoleDto[];
}

interface Props {
  projectId: string;
  member: ProjectMemberResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditProjectMemberRolesDialog({ projectId, member, open, onOpenChange }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const qc = useQueryClient();
  const [checked, setChecked] = useState<string[]>([]);

  // 取得專案以獲取 teamId
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}`)).data as ProjectResponse,
    enabled: open,
  });

  // 取得團隊可指派角色列表
  const team = useQuery({
    queryKey: ["team", project?.teamId],
    queryFn: async () =>
      (await api.get(`/teams/${project!.teamId}`, { headers: { "X-Team-Id": project!.teamId } })).data as TeamDetailDto,
    enabled: open && !!project?.teamId,
  });

  // 當開啟對話框或成員變更時，初始化勾選的角色清單
  useEffect(() => {
    if (member && open) {
      const initialRoleIds = member.roles?.map((r) => r.id) ?? member.roleIds ?? [];
      setChecked(initialRoleIds);
    }
  }, [member, open]);

  const updateRoles = useMutation({
    mutationFn: async () => {
      if (!member) return;
      if (checked.length === 0) {
        throw new Error(t("project:member.roles.required"));
      }
      // `timeZoneId` 是發起人時區（後端選填；缺漏 ⇒ UTC）：它只寫在**被新增的列**上——既有列是
      // 角色編輯、不是重新到職，`JoinedLocalDate` 不重寫；純角色編輯（不新增角色）時這一行
      // 不會改變任何列的到職日（後端 update-role 站的明文）。
      return api.put(`/projects/${projectId}/members/${member.userId}`, { roleIds: checked, timeZoneId: localTimeZoneId() });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["project-members", projectId] });
      toast.success(t("project:member.roles.update.success"));
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, t("project:member.roles.update.error")));
    },
  });

  const toggleRole = (roleId: string, isChecked: boolean) => {
    setChecked((prev) => (isChecked ? [...prev, roleId] : prev.filter((id) => id !== roleId)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("project:member.roles.edit.title")}</DialogTitle>
          <DialogDescription>
            {t("project:member.roles.edit.description", { name: member?.displayName, username: member?.username })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t("project:member.roles.edit.label")}</Label>
            {team.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("project:member.roles.loading")}</p>
            ) : team.isError ? (
              <p className="text-sm text-destructive">{t("project:member.roles.load.error")}</p>
            ) : (
              <div className="grid gap-2 max-h-60 overflow-y-auto pr-1">
                {(team.data?.roles ?? []).map((r) => {
                  const isChecked = checked.includes(r.id);
                  return (
                    <label
                      key={r.id}
                      className="flex items-center gap-2.5 rounded-md border p-2.5 text-sm cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <input
                        type="checkbox"
                        className="rounded border-input text-primary focus:ring-primary"
                        checked={isChecked}
                        onChange={(e) => toggleRole(r.id, e.target.checked)}
                      />
                      <div className="flex flex-1 items-center justify-between">
                        <span className="font-medium">{roleNameLabel(r.code, r.name)}</span>
                        {r.isSystem && (
                          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {t("project:member.role.system")}
                          </span>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={updateRoles.isPending}>
            {t("common:action.cancel")}
          </Button>
          <Button
            onClick={() => updateRoles.mutate()}
            disabled={updateRoles.isPending || checked.length === 0 || team.isLoading}
          >
            {updateRoles.isPending ? t("common:state.saving") : t("project:member.roles.save.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
