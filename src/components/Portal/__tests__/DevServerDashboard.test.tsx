// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

const useAllDevSessions = vi.fn<() => DevPreviewSessionState[]>();
const useWorktreeStore = vi.fn();

vi.mock("@/store/allDevSessionsStore", () => ({
  useAllDevSessions: () => useAllDevSessions(),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: unknown) => unknown) => useWorktreeStore(selector),
}));

import { DevServerDashboard } from "../DevServerDashboard";

function session(overrides: Partial<DevPreviewSessionState> = {}): DevPreviewSessionState {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    worktreeId: "wt-1",
    status: "running",
    url: "http://localhost:3000",
    predictedUrl: "http://localhost:3000",
    error: null,
    terminalId: "t-1",
    isRestarting: false,
    generation: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let restartByWorktree: ReturnType<typeof vi.fn>;
let stopDevServerByWorktree: ReturnType<typeof vi.fn>;

beforeEach(() => {
  restartByWorktree = vi.fn(() => Promise.resolve());
  stopDevServerByWorktree = vi.fn(() => Promise.resolve());
  (globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    electron: { devPreview: { restartByWorktree, stopDevServerByWorktree } },
  }) as unknown as Window;
  // Default: a worktree map resolving wt-1 -> "feature-foo".
  useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ worktrees: new Map([["wt-1", { id: "wt-1", name: "feature-foo" }]]) })
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DevServerDashboard", () => {
  it("shows the empty state when no active sessions", () => {
    useAllDevSessions.mockReturnValue([]);
    render(<DevServerDashboard />);
    expect(screen.getByText("No active dev servers")).toBeTruthy();
  });

  it("hides plain stopped sessions but keeps restored-stopped", () => {
    useAllDevSessions.mockReturnValue([
      session({ panelId: "p-stopped", status: "stopped", worktreeId: "wt-stopped" }),
      session({ panelId: "p-restored", status: "restored-stopped", worktreeId: "wt-1" }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.queryByText("No active dev servers")).toBeNull();
    expect(screen.getByText("feature-foo")).toBeTruthy();
  });

  it("renders worktree label, port and last output", () => {
    useAllDevSessions.mockReturnValue([
      session({ url: "http://localhost:4321", lastOutput: "ready in 200ms" }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText(":4321")).toBeTruthy();
    expect(screen.getByText("ready in 200ms")).toBeTruthy();
  });

  it("falls back to the worktreeId when no name is known", () => {
    useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ worktrees: new Map() })
    );
    useAllDevSessions.mockReturnValue([session({ worktreeId: "wt-unknown" })]);
    render(<DevServerDashboard />);
    expect(screen.getByText("wt-unknown")).toBeTruthy();
  });

  it("restarts the worktree dev server on click", () => {
    useAllDevSessions.mockReturnValue([session()]);
    render(<DevServerDashboard />);
    fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo"));
    expect(restartByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("stops the worktree dev server on click", () => {
    useAllDevSessions.mockReturnValue([session()]);
    render(<DevServerDashboard />);
    fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo"));
    expect(stopDevServerByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("disables stop for non-running sessions", () => {
    useAllDevSessions.mockReturnValue([session({ status: "error" })]);
    render(<DevServerDashboard />);
    const stopButton = screen.getByLabelText(
      "Stop dev server for feature-foo"
    ) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(true);
  });
});
