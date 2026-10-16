import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { invalidateProjectViews, type ViewScope } from "@/lib/invalidate-views";
import { currentLocale } from "@/lib/format";
import type { CardResponse, LabelResponse, ProjectMemberResponse, ReviewResponse } from "@/lib/board-types";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Pencil } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { colorName, LABEL_PALETTE } from "./label-palette";
import { CopyCardDialog, type CopyTarget } from "./CopyCardDialog";
import { CardDescriptionTab } from "./tabs/CardDescriptionTab";
import { ItemDetailsTab } from "./tabs/ItemDetailsTab";
import { CardChecklistsTab } from "./tabs/CardChecklistsTab";
import { CardAttachmentsTab } from "./tabs/CardAttachmentsTab";
import { CardActivityTab } from "./tabs/CardActivityTab";
import { CardCommentsTab } from "./tabs/CardCommentsTab";
import { useTranslation } from "react-i18next";

export interface CardDialogProps { cardId?: string; projectId?: string; boardId?: string; open?: boolean; onOpenChange?: (open: boolean) => void; }

export function CardDialog(props: CardDialogProps) {
  const { t } = useTranslation(["common", "card"]);
  const params = useParams();
  const cardId = props.cardId || params.cardId;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const card = useQuery({
    queryKey: ["card", cardId],
    queryFn: async () => (await api.get(`/cards/${cardId}`)).data as CardResponse,
    enabled: !!cardId,
  });

  const projectId = props.projectId || params.projectId;
  const boardId = props.boardId || params.boardId || card.data?.boardId;

  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/members`)).data as ProjectMemberResponse[],
    enabled: !!projectId,
  });
  const labels = useQuery({
    queryKey: ["board-labels", boardId],
    queryFn: async () => (await api.get(`/boards/${boardId}/labels`)).data as LabelResponse[],
    enabled: !!boardId,
  });
  const permissions = useProjectPermissions(projectId);
  const can = (code: string) => (permissions.data ?? []).includes(code);

  // 預設參數是**這張卡自己**所屬的看板／專案——八個既有呼叫端都不帶引數，行為不變。
  // 唯一帶引數的是複製：副本在**目標**專案，要失效的是目標的檢視，否則新卡不會出現在
  // 目標看板／報表上（而且沒有任何紅燈）。來源端不動——複製沒有改到來源的任何一列。
  //
  // 清單本身住在 `@/lib/invalidate-views`（2026-09-22 抽出）：看板／清單複製要再做一次
  // 同樣的事，三份清單各自漏 key 時都不會有紅燈 ⇒ 收斂成單一定義，由契約鎖釘住。
  const invalidateAllViews = (scope: ViewScope = { projectId, boardId }) => {
    invalidateProjectViews(queryClient, scope);
  };

  const saveCard = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await api.put(`/cards/${cardId}`, patch)).data as CardResponse,
    onSuccess: (updated, vars) => {
      // 標題存檔由呼叫端以序號守護校正 cache（spec #6：舊回應不覆寫較新輸入）
      if ("title" in vars) return;
      // Fix round 3：僅 patch 本次送出的欄位（vars 鍵）——回應快照可能含其他欄位
      // 並發變更前的舊值（與 5c 同類整卡覆寫危害）
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) => {
        if (!c) return c;
        const next = { ...c } as unknown as Record<string, unknown>;
        const updatedRecord = updated as unknown as Record<string, unknown>;
        for (const key of Object.keys(vars)) {
          if (key in updatedRecord) next[key] = updatedRecord[key];
        }
        return next as unknown as CardResponse;
      });
      invalidateAllViews();
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.save"))),
  });

  const archive = useMutation({
    mutationFn: async () => saveCard.mutateAsync({ isArchived: !card.data!.isArchived }),
    onSuccess: () => toast.success(t("card:archive.success")),
  });

  const toggleCompletion = useMutation({
    mutationFn: async (isCompleted: boolean) => (await api.put(`/cards/${cardId}/completion`, { isCompleted })).data as CardResponse,
    onSuccess: (updated) => {
      // 僅 patch completedAt——整卡覆寫會把並發的成員/標籤樂觀更新蓋回舊值
      //（saveCard/saveMembers/saveLabels 同型修復，此處為最後一處漏網）
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
        c ? { ...c, completedAt: updated.completedAt } : c,
      );
      invalidateAllViews();
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.toggleCompletion"))),
  });

  const deleteCard = useMutation({
    mutationFn: async () => api.delete(`/cards/${cardId}`),
    onSuccess: () => {
      invalidateAllViews();
      toast.success(t("card:delete.success"));
      if (props.onOpenChange) {
        props.onOpenChange(false);
      } else if (projectId && boardId) {
        navigate(`/projects/${projectId}/boards/${boardId}`);
      }
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.delete"))),
  });

  const copyCard = useMutation({
    // `?locale=` 決定副本標題的後綴樣板（後端寫入時就決定了，之後改語系不會跟著變）；
    // body 一律帶上使用者選的目標列表——不帶的話後端退回**來源列表**，而畫面照樣成功
    mutationFn: async (target: CopyTarget) =>
      (await api.post(`/cards/${cardId}/copy?locale=${encodeURIComponent(currentLocale())}`, {
        targetListId: target.listId,
      })).data as CardResponse,
    onSuccess: (_created, target) => {
      invalidateAllViews({ projectId: target.projectId, boardId: target.boardId });
      setCopyOpen(false);
      toast.success(t("card:copy.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.copy"))),
  });

  // 成員/標籤樂觀 toggle（spec #10）：onMutate 就地切換 card cache（checkbox 立即反應）、
  // onError 以 onMutate 快照回滾、onSuccess 以回應校正＋invalidate board。
  // 送出之 PUT payload 必等於樂觀後陣列——toggle 一律以最新 cache 計算（連點競態核心）。
  const saveMembers = useMutation({
    mutationFn: async (userIds: string[]) =>
      (await api.put(`/cards/${cardId}/members`, { userIds })).data as CardResponse,
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["card", cardId] });
      const prev = queryClient.getQueryData<CardResponse>(["card", cardId]);
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) => (c ? { ...c, members: next } : c));
      return { prev };
    },
    onSuccess: (updated, vars) => {
      // 回應亂序守護（review Important 1）：cache 已分叉（較新 toggle 樂觀態）時
      // 跳過覆寫（較新回應會校正），僅在同集合時套用；仍 invalidate board 背景同步
      const current = queryClient.getQueryData<CardResponse>(["card", cardId]);
      const stale =
        current &&
        (current.members.length !== vars.length || !current.members.every((id) => vars.includes(id)));
      if (!stale) {
        // 僅 patch 自己擁有的欄位（Fix round 2 Bug 1）：回應快照可能是在其他欄位
        // 的 PUT 處理前生成的（含舊 labels），整卡覆寫會把已樂觀更新的標籤蓋回
        queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
          c ? { ...c, members: updated.members } : c,
        );
      }
      invalidateAllViews();
    },
    onError: (error, _vars, ctx) => {
      // 僅回滾本 mutation 擁有的欄位——整卡快照會把其他欄位較新的樂觀/已確認更新蓋掉
      if (ctx?.prev) {
        queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
          c ? { ...c, members: ctx.prev!.members } : c,
        );
      }
      // 409 並發衝突：顯示伺服器的錯誤訊息（錯誤碼是 `concurrency.conflict`，
      // 定義在後端 `ErrorCodes.cs`，譯文即今天的中文）
      toast.error(apiErrorMessage(error, t("common:error.assign")));
    },
  });
  const saveReviewers = useMutation({
    mutationFn: async (reviewerUserIds: string[]) =>
      (await api.put(`/cards/${cardId}/reviews`, { reviewerUserIds })).data as ReviewResponse[],
    onSuccess: (updated) => {
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
        c ? { ...c, reviews: updated } : c,
      );
      invalidateAllViews();
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, t("card:review.assign.error")));
    },
  });

  const saveLabels = useMutation({
    mutationFn: async (labelIds: string[]) =>
      (await api.put(`/cards/${cardId}/labels`, { labelIds })).data as CardResponse,
    onMutate: async (next) => {
      // CardResponse.labels 為物件陣列：樂觀態以 board-labels 查詢對照 id→物件。
      // 於首個 await 前同步讀取——createLabel 剛回填的新標籤方得對照（不被 refetch 競跑）
      const labelMap = new Map(
        (queryClient.getQueryData<LabelResponse[]>(["board-labels", boardId]) ?? []).map((l) => [l.id, l]),
      );
      await queryClient.cancelQueries({ queryKey: ["card", cardId] });
      const prev = queryClient.getQueryData<CardResponse>(["card", cardId]);
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
        c
          ? {
              ...c,
              labels: next
                .map((id) => labelMap.get(id) ?? c.labels.find((l) => l.id === id))
                .filter((l): l is LabelResponse => Boolean(l)),
            }
          : c,
      );
      return { prev };
    },
    onSuccess: (updated, vars) => {
      // 回應亂序守護（review Important 1）：cache 已分叉時跳過覆寫，僅在同集合時套用
      const current = queryClient.getQueryData<CardResponse>(["card", cardId]);
      const stale =
        current &&
        (current.labels.length !== vars.length || !current.labels.every((l) => vars.includes(l.id)));
      if (!stale) {
        // 僅 patch 自己擁有的欄位（Fix round 2 Bug 1）：回應快照可能含舊 members，
        // 整卡覆寫會把已樂觀更新的成員蓋回
        queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
          c ? { ...c, labels: updated.labels } : c,
        );
      }
      invalidateAllViews();
    },
    onError: (error, _vars, ctx) => {
      // 僅回滾本 mutation 擁有的欄位——整卡快照會把其他欄位較新的樂觀/已確認更新蓋掉
      if (ctx?.prev) {
        queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
          c ? { ...c, labels: ctx.prev!.labels } : c,
        );
      }
      // 409 並發衝突：顯示伺服器中文 detail（axios 泛用英文 message 只說 status code）
      toast.error(apiErrorMessage(error, t("card:label.save.error")));
    },
  });
  const createLabel = useMutation({
    mutationFn: async (label: { name: string; color: string }) =>
      (await api.post(`/boards/${boardId}/labels`, label)).data as LabelResponse,
    onSuccess: (created) => {
      // 先回填 board-labels（含新標籤）再追打（review Minor 3）：saveLabels 樂觀態的
      // labelMap 得以對照新 id，按鈕計數即時翻動
      queryClient.setQueryData<LabelResponse[]>(["board-labels", boardId], (ls) => (ls ? [...ls, created] : ls));
      // 追打先於 invalidate：樂觀 labelMap 同步讀到剛回填的 cache；
      // refetch 僅作背景校正，避免與樂觀讀取競跑
      const current = queryClient.getQueryData<CardResponse>(["card", cardId]);
      const labelIds = current ? current.labels.map((l) => l.id) : card.data!.labels.map((l) => l.id);
      saveLabels.mutate([...labelIds, created.id]);
      queryClient.invalidateQueries({ queryKey: ["board-labels", boardId] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("card:label.create.error"))),
  });

  const updateLabel = useMutation({
    mutationFn: async ({ id, name, color }: { id: string; name: string; color: string }) =>
      (await api.put(`/boards/${boardId}/labels/${id}`, { name, color })).data as LabelResponse,
    onSuccess: (updated) => {
      queryClient.setQueryData<LabelResponse[]>(["board-labels", boardId], (ls) =>
        ls ? ls.map((l) => (l.id === updated.id ? updated : l)) : ls
      );
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) => {
        if (!c) return c;
        return {
          ...c,
          labels: c.labels.map((l) => (l.id === updated.id ? updated : l)),
        };
      });
      invalidateAllViews();
      setEditingLabel(null);
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("card:label.update.error"))),
  });

  const deleteLabel = useMutation({
    mutationFn: async (id: string) => api.delete(`/boards/${boardId}/labels/${id}`),
    onSuccess: (_, id) => {
      queryClient.setQueryData<LabelResponse[]>(["board-labels", boardId], (ls) =>
        ls ? ls.filter((l) => l.id !== id) : ls
      );
      queryClient.setQueryData<CardResponse>(["card", cardId], (c) => {
        if (!c) return c;
        return {
          ...c,
          labels: c.labels.filter((l) => l.id !== id),
        };
      });
      invalidateAllViews();
      setEditingLabel(null);
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("card:label.delete.error"))),
  });

  const toggleMember = (userId: string) => {
    const current =
      queryClient.getQueryData<CardResponse>(["card", cardId])?.members ?? card.data!.members;
    saveMembers.mutate(current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  };
  const toggleReviewer = (userId: string) => {
    const current =
      queryClient.getQueryData<CardResponse>(["card", cardId])?.reviews.map((r) => r.reviewerUserId) ?? 
      card.data!.reviews.map((r) => r.reviewerUserId);
    saveReviewers.mutate(current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  };
  const toggleLabel = (labelId: string) => {
    const current =
      queryClient.getQueryData<CardResponse>(["card", cardId])?.labels.map((l) => l.id) ??
      card.data!.labels.map((l) => l.id);
    saveLabels.mutate(current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId]);
  };

  // #25：以 mutation 回傳之 CardResponse patch card cache（取代整卡 invalidate/refetch）。
  // Fix round 3：僅 patch 呼叫端（ItemDetailsTab 自訂欄位存檔）擁有欄位 customFields——
  // 回應快照可能含其他欄位並發變更前的舊值（與 5c 同類整卡覆寫危害）
  const patchCardCustomFields = (updated: CardResponse) => {
    queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
      c ? { ...c, customFields: updated.customFields } : c,
    );
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState<LabelResponse | null>(null);
  const [title, setTitle] = useState<string>(() => card.data?.title ?? "");
  // 以 ref 追蹤實際焦點（fix round 1）：僅真正聚焦中才不讓 server 值同步覆寫輸入（spec #6）；
  // blur（含存檔後）即釋放——後續外部更新可正常同步，亦不會在重新聚焦輸入時被舊回應覆寫
  const titleFocusedRef = useRef(false);
  // 標題存檔序號：僅最新一次存檔的回應校正 cache（併發 PUT 以最新值勝）
  const titleSaveSeq = useRef(0);
  useEffect(() => {
    if (titleFocusedRef.current) return;
    const next = card.data?.title;
    if (next !== undefined) setTitle(next);
  }, [card.data?.title]);
  const [startDate, setStartDate] = useState<string>(() => card.data?.startAt?.slice(0, 10) ?? "");
  const [dueDate, setDueDate] = useState<string>(() => card.data?.dueAt?.slice(0, 10) ?? "");
  const dueFocusedRef = useRef(false);
  useEffect(() => {
    if (dueFocusedRef.current) return;
    setStartDate(card.data?.startAt?.slice(0, 10) ?? "");
    setDueDate(card.data?.dueAt?.slice(0, 10) ?? "");
  }, [card.data?.startAt, card.data?.dueAt]);

  const handleClose = () => {
    if (props.onOpenChange) props.onOpenChange(false);
    else navigate(`/projects/${projectId}/boards/${boardId}`);
  };

  if (card.isLoading)
    return (
      <Dialog open={props.open !== undefined ? props.open : true} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="card-dialog-skeleton">
          <DialogHeader>
            <DialogTitle><Skeleton className="h-7 w-1/2" /></DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </DialogContent>
      </Dialog>
    );
  if (card.isError)
    return (
      <Dialog open={props.open !== undefined ? props.open : true} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("card:load.error.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-destructive">{t("card:load.error.description")}</p>
          <Button variant="outline" onClick={handleClose}>{t("card:backToBoard.action")}</Button>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog open={props.open !== undefined ? props.open : true} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto [scrollbar-gutter:stable]">
        <DialogHeader>
          {/* pr-8：為 DialogContent 右上角 absolute 關閉鈕（right-4 + 1rem 寬）預留空間，避免遮蓋標題輸入框 */}
          <DialogTitle className="flex items-center justify-between gap-2 pr-8">
            <label className="flex items-center gap-2 cursor-pointer text-sm font-normal text-muted-foreground whitespace-nowrap">
              <input
                type="checkbox"
                disabled={!can("card.edit")}
                checked={!!card.data!.completedAt}
                onChange={(e) => toggleCompletion.mutate(e.target.checked)}
                className="h-4 w-4"
              />
              {t("card:field.completed.label")}
            </label>
            <input
              value={title}
              disabled={!can("card.edit")}
              className="flex-1 rounded border bg-transparent px-2 py-1 text-lg font-bold"
              onChange={(e) => setTitle(e.target.value)}
              onFocus={() => { titleFocusedRef.current = true; }}
              onBlur={(e) => {
                titleFocusedRef.current = false;
                const next = e.target.value.trim();
                if (next && next !== card.data!.title) {
                  const seq = ++titleSaveSeq.current;
                  saveCard.mutate(
                    { title: next },
                    {
                      onSuccess: (updated) => {
                        if (seq !== titleSaveSeq.current) return;
                        // Fix round 3：僅 patch title（序號只守 title-vs-title）——
                        // 整卡覆寫會蓋掉並發的 labels/members 樂觀態
                        queryClient.setQueryData<CardResponse>(["card", cardId], (c) =>
                          c ? { ...c, title: updated.title } : c,
                        );
                        queryClient.invalidateQueries({ queryKey: ["board", boardId] });
                      },
                    },
                  );
                } else {
                  setTitle(card.data!.title);
                }
              }}
            />
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <label>
            {t("card:field.startAt.label")}
            <input
              type="date"
              disabled={!can("card.edit")}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              onBlur={() => {
                const current = card.data!.startAt?.slice(0, 10) ?? "";
                if (startDate !== current) {
                  saveCard.mutate({ startAt: startDate ? `${startDate}T00:00:00Z` : null });
                }
              }}
            />
          </label>
          <label>
            {t("card:field.dueDate.label")}
            <input
              type="date"
              disabled={!can("card.edit")}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              onFocus={() => { dueFocusedRef.current = true; }}
              onBlur={() => {
                dueFocusedRef.current = false;
                const current = card.data!.dueAt?.slice(0, 10) ?? "";
                if (dueDate !== current) {
                  saveCard.mutate({ dueAt: dueDate ? `${dueDate}T00:00:00Z` : null });
                }
              }}
            />
          </label>
          {(card.data?.mindMapNodes ?? []).map((n) => (
            <Button key={n.id} variant="outline" size="sm"
              onClick={() => navigate(`/projects/${projectId}?tab=mindmap&node=${n.id}`)}>
              {t("card:field.mindMap.label", { title: n.title })}
            </Button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!can("card.assign")}>{t("card:member.count", { count: card.data!.members.length })}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel className="flex items-center justify-between gap-2">
                <span>{t("card:member.assign.label")}</span>
                {user && can("card.assign") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs text-primary font-medium hover:bg-primary/10"
                    onClick={(e) => {
                      e.preventDefault();
                      toggleMember(user.userId);
                    }}
                  >
                    {card.data!.members.includes(user.userId) ? t("card:member.removeSelf.action") : t("card:member.assignSelf.action")}
                  </Button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {members.isError ? (
                <div className="px-2 py-1.5 text-sm text-destructive">
                  {t("card:member.load.error")}
                  <Button size="sm" variant="outline" className="ml-2" onClick={() => members.refetch()}>
                    {t("common:action.retry")}
                  </Button>
                </div>
              ) : (
                <>
                  {(members.data ?? []).map((m) => (
                    <DropdownMenuCheckboxItem
                      key={m.userId}
                      checked={card.data!.members.includes(m.userId)}
                      onCheckedChange={() => toggleMember(m.userId)}
                    >
                      {t("common:member.display", { name: m.displayName, username: m.username })}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {(members.data ?? []).length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("card:member.empty")}</div>}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!can("card.assign")}>{t("card:reviewer.count", { count: card.data!.reviews.length })}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel className="flex items-center justify-between gap-2">
                <span>{t("card:reviewer.assign.label")}</span>
                {user && can("card.assign") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs text-primary font-medium hover:bg-primary/10"
                    onClick={(e) => {
                      e.preventDefault();
                      toggleReviewer(user.userId);
                    }}
                  >
                    {card.data!.reviews.some(r => r.reviewerUserId === user.userId) ? t("card:member.removeSelf.action") : t("card:member.assignSelf.action")}
                  </Button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {members.isError ? (
                <div className="px-2 py-1.5 text-sm text-destructive">
                  {t("card:member.load.error")}
                  <Button size="sm" variant="outline" className="ml-2" onClick={() => members.refetch()}>
                    {t("common:action.retry")}
                  </Button>
                </div>
              ) : (
                <>
                  {(members.data ?? []).map((m) => (
                    <DropdownMenuCheckboxItem
                      key={m.userId}
                      checked={card.data!.reviews.some((r) => r.reviewerUserId === m.userId)}
                      onCheckedChange={() => toggleReviewer(m.userId)}
                      disabled={saveReviewers.isPending}
                    >
                      {t("common:member.display", { name: m.displayName, username: m.username })}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {(members.data ?? []).length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("card:member.empty")}</div>}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!can("card.edit")}>{t("card:label.count", { count: card.data!.labels.length })}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>{t("card:label.list.title")}</DropdownMenuLabel>
              {labels.isError ? (
                <div className="px-2 py-1.5 text-sm text-destructive">
                  {t("card:label.load.error")}
                  <Button size="sm" variant="outline" className="ml-2" onClick={() => labels.refetch()}>
                    {t("common:action.retry")}
                  </Button>
                </div>
              ) : (
                (labels.data ?? []).map((l) => (
                  <div key={l.id} className="group relative flex items-center pr-8">
                    <DropdownMenuCheckboxItem
                      checked={card.data!.labels.some((cl) => cl.id === l.id)}
                      onCheckedChange={() => toggleLabel(l.id)}
                      className="flex-1"
                    >
                      <span className="mr-2 inline-block h-2 w-4 rounded" style={{ backgroundColor: l.color }} />
                      <span className="flex-1 overflow-hidden text-ellipsis">{l.name}</span>
                    </DropdownMenuCheckboxItem>
                    {can("board.edit") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingLabel(l);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))
              )}
              {can("board.edit") && (
                <LabelManageSection
                  onSelect={(e) => e.preventDefault()}
                  isCreating={createLabel.isPending}
                  isUpdating={updateLabel.isPending}
                  isDeleting={deleteLabel.isPending}
                  editingLabel={editingLabel}
                  onCancelEdit={() => setEditingLabel(null)}
                  onCreate={(name, color) => createLabel.mutate({ name, color })}
                  onUpdate={(id, name, color) => updateLabel.mutate({ id, name, color })}
                  onDelete={(id) => deleteLabel.mutate(id)}
                />
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {can("card.edit") && (
            <Button variant="outline" size="sm" disabled={archive.isPending} onClick={() => archive.mutate()}>
              {card.data!.isArchived ? t("common:action.unarchive") : t("common:action.archive")}
            </Button>
          )}
          {can("card.create") && (
            <Button variant="outline" size="sm" onClick={() => setCopyOpen(true)}>
              {t("common:action.copy")}
            </Button>
          )}
          {can("card.delete") && (
            confirmDelete ? (
              <span className="flex gap-1">
                <Button variant="destructive" size="sm" onClick={() => deleteCard.mutate()}>{t("card:delete.confirm.action")}</Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>{t("common:action.cancel")}</Button>
              </span>
            ) : (
              <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>{t("common:action.delete")}</Button>
            )
          )}
        </div>
        {/* 條件掛載：關閉即卸載、重開即重新初始化（回到卡片現址），故不需要 reset effect。
            入口在工具列、與分頁無關，所以掛在 Tabs 之外。 */}
        {copyOpen && (
          <CopyCardDialog
            card={{ title: card.data!.title, listId: card.data!.listId }}
            defaults={{ projectId, boardId }}
            onOpenChange={setCopyOpen}
            onConfirm={(target) => copyCard.mutate(target)}
            pending={copyCard.isPending}
          />
        )}
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">{t("card:tab.description")}</TabsTrigger>
            {/* 無障礙名稱取自可見文字，刻意不給 aria-label——給了就覆蓋掉譯文（WCAG 2.5.3 Label in Name）。 */}
            <TabsTrigger value="item-details">{t("card:tab.details")}</TabsTrigger>
            <TabsTrigger value="checklists">{t("card:tab.checklists")}</TabsTrigger>
            <TabsTrigger value="attachments">{t("card:tab.attachments")}</TabsTrigger>
            <TabsTrigger value="comments">{t("card:tab.comments")}</TabsTrigger>
            <TabsTrigger value="activity">{t("card:tab.activity")}</TabsTrigger>
          </TabsList>
          <TabsContent value="details">
            <CardDescriptionTab card={card.data!} canEdit={can("card.edit")} onSave={saveCard.mutateAsync} />
          </TabsContent>
          <TabsContent value="item-details">
            <ItemDetailsTab card={card.data!} projectId={projectId!} permissions={permissions.data ?? []} onCustomFieldsPatch={patchCardCustomFields} onRefresh={() => queryClient.invalidateQueries({ queryKey: ["card", cardId] })} />
          </TabsContent>
          <TabsContent value="checklists">
            <CardChecklistsTab card={card.data!} boardId={boardId!} canEdit={can("card.edit")} onRefresh={() => queryClient.invalidateQueries({ queryKey: ["card", cardId] })} />
          </TabsContent>
          <TabsContent value="attachments">
            <CardAttachmentsTab card={card.data!} canEdit={can("card.edit")} onSave={saveCard.mutate} onRefresh={() => queryClient.invalidateQueries({ queryKey: ["card", cardId] })} />
          </TabsContent>
          <TabsContent value="comments">
            <CardCommentsTab card={card.data!} canComment={can("card.comment") || can("card.edit")} onRefresh={() => queryClient.invalidateQueries({ queryKey: ["card", cardId] })} />
          </TabsContent>
          <TabsContent value="activity">
            <CardActivityTab card={card.data!} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function LabelManageSection({
  onSelect,
  isCreating,
  isUpdating,
  isDeleting,
  editingLabel,
  onCancelEdit,
  onCreate,
  onUpdate,
  onDelete,
}: {
  onSelect: (e: SyntheticEvent) => void;
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  editingLabel: LabelResponse | null;
  onCancelEdit: () => void;
  onCreate: (name: string, color: string) => void;
  onUpdate: (id: string, name: string, color: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation(["common", "card"]);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_PALETTE[0]);

  useEffect(() => {
    if (editingLabel) {
      setName(editingLabel.name);
      setColor(editingLabel.color);
    } else {
      setName("");
      setColor(LABEL_PALETTE[0]);
    }
  }, [editingLabel]);

  const isPending = isCreating || isUpdating || isDeleting;

  return (
    <div onSelect={onSelect}>
      <DropdownMenuSeparator />
      <div className="space-y-1 px-2 py-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            {editingLabel ? t("card:label.edit.heading") : t("card:label.create.heading")}
          </span>
          {editingLabel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1 text-[10px]"
              onClick={onCancelEdit}
            >
              {t("common:action.cancel")}
            </Button>
          )}
        </div>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("card:label.name.placeholder")} />
        <div className="flex flex-wrap gap-1 py-1">
          {LABEL_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={colorName(c)}
              aria-pressed={color === c}
              className={`h-5 w-5 rounded-full ${color === c ? "ring-2 ring-ring ring-offset-1" : ""}`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="flex gap-2">
          {editingLabel ? (
            <>
              <Button
                size="sm"
                className="flex-1"
                disabled={!name.trim() || isPending}
                onClick={() => onUpdate(editingLabel.id, name.trim(), color)}
              >
                {t("common:action.save")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isPending}
                onClick={() => {
                  if (window.confirm(t("card:label.delete.confirm"))) {
                    onDelete(editingLabel.id);
                  }
                }}
              >
                {t("common:action.delete")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="w-full"
              disabled={!name.trim() || isPending}
              onClick={() => {
                onCreate(name.trim(), color);
                setName("");
              }}
            >
              {t("card:label.create.action")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}


