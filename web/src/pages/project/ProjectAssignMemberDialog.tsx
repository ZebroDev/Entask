import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { serverMessage } from "@/lib/error-messages";
import { localTimeZoneId } from "@/lib/local-day";
import { roleNameLabel } from "@/lib/role-labels";
import type { ProjectResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";

interface TeamRoleDto { id: string; name: string; code?: string | null; description: string | null; isSystem: boolean; permissionCodes: string[]; }
interface TeamMemberDto { userId: string; username: string; displayName: string; roles: TeamRoleDto[]; deactivated: boolean; }
interface TeamDetailDto { id: string; name: string; description: string | null; members: TeamMemberDto[]; roles: TeamRoleDto[]; }

interface Props {
  projectId: string;
  disabled: boolean;
  onAssigned: () => void;
}

// 專案成員指派：呼叫 POST /api/projects/{id}/members（body: { userId, roleIds }）。
// 角色來源 = 系統範本 + 專案所屬團隊的自訂角色（後端仍驗證角色有效性）。
// 使用者下拉 = 專案所屬團隊成員（後端端點需要 userId，無使用者搜尋端點）。
export function ProjectAssignMemberDialog({ projectId, disabled, onAssigned }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [checked, setChecked] = useState<string[]>([]);

  // 與 ProjectPage 共用 ["project", projectId] 快取，取得 teamId
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}`)).data as ProjectResponse,
  });

  const team = useQuery({
    queryKey: ["team", project?.teamId],
    queryFn: async () =>
      // 以專案的 teamId 帶顯式 header，避免攔截器注入的「目前團隊」不同而 403
      (await api.get(`/teams/${project!.teamId}`, { headers: { "X-Team-Id": project!.teamId } })).data as TeamDetailDto,
    enabled: !!project?.teamId,
  });

  const submit = async () => {
    if (!userId || checked.length === 0) { toast.error(t("project:member.assign.required")); return; }
    try {
      // `timeZoneId` 是發起人時區（後端選填；缺漏 ⇒ UTC）：後端用它凍結新成員的到職本地日。
      await api.post(`/projects/${projectId}/members`, { userId, roleIds: checked, timeZoneId: localTimeZoneId() });
      await qc.invalidateQueries({ queryKey: ["project-members", projectId] });
      toast.success(t("project:member.assign.success"));
      onAssigned();
      setOpen(false);
      setUserId("");
      setChecked([]);
    } catch (error) {
      const detail = isAxiosError(error) ? serverMessage(error.response?.data) : null;
      toast.error(detail ? t("common:error.assignDetail", { detail }) : t("common:error.assign"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" disabled={disabled}>{t("project:member.assign.action")}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("project:member.assign.title")}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="assign-member">{t("project:member.label")}</Label>
            {team.isError ? (
              <p className="text-sm text-destructive">{t("project:member.load.error")}</p>
            ) : (
              <Select
                value={userId === "" ? "__none__" : userId}
                onValueChange={(v) => setUserId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger id="assign-member" className="w-full rounded-md border p-2">
                  <SelectValue placeholder={t("common:select.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("common:select.placeholder")}</SelectItem>
                  {(team.data?.members ?? []).map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>{t("common:member.display", { name: m.displayName, username: m.username })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1">
            <Label>{t("project:member.roles.label")}</Label>
            <div className="grid gap-2">
              {(team.data?.roles ?? []).map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked.includes(r.id)}
                    onChange={(e) =>
                      setChecked((prev) =>
                        e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id))}
                  />
                  {roleNameLabel(r.code, r.name)}
                  {r.isSystem && <span className="text-xs text-muted-foreground">{t("project:member.role.template")}</span>}
                </label>
              ))}
            </div>
          </div>
          <Button className="w-full" onClick={submit}>{t("project:member.assign.confirm.action")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
