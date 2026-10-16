import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDeleteWorkCalendarException,
  useUpsertWorkCalendarException,
  type WorkCalendarEntry,
} from "@/hooks/use-work-calendar";

interface Props {
  teamId: string;
  /** null = 新增；帶值 = 編輯該日（日期是識別碼，唯讀） */
  entry: WorkCalendarEntry | null;
  /** 新增時的預設日期（entry 帶值時不採用） */
  defaultDate?: string;
}

export function WorkCalendarExceptionDialog({ teamId, entry, defaultDate }: Props) {
  const { t } = useTranslation(["common", "workcalendar"]);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(entry?.date ?? defaultDate ?? "");
  const [kind, setKind] = useState<"Holiday" | "Workday">(entry?.kind ?? "Holiday");
  const [name, setName] = useState(entry?.name ?? "");

  const upsert = useUpsertWorkCalendarException(teamId);
  const remove = useDeleteWorkCalendarException(teamId);

  // 每次開啟都重設欄位：同一個對話框實例會被 React 沿用到下一次開啟（同一列重開、
  // 或新增完再開一次）⇒ 少了這一步會帶著上一次的殘值送出。
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDate(entry?.date ?? defaultDate ?? "");
      setKind(entry?.kind ?? "Holiday");
      setName(entry?.name ?? "");
    }
    setOpen(next);
  };

  const submit = async () => {
    try {
      await upsert.mutateAsync({ date, kind, name: name.trim() || null });
      toast.success(t("common:state.saved"));
      setOpen(false);
    } catch (error: unknown) {
      toast.error(apiErrorMessage(error, t("workcalendar:error.save")));
    }
  };

  const submitDelete = async () => {
    if (entry === null) return;
    if (!confirm(t("workcalendar:confirm.delete"))) return;
    try {
      await remove.mutateAsync(entry.date);
      toast.success(t("common:state.saved"));
      setOpen(false);
    } catch (error: unknown) {
      toast.error(apiErrorMessage(error, t("workcalendar:error.delete")));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={entry === null ? "default" : "ghost"} size="sm">
          {entry === null ? t("workcalendar:action.add") : t("workcalendar:action.edit")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {entry === null ? t("workcalendar:action.add") : t("workcalendar:action.edit")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="work-calendar-date">{t("workcalendar:field.date")}</Label>
            <Input
              id="work-calendar-date"
              type="date"
              value={date}
              readOnly={entry !== null}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="work-calendar-kind">{t("workcalendar:field.kind")}</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as "Holiday" | "Workday")}>
              <SelectTrigger id="work-calendar-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Holiday">{t("workcalendar:kind.holiday")}</SelectItem>
                <SelectItem value="Workday">{t("workcalendar:kind.workday")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="work-calendar-name">{t("workcalendar:field.name")}</Label>
            <Input
              id="work-calendar-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            {entry !== null && (
              <Button
                variant="destructive"
                type="button"
                disabled={remove.isPending}
                onClick={submitDelete}
              >
                {t("workcalendar:action.delete")}
              </Button>
            )}
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>
              {t("workcalendar:action.cancel")}
            </Button>
            <Button disabled={!date || upsert.isPending} onClick={submit}>
              {t("workcalendar:action.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
