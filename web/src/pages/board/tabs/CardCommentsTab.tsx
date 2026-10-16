import { useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { CardResponse, ActivityPageResponse } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

interface Props { card: CardResponse; canComment: boolean; onRefresh: () => void; }

export function CardCommentsTab({ card, canComment, onRefresh }: Props) {
  const { t } = useTranslation(["common", "card"]);
  const [text, setText] = useState("");
  const queryClient = useQueryClient();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
  } = useInfiniteQuery({
    queryKey: ["card-comments", card.id],
    queryFn: async ({ pageParam }) => {
      const url = pageParam 
        ? `/cards/${card.id}/activity?filter=comments_only&cursor=${encodeURIComponent(pageParam)}` 
        : `/cards/${card.id}/activity?filter=comments_only`;
      return (await api.get(url)).data as ActivityPageResponse;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const submittingRef = useRef(false);
  const addComment = useMutation({
    mutationFn: async (content: string) => api.post(`/cards/${card.id}/comments`, { text: content }),
    onSuccess: () => { 
      setText(""); 
      queryClient.invalidateQueries({ queryKey: ["card-comments", card.id] });
      onRefresh(); 
    },
    onSettled: () => { submittingRef.current = false; },
    onError: (error) => toast.error(apiErrorMessage(error, t("card:comment.create.error"))),
  });

  const submit = () => {
    const content = text.trim();
    if (!content || addComment.isPending || submittingRef.current) return;
    submittingRef.current = true;
    addComment.mutate(content);
  };

  const activities = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-4">
      {canComment && (
        <div className="flex gap-2 pb-2 border-b">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("card:comment.placeholder")}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (e.nativeEvent.isComposing) return;
              e.preventDefault();
              submit();
            }}
          />
          <Button disabled={!text.trim() || addComment.isPending} onClick={submit}>{t("card:comment.submit.action")}</Button>
        </div>
      )}
      
      {status === "pending" ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{t("common:state.loading")}</div>
      ) : status === "error" ? (
        <div className="py-6 text-center text-sm text-destructive">{t("common:error.load")}</div>
      ) : (
        <ul className="divide-y">
          {activities.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold shrink-0">{a.displayName}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(a.createdAt)}
                </span>
              </div>
              <div className="text-foreground whitespace-pre-wrap">
                {a.text}
              </div>
            </li>
          ))}
          {activities.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground border-none">{t("card:comment.empty")}</li>
          )}
        </ul>
      )}

      {hasNextPage && (
        <div className="pt-2 text-center">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => fetchNextPage()} 
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("common:state.loading") : t("common:action.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
