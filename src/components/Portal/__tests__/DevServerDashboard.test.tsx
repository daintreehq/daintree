// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

const useAllDevSessions = vi.fn<
  () => { sessions: DevPreviewSessionState[]; hydrated: boolean; fetchError: boolean }
>();
const useWorktreeStore = vi.fn();

function mockSessions(
  sessions: DevPreviewSessionState[],
  overrides: { hydrated?: boolean; fetchError?: boolean } = {}
) {
  useAllDevSessions.mockReturnValue({
    sessions,
    hydrated: true,
    fetchError: false,
    ...overrides,
  });
}

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
    mockSessions([]);
    render(<DevServerDashboard />);
    expect(screen.getByText("No active dev servers")).toBeTruthy();
  });

  it("renders no body before the store hydrates", () => {
    mockSessions([], { hydrated: false });
    render(<DevServerDashboard />);
    expect(screen.queryByText("No active dev servers")).toBeNull();
    expect(screen.queryByText("Couldn't load dev servers")).toBeNull();
  });

  it("shows a distinct message when the session fetch fails", () => {
    mockSessions([], { fetchError: true });
    render(<DevServerDashboard />);
    expect(screen.getByText("Couldn't load dev servers")).toBeTruthy();
    expect(screen.queryByText("No active dev servers")).toBeNull();
  });

  it("hides plain stopped sessions but keeps restored-stopped", () => {
    mockSessions([
      session({ panelId: "p-stopped", status: "stopped", worktreeId: "wt-stopped" }),
      session({ panelId: "p-restored", status: "restored-stopped", worktreeId: "wt-1" }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.queryByText("No active dev servers")).toBeNull();
    expect(screen.getByText("feature-foo")).toBeTruthy();
  });

  it("renders worktree label, port and last output", () => {
    mockSessions([session({ url: "http://localhost:4321", lastOutput: "ready in 200ms" })]);
    render(<DevServerDashboard />);
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText(":4321")).toBeTruthy();
    expect(screen.getByText("ready in 200ms")).toBeTruthy();
  });

  it("uses predictedUrl for the port when url is null", () => {
    mockSessions([session({ url: null, predictedUrl: "http://localhost:5050" })]);
    render(<DevServerDashboard />);
    expect(screen.getByText(":5050")).toBeTruthy();
  });

  it("omits the port when neither url has one", () => {
    mockSessions([session({ url: "http://localhost", predictedUrl: null })]);
    const { container } = render(<DevServerDashboard />);
    expect(container.textContent).not.toContain(":");
  });

  it("falls back to the worktreeId when no name is known", () => {
    useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ worktrees: new Map() })
    );
    mockSessions([session({ worktreeId: "wt-unknown" })]);
    render(<DevServerDashboard />);
    expect(screen.getByText("wt-unknown")).toBeTruthy();
  });

  it("restarts the worktree dev server on click", () => {
    mockSessions([session()]);
    render(<DevServerDashboard />);
    fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo"));
    expect(restartByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("stops the worktree dev server on click", () => {
    mockSessions([session()]);
    render(<DevServerDashboard />);
    fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo"));
    expect(stopDevServerByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("enables stop for errored sessions and fires the stop call", () => {
    mockSessions([session({ status: "error", terminalId: null, url: null })]);
    render(<DevServerDashboard />);
    const stopButton = screen.getByLabelText(
      "Stop dev server for feature-foo"
    ) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    fireEvent.click(stopButton);
    expect(stopDevServerByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("disables stop for restored-stopped sessions", () => {
    mockSessions([session({ status: "restored-stopped" })]);
    render(<DevServerDashboard />);
    const stopButton = screen.getByLabelText(
      "Stop dev server for feature-foo"
    ) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(true);
  });
});
