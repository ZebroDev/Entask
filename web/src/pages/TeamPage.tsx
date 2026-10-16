import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { TeamMembersTab } from "./team/TeamMembersTab";
import { TeamRolesTab } from "./team/TeamRolesTab";
import { TeamActivityTab } from "./team/TeamActivityTab";
import { TeamReportTab } from "./team/TeamReportTab";
import { WorkCalendarTab } from "./team/WorkCalendarTab";
import { WorkLogReport } from "./reports/WorkLogReport";
import { EditTeamDialog } from "./team/EditTeamDialog";
import { useAuth } from "@/stores/auth";
import { useTranslation } from "react-i18next";

export function TeamPage() {
  const { t } = useTranslation(["common", "team", "workcalendar"]);
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin;

  const { data: team, refetch } = useQuery({
    queryKey: ["team-info", teamId],
    queryFn: async () => (await api.get(`/teams/${teamId}`)).data as { id: string; name: string; description?: string | null },
    enabled: !!teamId,
  });

  return (
    <div className="flex-1 bg-background p-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">
              {team ? team.name : t("common:nav.teamSettings")}
            </h1>
            {isAdmin && team && (
              <EditTeamDialog
                team={team}
                onUpdated={() => refetch()}
              />
            )}
          </div>
          <div className="flex items-center gap-3">
            <Link to="/teams" className="text-sm text-muted-foreground hover:underline">{t("team:nav.selectTeam")}</Link>
            <Button variant="outline" size="sm" onClick={() => navigate("/projects")}>{t("common:nav.myProjects")}</Button>
          </div>
        </div>
        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members">{t("team:tab.members")}</TabsTrigger>
            <TabsTrigger value="roles">{t("team:tab.roles")}</TabsTrigger>
            <TabsTrigger value="activity">{t("team:tab.activity")}</TabsTrigger>
            <TabsTrigger value="report">{t("team:tab.report")}</TabsTrigger>
            <TabsTrigger value="worklog">{t("team:tab.worklog")}</TabsTrigger>
            <TabsTrigger value="work-calendar">{t("workcalendar:tab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="members"><TeamMembersTab teamId={teamId!} /></TabsContent>
          <TabsContent value="roles"><TeamRolesTab teamId={teamId!} /></TabsContent>
          <TabsContent value="activity"><TeamActivityTab teamId={teamId!} /></TabsContent>
          <TabsContent value="report"><TeamReportTab teamId={teamId!} /></TabsContent>
          <TabsContent value="worklog"><WorkLogReport scope="team" scopeId={teamId!} /></TabsContent>
          <TabsContent value="work-calendar"><WorkCalendarTab teamId={teamId!} /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
