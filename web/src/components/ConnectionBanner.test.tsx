import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner";
import { HubConnectionState } from "@microsoft/signalr";
import { usePresenceStore } from "@/lib/collaboration";
import { useAuth } from "@/stores/auth";

vi.mock("@/lib/collaboration", async () => {
  const actual = await vi.importActual<typeof import("@/lib/collaboration")>("@/lib/collaboration");
  return {
    ...actual,
    getCollaborationHub: vi.fn().mockResolvedValue({}),
  };
});

describe("ConnectionBanner", () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
  });

  it("renders nothing when user is not authenticated", () => {
    useAuth.setState({ user: null });
    const { container } = render(<ConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when connected and no recent reconnection", () => {
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "Alice", isAdmin: false },
    });
    usePresenceStore.getState().setConnectionState(HubConnectionState.Connected);
    const { container } = render(<ConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders reconnecting alert when connection is lost", () => {
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "Alice", isAdmin: false },
    });
    usePresenceStore.getState().setConnectionState(HubConnectionState.Reconnecting);
    render(<ConnectionBanner />);
    expect(screen.getByText(/正在嘗試自動重新連線/)).toBeInTheDocument();
  });

  it("renders disconnected warning with retry button when disconnected", () => {
    useAuth.setState({
      user: { userId: "u1", username: "alice", displayName: "Alice", isAdmin: false },
    });
    usePresenceStore.getState().setConnectionState(HubConnectionState.Disconnected);
    render(<ConnectionBanner />);
    expect(screen.getByText(/即時同步連線已離線/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重試連線/ })).toBeInTheDocument();
  });
});
