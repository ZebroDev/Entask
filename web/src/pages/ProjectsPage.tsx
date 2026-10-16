import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import type { ProjectResponse } from "@/lib/board-types";
import { usePermissions } from "@/hooks/use-permissions";
import { useHasTeamManagement } from "@/hooks/use-has-team-management";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCreateDialog } from "./project/ProjectCreateDialog";
import { EmptyState } from "@/components/EmptyState";
import { FolderPlus, Folder, KanbanSquare, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ProjectsPage() {
  const { t } = useTranslation(["common", "project"]);
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data as ProjectResponse[],
  });
  const { teamId } = useAuth();
  const { canManageTeams } = useHasTeamManagement();
  const navigate = useNavigate();
  // 建專案 gate（#17）：無 project.create 權限隱藏按鈕（fail-closed：查詢未完成亦不顯示）
  const permissions = usePermissions();
  const canCreateProject = (permissions.data ?? []).includes("project.create");

  if (projects.isLoading)
    return (
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-4 flex h-10 items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="projects-skeleton">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  if (projects.isError) {
    const detail = apiErrorMessage(projects.error, t("common:error.tryLater"));
    return <div className="p-6 text-destructive">{t("common:error.loadDetail", { detail })}</div>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("common:nav.myProjects")}</h1>
        <div className="flex items-center gap-2">
          {!teamId && canManageTeams && (
            <Button variant="outline" size="sm" onClick={() => navigate("/teams")}>
              {t("project:list.switchTeam.action")}
            </Button>
          )}
          {canCreateProject && (
            <Button onClick={() => setCreateOpen(true)}>{t("project:create.action")}</Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {projects.data!.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="group">
            <Card className="h-full border-border/70 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-primary/40 bg-card/90">
              <CardHeader className="pb-2 flex flex-row items-start justify-between space-y-0">
                <CardTitle className="text-base font-semibold group-hover:text-primary transition-colors">
                  {p.name}
                </CardTitle>
                <div className="p-1.5 rounded-lg bg-primary/10 text-primary opacity-70 group-hover:opacity-100 transition-opacity">
                  <Folder className="h-4 w-4" />
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-2">
                {p.description ? (
                  <p className="line-clamp-2 leading-relaxed">{p.description}</p>
                ) : (
                  <p className="italic text-muted-foreground/60">{t("project:list.noDescription")}</p>
                )}
                <div className="flex items-center gap-3 pt-2 border-t text-[11px]">
                  <span className="flex items-center gap-1 font-medium text-foreground">
                    <KanbanSquare className="h-3 w-3 text-muted-foreground" />
                    {t("project:list.boards.count", { count: p.boardCount })}
                  </span>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3 text-muted-foreground" />
                    {t("project:list.members.count", { count: p.memberCount })}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      {/* 三種空狀態：非團隊管理者（`noMember`）、尚未選擇團隊（`noTeam`）、
          有團隊但還沒有專案（`empty`）。前兩態的**標題**與 `empty` 共用同一句話
          （都是「尚無任何專案」），只有說明文字分家——所以 `list.noMember` 底下
          只有 `description`，標題仍在 `list.empty.title`。 */}
      {projects.data!.length === 0 && (
        <EmptyState
          icon={<FolderPlus className="h-7 w-7 text-primary" />}
          title={!canManageTeams ? t("project:list.empty.title") : !teamId ? t("project:list.noTeam.title") : t("project:list.empty.title")}
          description={
            !canManageTeams
              ? t("project:list.noMember.description")
              : !teamId
              ? t("project:list.noTeam.description")
              : t("project:list.empty.description")
          }
          actionText={
            !canManageTeams
              ? undefined
              : !teamId
              ? t("project:list.noTeam.action")
              : canCreateProject
              ? t("project:list.createFirst.action")
              : undefined
          }
          onAction={
            !canManageTeams
              ? undefined
              : !teamId
              ? () => navigate("/teams")
              : canCreateProject
              ? () => setCreateOpen(true)
              : undefined
          }
          className="mt-6 py-12"
        />
      )}
      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => {
          queryClient.setQueryData(["projects"], (old: ProjectResponse[]) => [...(old ?? []), created]);
          toast.success(t("project:create.success"));
        }}
      />
    </div>
  );
}
