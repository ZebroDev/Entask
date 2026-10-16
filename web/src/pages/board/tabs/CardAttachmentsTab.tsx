import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import type { CardResponse } from "@/lib/board-types";
import { useAttachmentImage } from "@/hooks/use-attachment-image";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

interface Props {
  card: CardResponse;
  canEdit: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onRefresh: () => void;
}

export function CardAttachmentsTab({ card, canEdit, onSave, onRefresh }: Props) {
  const { t } = useTranslation(["common", "card"]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; fileName: string } | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post(`/cards/${card.id}/attachments`, form);
    },
    onSuccess: () => { onRefresh(); toast.success(t("card:attachment.upload.success")); },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.upload"))),
  });

  // 附件刪除（spec #13）：mutation 化，失敗補 toast（舊裸 promise 靜默失敗）
  const remove = useMutation({
    mutationFn: async (attachmentId: string) =>
      api.delete(`/cards/${card.id}/attachments/${attachmentId}`),
    onSuccess: () => { onRefresh(); toast.success(t("card:attachment.delete.success")); },
    onError: (error) => toast.error(apiErrorMessage(error, t("common:error.delete"))),
  });

  return (
    <div className="space-y-3">
      {canEdit && (
        <div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            {t("card:attachment.upload.action")}
          </Button>
        </div>
      )}
      <ul className="divide-y">
        {card.attachments.map((a) => (
          <li key={a.id} className="flex items-center justify-between py-2 px-1 hover:bg-muted/50 rounded-sm">
            <AttachmentPreview attachmentId={a.id} fileName={a.fileName} isImage={a.contentType.startsWith("image/")} />
            <div className="flex gap-2">
              {canEdit && a.contentType.startsWith("image/") && (
                <Button size="sm" variant="outline"
                  onClick={() => onSave({ coverAttachmentId: card.coverAttachmentId === a.id ? null : a.id })}>
                  {card.coverAttachmentId === a.id ? t("card:attachment.coverRemove.action") : t("card:attachment.coverSet.action")}
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="destructive" disabled={remove.isPending}
                  onClick={() => setRemoveTarget({ id: a.id, fileName: a.fileName })}>{t("common:action.delete")}</Button>
              )}
            </div>
          </li>
        ))}
        {card.attachments.length === 0 && (
          <li className="py-6 text-center text-sm text-muted-foreground border-none">{t("card:attachment.empty")}</li>
        )}
      </ul>
      {/* 刪除附件確認（spec #20）：確認才呼叫 API */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("card:attachment.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("card:attachment.delete.confirm", { name: removeTarget?.fileName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:action.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (removeTarget) remove.mutate(removeTarget.id); }}>
              {t("common:action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AttachmentPreview({ attachmentId, fileName, isImage }: { attachmentId: string; fileName: string; isImage: boolean }) {
  const url = useAttachmentImage(isImage ? attachmentId : null);
  return (
    <div className="flex items-center gap-2">
      {url && <img src={url} alt={fileName} className="h-10 w-10 rounded object-cover" />}
      <button
        type="button"
        className="text-sm hover:underline"
        onClick={() => downloadAttachment(attachmentId, fileName)}
      >
        {fileName}
      </button>
    </div>
  );
}

// 下載經 api.get blob 走 axios——瀏覽器直連 <a href> 不帶 JWT 會 401，必須經攔截器
async function downloadAttachment(attachmentId: string, fileName: string) {
  try {
    const resp = await api.get(`/attachments/${attachmentId}`, { responseType: "blob" });
    const objectUrl = URL.createObjectURL(resp.data as Blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName;
    a.click();
    // 同步 revoke 可能中斷部分瀏覽器的下載，延後到事件迴圈再釋放
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  } catch {
    toast.error(i18n.t("common:error.download"));
  }
}
