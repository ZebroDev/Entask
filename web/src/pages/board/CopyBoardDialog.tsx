// 看板複製的目標選擇對話框（跨專案）。
//
// 後端 `POST /api/boards/{boardId}/copy` 收 `{ targetProjectId, name }`，兩者都可為 null；
// 不帶目標時退回**來源專案**、名稱空白時以語系樣板自動命名，而授權只看**目標專案**的
// `board.create`（`CopyEndpoints.cs`）⇒ 前端唯一會靜默出錯的地方就是「送出的專案 id
// 不是畫面上顯示的那一個」。三條防線都落在這裡：
//
//   ① 確認鈕送出的 `targetProjectId` 逐字等於下拉選中的 id（測試以精確物件比對）。
//   ② 選中的專案必須在可見選項裡——它若不在選項中，Radix 的 trigger 是一片空白，
//      而確認鈕照樣可按（`canSubmit` 的 `visible` 子句把它擋掉）。
//   ③ 目標專案缺 `board.create` 時停用確認鈕並說明。這一條不是猜測：`useProjectPermissions`
//      打的端點與複製端點的授權**共用同一個函式**（`GetProjectEffectivePermissionsAsync`）。
//
// 條件掛載（父層以 `{copyingOpen && …}` 決定）⇒ 關閉即卸載、重開即重新初始化，
// 因此不需要 reset effect。
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import { useTranslation } from "react-i18next";

interface ProjectItem {
  id: string;
  name: string;
}

/** 使用者選定的落點。專案 id 與名稱都由這裡的 state 決定，與送出的請求同源。 */
export interface CopyBoardTarget {
  projectId: string;
  name: string;
}

interface Props {
  board: { id: string; name: string };
  /** 來源專案——目標專案下拉的初始值。 */
  defaults: { projectId?: string };
  onOpenChange: (open: boolean) => void;
  onConfirm: (target: CopyBoardTarget) => void;
  pending: boolean;
}

export function CopyBoardDialog({ board, defaults, onOpenChange, onConfirm, pending }: Props) {
  const { t } = useTranslation(["board", "card", "common"]);

  const [selectedProjectId, setSelectedProjectId] = useState(defaults.projectId ?? "");
  const [name, setName] = useState("");

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data as ProjectItem[],
  });

  // 目標專案的權限：只在選定之後才打，且**查詢成功前不顯示「沒有權限」**——
  // 載入中顯示那句會讓每一次開啟都閃一下不存在的錯誤。
  const targetPermissions = useProjectPermissions(selectedProjectId || undefined);
  const canCreateInTarget = (targetPermissions.data ?? []).includes("board.create");
  const showNoPermission = targetPermissions.isSuccess && !canCreateInTarget;

  // 目標專案清單載入失敗時要說出來：否則它長得跟「沒有東西可選」一模一樣
  // （空的選項 ＋ 停用的確認鈕），而 `showNoPermission` 只在 isSuccess 時顯示。
  const loadError = projectsQuery.isError
    ? apiErrorMessage(projectsQuery.error, t("common:error.tryLater"))
    : null;

  const projects = projectsQuery.data ?? [];
  const targetIsVisible = projects.some((p) => p.id === selectedProjectId);
  const canSubmit = !pending && !!selectedProjectId && targetIsVisible && canCreateInTarget;

  return (
    <Dialog
      open
      // 送出中吞掉關閉請求（Escape 與點遮罩都會走這條）：請求已飛出去，
      // 關掉只會讓使用者以為沒送出而再點一次
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[500px]" data-testid="copy-board-dialog">
        <DialogHeader>
          <DialogTitle>{t("board:copy.confirm")}</DialogTitle>
          <DialogDescription>{t("board:copy.description", { name: board.name })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <div className="space-y-1">
            <Label htmlFor="copy-board-project" className="text-xs font-medium text-muted-foreground">
              {t("board:copy.targetProject.label")}
            </Label>
            <Select
              value={targetIsVisible ? selectedProjectId : ""}
              onValueChange={setSelectedProjectId}
            >
              <SelectTrigger id="copy-board-project" className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    projectsQuery.isLoading
                      ? t("card:create.project.loading")
                      : t("card:create.project.placeholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="copy-board-name" className="text-xs font-medium text-muted-foreground">
              {t("board:copy.name.label")}
            </Label>
            <Input
              id="copy-board-name"
              className="h-8 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("board:copy.name.placeholder")}
            />
          </div>

          {loadError && (
            <p className="text-xs text-destructive">
              {t("common:error.loadDetail", { detail: loadError })}
            </p>
          )}

          {showNoPermission && (
            <p className="text-xs text-destructive">{t("board:copy.noPermission")}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common:action.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => onConfirm({ projectId: selectedProjectId, name: name.trim() })}
          >
            {pending ? t("common:state.copying") : t("board:copy.submit.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
