import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import type { CustomFieldResponse } from "@/lib/board-types";
import { scopeLabel, typeLabel } from "@/lib/custom-fields";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CustomFieldDialog } from "./CustomFieldDialog";
import { useTranslation } from "react-i18next";

interface Props { projectId: string; canEditProject: boolean; canEditBoard: boolean; }

export function CustomFieldsTab({ projectId, canEditProject, canEditBoard }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CustomFieldResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldResponse | null>(null);
  const queryClient = useQueryClient();

  const openCreate = () => {
    setEditTarget(null);
    setDialogOpen(true);
  };

  const openEdit = (field: CustomFieldResponse) => {
    setEditTarget(field);
    setDialogOpen(true);
  };

  const fields = useQuery({
    queryKey: ["custom-fields", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/custom-fields`)).data as CustomFieldResponse[],
  });

  const deleteField = useMutation({
    mutationFn: async (field: CustomFieldResponse) =>
      field.scopeType === "project"
        ? api.delete(`/projects/${projectId}/custom-fields/${field.id}`)
        : api.delete(`/boards/${field.scopeId}/custom-fields/${field.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-fields", projectId] });
      toast.success(t("project:field.delete.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.delete"))),
  });

  if (fields.isLoading) return <p className="text-muted-foreground">{t("common:state.loading")}</p>;
  if (fields.isError) {
    const detail = apiErrorMessage(fields.error, t("common:error.tryLater"));
    return <p className="text-destructive">{t("common:error.loadDetail", { detail })}</p>;
  }

  return (
    <div>
      {/* 新增與編輯各自獨立：新增走這顆按鈕開對話框，編輯走每一列自己的對話框，
          不再共用同一個表單（共用會出現「按了編輯卻看不到在改哪一列」的問題） */}
      {canEditProject && (
        <div className="mb-4">
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("project:field.add.action")}
          </Button>
        </div>
      )}
      {/* 手機窄螢幕以橫向捲動取代逐字換行直排 */}
      <Card className="overflow-x-auto">
        <Table className="whitespace-nowrap">
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("project:field.name.label")}</TableHead>
              <TableHead>{t("project:field.type.label")}</TableHead>
              <TableHead>{t("project:field.scope.label")}</TableHead>
              <TableHead>{t("project:field.options.label")}</TableHead>
              {(canEditProject || canEditBoard) && <TableHead>{t("common:column.actions")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(fields.data ?? []).map((f) => {
              const canEditRow = f.scopeType === "project" ? canEditProject : canEditBoard;
              return (
                <TableRow key={f.id}>
                  <TableCell>{f.name}</TableCell>
                  <TableCell>{typeLabel(f.type)}</TableCell>
                  <TableCell>{scopeLabel(f.scopeType)}</TableCell>
                  {/* 清單分隔符是**語系**的性質，走語系檔而不是 Intl：`Intl.ListFormat`
                      的 `narrow/unit` 在 zh-TW 直接把項目黏起來（`高中低`），
                      `conjunction` 會插入「和」／「and」——都改變了現行輸出。
                      分隔符是標點、不是清單語意，本來就該由譯文決定（B2-7 定案）。 */}
                  <TableCell>{f.options?.join(t("common:separator.list")) ?? "—"}</TableCell>
                  {canEditRow && (
                    <TableCell className="whitespace-nowrap space-x-1">
                      <Button variant="outline" size="sm" onClick={() => openEdit(f)}>{t("common:action.edit")}</Button>
                      <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(f)}>{t("common:action.delete")}</Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <CustomFieldDialog
        projectId={projectId}
        field={editTarget}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTarget(null);
        }}
      />
      {/* 刪欄位確認（spec #20）：明示後果，確認才呼叫 API。型態變更的後果則在
          CustomFieldDialog 內以警示列說明，不另開對話框疊在表單上。 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project:field.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("project:field.delete.confirm", { name: deleteTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteTarget) deleteField.mutate(deleteTarget); }}>
              {t("common:action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
