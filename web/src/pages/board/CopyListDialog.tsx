// 清單複製的目標選擇對話框（跨看板、可跨專案）。
//
// 後端 `POST /api/lists/{listId}/copy` 只收 `{ targetBoardId }`——不帶時退回**來源看板**
// （就地複製），而授權看的是**目標看板所屬專案**的 `board.edit`（`CopyEndpoints.cs`；
// 沒有 `list.create` 這個權限碼）。名稱沒有參數可傳，一律由後端的樣板產生
// （`原清單（副本）`），與卡片複製同源。三條防線：
//
//   ① 確認鈕送出的 `targetBoardId` 逐字等於下拉選中的 id（測試以精確物件比對）。
//   ② 換上層一律清下層（專案 → 看板），確認鈕跟著停用——**刻意不做「自動挑第一個」**，
//      理由同 `CopyCardDialog`：那會讓系統靜默替使用者決定目標。
//   ③ 選中的看板必須在可見選項裡。封存的看板不列在選項中，而清單的現址剛好可能封存
//      ⇒ 少了這個子句就會送出畫面上看不到的目標（後端照樣成功）。
//
// 條件掛載（父層以 `{copyListTarget && …}` 決定）⇒ 關閉即卸載、重開即重新初始化。
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

interface BoardItem {
  id: string;
  name: string;
  isArchived: boolean;
}

/** 使用者選定的落點。看板 id 由這裡的 state 決定，與送出的請求同源。 */
export interface CopyListTarget {
  projectId: string;
  boardId: string;
}

interface Props {
  list: { id: string; name: string };
  /** 清單現址的專案／看板——兩層下拉的初始值。 */
  defaults: { projectId?: string; boardId?: string };
  onOpenChange: (open: boolean) => void;
  onConfirm: (target: CopyListTarget) => void;
  pending: boolean;
}

export function CopyListDialog({ list, defaults, onOpenChange, onConfirm, pending }: Props) {
  const { t } = useTranslation(["board", "card", "common"]);

  const [selectedProjectId, setSelectedProjectId] = useState(defaults.projectId ?? "");
  const [selectedBoardId, setSelectedBoardId] = useState(defaults.boardId ?? "");

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data as ProjectItem[],
  });

  const boardsQuery = useQuery({
    queryKey: ["boards", selectedProjectId],
    queryFn: async () => (await api.get(`/projects/${selectedProjectId}/boards`)).data as BoardItem[],
    enabled: !!selectedProjectId,
  });

  // 只在選定專案之後才打；**查詢成功前不顯示「沒有權限」**（否則每次開啟都閃一下）。
  const targetPermissions = useProjectPermissions(selectedProjectId || undefined);
  const canEditInTarget = (targetPermissions.data ?? []).includes("board.edit");
  const showNoPermission = targetPermissions.isSuccess && !canEditInTarget;

  // 兩支下拉的載入失敗都要說出來（理由同 `CopyBoardDialog`）——否則失敗長得跟
  // 「沒有東西可選」一模一樣，而使用者只知道確認鈕按不下去。
  const loadError =
    projectsQuery.isError || boardsQuery.isError
      ? apiErrorMessage(projectsQuery.error ?? boardsQuery.error, t("common:error.tryLater"))
      : null;

  const availableBoards = (boardsQuery.data ?? []).filter((b) => !b.isArchived);
  const targetIsVisible = availableBoards.some((b) => b.id === selectedBoardId);
  const canSubmit = !pending && !!selectedBoardId && targetIsVisible && canEditInTarget;

  // 選中的看板若不在選項裡（清單現址剛好封存），把 trigger 交還給 placeholder——
  // 否則 Radix 對「有值、但沒有對應選項」的顯示是一片空白，比「請選擇看板」更難懂。
  const boardValue = targetIsVisible ? selectedBoardId : "";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[500px]" data-testid="copy-list-dialog">
        <DialogHeader>
          <DialogTitle>{t("board:list.copy.action")}</DialogTitle>
          <DialogDescription>{t("board:list.copy.description", { name: list.name })}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-2">
          <div className="space-y-1">
            <Label htmlFor="copy-list-project" className="text-xs font-medium text-muted-foreground">
              {t("board:copy.targetProject.label")}
            </Label>
            <Select
              value={selectedProjectId}
              onValueChange={(val) => {
                setSelectedProjectId(val);
                setSelectedBoardId("");
              }}
            >
              <SelectTrigger id="copy-list-project" className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    projectsQuery.isLoading
                      ? t("card:create.project.loading")
                      : t("card:create.project.placeholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(projectsQuery.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="copy-list-board" className="text-xs font-medium text-muted-foreground">
              {t("board:list.copy.targetBoard.label")}
            </Label>
            <Select
              value={boardValue}
              onValueChange={setSelectedBoardId}
              disabled={boardsQuery.isLoading || availableBoards.length === 0}
            >
              <SelectTrigger id="copy-list-board" className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    boardsQuery.isLoading
                      ? t("card:create.board.loading")
                      : availableBoards.length === 0
                        ? t("card:create.board.empty")
                        : t("card:create.board.placeholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableBoards.map((b) => (
                  <SelectItem key={b.id} value={b.id} className="text-xs">
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loadError && (
          <p className="text-xs text-destructive">
            {t("common:error.loadDetail", { detail: loadError })}
          </p>
        )}

        {showNoPermission && (
          <p className="text-xs text-destructive">{t("board:list.copy.noPermission")}</p>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common:action.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => onConfirm({ projectId: selectedProjectId, boardId: selectedBoardId })}
          >
            {pending ? t("common:state.copying") : t("board:list.copy.submit.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
