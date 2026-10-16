import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateTeamDialog } from "./team/CreateTeamDialog";
import { EditTeamDialog } from "./team/EditTeamDialog";
import { useTranslation } from "react-i18next";

interface TeamDto { id: string; name: string; description?: string | null; }
interface TeamPermissionsDto { teamId: string; codes: string[]; }

export function TeamSelectPage() {
  const { t } = useTranslation(["common", "team"]);
  const navigate = useNavigate();
  const { user, teamId, setTeamId } = useAuth();
  const isAdmin = user?.isAdmin;

  const teams = useQuery({
    queryKey: ["teams"],
    queryFn: async () => (await api.get("/teams")).data as TeamDto[],
  });

  // R24：僅顯示有 team.read 權限的團隊。
  // #24：單次 bulk 請求（/teams/my-permissions）取代每團隊 1+N 的 /permissions/mine 呼叫
  const permissions = useQuery({
    queryKey: ["my-team-permissions"],
    queryFn: async () =>
      (await api.get("/teams/my-permissions")).data as TeamPermissionsDto[],
  });

  // 權限查詢失敗顯示錯誤而非過濾後的空清單（誤導空態 #16）
  if (teams.isError || permissions.isError) {
    return (
      <div className="flex-1 bg-background p-8">
        <p className="text-center text-muted-foreground">{t("common:error.load")}</p>
        <div className="mt-4 text-center">
          <Button
            variant="outline"
            onClick={() => {
              teams.refetch();
              permissions.refetch();
            }}
          >
            {t("common:action.retry")}
          </Button>
        </div>
      </div>
    );
  }
  if (teams.isLoading) {
    return (
      <div className="flex-1 bg-background p-8">
        <div className="mx-auto max-w-2xl">
          <div className="mb-6 flex h-10 items-center justify-between">
            <Skeleton className="h-6 w-24" />
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-24" />
            </div>
          </div>
          <div className="grid gap-4" data-testid="team-select-skeleton">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const permByTeam = new Map((permissions.data ?? []).map((p) => [p.teamId, p.codes]));
  const permsLoaded = permissions.isSuccess;
  // render-as-you-go：權限碼未到前團隊名先渲染；碼到後僅保留有 team.read 者
  const visibleTeams = (teams.data ?? []).filter(
    (team) => !permsLoaded || (permByTeam.get(team.id) ?? []).includes("team.read"),
  );

  const handleTeamCreated = (newTeam: TeamDto) => {
    teams.refetch();
    permissions.refetch();
    setTeamId(newTeam.id);
    navigate(`/teams/${newTeam.id}`);
  };

  return (
    <div className="flex-1 bg-background p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t("common:nav.selectTeam")}</h1>
          {isAdmin && <CreateTeamDialog onCreated={handleTeamCreated} />}
        </div>
        <div className="grid gap-4">
          {/* 回呼參數名是 `team` 不是 `t`：`t` 是這個元件的翻譯函式（useTranslation），
              同名會讓「在這個區塊裡抽字串」變成要等編譯器才發現的陷阱——B2-6a 改寫時
              正是這裡的 `t("team:select.current")` 被解讀成 TeamDto 而紅燈
              （B2-3／B2-4／B2-5b／B2-5c 各修過同樣的遮蔽）。上面 filter 的參數同理。 */}
          {visibleTeams.map((team) => (
            <Card
              key={team.id}
              className={`transition-all hover:shadow-md ${team.id === teamId ? "ring-2 ring-primary" : ""}`}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{team.name}</span>
                  <div className="flex items-center gap-2">
                    {isAdmin && (
                      <EditTeamDialog
                        team={team}
                        onUpdated={() => {
                          teams.refetch();
                          permissions.refetch();
                        }}
                      />
                    )}
                    {team.id === teamId && <span className="text-xs font-normal text-primary">{t("team:select.current")}</span>}
                    {(permByTeam.get(team.id) ?? []).includes("team.read") && (
                      <Button size="sm" onClick={() => { setTeamId(team.id); navigate(`/teams/${team.id}`); }}>{t("team:select.enter.action")}</Button>
                    )}
                  </div>
                </CardTitle>
              </CardHeader>
              {team.description && <CardContent className="text-sm text-muted-foreground">{team.description}</CardContent>}
            </Card>
          ))}
          {visibleTeams.length === 0 && (
            <div className="text-center py-12 border rounded-lg bg-card/50 space-y-4 px-6">
              {isAdmin ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    {t("team:select.empty.description")}
                  </p>
                  <CreateTeamDialog
                    onCreated={handleTeamCreated}
                    trigger={<Button className="mt-2">{t("team:select.empty.action")}</Button>}
                  />
                </>
              ) : (teams.data ?? []).length > 0 ? (
                <div className="space-y-3">
                  <h3 className="text-base font-semibold">{t("team:select.noPermission.title")}</h3>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    {t("team:select.noPermission.description")}
                  </p>
                  <div className="flex items-center justify-center gap-3 pt-2">
                    <Button onClick={() => navigate("/projects")}>{t("team:select.projects.action")}</Button>
                    <Button variant="outline" onClick={() => navigate("/my-tasks")}>{t("team:select.tasks.action")}</Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <h3 className="text-base font-semibold">{t("team:select.noTeam.title")}</h3>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    {t("team:select.noTeam.description")}
                  </p>
                  <div className="pt-2">
                    <Button variant="outline" onClick={() => navigate("/projects")}>{t("team:select.projects.action")}</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
