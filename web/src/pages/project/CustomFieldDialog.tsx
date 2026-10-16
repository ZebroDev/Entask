import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { FIELD_TYPES, scopeLabel, typeLabel } from "@/lib/custom-fields";
import type { CustomFieldResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";

interface Props {
  projectId: string;
  /** null = 新增；帶值 = 編輯該欄位 */
  field: CustomFieldResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomFieldDialog({ projectId, field, open, onOpenChange }: Props) {
  const { t } = useTranslation(["common", "project"]);
  const isEdit = field !== null;
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [options, setOptions] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // 每次開啟才由 field（或空白）初始化：表單狀態不再跨欄位共用，
  // 切換編輯對象不可能覆蓋前一筆未儲存的變更。
  useEffect(() => {
    if (!open) return;
    setName(field?.name ?? "");
    setType(field?.type ?? "text");
    setOptions(field?.options ?? []);
    setDraft("");
  }, [open, field]);

  const typeChanged = isEdit && field.type !== type;
  const missingOptions = type === "select" && options.length === 0;

  // 支援貼上「高,中,低」與全形逗號「，」：一次拆成多個選項，並自動去除重複
  const commitDraft = (raw: string) => {
    const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    setOptions((prev) => [...prev, ...parts.filter((p) => !prev.includes(p))]);
    setDraft("");
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, type, options: type === "select" ? options : null };
      if (!field) {
        return (await api.post(`/projects/${projectId}/custom-fields`, body)).data as CustomFieldResponse;
      }
      return field.scopeType === "project"
        ? (await api.put(`/projects/${projectId}/custom-fields/${field.id}`, body)).data as CustomFieldResponse
        : (await api.put(`/boards/${field.scopeId}/custom-fields/${field.id}`, body)).data as CustomFieldResponse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-fields", projectId] });
      queryClient.invalidateQueries({ queryKey: ["card"] });
      if (field) {
        toast.success(t("project:field.update.success"));
        onOpenChange(false);
        return;
      }
      // 新增：留在對話框並清空名稱，維持連續新增多個欄位的工作流
      toast.success(t("project:field.create.success"));
      setName("");
      setOptions([]);
      setDraft("");
      nameRef.current?.focus();
    },
    onError: (error) =>
      toast.error(apiErrorMessage(error, field ? t("common:error.update") : t("common:error.create"))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("project:field.edit.title", { name: field.name }) : t("project:field.create.title")}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("project:field.edit.hint", { scope: scopeLabel(field.scopeType) })
              : t("project:field.create.hint")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cf-name">{t("project:field.name.label")}</Label>
            <Input
              id="cf-name"
              ref={nameRef}
              className="h-9"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("project:field.name.placeholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-type">{t("project:field.type.label")}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="cf-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((v) => (
                  <SelectItem key={v} value={v}>{typeLabel(v)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 型態變更的後果直接在對話框內說明，不再另外疊一層確認框 */}
          {typeChanged && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">
                {t("project:field.typeChange.summary", { from: typeLabel(field.type), to: typeLabel(type) })}
              </p>
              {/* 兩種後果各是一句完整的話，不是「句子 + 條件片段 + 句子」——
                  片段拼接在別的語系無從重排（B2-5c 的判定 6）。 */}
              <p className="mt-1 text-muted-foreground">
                {field.type === "select"
                  ? t("project:field.typeChange.warningWithOptions")
                  : t("project:field.typeChange.warning")}
              </p>
            </div>
          )}

          {type === "select" && (
            <div className="space-y-1.5">
              <Label htmlFor="cf-option">{t("project:field.options.label")}</Label>
              <div className="flex gap-2">
                <Input
                  id="cf-option"
                  className="h-9"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // 輸入法組字中的 Enter/逗號屬於選字，不可當成送出（中文輸入必踩）
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" || e.key === "," || e.key === "，") {
                      e.preventDefault();
                      commitDraft(draft);
                      return;
                    }
                    if (e.key === "Backspace" && draft === "" && options.length > 0) {
                      setOptions((prev) => prev.slice(0, -1));
                    }
                  }}
                  placeholder={t("project:field.options.placeholder")}
                />
                <Button type="button" variant="outline" onClick={() => commitDraft(draft)} disabled={!draft.trim()}>
                  {t("project:field.options.add.action")}
                </Button>
              </div>
              {options.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {options.map((o) => (
                    <span
                      key={o}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs"
                    >
                      {o}
                      <button
                        type="button"
                        aria-label={t("project:field.options.remove.aria", { option: o })}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setOptions((prev) => prev.filter((x) => x !== o))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("project:field.options.empty")}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t("common:action.cancel")}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!name.trim() || missingOptions || save.isPending}
          >
            {save.isPending
              ? t("common:state.saving")
              : isEdit
                ? typeChanged
                  ? t("project:field.typeChange.confirm.action")
                  : t("common:action.saveChanges")
                : t("project:field.create.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
