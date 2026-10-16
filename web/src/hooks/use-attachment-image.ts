import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function useAttachmentImage(attachmentId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!attachmentId) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .get(`/attachments/${attachmentId}`, { responseType: "blob" })
      .then((resp) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(resp.data as Blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [attachmentId]);

  return url;
}
