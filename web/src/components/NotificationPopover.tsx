import { Bell, CheckCircle2, AlertTriangle, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import { useNotificationStore, type NotificationItem } from "@/lib/notificationStore";
import { notificationBody, notificationTime, notificationTitle } from "@/lib/notification-text";
import { useTranslation } from "react-i18next";

export function NotificationPopover() {
  const { t } = useTranslation(["me"]);
  const notifications = useNotificationStore((s) => s.notifications);
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const unreadCount = notifications.filter((n) => !n.read).length;
  const navigate = useNavigate();

  const handleClickItem = (item: NotificationItem) => {
    markAsRead(item.id);
    if (item.link) {
      if (item.link.startsWith("http")) {
        window.location.href = item.link;
      } else {
        navigate(item.link);
      }
    }
  };

  // 後端沒有任何站點會送 `due_soon`（它只存在於前端）——那個分支是死碼，
  // 留著會讓下一個人以為「有這個型別」。認不得的型別一律走 default。
  const getIcon = (type: NotificationItem["type"]) => {
    switch (type) {
      case "review":
        return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />;
      case "comment":
        return <MessageSquare className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />;
      default:
        return <AlertTriangle className="h-4 w-4 text-primary shrink-0 mt-0.5" />;
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8 rounded-full focus-visible:ring-0 focus-visible:ring-offset-0">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
            </span>
          )}
          <span className="sr-only">{t("me:notification.bell.aria")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-sm">{t("me:notification.title")}</span>
            {unreadCount > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {t("me:notification.unread", { count: unreadCount })}
              </Badge>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllAsRead}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("me:notification.markAllRead.action")}
            </button>
          )}
        </div>

        <div className="max-h-[350px] overflow-y-auto divide-y">
          {notifications.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => handleClickItem(n)}
              className={'w-full text-left focus:outline-none focus:bg-muted/50 p-3 flex items-start gap-2.5 cursor-pointer hover:bg-muted/50 transition-colors text-xs ' + (
                !n.read ? "bg-primary/5" : ""
              )}
            >
              <div className={!n.read ? "opacity-100" : "opacity-60"}>
                {getIcon(n.type)}
              </div>
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    {!n.read && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" aria-hidden="true" />
                    )}
                    <span className={!n.read ? "text-foreground font-semibold" : "text-muted-foreground"}>
                      {notificationTitle(n)}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{notificationTime(n)}</span>
                </div>
                <p className={"text-[11px] leading-normal " + (!n.read ? "text-foreground/80" : "text-muted-foreground")}>
                  {notificationBody(n)}
                </p>
              </div>
            </button>
          ))}

          {notifications.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {t("me:notification.empty")}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
