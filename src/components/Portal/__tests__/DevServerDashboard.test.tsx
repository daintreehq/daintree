// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

const useAllDevSessions =
  vi.fn<() => { sessions: DevPreviewSessionState[]; hydrated: boolean; fetchError: boolean }>();
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
    expect(screen.getByText("Open a Dev Server panel in any worktree to start one")).toBeTruthy();
  });

  it("renders no body before the store hydrates", () => {
    mockSessions([], { hydrated: false });
    render(<DevServerDashboard />);
    expect(screen.queryByText("Open a Dev Server panel in any worktree to start one")).toBeNull();
    expect(screen.queryByText("Couldn't load dev servers")).toBeNull();
  });

  it("shows a distinct message when the session fetch fails", () => {
    mockSessions([], { fetchError: true });
    render(<DevServerDashboard />);
    expect(screen.getByText("Couldn't load dev servers")).toBeTruthy();
    expect(screen.queryByText("Open a Dev Server panel in any worktree to start one")).toBeNull();
  });

  it("hides plain stopped sessions but keeps restored-stopped", () => {
    mockSessions([
      session({ panelId: "p-stopped", status: "stopped", worktreeId: "wt-stopped" }),
      session({ panelId: "p-restored", status: "restored-stopped", worktreeId: "wt-1" }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.queryByText("Open a Dev Server panel in any worktree to start one")).toBeNull();
    expect(screen.getByText("feature-foo")).toBeTruthy();
  });

  it("renders a running server's label and port, keeping routine output to the tooltip", () => {
    mockSessions([session({ url: "http://localhost:4321", lastOutput: "ready in 200ms" })]);
    const { container } = render(<DevServerDashboard />);
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText(":4321")).toBeTruthy();
    expect(screen.queryByText("ready in 200ms")).toBeNull();
    expect(container.querySelector("li")?.getAttribute("title")).toBe("ready in 200ms");
  });

  it("shows progress output while a server is starting", () => {
    mockSessions([session({ status: "starting", lastOutput: "> app@1.0.0 dev" })]);
    render(<DevServerDashboard />);
    expect(screen.getByText("> app@1.0.0 dev")).toBeTruthy();
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

  it("falls back to the worktree folder's name, not its full path, when no name is known", () => {
    useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ worktrees: new Map() })
    );
    mockSessions([session({ worktreeId: "/Users/dev/Projects/atlas-worktrees/wt-unknown" })]);
    render(<DevServerDashboard />);
    expect(screen.getByText("wt-unknown")).toBeTruthy();
  });

  it("tells apart two unnamed worktrees that share a folder name", () => {
    useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ worktrees: new Map() })
    );
    mockSessions([
      session({ panelId: "a", worktreeId: "/repos/alpha-worktrees/main" }),
      session({ panelId: "b", worktreeId: "/repos/beta-worktrees/main" }),
    ]);
    render(<DevServerDashboard />);
    const restart = screen.getAllByRole("button", { name: /^Restart dev server for / });
    const names = restart.map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).not.toContain("/repos/");
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

  it("offers to dismiss an errored session's error, which fires the stop call", () => {
    mockSessions([session({ status: "error", terminalId: null, url: null })]);
    render(<DevServerDashboard />);
    const stopButton = screen.getByLabelText("Dismiss error for feature-foo") as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    fireEvent.click(stopButton);
    expect(stopDevServerByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("disables both buttons when the session has no worktreeId", () => {
    mockSessions([session({ status: "error", worktreeId: undefined })]);
    render(<DevServerDashboard />);
    const stopButton = screen.getByLabelText("Dismiss error for panel-1") as HTMLButtonElement;
    const restartButton = screen.getByLabelText(
      "Restart dev server for panel-1"
    ) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(true);
    expect(restartButton.disabled).toBe(true);
    fireEvent.click(stopButton);
    fireEvent.click(restartButton);
    expect(stopDevServerByWorktree).not.toHaveBeenCalled();
    expect(restartByWorktree).not.toHaveBeenCalled();
  });

  it("offers start, never stop, for restored-stopped sessions", () => {
    mockSessions([session({ status: "restored-stopped" })]);
    render(<DevServerDashboard />);
    expect(screen.queryByLabelText("Stop dev server for feature-foo")).toBeNull();
    fireEvent.click(screen.getByLabelText("Start dev server for feature-foo"));
    expect(restartByWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
  });

  it("names why an errored session failed", () => {
    mockSessions([
      session({
        status: "error",
        terminalId: null,
        url: null,
        error: {
          type: "port-conflict",
          message: "Port 3000 in use",
        } as DevPreviewSessionState["error"],
      }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.getByText("Port 3000 in use")).toBeTruthy();
  });
});
