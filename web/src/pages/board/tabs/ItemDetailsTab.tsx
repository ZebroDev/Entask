import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/utils";
import { formatDateTime, formatDay, formatHours, hourUnit } from "@/lib/format";
import { localDayString, localTimeZoneId } from "@/lib/local-day";
import { scopeLabel } from "@/lib/custom-fields";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CardResponse, CustomFieldResponse, ProjectMemberResponse, ReviewEntryResponse, ReviewResponse } from "@/lib/board-types";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import { REVIEW_BADGE_CLASS, REVIEW_BADGE_SHELL, reviewStateLabel } from "@/lib/review-badge";
import type { TFunction } from "i18next";

// 後端原樣回傳的審查識別碼 → 顯示文字。switch ＋ 字面值是動態 key 的唯一合法寫法：
// i18next-parser 只認字面值引數，查表抽不到，而 keepRemoved 會把抽不到的 key 從語系檔
// 刪掉——畫面直接印出 key 本身，且測試與型別檢查都不會紅。
//
// `t` 由呼叫端於 render 時傳入（不是模組層級求值），語系切換才會重繪。
//
// 這一支翻的是**逐審查者**的立場（審查者摘要列）。整張卡的 rollup 走下面那一支。
//
// `TFunction<["common", "card"]>` 的兩個 namespace 不可省（不是裸的 TFunction）：
// 型別化 key 以 defaultNS（common）為權威，少了這一行，帶 `card:` 前綴的那一條會在
// `tsc -b` 紅成「不能把 card:review.status.pending 指定給 common 的 key」。
function reviewStatusLabel(t: TFunction<["common", "card"]>, status: string): string {
  switch (status) {
    case "approved": return t("common:state.approved");
    case "rejected": return t("common:state.rejected");
    case "pending": return t("card:review.status.pending");
    default: return status;
  }
}

interface Props {
  card: CardResponse;
  projectId: string;
  permissions: string[];
  onCustomFieldsPatch: (card: CardResponse) => void;
  onRefresh: () => void;
}

export function ItemDetailsTab({ card, projectId, permissions, onCustomFieldsPatch, onRefresh }: Props) {
  const { t } = useTranslation(["common", "card"]);
  const [hours, setHours] = useState("");
  // 補登日期（設計 D2）：預設今日的**本地日**（`yyyy-MM-dd`），由使用者改選。
  // 以 lazy initializer 取當日而不是模組層級常數——模組層級會凍結在 import 當下，
  // 開著的分頁跨過午夜後再開表單就會拿到昨天。
  const [logDate, setLogDate] = useState(() => localDayString());
  const [estimate, setEstimate] = useState(card.estimatedHours?.toString() ?? "");
  const myUserId = useAuth((s) => s.user?.userId);
  const queryClient = useQueryClient();

  const fields = useQuery({
    queryKey: ["custom-fields", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/custom-fields`)).data as CustomFieldResponse[],
  });
  const projectName = useQuery({
    queryKey: ["project-name", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}`)).data as { name: string },
  });
  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/members`)).data as ProjectMemberResponse[],
  });
  // 審查歷程：endpoint 回的是**裸陣列**（append-only，刻意不分頁）。
  const reviewHistory = useQuery({
    queryKey: ["card-review-history", card.id],
    queryFn: async () => (await api.get(`/cards/${card.id}/review-history`)).data as ReviewEntryResponse[],
  });

  const can = (code: string) => permissions.includes(code);
  const remaining = card.estimatedHours !== null ? card.estimatedHours - card.effort.totalHours : null;
  const progress = card.estimatedHours && card.estimatedHours > 0
    ? Math.min(100, Math.round((card.effort.totalHours / card.estimatedHours) * 100))
    : 0;

  // 樂觀更新自訂欄位值（spec #5）：onMutate patch card cache、onError 回滾；
  // text/number 由 CustomFieldTextInput 於 blur/Enter 提交，select/checkbox/date 仍即時提交。
  // #25：PUT 回傳 CardResponse——onSuccess 以回應 patch card cache 取代 invalidate/refetch
  const saveField = useMutation({
    mutationFn: async ({ fieldId, value }: { fieldId: string; value: unknown }) =>
      (await api.put(`/cards/${card.id}/custom-fields`, { [fieldId]: value })).data as CardResponse,
    onMutate: async ({ fieldId, value }) => {
      await queryClient.cancelQueries({ queryKey: ["card", card.id] });
      const previous = queryClient.getQueryData<CardResponse>(["card", card.id]);
      queryClient.setQueryData<CardResponse>(["card", card.id], (old) =>
        old
          ? {
              ...old,
              customFields: old.customFields.some((v) => v.fieldDefinitionId === fieldId)
                ? old.customFields.map((v) => (v.fieldDefinitionId === fieldId ? { ...v, value } : v))
                : [...old.customFields, { fieldDefinitionId: fieldId, value }],
            }
          : old,
      );
      return { previous };
    },
    onSuccess: (updated) => {
      // 回應亂序守護（同 members/labels 慣例，欄位版）：cache 中任一欄位值與回應
      // 不一致＝此回應較舊（他欄位較新存檔在途/已落地，或本欄位已被較新存檔覆蓋）
      // → 跳過覆寫，由較新回應校正；僅在回應與 cache 一致時套用 patch
      const current = queryClient.getQueryData<CardResponse>(["card", card.id]);
      if (!current) { onCustomFieldsPatch(updated); return; }
      const diverged = current.customFields.some(
        (v) => updated.customFields.find((u) => u.fieldDefinitionId === v.fieldDefinitionId)?.value !== v.value,
      );
      if (!diverged) onCustomFieldsPatch(updated);
    },
    onError: (error, _vars, context) => {
      // 僅回滾自訂欄位——整卡快照會把其他欄位較新的樂觀/已確認更新蓋掉
      if (context?.previous) {
        queryClient.setQueryData<CardResponse>(["card", card.id], (c) =>
          c ? { ...c, customFields: context.previous!.customFields } : c,
        );
      }
      // 409 並發衝突（欄位定義變更）顯示伺服器中文 detail
      toast.error(apiErrorMessage(error, t("card:customField.save.error")));
    },
  });

  // 估時存檔序號：僅最新一次存檔的回應校正 cache（同欄位並發亂序時舊回應不可覆寫較新值）
  const estimateSaveSeq = useRef(0);
  const saveEstimate = useMutation({
    mutationFn: async () => {
      const seq = ++estimateSaveSeq.current;
      const data = (await api.put(`/cards/${card.id}`, { estimatedHours: estimate === "" ? null : Number(estimate) }))
        .data as CardResponse;
      return { seq, data };
    },
    onSuccess: ({ seq, data: updated }) => {
      if (seq !== estimateSaveSeq.current) return;
      // I-1：僅 patch 本 mutation 擁有欄位（estimatedHours）——整卡覆寫會讓舊回應
      // （含舊 title）覆蓋他欄位較新值（估時與標題併發回應亂序時）；其餘欄位維持 cache 現值
      queryClient.setQueryData<CardResponse>(["card", card.id], (old) =>
        old ? { ...old, estimatedHours: updated.estimatedHours } : updated,
      );
      toast.success(t("card:effort.estimate.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.save"))),
  });

  const logEffort = useMutation({
    // 三欄缺一不可：`localDate` 是後端凍結工作日誌那一日的**唯一**來源（不從時間戳回推），
    // 而 `timeZoneId` 是「這個本地日是哪個時區的」的自陳——沒有它，後端無從判斷
    // 這個日期是不是未來（`effort.localDateInFuture`）。`max` 只是 UI affordance。
    mutationFn: async () => api.post(`/cards/${card.id}/effort`, {
      hours: Number(hours), timeZoneId: localTimeZoneId(), localDate: logDate,
    }),
    // 工時回報是工作日誌列的唯一生產者——記錄成功後一併失效 worklog，
    // 否則日誌頁在自家事件外的失效路徑（後端廣播）到達前仍顯示舊資料
    onSuccess: () => {
      onRefresh();
      queryClient.invalidateQueries({ queryKey: ["worklog"] });
      setHours("");
      setLogDate(localDayString());
      toast.success(t("card:effort.log.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("card:effort.log.error"))),
  });

  const submitReview = useMutation({
    mutationFn: async (r: { reviewId: string; status: string; score: number | null; comment: string }) =>
      api.put(`/cards/${card.id}/reviews/${r.reviewId}`, { status: r.status, score: r.score, comment: r.comment }),
    onSuccess: () => {
      onRefresh();
      // 審查歷程是 append-only 的留痕（`card.reviews` 是**當前**立場，被覆寫），兩者是
      // 兩份資料、兩個 query key。`onRefresh()` 失效的是 `["card", id]`，而 react-query
      // 的前綴比對是**逐元素**的——`"card"` 不等於 `"card-review-history"`，所以少了
      // 這一行，提交之後上方的摘要列會更新、下方的歷程仍是舊的（且 30 秒內不會自己重取）。
      // 另一個使用者的提交廣播走 `collaboration.ts` 的 `invalidateCardQueries`。
      queryClient.invalidateQueries({ queryKey: ["card-review-history", card.id] });
      toast.success(t("card:review.submit.success"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, t("card:review.submit.error"))),
  });

  const findValue = (fieldId: string) =>
    card.customFields.find((v) => v.fieldDefinitionId === fieldId)?.value ?? null;

  // R10：無編輯權限之停用態 affordance——灰底＋禁點游標＋title＋aria-disabled
  // （使用者回報「優先級無法下拉」根因＝靜默停用零視覺提示）
  const canEdit = can("card.edit");
  const readonlyAffordance = {
    "aria-disabled": canEdit ? undefined : true,
    title: canEdit ? undefined : t("card:permission.editRequired"),
  } as const;
  const disabledCls = "disabled:opacity-50 disabled:cursor-not-allowed";

  const renderFieldInput = (field: CustomFieldResponse) => {
    const value = findValue(field.id);
    switch (field.type) {
      case "select": {
        // Radix SelectItem 禁止空字串 value → 以 "__none__" sentinel 代表未選（null）
        const selected = (value as string) ?? "";
        return (
          <Select
            value={selected === "" ? "__none__" : selected}
            onValueChange={(v) =>
              saveField.mutate({ fieldId: field.id, value: v === "__none__" ? null : v })}
          >
            <SelectTrigger
              className={`w-full rounded border p-1 ${disabledCls}`}
              disabled={!canEdit}
              {...readonlyAffordance}
            >
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              {(field.options ?? []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        );
      }
      case "checkbox":
        return (
          <input
            type="checkbox"
            className={disabledCls}
            checked={Boolean(value)}
            disabled={!canEdit}
            {...readonlyAffordance}
            onChange={(e) => saveField.mutate({ fieldId: field.id, value: e.target.checked })}
          />
        );
      case "date":
        return (
          <input
            type="date"
            className={`w-full rounded border p-1 ${disabledCls}`}
            value={(value as string)?.slice(0, 10) ?? ""}
            disabled={!canEdit}
            {...readonlyAffordance}
            onChange={(e) => saveField.mutate({ fieldId: field.id, value: e.target.value })}
          />
        );
      case "number":
        return (
          <CustomFieldTextInput
            field={field}
            value={value}
            disabled={!can("card.edit")}
            onSave={(fieldId, v) => saveField.mutate({ fieldId, value: v })}
          />
        );
      case "member":
        // 成員查詢失敗顯示錯誤而非空選項（誤導空態 #16）
        if (members.isLoading)
          return <div className="text-sm text-muted-foreground p-1">{t("common:state.loading")}</div>;
        if (members.isError)
          return (
            <div className="flex items-center gap-2 text-sm text-destructive">
              {t("card:member.load.error")}
              <Button size="sm" variant="outline" onClick={() => members.refetch()}>{t("common:action.retry")}</Button>
            </div>
          );
        const selected = (value as string) ?? "";
        return (
          <Select
            value={selected === "" ? "__none__" : selected}
            onValueChange={(v) =>
              saveField.mutate({ fieldId: field.id, value: v === "__none__" ? null : v })}
          >
            <SelectTrigger
              className={`w-full rounded border p-1 ${disabledCls}`}
              disabled={!canEdit}
              {...readonlyAffordance}
            >
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              {(members.data ?? []).map((m) => (
                <SelectItem key={m.userId} value={m.userId}>{t("common:member.display", { name: m.displayName, username: m.username })}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      default:
        return (
          <CustomFieldTextInput
            field={field}
            value={value}
            disabled={!can("card.edit")}
            onSave={(fieldId, v) => saveField.mutate({ fieldId, value: v })}
          />
        );
    }
  };

  const projectNameLabel = projectName.isSuccess ? projectName.data!.name : projectName.isError ? t("common:error.load") : "—";

  return (
    <div className="space-y-6 text-sm">
      <section>
        <h3 className="mb-2 font-semibold">{t("card:section.background")}</h3>
        <p className="mb-2 text-muted-foreground">
          {t("card:background.project.label", { name: projectNameLabel })}
        </p>
        {fields.isError ? (
          <div className="flex items-center gap-2 text-destructive">
            {t("card:customField.load.error")}
            <Button size="sm" variant="outline" onClick={() => fields.refetch()}>{t("common:action.retry")}</Button>
          </div>
        ) : (
          <div className="divide-y">
            {!fields.isLoading && (fields.data ?? []).length === 0 && <p className="text-muted-foreground py-2">{t("card:customField.empty")}</p>}
            {(fields.data ?? []).map((field) => (
              <div key={field.id} className="flex items-center justify-between gap-2 py-2">
                <span className="w-24 shrink-0 text-muted-foreground">
                  {field.name}{!canEdit && t("card:field.readonly")}
                </span>
                <div className="flex-1">{renderFieldInput(field)}</div>
                <span className="text-xs text-muted-foreground">
                  {scopeLabel(field.scopeType)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="mb-2 font-semibold">{t("card:section.work")}</h3>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span>{t("card:effort.estimate.label")}</span>
            <Input
              className="w-24"
              type="number"
              min="0"
              step="0.5"
              value={estimate}
              disabled={!can("card.edit")}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => {
                const parsed = estimate === "" ? null : Number(estimate);
                if (parsed !== card.estimatedHours) saveEstimate.mutate();
              }}
            />
            {/* 工時摘要：值由 format.ts（Intl）產生，訊息只負責組句子（設計 §6.2、P-B0 的單位政策）。
                改動前是「h · 已記錄 12h · 剩餘 3h」——三個 h 都是硬編碼的單位，
                而 P-B0 已把三種拼法（hrs／hr／h）收斂成 Intl 提供的那一個。
                `remaining === null` 的破折號是「沒有預估工時」的佔位，不是文案。 */}
            <span className="text-muted-foreground">
              {t("card:effort.summary", {
                unit: hourUnit(),
                logged: formatHours(card.effort.totalHours),
                remaining: remaining === null ? "—" : formatHours(remaining),
              })}
            </span>
          </div>
          <div
            className="h-2 w-full rounded bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-2 rounded bg-primary" style={{ width: `${progress}%` }} />
          </div>
          {can("card.effort.update") && (
            <div className="flex gap-2">
              <Input type="number" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} placeholder={t("card:effort.hours.placeholder")} />
              {/* 補登日期欄：`max` 以本地日字串比較——`yyyy-MM-dd` 零填充 ⇒ 字典序＝時序。
                  這一層只擋 UI，後端另有 `localDateInFuture` 的 400（表單改得掉 `max`）。
                  空日期也算不完整（上面按鈕的 `!logDate`）：原生欄位可以被清空，而空字串的
                  `localDate` 會死在後端的繫結 400——**刻意不做「空＝今天」**，猜一個使用者
                  沒選的日子等於替他寫了一筆他不知道的工作日誌。 */}
              <Input type="date" max={localDayString()} value={logDate}
                     onChange={(e) => setLogDate(e.target.value)} aria-label={t("card:effort.log.date")} />
              <Button size="sm" disabled={!hours || Number(hours) <= 0 || !logDate || logEffort.isPending} onClick={() => logEffort.mutate()}>
                {t("card:effort.log.action")}
              </Button>
            </div>
          )}
          <ul className="divide-y mt-2 border-t">
            {card.effort.logs.map((l) => (
              <li key={l.id} className="text-muted-foreground py-2">
                {t("card:effort.log.entry", { name: l.displayName, hours: formatHours(l.hours) })}{" "}
                {/* 顯示**凍結的本地日**（`localDate`），不轉時間——它是一個日期，
                    不是某一瞬間；走 `formatDateTime` 會把 `"2026-09-01"` 解成 UTC
                    午夜再按執行時區位移，印出「前一日 19:00」這種不存在的資訊。 */}
                {l.note && t("card:effort.log.note", { note: l.note })} · {formatDay(l.localDate)}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-4 space-y-2">
          {/* 徽章是**整張卡的 rollup**（`CardResponse.reviewState`），掛在整個審查區塊
              的標題上語意最貼。沒有審查者時後端回 null，那一格不渲染徽章。 */}
          <h4 className="font-semibold">
            {t("card:section.review")}
            {card.reviewState && (
              <span className={`ml-2 ${REVIEW_BADGE_SHELL} align-middle ${REVIEW_BADGE_CLASS[card.reviewState]}`}>
                {reviewStateLabel(t, card.reviewState)}
              </span>
            )}
          </h4>
          <div className="divide-y border-t">
            {card.reviews.length === 0 && <p className="text-muted-foreground py-2">{t("card:reviewer.empty")}</p>}
            {card.reviews.map((r) => {
              const isMine = r.reviewerUserId === myUserId;
              return (
                <div key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    {/* r.status 是後端原樣回傳的識別碼，逐審查者翻成顯示文字
                        （整張卡的 rollup 是另一組字，見上面的徽章）。 */}
                    {t("card:review.summary", { name: r.reviewerDisplayName, status: reviewStatusLabel(t, r.status) })}
                    {r.score ? t("card:review.score", { score: r.score }) : ""}
                    {r.comment ? t("card:review.comment", { comment: r.comment }) : ""}
                  </span>
                  {isMine && can("card.review") && (
                    <ReviewSubmitForm
                      review={r}
                      cardTitle={card.title}
                      canRate={can("card.rate")}
                      isPending={submitReview.isPending}
                      onSubmit={(status, score, comment) =>
                        submitReview.mutate({ reviewId: r.id, status, score, comment })}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {/* 審查歷程：append-only 的每一次立場變更（`CardReviewEntries`）。上面的
              `card.reviews` 是**當前**立場，被覆寫；這裡是留痕的那一份。
              立場走 `reviewStatusLabel`（與摘要列同一支，pending 是「待審」而不是
              rollup 徽章的「待審查」——那個分裂是刻意的，見上面的說明）。
              一列＝人名 · 立場 · 分數 · 意見 · 時間，`join(" · ")` 會把空的那幾格
              濾掉——`reviewerDisplayName` 可能是空字串（後端查不到人時）。 */}
          <div className="mt-4 space-y-2">
            <h4 className="font-semibold">{t("card:reviewHistory.title")}</h4>
            <ul className="divide-y border-t">
              {/* 失敗態。**少了這一格，請求失敗與「真的沒有紀錄」在畫面上長得一樣**：
                  `isLoading` 在 error 態是 false、`data` 是 undefined，於是 `?? []` 命中
                  空態條件，畫面斷言「尚無審查紀錄」——一句關於治理留痕的假陳述。
                  形狀沿用同層的 `CardActivityTab`（`status === "error"` → 同一條
                  `common:error.load`），但這裡的容器是 `<ul>`，所以那一格是 `<li>`。 */}
              {reviewHistory.status === "error" ? (
                <li className="py-2 text-destructive">{t("common:error.load")}</li>
              ) : (
                <>
                  {!reviewHistory.isLoading && (reviewHistory.data ?? []).length === 0 && (
                    <li className="text-muted-foreground py-2">{t("card:reviewHistory.empty")}</li>
                  )}
                  {(reviewHistory.data ?? []).map((h) => (
                    <li key={h.id} className="py-2 text-muted-foreground">
                      {[
                        h.reviewerDisplayName,
                        reviewStatusLabel(t, h.status),
                        // 分數與意見兩格都 **trim** 掉自己的前後空白：`card:review.score`
                        // 與 `card:review.comment` 的 en 值都自帶前導空白（接在別的字後
                        // 面用的），而這一列是 `join(" · ")`——不 trim 的話分隔符後面會
                        // 多一個空白（` ·  (failed)`）。zh-TW 的中文值沒有前導空白，
                        // trim 對它是恆等。
                        h.score !== null ? t("card:review.score", { score: h.score }).trim() : "",
                        h.comment ? t("card:review.comment", { comment: h.comment }).trim() : "",
                        formatDateTime(h.createdAt),
                      ].filter(Boolean).join(" · ")}
                    </li>
                  ))}
                </>
              )}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

// text/number 自訂欄位：編輯中值存 local state，blur/Enter 才提交（spec #5）
function CustomFieldTextInput({ field, value, disabled, onSave }: {
  field: CustomFieldResponse;
  value: unknown;
  disabled: boolean;
  onSave: (fieldId: string, value: unknown) => void;
}) {
  const isNumber = field.type === "number";
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  // 以 ref 追蹤實際焦點（fix round 1）：僅真正聚焦中才阻擋 server 值同步；
  // blur（含存檔後）即釋放——後續外部更新可正常同步，亦不會在重新聚焦輸入時被舊回應覆寫
  const focusedRef = useRef(false);
  const current = isNumber ? value : ((value as string) ?? "");
  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(value === null ? "" : String(value));
  }, [value]);
  const submit = () => {
    focusedRef.current = false;
    const next = isNumber ? (draft === "" ? null : Number(draft)) : draft;
    if (next !== current) onSave(field.id, next);
  };
  return (
    <input
      type={isNumber ? "number" : "text"}
      aria-label={field.name}
      className="w-full rounded border p-1"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        // IME 組字中 Enter 為候選字確認，不觸發提交（fix round 1）
        if (e.nativeEvent.isComposing) return;
        e.currentTarget.blur();
      }}
    />
  );
}

// 分數下拉的「不評分」sentinel：Radix 的 `SelectItem` 不接受空字串 value
// （同自訂欄位 select 的 `"__none__"`，見 `renderFieldInput`）。
const NO_SCORE = "__none__";

function ReviewSubmitForm({ review, cardTitle, onSubmit, isPending, canRate }: {
  review: ReviewResponse;
  cardTitle: string;
  onSubmit: (status: string, score: number | null, comment: string) => void;
  isPending: boolean;
  canRate: boolean;
}) {
  const { t } = useTranslation(["common", "card"]);
  // 以當前立場預填。重新交付會把立場重設為 pending，複審時這裡自然是乾淨的，
  // 而上一輪的內容在歷史區塊看得到——不會再發生「一次誤送出就摧毀前一筆退回紀錄」。
  const [status, setStatus] = useState(review.status === "pending" ? "approved" : review.status);
  // 分數是**下拉**不是自由輸入（2026-10-14）：1–5 是五個值的枚舉，而自由輸入允許
  // 「4.5」這種永遠送不出去的值——它死在後端 JSON 繫結（`SubmitReviewRequest.Score`
  // 是 `int?`），那個 400 的 body 不帶本 app 的 code／message，前端只印得出通用失敗
  // 字串。讓不合法狀態不可表示，比事後驗證便宜。
  const [score, setScore] = useState(review.score === null ? NO_SCORE : String(review.score));
  const [comment, setComment] = useState(review.comment ?? "");
  // 核定會影響績效（分數經 `CardReviewEntries` 進主管評分平均），所以多一道確認。
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isReject = status === "rejected";
  // 純空白的評語等同「沒有評語」，而**顯示與送出的是同一個值**：少了 `sentComment`，
  // 畫面會說「評語：—」而 DB 收到三個空白（approve 路徑可達；reject 已被下面那一格
  // 擋住）——那會是本檔自己那條「送出的內容必須是它顯示的內容」唯一的反例
  // （2026-10-14 複審的 LOW）。
  const sentComment = comment.trim() === "" ? "" : comment;
  const commentMissing = isReject && sentComment === "";
  // 沒有 card.rate 時**連這一列既有的分數也不能送**：欄位只是不渲染，state 仍是
  // 上一輪的分數（例如當事人被調離主管職、或專案角色被改掉），使用者看不到它，
  // 也就無從知道自己送出了什麼。少了 !canRate 這一項，後端回 400
  // （review.rateNotPermitted）而整個提交連同意見一起失敗，前端卻沒有欄位可改。
  // 原則：表單送出的內容必須是它顯示的內容——看不到分數，就不送分數。
  const submitScore = isReject || !canRate || score === NO_SCORE ? null : Number(score);
  const statusLabel = isReject ? t("common:state.rejected") : t("common:state.approved");
  // 分數那一行的顯示值：null 要說「不評分」，不是空字串也不是 "null"。
  // **內層的呼叫必須提成陳述式**（放在 render 裡，不能提到模組層級——那會凍結當下的
  // 語系）：`t()` 的引數裡再呼叫一次 t() 是 `check:error-paths` 明文禁止的形狀——
  // i18next-parser 抽不到內層，`keepRemoved: false` 會把那個 key 從語系檔刪掉，
  // 畫面只印 key 本身，而 `tsc -b`／vitest／parity 全都不會紅。
  const scoreText = submitScore === null ? t("card:review.scoreNone") : String(submitScore);
  // 三項都沒有變＝這不是一次新的核定。後端對同值重送回 200 但**不寫第二筆 entry**
  // （見 `ReviewEndpoints` 的說明），所以這裡也沒有東西可以確認——停用確認鈕並說明，
  // 而不是給一顆按了什麼都不會發生的鈕。pending 的列永遠不會落在這裡：下拉沒有
  // pending 這個選項，立場必然改變。
  const unchanged = status === review.status && submitScore === review.score
    && sentComment === (review.comment ?? "");
  // 將被覆蓋的那一輪摘要（立場 ＋ 分數）。`card:review.score` 的 en 值自帶前導空白
  // ——它的設計是接在別的句子後面用的——所以這裡 trim 掉。
  const previous = [
    review.status === "rejected" ? t("common:state.rejected") : t("common:state.approved"),
    review.score === null ? "" : t("card:review.score", { score: review.score }).trim(),
  ].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-auto rounded border p-1" aria-label={t("card:review.status.aria")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* pending 不是一種可提交的立場（提交它等於什麼都沒做，卻會覆蓋掉先前的
              退回紀錄，設計 D4），所以選單只有兩項——與後端 ReviewStatuses.Submittable 同集合，
              由 check-label-tables 的第四張表鎖住。 */}
          <SelectItem value="approved">{t("common:state.approved")}</SelectItem>
          <SelectItem value="rejected">{t("common:state.rejected")}</SelectItem>
        </SelectContent>
      </Select>
      {/* 退回不是一種結果，沒有分數可言——欄位直接不渲染，不是禁用。
          分數的另一個獨立條件是權限（設計 §13.5 的 D8）：沒有 card.rate 的人
          （工程師／測試工程師／專案助理）也看不到它，而不是看到一個灰掉的輸入框
          ——沒有分數語意時那只是一個不能用的欄位。技術複核本身不受影響，
          表單其餘部分與提交鈕原樣。 */}
      {!isReject && canRate && (
        <Select value={score} onValueChange={setScore}>
          <SelectTrigger className="w-auto rounded border p-1" aria-label={t("card:review.scoreLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 「不評分」是一個**看得見的選項**，不是空白欄位：空白分不出「這次不打分」
                與「我忘了填」，而兩者送出去是同一件事（null）。技術複核走的就是這一格。 */}
            <SelectItem value={NO_SCORE}>{t("card:review.scoreNone")}</SelectItem>
            {["1", "2", "3", "4", "5"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <Input className="w-32" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("card:review.commentField.placeholder")} />
      <Button
        size="sm"
        disabled={isPending || commentMissing}
        onClick={() => setConfirmOpen(true)}
      >
        {t("card:review.submit.action")}
      </Button>

      {/* 確定之後才送出（2026-10-14）：視窗把**即將送出的三項**逐項列出來，
          使用者確認的對象是他看到的內容，不是他記得的內容。 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("card:review.confirm.title")}</AlertDialogTitle>
            {/* asChild ＋ <div>：這裡有四、五個區塊，Description 預設渲染成 <p>，
                巢狀 <p> 是無效的 DOM 結構。 */}
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                <p>{t("card:review.confirm.card", { name: cardTitle })}</p>
                <p>{t("card:review.confirm.verdict", { status: statusLabel })}</p>
                <p>{t("card:review.confirm.score", { score: scoreText })}</p>
                <p>{t("card:review.confirm.comment", { comment: sentComment === "" ? "—" : sentComment })}</p>
                {/* 已有立場的列才顯示：pending 的一列沒有東西可以被覆蓋，
                    對它寫「將覆蓋…」是一句假陳述。 */}
                {review.status !== "pending" && (
                  <p className="text-destructive">
                    {t("card:review.confirm.overwrite", { time: formatDateTime(review.updatedAt), previous })}
                  </p>
                )}
                {unchanged && <p className="text-destructive">{t("card:review.confirm.unchanged")}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={unchanged} onClick={() => onSubmit(status, submitScore, sentComment)}>
              {t("card:review.confirm.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
