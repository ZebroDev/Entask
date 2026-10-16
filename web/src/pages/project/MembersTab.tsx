import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ProjectMemberResponse } from "@/lib/board-types";
import { apiErrorMessage } from "@/lib/utils";
import { roleNameLabel } from "@/lib/role-labels";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { ProjectAssignMemberDialog } from "./ProjectAssignMemberDialog";
import { EditProjectMemberRolesDialog } from "./EditProjectMemberRolesDialog";
import { useTranslation } from "react-i18next";

interface Props { projectId: string; canManage: boolean; }

export function MembersTab({ projectId, canManage }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/members`)).data as ProjectMemberResponse[],
  });
  const [removeTarget, setRemoveTarget] = useState<ProjectMemberResponse | null>(null);
  const [editingMember, setEditingMember] = useState<ProjectMemberResponse | null>(null);

  const remove = useMutation({
    mutationFn: async (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
      toast.success(t("project:member.remove.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.remove"))),
  });

  if (members.isLoading) return <p className="text-muted-foreground">{t("common:state.loading")}</p>;
  if (members.isError) {
    const detail = apiErrorMessage(members.error, t("common:error.tryLater"));
    return <p className="text-destructive">{t("common:error.loadDetail", { detail })}</p>;
  }

  return (
    <div>
      <div className="mb-4">
        <ProjectAssignMemberDialog
          projectId={projectId}
          disabled={!canManage}
          onAssigned={() => queryClient.invalidateQueries({ queryKey: ["project-members", projectId] })}
        />
      </div>
      <Card className="overflow-x-auto">
        <Table className="whitespace-nowrap">
          <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead>{t("project:member.column.user")}</TableHead>
            <TableHead>{t("project:member.column.roles")}</TableHead>
            {canManage && <TableHead className="w-[180px]">{t("common:column.actions")}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {(members.data ?? []).map((m) => (
            <TableRow key={m.userId}>
              <TableCell className="font-medium">
                {t("common:member.display", { name: m.displayName, username: m.username })}
              </TableCell>
              <TableCell>
                {m.roles && m.roles.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {m.roles.map((r) => (
                      <Badge key={r.id} variant="secondary">
                        {roleNameLabel(r.code, r.name)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">{t("project:member.noRoles")}</span>
                )}
              </TableCell>
              {canManage && (
                <TableCell className="space-x-2">
                  <Button variant="outline" size="sm" onClick={() => setEditingMember(m)}>
                    {t("project:member.roles.edit.action")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setRemoveTarget(m)}>
                    {t("common:action.remove")}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </Card>

      <EditProjectMemberRolesDialog
        projectId={projectId}
        member={editingMember}
        open={editingMember !== null}
        onOpenChange={(open) => !open && setEditingMember(null)}
      />
      {/* 移除專案成員確認（spec #20）：確認才呼叫 API */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project:member.remove.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("project:member.remove.confirm", { name: removeTarget?.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (removeTarget) remove.mutate(removeTarget.userId); }}>
              {t("common:action.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
