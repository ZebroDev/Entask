import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { serverMessage } from "@/lib/error-messages";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

interface TeamRoleDto { id: string; name: string; description?: string | null; isSystem: boolean; permissionCodes: string[]; }
interface PermissionDto { code: string; category: string; description: string; }

/**
 * 權限分類 → 標籤。分類識別碼是**權限碼的第一段**，不是後端 `PermissionDto.category`
 * ——後者是寫進 DB 的顯示字（中文），P-C 在地化之後會隨語系改變。
 *
 * 寫成 switch 而不是查表，是被 `i18next-parser` 逼的（與 `CardActivityTab` 的 `typeLabel`
 * 同一形狀，設計 §6.1）。這張表同時是後端 `PermissionCategories` 的契約鎖
 * （`web/scripts/check-label-tables.mjs` 的第七張表）。認不得的分類原樣顯示。
 */
const categoryLabel = (category: string) => {
  switch (category) {
    case "team":
      return i18n.t("team:permissionCategory.team");
    case "project":
      return i18n.t("team:permissionCategory.project");
    case "board":
      return i18n.t("team:permissionCategory.board");
    case "card":
      return i18n.t("team:permissionCategory.card");
    case "mindmap":
      return i18n.t("team:permissionCategory.mindmap");
    case "report":
      return i18n.t("team:permissionCategory.report");
    default:
      return category;
  }
};

/**
 * 權限說明。識別碼是**權限碼本身**（後端 `PermissionCodes`），不是 `PermissionDto.description`
 * ——後者是資料庫種子裡的中文顯示字，P-C 之前直接渲染在畫面上（`{p.description}`），
 * 是**全庫最後一處直接渲染後端顯示字的地方**。
 *
 * 與 `categoryLabel` 同一條規則：不寫成查表是被 `i18next-parser` 逼的
 * （`keepRemoved: false` 會把查表用的 key 從語系檔刪掉，畫面只顯示 key 本身）。
 * 認不得的權限碼回空字串——後端新增權限碼而前端沒補時，畫面顯示的是識別碼（左邊那一欄）
 * 而不是一句錯的說明。守門員是 `check-label-tables.mjs` 的第九張表（集合相等）。
 */
const permissionLabel = (code: string) => {
  switch (code) {
    case "team.read":
      return i18n.t("permission:team.read");
    case "team.member.manage":
      return i18n.t("permission:team.member.manage");
    case "team.role.manage":
      return i18n.t("permission:team.role.manage");
    case "team.workcalendar.manage":
      return i18n.t("permission:team.workcalendar.manage");
    case "project.read":
      return i18n.t("permission:project.read");
    case "project.create":
      return i18n.t("permission:project.create");
    case "project.edit":
      return i18n.t("permission:project.edit");
    case "project.delete":
      return i18n.t("permission:project.delete");
    case "project.member.manage":
      return i18n.t("permission:project.member.manage");
    case "board.read":
      return i18n.t("permission:board.read");
    case "board.create":
      return i18n.t("permission:board.create");
    case "board.edit":
      return i18n.t("permission:board.edit");
    case "board.delete":
      return i18n.t("permission:board.delete");
    case "card.read":
      return i18n.t("permission:card.read");
    case "card.create":
      return i18n.t("permission:card.create");
    case "card.edit":
      return i18n.t("permission:card.edit");
    case "card.delete":
      return i18n.t("permission:card.delete");
    case "card.assign":
      return i18n.t("permission:card.assign");
    case "card.review":
      return i18n.t("permission:card.review");
    case "card.rate":
      return i18n.t("permission:card.rate");
    case "card.comment":
      return i18n.t("permission:card.comment");
    case "card.effort.update":
      return i18n.t("permission:card.effort.update");
    case "mindmap.edit":
      return i18n.t("permission:mindmap.edit");
    case "report.view":
      return i18n.t("permission:report.view");
    default:
      return "";
  }
};

export function RoleEditDialog({ teamId, role }: { teamId: string; role?: TeamRoleDto }) {
  const { t } = useTranslation(["common", "team"]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [codes, setCodes] = useState<string[]>(role?.permissionCodes ?? []);
  const [submitting, setSubmitting] = useState(false);

  const { data: permissions } = useQuery({
    queryKey: ["permissions"],
    queryFn: async () => (await api.get("/permissions")).data as PermissionDto[],
  });

  // 分組鍵用**權限碼的前綴**，不是後端給的 `p.category`：後者是顯示字，一旦它隨語系
  // 改變，鍵也會跟著跑——切一次語系就多出一組分組，而 zh-TW 的測試看不出來
  // （`GanttTab` 的 `UNASSIGNED` 是同一個坑）。前綴的契約在後端 `PermissionCategories`。
  // 分組順序不受影響：兩者都照 `/permissions` 回應的順序首次出現。
  const byCategory = (permissions ?? []).reduce<Record<string, PermissionDto[]>>((acc, p) => {
    const key = p.code.split(".")[0];
    (acc[key] ??= []).push(p);
    return acc;
  }, {});

  const submit = async () => {
    if (!name) { toast.error(t("team:role.name.required")); return; }
    if (submitting) return;
    setSubmitting(true);
    try {
      const payload = { name, description, permissionCodes: codes };
      if (role) await api.put(`/teams/${teamId}/roles/${role.id}`, payload);
      else await api.post(`/teams/${teamId}/roles`, payload);
      await qc.invalidateQueries({ queryKey: ["team-roles", teamId] });
      toast.success(t("common:state.saved"));
      setOpen(false);
    } catch (error) {
      const detail = isAxiosError(error) ? serverMessage(error.response?.data) : null;
      toast.error(detail ? t("common:error.saveDetail", { detail }) : t("common:error.save"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">{role ? t("common:action.edit") : t("team:role.create.action")}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{role ? t("team:role.edit.title") : t("team:role.create.title")}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="role-name">{t("team:role.name.label")}</Label>
            <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role-description">{t("team:role.description.label")}</Label>
            <Input id="role-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {Object.entries(byCategory).map(([categoryCode, items]) => (
            <div key={categoryCode} className="space-y-1">
              <Label>{categoryLabel(categoryCode)}</Label>
              <div className="grid gap-2">
                {items.map((p) => (
                  <label key={p.code} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={codes.includes(p.code)}
                      onChange={(e) => setCodes((prev) =>
                        e.target.checked ? [...prev, p.code] : prev.filter((c) => c !== p.code))}
                    />
                    <span>{p.code}</span>
                    <span className="text-xs text-muted-foreground">{permissionLabel(p.code)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <Button className="w-full" onClick={submit}>{t("common:action.save")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
