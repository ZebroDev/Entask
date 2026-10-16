import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NotFoundPage } from "./NotFoundPage";

describe("NotFoundPage", () => {
  it("renders 404 error and navigation links", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );

    expect(screen.getByText(/404/)).toBeInTheDocument();
    expect(screen.getByText("找不到您請求的頁面")).toBeInTheDocument();
    expect(screen.getByText(/回到我的專案/)).toBeInTheDocument();
    expect(screen.getByText(/返回上一頁/)).toBeInTheDocument();
  });
});
