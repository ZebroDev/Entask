import { useState, useEffect } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Edit2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TeamDto { id: string; name: string; description?: string | null; }

interface Props {
  team: TeamDto;
  onUpdated?: (updated: TeamDto) => void;
  trigger?: React.ReactNode;
}

export function EditTeamDialog({ team, onUpdated, trigger }: Props) {
  const { t } = useTranslation(["common", "team"]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description || "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(team.name);
      setDescription(team.description || "");
    }
  }, [open, team]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t("team:edit.name.required"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.put("/teams/" + team.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      const updated = res.data as TeamDto;
      toast.success(t("team:edit.success"));
      setOpen(false);
      onUpdated?.(updated);
    } catch (error: unknown) {
      toast.error(apiErrorMessage(error, t("team:edit.error")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            <Edit2 className="h-4 w-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team:edit.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-team-name">{t("team:name.label")} <span className="text-destructive">*</span></Label>
            <Input
              id="edit-team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("team:edit.name.placeholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-team-desc">{t("team:description.label")}</Label>
            <Input
              id="edit-team-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("team:description.placeholder")}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>
              {t("common:action.cancel")}
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? t("common:state.saving") : t("common:action.saveChanges")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
