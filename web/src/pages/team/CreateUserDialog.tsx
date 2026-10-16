import { useState } from "react";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { serverMessage } from "@/lib/error-messages";
import { apiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

interface CreatedUserDto {
  userId: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

interface Props {
  onCreated?: (user: CreatedUserDto) => void;
  trigger?: React.ReactNode;
}

export function CreateUserDialog({ onCreated, trigger }: Props) {
  const { t } = useTranslation(["common", "team"]);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!username.trim() || !displayName.trim() || !password) {
      toast.error(t("team:user.create.required"));
      return;
    }
    if (password.length < 8) {
      toast.error(t("team:user.password.minLength"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post("/auth/users", {
        username: username.trim(),
        displayName: displayName.trim(),
        password,
        isAdmin,
      });
      const created = res.data as CreatedUserDto;
      toast.success(t("team:user.create.success", { name: created.displayName }));
      setUsername("");
      setDisplayName("");
      setPassword("");
      setIsAdmin(false);
      setOpen(false);
      onCreated?.(created);
    } catch (error) {
      // 伺服器有話說就包進「建立失敗：{{detail}}」，沒有就退回 apiErrorMessage 的通用句。
      // 用 serverMessage 而不是自己讀 data：`POST /auth/users` 的錯誤 body 自 P-C 起是
      // { code, message }，讀死字串形狀的守衛會靜默失效（那正是這次修掉的缺陷）。
      const detail = isAxiosError(error) ? serverMessage(error.response?.data) : null;
      toast.error(
        detail
          ? t("common:error.createDetail", { detail })
          : apiErrorMessage(error, t("team:user.create.error")),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="gap-1.5">
            <UserPlus className="h-4 w-4" />
            {t("team:user.create.action")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team:user.create.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="create-user-username">{t("team:user.username.label")} <span className="text-destructive">*</span></Label>
            <Input
              id="create-user-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("team:user.username.placeholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-user-displayname">{t("team:user.displayName.label")} <span className="text-destructive">*</span></Label>
            <Input
              id="create-user-displayname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("team:user.displayName.placeholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-user-password">{t("team:user.password.label")} <span className="text-destructive">*</span></Label>
            <Input
              id="create-user-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              className="rounded"
            />
            {t("team:user.admin.label")}
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>
              {t("common:action.cancel")}
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? t("common:state.creating") : t("team:user.create.confirm.action")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
