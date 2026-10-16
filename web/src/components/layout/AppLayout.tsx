import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/stores/auth";
import { LazyBoundary } from "@/components/LazyBoundary";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Search, Keyboard, CheckSquare, NotebookPen, Users, ScrollText } from "lucide-react";
import { SearchModal } from "@/components/SearchModal";
import { ModeToggle } from "@/components/ThemeToggle";
import { NotificationPopover } from "@/components/NotificationPopover";
import { QuickCreateCardModal } from "@/components/QuickCreateCardModal";
import { ShortcutsHelpDialog } from "@/components/ShortcutsHelpDialog";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { UserSettingsDialog } from "@/components/UserSettingsDialog";
import { useState, useEffect } from "react";
import { useCollaboration } from "@/lib/collaboration";
import { setNotificationNavigate, useNotificationStore } from "@/lib/notificationStore";
import { useHasTeamManagement } from "@/hooks/use-has-team-management";
import { useTranslation } from "react-i18next";
import { SOURCE_URL } from "@/lib/source-offer";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function AppLayout() {
  // `admin` 是第二個 namespace：只有 admin 那一條導覽連結用到它，而 key 在程式碼裡是
  // 帶前綴的（`admin:title`）。第一個元素仍必須是 `common`——它同時是 i18next-parser
  // 抽 key 時的預設 namespace。
  const { t } = useTranslation(["common", "admin"]);
  const { user, logout } = useAuth();
  const { canManageTeams } = useHasTeamManagement();
  useCollaboration();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Register SPA navigation for toast notification actions
  useEffect(() => {
    setNotificationNavigate((path) => navigate(path));
    useNotificationStore.getState().fetchNotifications();
  }, [navigate]);

  const pathParts = location.pathname.split("/").filter(Boolean);
  const projectId = pathParts[0] === 'projects' && pathParts.length >= 2 ? pathParts[1] : undefined;
  const boardId = pathParts[0] === 'projects' && pathParts.includes("boards") && pathParts.length >= 4 ? pathParts[3] : undefined;

  const renderBreadcrumb = () => {
    if (pathParts[0] === "my-tasks") {
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground transition-colors">{t("common:nav.projects")}</Link>
          <span>/</span>
          <span className="text-foreground font-medium">{t("common:nav.myTasks")}</span>
        </div>
      );
    }
    if (pathParts[0] === "my-worklog") {
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground transition-colors">{t("common:nav.projects")}</Link>
          <span>/</span>
          <span className="text-foreground font-medium">{t("common:nav.myWorklog")}</span>
        </div>
      );
    }
    if (pathParts[0] === "projects" && boardId) {
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground transition-colors">{t("common:nav.myProjects")}</Link>
          <span>/</span>
          <Link to={`/projects/${projectId}`} className="hover:text-foreground transition-colors">{t("common:nav.project")}</Link>
          <span>/</span>
          <span className="text-foreground font-medium">{t("common:nav.board")}</span>
        </div>
      );
    }
    if (pathParts[0] === "projects" && projectId) {
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground transition-colors">{t("common:nav.myProjects")}</Link>
          <span>/</span>
          <span className="text-foreground font-medium">{t("common:nav.projectDetail")}</span>
        </div>
      );
    }
    if (pathParts[0] === "projects") {
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {canManageTeams && (
            <>
              <Link to="/teams" className="hover:text-foreground transition-colors">{t("common:nav.teams")}</Link>
              <span>/</span>
            </>
          )}
          <span className="text-foreground font-medium">{t("common:nav.myProjects")}</span>
        </div>
      );
    }
    if (pathParts[0] === "teams" && pathParts.length >= 2) {
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/teams" className="hover:text-foreground transition-colors">{t("common:nav.selectTeam")}</Link>
          <span>/</span>
          <span className="text-foreground font-medium">{t("common:nav.teamSettings")}</span>
        </div>
      );
    }
    if (pathParts[0] === "teams") {
      return <span className="text-muted-foreground">{t("common:nav.selectTeam")}</span>;
    }
    return <span className="text-muted-foreground">Entask</span>;
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <ConnectionBanner />
      <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 max-w-screen-2xl items-center">
          <div className="flex items-center gap-2 sm:gap-4 mr-2 sm:mr-4 flex-1 min-w-0">
            <Link to="/" className="flex items-center space-x-2 shrink-0">
              <span className="font-bold hidden sm:inline-block text-primary">Entask</span>
            </Link>
            <Link
              to="/my-tasks"
              className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md transition-colors shrink-0 ${
                location.pathname === "/my-tasks"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              <span className="hidden sm:inline-block">{t("common:nav.myTasks")}</span>
            </Link>
            <Link
              to="/my-worklog"
              className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md transition-colors shrink-0 ${
                location.pathname === "/my-worklog"
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              <NotebookPen className="h-3.5 w-3.5" />
              <span className="hidden sm:inline-block">{t("common:nav.myWorklog")}</span>
            </Link>
            {/* 導覽是行內 JSX——這一頁沒有 sidebar，也沒有 nav-items 陣列（設計 §3.7 實查）。
                條件用元件頂端那個 `useAuth()` 訂閱取到的 `user`，**不用 `useAuth.getState()`**：
                後者在 render 期間讀到的不是這一輪訂閱到的值。 */}
            {user?.isAdmin && (
              <Link
                to="/users"
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md transition-colors shrink-0 ${
                  location.pathname === "/users"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                <Users className="h-3.5 w-3.5" />
                <span className="hidden sm:inline-block">{t("admin:title")}</span>
              </Link>
            )}
            {user?.isAdmin && (
              <Link
                to="/system-activity"
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md transition-colors shrink-0 ${
                  location.pathname === "/system-activity"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                <ScrollText className="h-3.5 w-3.5" />
                <span className="hidden sm:inline-block">{t("admin:activity.title")}</span>
              </Link>
            )}
            <nav className="flex items-center gap-2 text-sm font-medium overflow-x-auto no-scrollbar whitespace-nowrap max-w-full" aria-label={t("common:nav.aria.breadcrumb")}>
              {renderBreadcrumb()}
            </nav>
          </div>
          
          <div className="flex items-center justify-end space-x-1 sm:space-x-2 shrink-0">
            <Button
              variant="outline"
              className="relative h-8 w-8 justify-center rounded-[0.5rem] bg-muted/50 text-sm font-normal text-muted-foreground shadow-none p-0 sm:w-48 sm:justify-start sm:px-4 sm:pr-12 md:w-40 lg:w-64"
              onClick={() => setSearchOpen(true)}
              aria-label={t("common:nav.search")}
            >
              <Search className="h-4 w-4 sm:mr-2" />
              <span className="hidden lg:inline-flex">{projectId ? t("common:search.hint.cards") : t("common:search.hint.projects")}</span>
              <span className="hidden sm:inline-flex lg:hidden">{t("common:search.hint.compact")}</span>
              <kbd className="pointer-events-none absolute right-[0.3rem] top-[0.3rem] hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
                <span className="text-xs">{isMac ? "\u2318" : "Ctrl"}</span>K
              </kbd>
            </Button>
            
            <Button
              variant="ghost"
              size="icon"
              className="hidden sm:inline-flex h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => setShortcutsHelpOpen(true)}
              title={t("common:nav.shortcuts")}
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            <ModeToggle />
            <NotificationPopover />
            {user && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" aria-label={t("common:nav.aria.userMenu")} className="relative h-8 w-8 rounded-full">
                    <Avatar className="h-8 w-8">
                      {user.avatarUrl ? (
                        <AvatarImage src={user.avatarUrl} alt={user.displayName} />
                      ) : (
                        <AvatarFallback>{user.displayName?.charAt(0) || user.username.charAt(0).toUpperCase()}</AvatarFallback>
                      )}
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end" forceMount>
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex flex-col space-y-1">
                      <p className="text-sm font-medium leading-none">{user.displayName}</p>
                      <p className="text-xs leading-none text-muted-foreground">
                        {user.username}
                      </p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/my-tasks")}>
                    {t("common:nav.myTasks")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/my-worklog")}>
                    {t("common:nav.myWorklog")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/projects")}>
                    {t("common:nav.myProjects")}
                  </DropdownMenuItem>
                  {canManageTeams && (
                    <DropdownMenuItem onClick={() => navigate("/teams")}>
                      {t("common:nav.selectTeam")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                    {t("common:nav.userSettings")}
                  </DropdownMenuItem>
                  {/* AGPL-3.0 §13 的 Source offer。這一項補的是登入頁涵蓋不到的人：
                      session 常駐、不會再回到登入頁的使用者。`asChild` 讓它是一個真的
                      錨點（新分頁開得起來、右鍵複製得到網址），而不是一顆 onClick。 */}
                  <DropdownMenuItem asChild>
                    <a
                      href={SOURCE_URL}
                      target="_blank"
                      rel="noreferrer"
                      title={t("common:sourceOffer.title")}
                    >
                      {t("common:sourceOffer.link")}
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={logout}>
                    {t("common:nav.logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>
      
      {/* 邊界刻意擺在**外殼裡面**：導覽到還沒下載完的路由時，頁首與導覽不該跟著消失。
          擺到 `<Routes>` 外面（或包住整個 AppLayout）就會讓每一次切換頁面都閃一次空白。
          `key` 指 `pathname`：這一層橫跨每一次路由切換，少了它，一次 chunk 失敗
          會讓內容區停在錯誤畫面，連下一條本來沒問題的路由都進不去。 */}
      <main className="flex-1 flex flex-col">
        <LazyBoundary key={location.pathname}>
          <Outlet />
        </LazyBoundary>
      </main>

      {/* Global Search Modal */}
      <SearchModal projectId={projectId} open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Global Quick Create Card Modal */}
      <QuickCreateCardModal
        open={quickCreateOpen}
        onOpenChange={setQuickCreateOpen}
        currentProjectId={projectId}
        currentBoardId={boardId}
      />

      {/* Shortcuts Help Dialog */}
      <ShortcutsHelpDialog 
        open={shortcutsHelpOpen} 
        onOpenChange={setShortcutsHelpOpen} 
      />
      <UserSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
