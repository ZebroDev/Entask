import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
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
interface DeactivatableUser {
  userId: string;
  displayName: string;
}

/** `OffboardingResponse`（`src/Entask.Api/Dtos/AuthDtos.cs`）。 */
interface OffboardingDto {
  openCards: number;
  pendingReviews: number;
  projectMemberships: number;
  teamMemberships: number;
}

interface Props {
  user: DeactivatableUser | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * 停用的確認框。開啟時先打 `GET /admin/users/{id}/offboarding` 把未完事項列出來，
 * 但**顯示、不阻擋**（設計 D4）：未完事項是給人判斷用的資訊，不是守衛——
 * 停用是可復原的，沒有理由為了「他還有 3 張卡」而擋住。
 *
 * 確認鈕的形狀照 `DeleteBoardDialog.tsx`（Cancel ＋ Action ＋
 * `buttonVariants({ variant: "destructive" })`，`preventDefault` 讓它不自動關閉）。
 */
export function DeactivateUserDialog({ user, onOpenChange }: Props) {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const offboarding = useQuery({
    queryKey: ["admin-user-offboarding", user?.userId],
    queryFn: async () =>
      (await api.get(`/admin/users/${user!.userId}/offboarding`)).data as OffboardingDto,
    // `user` 為 null 時整支查詢是關的——列沒有被打開就不該發請求（`user!` 的前提）
    enabled: !!user,
  });

  const handleDeactivate = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      await api.post(`/admin/users/${user.userId}/deactivate`, {});
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["project-members"] });
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["all-users"] });
      toast.success(t("admin:deactivate.success"));
      onOpenChange(false);
    } catch (error) {
      toast.error(apiErrorMessage(error, t("admin:deactivate.error")));
    } finally {
      setSubmitting(false);
    }
  };

  const counts = offboarding.data;

  return (
    <AlertDialog open={user !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:deactivate.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:deactivate.confirm", { name: user?.displayName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {counts && (
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">{t("admin:deactivate.offboarding")}</p>
            <ul className="list-disc pl-5">
              <li>{t("admin:deactivate.openCards", { n: counts.openCards })}</li>
              <li>{t("admin:deactivate.pendingReviews", { n: counts.pendingReviews })}</li>
              <li>{t("admin:deactivate.projectMemberships", { n: counts.projectMemberships })}</li>
              <li>{t("admin:deactivate.teamMemberships", { n: counts.teamMemberships })}</li>
            </ul>
          </div>
        )}
        <p className="text-sm text-muted-foreground">{t("admin:deactivate.note")}</p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{t("common:action.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDeactivate();
            }}
            disabled={submitting}
            className={buttonVariants({ variant: "destructive" })}
          >
            {t("common:action.deactivate")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
