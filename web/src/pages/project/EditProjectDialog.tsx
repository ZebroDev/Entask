import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

interface Props {
  projectId: string;
  name: string;
  description: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

export function EditProjectDialog({ projectId, name, description, open, onOpenChange, onUpdated }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const [newName, setNewName] = useState(name);
  const [newDescription, setNewDescription] = useState(description ?? "");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!newName.trim()) {
      toast.error(t("project:name.required"));
      return;
    }
    setSubmitting(true);
    try {
      // 後端為 patch 語意（null = 不變更），清空敘述須送空字串
      await api.put(`/projects/${projectId}`, {
        name: newName.trim(),
        description: newDescription.trim(),
      });
      onUpdated();
      onOpenChange(false);
      toast.success(t("project:edit.success"));
    } catch (error) {
      toast.error(apiErrorMessage(error, t("common:error.update")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("project:edit.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="edit-project-name">{t("project:name.label")}</Label>
            <Input id="edit-project-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-project-desc">{t("project:description.label")}</Label>
            <textarea
              id="edit-project-desc"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={t("project:description.placeholder")}
              className="h-24 w-full rounded border p-2 text-sm"
            />
          </div>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? t("common:state.saving") : t("common:action.saveChanges")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
