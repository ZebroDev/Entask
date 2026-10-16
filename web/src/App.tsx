import { Route, Routes, Navigate } from "react-router-dom";
import { RequireAuth } from "./components/RequireAuth";
import { RequireAdmin } from "./components/RequireAdmin";
import { RequireTeamManagement } from "./components/RequireTeamManagement";
import { NotFoundPage } from "./pages/NotFoundPage";
import { AppLayout } from "./components/layout/AppLayout";
import { LazyBoundary } from "./components/LazyBoundary";
import { lazyPage, loadCardDialog } from "./lib/lazy-route";

// 路由層 lazy-load（2026-09-27）：每一條路由各自一個 chunk。
// `RequireAuth`／`RequireAdmin`／`RequireTeamManagement`／`AppLayout` 刻意留靜態——它們是
// 外殼與路由膠水，拆出去只換來「連外殼都還沒有的空白」；`NotFoundPage` 只有 36 行，
// 拆出去只是多一次往返。
const LoginPage = lazyPage(() => import("./pages/LoginPage"), "LoginPage");
const TeamPage = lazyPage(() => import("./pages/TeamPage"), "TeamPage");
const TeamSelectPage = lazyPage(() => import("./pages/TeamSelectPage"), "TeamSelectPage");
const ProjectsPage = lazyPage(() => import("./pages/ProjectsPage"), "ProjectsPage");
const ProjectPage = lazyPage(() => import("./pages/ProjectPage"), "ProjectPage");
const BoardPage = lazyPage(() => import("./pages/board/BoardPage"), "BoardPage");
const CardDialog = lazyPage(loadCardDialog, "CardDialog");
const MyTasksPage = lazyPage(() => import("./pages/MyTasksPage"), "MyTasksPage");
const MyWorkLogPage = lazyPage(() => import("./pages/MyWorkLogPage"), "MyWorkLogPage");
const UsersPage = lazyPage(() => import("./pages/admin/UsersPage"), "UsersPage");
const SystemActivityPage = lazyPage(() => import("./pages/SystemActivityPage"), "SystemActivityPage");

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      {/* 登入頁不在 AppLayout 底下，所以它要自己的邊界——否則最外層沒有任何 fallback */}
      <Route
        path="/login"
        element={
          <LazyBoundary>
            <LoginPage />
          </LazyBoundary>
        }
      />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/my-tasks" element={<MyTasksPage />} />
        <Route path="/my-worklog" element={<MyWorkLogPage />} />
        <Route path="/teams" element={<TeamSelectPage />} />
        <Route
          path="/teams/:teamId"
          element={
            <RequireTeamManagement>
              <TeamPage />
            </RequireTeamManagement>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/system-activity"
          element={
            <RequireAdmin>
              <SystemActivityPage />
            </RequireAdmin>
          }
        />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/projects/:projectId/boards/:boardId" element={<BoardPage />}>
          <Route path="cards/:cardId" element={<CardDialog />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
