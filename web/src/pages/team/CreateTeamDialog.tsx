import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { localTimeZoneId } from "@/lib/local-day";
import { apiErrorMessage } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

// `code` 是系統範本角色的穩定識別碼（後端 Role.Code），團隊自訂角色為 null。
interface TeamRoleDto { id: string; name: string; isSystem: boolean; code?: string | null; }
interface TeamDto { id: string; name: string; description?: string | null; }

interface Props {
  onCreated?: (team: TeamDto) => void;
  trigger?: React.ReactNode;
}

export function CreateTeamDialog({ onCreated, trigger }: Props) {
  const { t } = useTranslation(["common", "team"]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { user } = useAuth();

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t("team:create.name.required"));
      return;
    }
    setSubmitting(true);
    try {
      // 1. 建立團隊
      const res = await api.post("/teams", { name: name.trim(), description: description.trim() || null });
      const newTeam = res.data as TeamDto;

      // 2. 自動將當前管理者加入為團隊經理
      if (user?.username) {
        try {
          const rolesRes = await api.get("/teams/" + newTeam.id + "/roles");
          const roles = rolesRes.data as TeamRoleDto[];
          // 以**穩定識別碼**查，不是顯示名稱（P-A 的第四處，也是唯一在前端的）。
          // 名稱會隨語系改變；而原本的 `|| roles[0]` 後備會退回**資料庫順序的第一個**
          // 角色（後端這條查詢沒有 OrderBy），等於把建立者指派到一個任意角色——
          // 比不指派更糟，因為錯誤的權限不會有任何徵兆。
          const managerRole = roles.find((r) => r.code === "team_manager");
          if (!managerRole) throw new Error("team_manager role not found");
          // `timeZoneId` 是發起人時區（後端選填；缺漏 ⇒ UTC）：後端用它凍結新成員的到職本地日。
          await api.put("/teams/" + newTeam.id + "/members", {
            username: user.username,
            roleIds: [managerRole.id],
            timeZoneId: localTimeZoneId(),
          });
        } catch {
          // 指派非致命，仍不阻斷團隊建立——但不再靜默。建立者沒被加進自己剛建立的團隊，
          // 表現成「團隊是空的、我什麼都不能做」，而畫面上原本沒有任何線索。
          toast.warning(t("team:create.assign.failed"));
        }
      }

      toast.success(t("team:create.success"));
      setName("");
      setDescription("");
      setOpen(false);
      onCreated?.(newTeam);
    } catch (error) {
      toast.error(apiErrorMessage(error, t("team:create.error")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("team:create.action")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team:create.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="create-team-name">{t("team:name.label")} <span className="text-destructive">*</span></Label>
            <Input
              id="create-team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("team:create.name.placeholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-team-desc">{t("team:description.label")}</Label>
            <Input
              id="create-team-desc"
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
              {submitting ? t("common:state.creating") : t("team:create.confirm.action")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
