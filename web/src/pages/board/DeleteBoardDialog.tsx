import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

interface BoardInfo {
  id: string;
  name: string;
  projectId: string;
}

interface Props {
  board: BoardInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function DeleteBoardDialog({ board, open, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation(["common", "board"]);
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();

  const handleDelete = async () => {
    setSubmitting(true);
    try {
      await api.delete(`/boards/${board.id}`);
      queryClient.invalidateQueries({ queryKey: ["boards", board.projectId] });
      toast.success(t("board:delete.success"));
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      // 錯誤 body 自 P-C 起是 { code, message }；舊寫法把整個物件交給 sonner，
      // React 對它拋「Objects are not valid as a React child」（全站無 ErrorBoundary）。
      toast.error(apiErrorMessage(error, t("board:delete.error")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("board:delete.confirm")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("board:delete.description", { name: board.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t("common:action.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            disabled={submitting}
            className={buttonVariants({ variant: "destructive" })}
          >
            {submitting ? t("common:state.deleting") : t("board:delete.submit.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
