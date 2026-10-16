import { NotebookPen } from "lucide-react";
import { WorkLogReport } from "./reports/WorkLogReport";
import { useTranslation } from "react-i18next";

export function MyWorkLogPage() {
  const { t } = useTranslation(["common", "worklog"]);
  return (
    <div className="container max-w-6xl space-y-6 px-4 py-6 md:px-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          {t("common:nav.myWorklog")}
          <NotebookPen className="h-5 w-5 text-primary" />
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("worklog:page.hint")}
        </p>
      </div>
      <WorkLogReport scope="me" />
    </div>
  );
}
