import type { WorkLogMember } from "@/lib/board-types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatDay } from "@/lib/format";
import { useTranslation } from "react-i18next";

interface Props {
  scope: "me" | "project" | "team";
  members: WorkLogMember[];
  workdays: string[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function WorkLogMissingDialog({ scope, members, workdays, open, onOpenChange }: Props) {
  const { t } = useTranslation(["worklog"]);
  const isMe = scope === "me";
  const missingMembers = members
    .filter((m) => m.missingWorkdays > 0)
    .sort(
      (a, b) =>
        b.missingWorkdays - a.missingWorkdays ||
        (a.displayName || a.username).localeCompare(b.displayName || b.username),
    );
  const noMissCount = members.length - missingMembers.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="worklog-missing-dialog">
        <DialogHeader>
          <DialogTitle>{isMe ? t("worklog:missing.me.title") : t("worklog:missing.group.title")}</DialogTitle>
          <DialogDescription>{t("worklog:missing.workdays", { count: workdays.length })}</DialogDescription>
        </DialogHeader>

        {missingMembers.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="worklog-missing-empty">
            {isMe ? t("worklog:missing.me.empty") : t("worklog:missing.group.empty")}
          </p>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {missingMembers.map((m) => {
              const name = m.displayName || m.username;
              // 漏報日的推導在後端（含到職日夾擠）：這裡只渲染，不再由 workdays 推導
              const dates = m.missingDays;
              return (
                <div key={m.userId} className="space-y-1.5" data-testid="worklog-missing-member">
                  <div className="flex flex-wrap items-center gap-3">
                    <Avatar className="h-8 w-8">
                      {m.avatarUrl ? <AvatarImage src={m.avatarUrl} alt={name} /> : null}
                      <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                    <span
                      className="shrink-0 text-sm tabular-nums text-muted-foreground"
                      data-testid="worklog-missing-count"
                    >
                      {t("worklog:missing.member.count", { missing: m.missingDays.length, count: m.expectedWorkdays })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-11">
                    {dates.map((date) => (
                      <Badge key={date} variant="secondary" data-testid="worklog-missing-day" className="font-normal">
                        {formatDay(date)}
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 「另有」預設上方有一份漏報清單：清單為空時（全員無漏報）該列不得出現，
            否則會與空狀態的「此期間無漏報」同時渲染成自相矛盾的文案。 */}
        {!isMe && missingMembers.length > 0 && noMissCount > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="worklog-missing-none">
            {t("worklog:missing.none", { count: noMissCount })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
