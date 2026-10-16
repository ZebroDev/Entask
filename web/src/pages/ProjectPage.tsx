import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import type { ProjectResponse } from "@/lib/board-types";
import { useProjectPermissions } from "@/hooks/use-project-permissions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  KanbanSquare,
  Users,
  SlidersHorizontal,
  GitFork,
  BarChart3,
  Calendar,
  Table,
  GanttChartSquare,
  Pencil,
  NotebookPen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditProjectDialog } from "./project/EditProjectDialog";
import { LazyBoundary } from "@/components/LazyBoundary";
import { lazyPage, loadCardDialog } from "@/lib/lazy-route";

// 分頁層 lazy-load（2026-09-27）：9 個分頁各自一個 chunk。這一包原本是全庫最大的
// 單一 chunk——為了看一眼預設的「看板清單」，要把 React Flow 與 recharts 一起下載。
// `EditProjectDialog` 留靜態：它在 `editOpen` 之前不掛載，而且本身很小。
// `WorkLogReport` 另有兩個靜態入口（`MyWorkLogPage`／`TeamPage`）⇒ 它會落在共用 chunk。
const BoardListTab = lazyPage(() => import("./project/BoardListTab"), "BoardListTab");
const MembersTab = lazyPage(() => import("./project/MembersTab"), "MembersTab");
const CustomFieldsTab = lazyPage(() => import("./project/CustomFieldsTab"), "CustomFieldsTab");
const MindMapTab = lazyPage(() => import("./project/tabs/MindMapTab"), "MindMapTab");
const ReportTab = lazyPage(() => import("./project/tabs/ReportTab"), "ReportTab");
const WorkLogReport = lazyPage(() => import("./reports/WorkLogReport"), "WorkLogReport");
const CalendarTab = lazyPage(() => import("./project/tabs/CalendarTab"), "CalendarTab");
const TableTab = lazyPage(() => import("./project/tabs/TableTab"), "TableTab");
const GanttTab = lazyPage(() => import("./project/tabs/GanttTab"), "GanttTab");

// `CardDialog` 2026-09-27 起也是 lazy。它本來是這一頁的**靜態**相依，於是「進專案頁
// 看一眼看板清單」要一起下載 49,748 raw／11,417 gzip——那一頁 12 個 chunk 的 **60%**
// （實測，見 `docs/history/2026-09-27-card-dialog-lazy.md`）。
// 載入器與路由層共用同一個 `loadCardDialog`，兩邊不會各自漂移。
//
// ★ **這一頁刻意不預取，也不要加 `prefetchCardDialog()`**：`BoardPage` 有它，但搬到
//   這裡就等於那 50KB 在閒置時照樣被下載、這一條的效益歸零——而畫面上、測試上、
//   閘門上**全都看不出來**。守門員是 `ProjectPage.test.tsx` 的
//   「沒有 ?card= 時不下載、也不預取對話框的 chunk」那一支。
// ★ 另外六處**仍是靜態** import（四個分頁與 `MyTasksPage`／`WorkLogMemberCard`），
//   其中四個是這一頁的 lazy 分頁 ⇒ **切過去時還是會把 50KB 帶下來**。這一條拿到的
//   是**進頁成本**，不是「架構上再也沒有人靜態相依它」。
const CardDialog = lazyPage(loadCardDialog, "CardDialog");
import { useCollaboration } from "@/lib/collaboration";
import { useTranslation } from "react-i18next";

export function ProjectPage() {
  const { t } = useTranslation(["common", "project"]);
  const { projectId } = useParams<{ projectId: string }>();
  useCollaboration({ projectId });
  const [searchParams, setSearchParams] = useSearchParams();
  const [editOpen, setEditOpen] = useState(false);
  const queryClient = useQueryClient();
  const tab = searchParams.get("tab") ?? "boards";
  const setTab = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === "boards") next.delete("tab");
      else next.set("tab", value);
      return next;
    });
  };
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}`)).data as ProjectResponse,
  });
  const permissions = useProjectPermissions(projectId);

  if (project.isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-4 w-24 bg-muted rounded animate-pulse" />
        <div className="h-8 w-64 bg-muted rounded animate-pulse" />
        <div className="h-10 w-full bg-muted rounded animate-pulse" />
        <div className="h-64 w-full bg-muted rounded animate-pulse" />
      </div>
    );
  }
  if (project.isError) {
    const detail = apiErrorMessage(project.error, t("common:error.tryLater"));
    return <div className="p-6 text-destructive">{t("common:error.loadDetail", { detail })}</div>;
  }

  const can = (code: string) => (permissions.data ?? []).includes(code);

  return (
    <div className="flex flex-col flex-1 px-6 py-6 w-full min-h-[calc(100vh-3.5rem)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to="/projects" className="text-sm text-muted-foreground hover:underline">{t("project:backToProjects")}</Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{project.data!.name}</h1>
            {can("project.edit") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                title={t("project:edit.aria")}
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="sr-only">{t("project:edit.aria")}</span>
              </Button>
            )}
          </div>
          {project.data!.description && (
            <p className="text-sm text-muted-foreground mt-1">{project.data!.description}</p>
          )}
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex items-center justify-start max-w-full overflow-x-auto no-scrollbar h-auto p-1 gap-1 bg-muted/60 rounded-xl border flex-nowrap shrink-0">
          <TabsTrigger value="boards" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
            <KanbanSquare className="h-3.5 w-3.5" />
            <span>{t("project:tab.boards")}</span>
          </TabsTrigger>
          <TabsTrigger value="members" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
            <Users className="h-3.5 w-3.5" />
            <span>{t("project:tab.members")}</span>
          </TabsTrigger>
          <TabsTrigger value="fields" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>{t("project:tab.fields")}</span>
          </TabsTrigger>
          {can("project.read") && (
            <TabsTrigger value="mindmap" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
              <GitFork className="h-3.5 w-3.5" />
              <span>{t("project:tab.mindMap")}</span>
            </TabsTrigger>
          )}
          {can("report.view") && (
            <TabsTrigger value="report" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
              <BarChart3 className="h-3.5 w-3.5" />
              <span>{t("project:tab.report")}</span>
            </TabsTrigger>
          )}
          {can("report.view") && (
            <TabsTrigger value="worklog" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
              <NotebookPen className="h-3.5 w-3.5" />
              {t("project:tab.worklog")}
            </TabsTrigger>
          )}
          {can("project.read") && (
            <TabsTrigger value="calendar" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
              <Calendar className="h-3.5 w-3.5" />
              <span>{t("project:tab.calendar")}</span>
            </TabsTrigger>
          )}
          {can("project.read") && (
            <TabsTrigger value="table" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
              <Table className="h-3.5 w-3.5" />
              <span>{t("project:tab.table")}</span>
            </TabsTrigger>
          )}
          {can("project.read") && (
            <TabsTrigger value="gantt" className="flex items-center gap-1.5 text-xs rounded-lg whitespace-nowrap shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs">
              <GanttChartSquare className="h-3.5 w-3.5" />
              <span>{t("project:tab.gantt")}</span>
            </TabsTrigger>
          )}
        </TabsList>
        {/* 分頁內容的邊界：分頁列（`TabsList`）刻意留在邊界**外面**——切到
            還沒下載完的分頁時，使用者要看得到自己站在哪。與 `BoardPage` 的 CardDialog
            那個邊界不同：那邊留 `null` 是因為有閒置預取，這邊**不預取**（全部預取就等於
            沒拆），所以要有看得見的提示。Radix 的 `TabsContent` 不掛載未選中的分頁
            ⇒ lazy 的分頁只在使用者真的切過去時才 import。
            `key` 指當前分頁：某個分頁的 chunk 失敗之後，切到別的分頁要能離開
            那個錯誤畫面（否則分頁列活著、內容區卻永久卡住）。 */}
        <LazyBoundary key={tab}>
          <TabsContent value="boards">
            <BoardListTab
              projectId={projectId!}
              canCreateBoard={can("board.create")}
              canReadBoard={can("board.read")}
              canEditBoard={can("board.edit")}
              canDeleteBoard={can("board.delete")}
            />
          </TabsContent>
          <TabsContent value="members">
            <MembersTab projectId={projectId!} canManage={can("project.member.manage")} />
          </TabsContent>
          <TabsContent value="fields">
            <CustomFieldsTab projectId={projectId!} canEditProject={can("project.edit")} canEditBoard={can("board.edit")} />
          </TabsContent>
          {can("project.read") && (
            <TabsContent value="mindmap">
              <MindMapTab projectId={projectId!} canEdit={can("mindmap.edit")} focusNodeId={searchParams.get("node")} />
            </TabsContent>
          )}
          {can("report.view") && (
            <TabsContent value="report">
              <ReportTab projectId={projectId!} />
            </TabsContent>
          )}
          {can("report.view") && (
            <TabsContent value="worklog">
              <WorkLogReport scope="project" scopeId={projectId!} />
            </TabsContent>
          )}
          {can("project.read") && (
            <TabsContent value="calendar">
              <CalendarTab projectId={projectId!} canEdit={can("card.edit") || can("board.edit")} />
            </TabsContent>
          )}
          {can("project.read") && (
            <TabsContent value="table">
              <TableTab projectId={projectId!} canEdit={can("card.edit") || can("board.edit")} />
            </TabsContent>
          )}
          {can("project.read") && (
            <TabsContent value="gantt">
              <GanttTab projectId={projectId!} canEdit={can("card.edit") || can("board.edit")} />
            </TabsContent>
          )}
        </LazyBoundary>
      </Tabs>
      {editOpen && project.data && (
        <EditProjectDialog
          projectId={projectId!}
          name={project.data.name}
          description={project.data.description}
          open={editOpen}
          onOpenChange={setEditOpen}
          onUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            queryClient.invalidateQueries({ queryKey: ["project-name", projectId] });
            queryClient.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      )}
      {/* 邊界必須擺在**這裡**：上面那個邊界只包得住 `<Tabs>` 的分頁，
          包不到對話框 ⇒ 少了這一層，最近的界會是 `AppLayout` 的 `<Outlet />`，
          整頁（含標題與分頁列）會被 fallback 換掉。
          `fallback` 留 `null` 的理由與 `BoardPage` **不同**：那個邊界的唯一孩子就是
          這個對話框，而 fallback 渲染在**頁面流**裡（不是浮層），放 `<LazyFallback />`
          會讓頁尾多出一塊 `min-h-[50vh]` 的空塊。這裡沒有預取，所以 `null` 就是
          「chunk 還沒到之前，畫面上什麼都不多」——延遲只有第一次開卡片時那一次。 */}
      {(searchParams.has('card') || searchParams.has('cardId')) && (
        <LazyBoundary fallback={null}>
          <CardDialog
            cardId={(searchParams.get('card') || searchParams.get('cardId'))!}
            projectId={projectId!}
            open={true}
            onOpenChange={() => setSearchParams(p => { p.delete('card'); p.delete('cardId'); return p })}
          />
        </LazyBoundary>
      )}
    </div>
  );
}

