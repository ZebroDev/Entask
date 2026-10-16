import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

interface BoardInfo {
  id: string;
  name: string;
  description?: string | null;
  projectId: string;
}

interface Props {
  board: BoardInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (updated: { name: string; description: string | null }) => void;
}

export function EditBoardDialog({ board, open, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation(["common", "board"]);
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description || "");
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setName(board.name);
      setDescription(board.description || "");
    }
  }, [open, board]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t("board:edit.name.required"));
      return;
    }
    setSubmitting(true);
    try {
      await api.put(`/boards/${board.id}`, {
        name: name.trim(),
        description: description.trim() || null,
      });
      queryClient.invalidateQueries({ queryKey: ["boards", board.projectId] });
      queryClient.invalidateQueries({ queryKey: ["board", board.id] });
      toast.success(t("board:edit.success"));
      onSuccess?.({ name: name.trim(), description: description.trim() || null });
      onOpenChange(false);
    } catch (error) {
      // 錯誤 body 自 P-C 起是 { code, message }；舊寫法把整個物件交給 sonner，
      // React 對它拋「Objects are not valid as a React child」（全站無 ErrorBoundary）。
      toast.error(apiErrorMessage(error, t("board:edit.error")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("board:edit.title")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-4 pt-2"
        >
          <div className="space-y-1.5">
            <Label htmlFor="edit-board-name">
              {t("board:edit.name.label")} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-board-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("board:edit.name.placeholder")}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-board-desc">{t("board:edit.description.label")}</Label>
            <Input
              id="edit-board-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("board:edit.description.placeholder")}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              {t("common:action.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("common:state.saving") : t("common:action.saveChanges")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
