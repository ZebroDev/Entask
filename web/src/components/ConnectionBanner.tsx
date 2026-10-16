import { useEffect, useState, useRef } from "react";
import { HubConnectionState } from "@microsoft/signalr";
import { usePresenceStore, getCollaborationHub } from "@/lib/collaboration";
import { useAuth } from "@/stores/auth";
import { WifiOff, Loader2, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export function ConnectionBanner() {
  const { t } = useTranslation(["common"]);
  const connectionState = usePresenceStore((state) => state.connectionState);
  const user = useAuth((state) => state.user);
  const [showRestored, setShowRestored] = useState(false);
  const prevRef = useRef(connectionState);

  useEffect(() => {
    // Detect reconnection transition
    if (
      (prevRef.current === HubConnectionState.Reconnecting ||
        prevRef.current === HubConnectionState.Disconnected) &&
      connectionState === HubConnectionState.Connected
    ) {
      setShowRestored(true);
      const timer = setTimeout(() => setShowRestored(false), 3500);
      return () => clearTimeout(timer);
    }
    prevRef.current = connectionState;
  }, [connectionState]);

  if (!user) return null;

  if (connectionState === HubConnectionState.Reconnecting) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="w-full bg-amber-500/15 border-b border-amber-500/30 text-amber-700 dark:text-amber-400 px-4 py-1.5 text-xs font-medium flex items-center justify-center gap-2 animate-in slide-in-from-top duration-200"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        <span>{t("common:connection.reconnecting")}</span>
      </div>
    );
  }

  if (connectionState === HubConnectionState.Disconnected) {
    return (
      <div
        role="alert"
        className="w-full bg-destructive/10 border-b border-destructive/20 text-destructive px-4 py-1.5 text-xs font-medium flex items-center justify-center gap-2.5 animate-in slide-in-from-top duration-200"
      >
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>{t("common:connection.offline")}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-5 px-2 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/10 gap-1 rounded"
          onClick={() => {
            getCollaborationHub().catch(() => {});
          }}
        >
          <RefreshCw className="h-2.5 w-2.5" />
          {t("common:connection.retry.action")}
        </Button>
      </div>
    );
  }

  if (showRestored) {
    return (
      <div
        role="status"
        className="w-full bg-green-600/10 border-b border-green-600/20 text-green-700 dark:text-green-400 px-4 py-1.5 text-xs font-medium flex items-center justify-center gap-2 animate-in slide-in-from-top duration-200"
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
        <span>{t("common:connection.restored")}</span>
      </div>
    );
  }

  return null;
}
