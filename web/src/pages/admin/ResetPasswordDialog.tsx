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
interface ResettableUser {
  userId: string;
  displayName: string;
}

interface Props {
  user: ResettableUser | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 管理員重設使用者密碼的對話框。骨架與 `DeleteUserDialog` 同形（Cancel ＋ Action ＋
 * destructive、同一個 `submitting` 護欄），**但有兩處刻意的差異**：
 *
 * 1. **沒有「打字確認」。** `DeleteUserDialog` 加它是因為刪除不可逆、會清掉帳號資料；
 *    重設密碼可復原——管理員再重設一次就好，而且他本來就必須知道新密碼才能轉達。
 *    對一個可復原的動作要求打字確認，只是把兩顆按鈕的份量拉成一樣。
 *
 * 2. **臨時密碼欄位可見不遮。** 這個流程的重點就是管理員把密碼念給使用者聽；遮起來
 *    只多一個「顯示」控制項，對這個流程沒有任何保護。
 *
 * 成功與失敗的分岔押在確認鈕的 `e.preventDefault()` 上：`AlertDialogAction` 預設會關閉
 * 對話框，而失敗時我們要它**開著**——關掉的話使用者看不到錯誤，剛打的密碼也一併被清掉
 * （`handleOpenChange` 的 `setPassword("")`）。
 */
export function ResetPasswordDialog({ user, onOpenChange }: Props) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open) setPassword("");
    onOpenChange(open);
  };

  const handleReset = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      await api.post(`/admin/users/${user.userId}/reset-password`, { newPassword: password });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success(t("admin:resetPassword.success"));
      handleOpenChange(false);
    } catch (error) {
      toast.error(apiErrorMessage(error, t("admin:resetPassword.error")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={user !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:resetPassword.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:resetPassword.description", { name: user?.displayName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">{t("admin:resetPassword.hint")}</p>
        <Input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("admin:resetPassword.field")}
          aria-label={t("admin:resetPassword.field")}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t("common:action.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleReset();
            }}
            disabled={submitting || password === ""}
            className={buttonVariants({ variant: "destructive" })}
          >
            {t("admin:resetPassword.submit")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
