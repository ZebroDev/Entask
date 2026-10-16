import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireAdmin } from "./RequireAdmin";
import { useAuth } from "@/stores/auth";

// 落點寫成 /projects 的**內容**而不是 Navigate 的 props：這一支要證的是
// 「非 admin 進 /users 會被帶到哪裡」，只有把目的地掛成一條真的路由才問得到。
function renderAt(initialPath: string, isAdmin: boolean) {
  useAuth.setState({
    user: { userId: "u1", username: "alice", displayName: "陳美惠", isAdmin },
  });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/users"
          element={
            <RequireAdmin>
              <div>使用者管理內容</div>
            </RequireAdmin>
          }
        />
        <Route path="/projects" element={<div>專案清單</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAdmin", () => {
  // auth store 是模組層級的，不留殘餘（與 TeamMembersTab.test.tsx 同）。
  afterEach(() => useAuth.setState({ user: null, tokens: null, teamId: null }));

  it("admin 放行：children 渲染，且不被彈走", () => {
    renderAt("/users", true);
    expect(screen.getByText("使用者管理內容")).toBeInTheDocument();
    expect(screen.queryByText("專案清單")).toBeNull();
  });

  it("非 admin 彈到 /projects，children 不渲染", () => {
    renderAt("/users", false);
    expect(screen.getByText("專案清單")).toBeInTheDocument();
    expect(screen.queryByText("使用者管理內容")).toBeNull();
  });
});
