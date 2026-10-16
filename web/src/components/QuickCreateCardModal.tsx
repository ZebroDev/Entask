import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Sparkles } from "lucide-react";
import type { BoardCardResponse, BoardDetailResponse } from "@/lib/board-types";
import { Trans, useTranslation } from "react-i18next";

interface ProjectItem {
  id: string;
  name: string;
}

interface BoardItem {
  id: string;
  name: string;
}

interface QuickCreateCardModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentProjectId?: string;
  currentBoardId?: string;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function QuickCreateCardModal({
  open,
  onOpenChange,
  currentProjectId,
  currentBoardId,
}: QuickCreateCardModalProps) {
  // **這串陣列的順序有意義，不是排版：第一個元素就是 `<Trans>` 的 namespace。**
  //
  // i18next-parser 的 `JavascriptLexer.setNamespaces` 對每個 entry 取
  // `entry.ns ?? translationFunctionsWithArgs[functionName]?.ns ?? defaultNamespace`
  // 覆寫其 namespace，而 `useTranslation([...])` 正是把**第一個**元素寫進後兩者。
  // 所以 `<Trans>` 的 `ns` prop（jsx lexer 有讀、也確實寫進 `entry.namespace`）會被蓋掉。
  // 一行之差：`["common", "card"]` 會把下面的 key 寫進 `common.json`（值為空），
  // `keepRemoved: false` 再把它從 `card.json` 刪掉——執行期讀不到 `card:create.hint`，
  // 畫面直接印出 key 本身。**zh-TW 的測試、`tsc`、parity 都不會紅**，只有 CI 的
  // `--fail-on-update` 會響，而它的訊息指向語系檔、不指向肇因。
  //
  // **不要把 `i18nKey` 改成帶前綴的 `card:create.hint` 來繞開這件事**：實測那個形狀
  // **不受型別檢查**（寫一個不存在的 key，`tsc -b` 照樣 exit 0），等於用這個 key 的
  // 型別保護換取安定，不划算。`ns` ＋ 裸鍵才是被檢查的形狀。
  //
  // 本檔的主 namespace 本來就是 `card`（`card:*` 28 條，`common:*` 只有 3 條），
  // 排在前面既符合語意，也讓 parser 與執行期看到同一個 namespace。**本檔只有這一處
  // `useTranslation`**——多個呼叫時以最後寫入者為準，那種情況下請跑
  // `npx i18next-parser --fail-on-update` 確認，不要靠推論。
  const { t } = useTranslation(["card", "common"]);
  const queryClient = useQueryClient();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedBoardId, setSelectedBoardId] = useState<string>("");
  const [selectedListId, setSelectedListId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Global 'c' shortcut to open quick create
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "c" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange]);

  // Sync current project/board props when modal opens
  useEffect(() => {
    if (open) {
      setSelectedProjectId(currentProjectId || "");
      setSelectedBoardId(currentBoardId || "");
      setSelectedListId("");
      setTitle("");
      setDescription("");
      setDueDate("");
      setTimeout(() => titleInputRef.current?.focus(), 80);
    }
  }, [open, currentProjectId, currentBoardId]);

  // Query projects
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data as ProjectItem[],
    enabled: open,
  });

  // Pick first project if none selected
  useEffect(() => {
    if (open && !selectedProjectId && projectsQuery.data && projectsQuery.data.length > 0) {
      setSelectedProjectId(projectsQuery.data[0].id);
    }
  }, [open, selectedProjectId, projectsQuery.data]);

  // Query boards of selected project
  const boardsQuery = useQuery({
    queryKey: ["boards", selectedProjectId],
    queryFn: async () =>
      (await api.get(`/projects/${selectedProjectId}/boards`)).data as BoardItem[],
    enabled: open && !!selectedProjectId,
  });

  // Pick first board if none selected
  useEffect(() => {
    if (open && boardsQuery.data && boardsQuery.data.length > 0) {
      if (!selectedBoardId || !boardsQuery.data.some((b) => b.id === selectedBoardId)) {
        setSelectedBoardId(boardsQuery.data[0].id);
      }
    }
  }, [open, selectedBoardId, boardsQuery.data]);

  // Query lists of selected board
  const boardDetailQuery = useQuery({
    queryKey: ["board", selectedBoardId],
    queryFn: async () =>
      (await api.get(`/boards/${selectedBoardId}`)).data as BoardDetailResponse,
    enabled: open && !!selectedBoardId,
  });

  const availableLists = (boardDetailQuery.data?.lists ?? []).filter((l) => !l.isArchived);

  // Pick first list if none selected
  useEffect(() => {
    if (open && availableLists.length > 0) {
      if (!selectedListId || !availableLists.some((l) => l.id === selectedListId)) {
        setSelectedListId(availableLists[0].id);
      }
    }
  }, [open, selectedListId, availableLists]);

  const handleCreate = async (keepOpen = false) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t("card:create.name.required"));
      titleInputRef.current?.focus();
      return;
    }
    if (!selectedListId) {
      toast.error(t("card:create.list.required"));
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await api.post(`/lists/${selectedListId}/cards`, {
        title: trimmedTitle,
        description: description.trim() || null,
      });
      const createdCard = res.data as BoardCardResponse;

      // 卡片已建立，截止日設定屬次要步驟——失敗不得誤報整體失敗（重試會產生重複卡片）
      let dueFailed = false;
      if (dueDate) {
        try {
          await api.put(`/cards/${createdCard.id}`, {
            dueAt: new Date(dueDate).toISOString(),
          });
        } catch {
          dueFailed = true;
        }
      }

      queryClient.invalidateQueries({ queryKey: ["board", selectedBoardId] });
      if (selectedProjectId) {
        queryClient.invalidateQueries({ queryKey: ["project-cards", selectedProjectId] });
        queryClient.invalidateQueries({ queryKey: ["project-cards-table", selectedProjectId] });
        queryClient.invalidateQueries({ queryKey: ["project-cards-nodue", selectedProjectId] });
      }

      if (keepOpen) {
        if (dueFailed) toast.error(t("card:create.partialError"));
        else toast.success(t("card:create.successKeepOpen"));
        setTitle("");
        setDescription("");
        titleInputRef.current?.focus();
      } else {
        if (dueFailed) toast.error(t("card:create.partialError"));
        else toast.success(t("card:create.success"));
        setTitle("");
        setDescription("");
        setDueDate("");
        onOpenChange(false);
      }
    } catch (err: any) {
      toast.error(apiErrorMessage(err, t("common:error.create")));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleCreate(true);
      } else if (e.target === titleInputRef.current) {
        e.preventDefault();
        handleCreate(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg">{t("card:create.title")}</DialogTitle>
              {/* 全庫唯一一處「句子中間夾著 JSX 元素」。設計 §5.3 原本以「沒有案例」為由
                  排除這個元件，遇到時要求停下來問——2026-09-14 使用者裁定採用它 ＋ components：
                  畫面零變化（鍵帽樣式留著），且譯文可以自由重排語序（鍵帽在英文句中的位置與中文不同）。
                  自閉合、不給 children 是刻意的：children 會被 i18next-parser 當成預設譯文，
                  等於把中文原文留在原始碼裡（那就白抽了）。實測自閉合時 parser 不會覆寫既有譯文，
                  `--fail-on-update` 仍為 exit 0。

                  **下面這個元件的名字不要寫進註解。** 實測（2026-09-14）：lexer 對註解裡的
                  JSX 元素也照認，一個沒有 i18nKey 的它會產出 key 為 undefined 的幽靈條目，
                  寫進 `locales/<語系>/.json`（namespace 是空字串的檔），`--fail-on-update` 當場紅。
                  與 `i18next-parser.config.js` 記載的「註解裡的呼叫」是同一類陷阱的另一半。 */}
              <DialogDescription className="text-xs">
                {/* `ns` 與**不帶前綴**的 key 是這個元件的型別要求，不是偏好：
                    它的 i18nKey 對應的是單一 namespace 的裸鍵（帶前綴會型別錯誤，
                    因為帶前綴的形狀只存在於 useTranslation 回傳的 t）。
                    `ns="card"` 已經把 namespace 寫在眼前，自我說明性沒有損失。 */}
                <Trans
                  ns="card"
                  i18nKey="create.hint"
                  values={{ key: "C" }}
                  components={{ kbd: <kbd className="font-mono bg-muted px-1 rounded border" /> }}
                />
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3.5 py-2">
          {/* Card Title */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t("card:create.name.label")}</label>
            <Input
              ref={titleInputRef}
              placeholder={t("card:create.name.placeholder")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-sm font-medium"
            />
          </div>

          {/* Target Location Selectors */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("card:create.project.label")}</label>
              <Select
                value={selectedProjectId}
                onValueChange={(val) => {
                  setSelectedProjectId(val);
                  setSelectedBoardId("");
                  setSelectedListId("");
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={projectsQuery.isLoading ? t("card:create.project.loading") : t("card:create.project.placeholder")} />
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
              <label className="text-xs font-medium text-muted-foreground">{t("card:create.board.label")}</label>
              <Select
                value={selectedBoardId}
                onValueChange={(val) => {
                  setSelectedBoardId(val);
                  setSelectedListId("");
                }}
                disabled={!selectedProjectId || boardsQuery.isLoading || (boardsQuery.data ?? []).length === 0}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={boardsQuery.isLoading ? t("card:create.board.loading") : (boardsQuery.data ?? []).length === 0 ? t("card:create.board.empty") : t("card:create.board.placeholder")} />
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
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("card:create.list.label")}</label>
              <Select
                value={selectedListId}
                onValueChange={setSelectedListId}
                disabled={!selectedBoardId || boardDetailQuery.isLoading || availableLists.length === 0}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={boardDetailQuery.isLoading ? t("card:create.list.loading") : availableLists.length === 0 ? t("card:create.list.empty") : t("card:create.list.placeholder")} />
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

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t("card:create.dueDate.label")}</label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t("card:create.description.label")}</label>
            <textarea
              placeholder={t("card:create.description.placeholder")}
              value={description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
              rows={2}
              className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>
        </div>

        <DialogFooter className="flex flex-row items-center justify-between sm:justify-between pt-2 border-t">
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <kbd className="font-mono bg-muted px-1 rounded border">Enter</kbd> {t("common:action.create")}
            </span>
            <span>·</span>
            <span className="flex items-center gap-0.5">
              <kbd className="font-mono bg-muted px-1 rounded border">
                {isMac ? "⌘" : "Ctrl"}+Enter
              </kbd>{" "}
              {t("card:create.keepOpen.hint")}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t("common:action.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleCreate(true)}
              disabled={isSubmitting || !title.trim() || !selectedListId}
              className="text-xs"
            >
              {t("card:create.keepOpen.action")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => handleCreate(false)}
              disabled={isSubmitting || !title.trim() || !selectedListId}
              className="gap-1 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("card:create.submit.action")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
