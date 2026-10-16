import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useWorkCalendar } from "@/hooks/use-work-calendar";
import { useCanManageWorkCalendar } from "@/hooks/use-has-team-management";
import { WorkCalendarExceptionDialog } from "./WorkCalendarExceptionDialog";

// 年度區間：一次讀一年（≤366 天，後端的上限）。切年份是唯一的重讀來源。
const thisYear = new Date().getFullYear();

export function WorkCalendarTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation(["common", "workcalendar"]);
  const [year, setYear] = useState(thisYear);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const { data, isLoading, isError } = useWorkCalendar(teamId, from, to);
  const { canManageWorkCalendar } = useCanManageWorkCalendar(teamId);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">{t("workcalendar:title")}</h2>
            <p className="text-sm text-muted-foreground">{t("workcalendar:hint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setYear((y) => y - 1)}>
              {year - 1}
            </Button>
            {/* 目前選中的年度：唯讀、不是控制項（切換靠兩旁）。與兩旁 outline 按鈕同高同框，
                但用底色標出「選中的是這一個」——裸文字夾在兩個有框的按鈕之間會看起來像凹下去。 */}
            <span className="inline-flex h-9 items-center rounded-md border border-input bg-secondary px-3 text-sm font-medium text-secondary-foreground">
              {year}
            </span>
            <Button variant="outline" size="sm" onClick={() => setYear((y) => y + 1)}>
              {year + 1}
            </Button>
          </div>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">{t("common:state.loading")}</p>}
        {isError && <p className="text-sm text-destructive">{t("workcalendar:error.load")}</p>}
        {data && data.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("workcalendar:empty")}</p>
        )}
        {data && data.length > 0 && (
          <table className="w-full text-sm">
            <tbody>
              {data.map((entry) => (
                <tr key={entry.date} className="border-t">
                  <td className="py-2 font-mono">{entry.date}</td>
                  <td className="py-2">
                    {entry.kind === "Holiday"
                      ? t("workcalendar:kind.holiday")
                      : t("workcalendar:kind.workday")}
                  </td>
                  <td className="py-2 text-muted-foreground">{entry.name ?? ""}</td>
                  <td className="py-2 text-right">
                    {canManageWorkCalendar && (
                      <WorkCalendarExceptionDialog teamId={teamId} entry={entry} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canManageWorkCalendar && (
          <WorkCalendarExceptionDialog teamId={teamId} entry={null} defaultDate={`${year}-01-01`} />
        )}

      </CardContent>
    </Card>
  );
}
