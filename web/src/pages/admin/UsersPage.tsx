import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DeactivateUserDialog } from "./DeactivateUserDialog";
import { DeleteUserDialog } from "./DeleteUserDialog";
import { ResetPasswordDialog } from "./ResetPasswordDialog";

// 對應後端 `AdminUserResponse`（`src/Entask.Api/Dtos/AuthDtos.cs`）。
// DTO 留在頁面內、不 export：它沒有任何其他消費者。
interface AdminUserDto {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  deactivatedAt: string | null;
  deletedAt: string | null;
}

type Filter = "all" | "active" | "deactivated";

/** 頁面的 **default 匯出**是給測試用的（`import UsersPage from …`），
 *  具名匯出是 `lazyPage` 的要件（它要求模組裡有同名成員，見 `lib/lazy-route.ts`）。 */
export function UsersPage() {
  const { t } = useTranslation(["admin", "common"]);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [reactivating, setReactivating] = useState<AdminUserDto | null>(null);
  const [deactivating, setDeactivating] = useState<AdminUserDto | null>(null);
  const [deleting, setDeleting] = useState<AdminUserDto | null>(null);
  const [resetting, setResetting] = useState<AdminUserDto | null>(null);

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => (await api.get("/admin/users")).data as AdminUserDto[],
  });

  // 復原沒有 dialog 之外的輸入，但**要有一步確認**：它會讓一個被撤銷的帳號重新進得來，
  // 而畫面上一列「復原」就在「刪除」旁邊——誤點一次的代價是一個不該回來的人可以登入。
  // 三條 `admin:reactivate.*` 的文案（含「先前的工作階段不會恢復」）也只有這裡在顯示。
  const reactivate = useMutation({
    mutationFn: async (userId: string) => api.post(`/admin/users/${userId}/reactivate`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["project-members"] });
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["all-users"] });
      toast.success(t("admin:reactivate.success"));
      // 關框（與兩個 sibling 對話框一致）：不關的話畫面看起來像什麼都沒發生
      // ——清單還是舊的、框還在——於是使用者再按一次，再送一次（後端冪等，
      // 但會多跳一次 toast，而畫面上看不出剛剛那一次已經成功了）。
      setReactivating(null);
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, t("admin:reactivate.error"))),
  });

  const rows = useMemo(() => {
    const all = users.data ?? [];
    if (filter === "active") return all.filter((u) => !u.deactivatedAt && !u.deletedAt);
    if (filter === "deactivated") return all.filter((u) => u.deactivatedAt && !u.deletedAt);
    return all;
  }, [users.data, filter]);

  const statusOf = (u: AdminUserDto) =>
    u.deletedAt ? t("admin:status.deleted") : u.deactivatedAt ? t("admin:status.deactivated") : t("admin:status.active");

  /** 「異動時間」欄：刪除優先於停用（刪除是後發生、也是現在看不見的那一個原因）。 */
  const changedAtOf = (u: AdminUserDto) => u.deletedAt ?? u.deactivatedAt;

  if (users.isError) return <p className="p-6 text-sm text-destructive">{apiErrorMessage(users.error, t("admin:error"))}</p>;

  return (
    <div className="p-6 space-y-4">
      <header>
        <h1 className="text-lg font-semibold">{t("admin:title")}</h1>
        <p className="text-sm text-muted-foreground">{t("admin:subtitle")}</p>
      </header>

      {/* 三個篩選鈕刻意逐一寫出來、不走 map：i18next-parser 只抽得到**字面值**引數的
          t 呼叫，`t(\`admin:filter.${f}\`)` 會讓這三條被 --fail-on-update 判為沒人用
          而被刪掉（`i18next-parser.config.js` 的 input 註解）。 */}
      <div className="flex gap-2">
        <Button variant={filter === "all" ? "default" : "outline"} size="sm" onClick={() => setFilter("all")}>
          {t("admin:filter.all")}
        </Button>
        <Button variant={filter === "active" ? "default" : "outline"} size="sm" onClick={() => setFilter("active")}>
          {t("admin:filter.active")}
        </Button>
        <Button variant={filter === "deactivated" ? "default" : "outline"} size="sm" onClick={() => setFilter("deactivated")}>
          {t("admin:filter.deactivated")}
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-2">{t("admin:column.user")}</th>
            <th>{t("admin:column.status")}</th>
            <th>{t("admin:column.changedAt")}</th>
            <th>{t("admin:column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.userId} className="border-t">
              <td className="py-2">
                <div className="font-medium">{u.displayName}</div>
                <div className="text-xs text-muted-foreground">@{u.username}</div>
              </td>
              <td>
                <Badge variant={u.deletedAt || u.deactivatedAt ? "secondary" : "default"}>{statusOf(u)}</Badge>
              </td>
              <td className="text-muted-foreground">
                {changedAtOf(u) ? formatDate(changedAtOf(u)) : "—"}
              </td>
              <td className="space-x-2">
                {!u.deletedAt && !u.deactivatedAt && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setDeactivating(u)}>
                      {t("common:action.deactivate")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setResetting(u)}>
                      {t("admin:resetPassword.action")}
                    </Button>
                  </>
                )}
                {u.deactivatedAt && !u.deletedAt && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setReactivating(u)}>
                      {t("common:action.reactivate")}
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeleting(u)}>
                      {t("common:action.delete")}
                    </Button>
                    {/* 停用者也給這一顆：後端**允許**對停用者重置（`Reset_ForDeactivatedUser_Succeeds`）。
                        只放在 active 分支會讓 UI 與 API 不一致，而那個不一致沒有任何地方會響。 */}
                    <Button variant="outline" size="sm" onClick={() => setResetting(u)}>
                      {t("admin:resetPassword.action")}
                    </Button>
                  </>
                )}
                {/* 已刪除者沒有任何動作（設計 §4.9）：帳號資料已經清了，剩下的動作都是 400 */}
                {u.deletedAt && <span className="text-muted-foreground">—</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-6 text-center text-muted-foreground">{t("admin:empty")}</td>
            </tr>
          )}
        </tbody>
      </table>

      <AlertDialog open={reactivating !== null} onOpenChange={(open) => !open && setReactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin:reactivate.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin:reactivate.confirm", { name: reactivating?.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">{t("admin:reactivate.note")}</p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (reactivating) reactivate.mutate(reactivating.userId);
              }}
              // pending 護欄：`e.preventDefault()` 讓框不自動關，少了這一行連點就重複送
              disabled={reactivate.isPending}
            >
              {t("common:action.reactivate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeactivateUserDialog user={deactivating} onOpenChange={(open) => !open && setDeactivating(null)} />
      <DeleteUserDialog user={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
      <ResetPasswordDialog user={resetting} onOpenChange={(open) => !open && setResetting(null)} />
    </div>
  );
}

export default UsersPage;
