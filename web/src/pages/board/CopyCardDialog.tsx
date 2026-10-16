// 卡片複製的目標選擇對話框（跨專案）。
//
// 後端 `POST /api/cards/{cardId}/copy` 收 `{ targetListId }`，不帶時退回**來源列表**
// （`CopyEndpoints.cs`），而授權只看**目標列表所屬專案**的 `card.create` ⇒ 前端唯一
// 會靜默出錯的地方就是「送出的列表 id 不是畫面上顯示的那一個」。四條防線都落在這裡：
//
//   ① 確認鈕送出的 `targetListId` 逐字等於下拉選中的 id（測試以精確物件比對 URL 與 body）。
//   ② 換上層一律清下層（專案 → 看板＋列表、看板 → 列表），並讓確認鈕跟著停用。
//   ③ 停用規則多一個子句「選中的列表必須在可見選項裡」——卡片現址若剛好是封存列表，
//      它不會出現在選項中，少了這個子句就會送出畫面上看不到的目標。
//   ④ 成功後**目標**專案的每一個檢視都要失效（由父層 `CardDialog` 執行；卡片複製
//      不廣播 SignalR，失效是副本現形的唯一路徑）。
//
// 與 `QuickCreateCardModal` 刻意不同的一點：**不做「自動挑第一個」**。那裡是為了
// 快速新增少點幾下，代價是換上層之後系統靜默替你決定目標；本對話框已經有一組正確的
// 完整預設（卡片現址），換上層就讓它空著並停用確認鈕。
//
// 條件掛載（父層以 `{copyOpen && …}` 決定）⇒ 關閉即卸載、重開即重新初始化，
// 因此不需要 reset effect。
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
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
import type { BoardDetailResponse } from "@/lib/board-types";
import { useTranslation } from "react-i18next";

interface ProjectItem {
  id: string;
  name: string;
}

interface BoardItem {
  id: string;
  name: string;
}

/** 使用者選定的落點。三個 id 都由這裡的 state 決定，與送出的請求同源。 */
export interface CopyTarget {
  projectId: string;
  boardId: string;
  listId: string;
}

interface Props {
  card: { title: string; listId: string };
  /** 卡片現址的專案／看板——三層下拉的初始值。 */
  defaults: { projectId?: string; boardId?: string };
  onOpenChange: (open: boolean) => void;
  onConfirm: (target: CopyTarget) => void;
  pending: boolean;
}

export function CopyCardDialog({ card, defaults, onOpenChange, onConfirm, pending }: Props) {
  const { t } = useTranslation(["card", "common"]);

  const [selectedProjectId, setSelectedProjectId] = useState(defaults.projectId ?? "");
  const [selectedBoardId, setSelectedBoardId] = useState(defaults.boardId ?? "");
  const [selectedListId, setSelectedListId] = useState(card.listId);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data as ProjectItem[],
  });

  const boardsQuery = useQuery({
    queryKey: ["boards", selectedProjectId],
    queryFn: async () => (await api.get(`/projects/${selectedProjectId}/boards`)).data as BoardItem[],
    enabled: !!selectedProjectId,
  });

  const boardDetailQuery = useQuery({
    queryKey: ["board", selectedBoardId],
    queryFn: async () => (await api.get(`/boards/${selectedBoardId}`)).data as BoardDetailResponse,
    enabled: !!selectedBoardId,
  });

  const availableLists = (boardDetailQuery.data?.lists ?? []).filter((l) => !l.isArchived);

  const canSubmit = !pending && !!selectedListId && availableLists.some((l) => l.id === selectedListId);

  // 選中的列表若不在選項裡（卡片現址剛好是封存列表），把 trigger 交還給 placeholder。
  // Radix 對「有值、但沒有對應選項」的顯示是**一片空白**——比「請選擇列表」更難懂。
  // 這只是顯示層的還原，state 不動；能不能送出由 `canSubmit` 決定（它要求選中的
  // 必須在可見選項裡），所以畫面上看不到的目標送不出去。
  const listValue = availableLists.some((l) => l.id === selectedListId) ? selectedListId : "";

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
      <DialogContent className="sm:max-w-[500px]" data-testid="copy-card-dialog">
        <DialogHeader>
          <DialogTitle>{t("card:copy.title")}</DialogTitle>
          <DialogDescription>{t("card:copy.description", { title: card.title })}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-2">
          <div className="space-y-1">
            <Label htmlFor="copy-card-project" className="text-xs font-medium text-muted-foreground">
              {t("card:copy.targetProject.label")}
            </Label>
            <Select
              value={selectedProjectId}
              onValueChange={(val) => {
                setSelectedProjectId(val);
                setSelectedBoardId("");
                setSelectedListId("");
              }}
            >
              <SelectTrigger id="copy-card-project" className="h-8 text-xs">
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
            <Label htmlFor="copy-card-board" className="text-xs font-medium text-muted-foreground">
              {t("card:copy.targetBoard.label")}
            </Label>
            <Select
              value={selectedBoardId}
              onValueChange={(val) => {
                setSelectedBoardId(val);
                setSelectedListId("");
              }}
              disabled={boardsQuery.isLoading || (boardsQuery.data ?? []).length === 0}
            >
              <SelectTrigger id="copy-card-board" className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    boardsQuery.isLoading
                      ? t("card:create.board.loading")
                      : (boardsQuery.data ?? []).length === 0
                        ? t("card:create.board.empty")
                        : t("card:create.board.placeholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(boardsQuery.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id} className="text-xs">
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="copy-card-list" className="text-xs font-medium text-muted-foreground">
              {t("card:copy.targetList.label")}
            </Label>
            <Select
              value={listValue}
              onValueChange={setSelectedListId}
              disabled={boardDetailQuery.isLoading || availableLists.length === 0}
            >
              <SelectTrigger id="copy-card-list" className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    boardDetailQuery.isLoading
                      ? t("card:create.list.loading")
                      : availableLists.length === 0
                        ? t("card:create.list.empty")
                        : t("card:create.list.placeholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableLists.map((l) => (
                  <SelectItem key={l.id} value={l.id} className="text-xs">
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common:action.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => onConfirm({ projectId: selectedProjectId, boardId: selectedBoardId, listId: selectedListId })}
          >
            {pending ? t("common:state.copying") : t("card:copy.submit.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
