import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useTranslation } from "react-i18next";

/** 對話框只用到兩個欄位——刻意收窄，不吃 `UsersPage` 的整個 DTO（那個型別不 export）。 */
interface DeletableUser {
  userId: string;
  displayName: string;
}

interface Props {
  user: DeletableUser | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 刪除的確認框。與停用框同形（Cancel ＋ Action ＋ destructive），**多一個打字確認**：
 * 確認鈕在輸入值（兩側 trim 後）等於 `displayName` 之前是 disabled 的。
 *
 * 這是本專案**第一個**打名字確認的對話框（設計 §3.7 實查：全庫沒有先例）。理由：
 * 刪除不可逆、會清掉帳號資料，而清單裡「刪除」就貼在「復原」旁邊——點錯一列沒有任何
 * 補救（前端沒有專案刪除 UI，最近的可比對象是刪看板，那一個只刪得掉一個看板）。
 *
 * 比對**兩側都 trim**。後端的 `DisplayName` 不 trim（建立帳號只驗非空），所以
 * 「 王大明 」這種值存得進去，而畫面上的尾隨空白**看不見**——逐字比對時那個名字
 * 打不出來，確認鈕永遠是 disabled，而畫面上沒有任何線索說明少了什麼（實際症狀：
 * 這一列永遠刪不掉）。trim 之外一律不動（不分大小寫、不做其他正規化）。
 */
export function DeleteUserDialog({ user, onOpenChange }: Props) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open) setTyped("");
    onOpenChange(open);
  };

  const handleDelete = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      await api.delete(`/admin/users/${user.userId}`);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["project-members"] });
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["all-users"] });
      toast.success(t("admin:delete.success"));
      handleOpenChange(false);
    } catch (error) {
      toast.error(apiErrorMessage(error, t("admin:delete.error")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={user !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:delete.confirm", { name: user?.displayName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">{t("admin:delete.description")}</p>
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={t("admin:delete.typeToConfirm", { name: user?.displayName })}
          aria-label={t("admin:delete.typeToConfirm", { name: user?.displayName })}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t("common:action.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            disabled={submitting || typed.trim() !== user?.displayName.trim()}
            className={buttonVariants({ variant: "destructive" })}
          >
            {t("common:action.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
