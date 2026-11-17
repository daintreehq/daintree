// @vitest-environment jsdom
import {
  cleanup,
  render as rtlRender,
  screen,
  fireEvent,
  within,
  type RenderOptions,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

const useAllDevSessions =
  vi.fn<() => { sessions: DevPreviewSessionState[]; hydrated: boolean; fetchError: boolean }>();
const useWorktreeStore = vi.fn();
let projectsState: { projects: Array<{ id: string; name: string }> };
let scratchesState: { scratches: Array<{ id: string; name: string }> };

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
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector(projectsState),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: unknown) => unknown) => selector(scratchesState),
  scratchName: (scratches: Array<{ id: string; name: string }>, id: string | null) =>
    scratches.find((scratch) => scratch.id === id)?.name ?? null,
}));

import { DevServerDashboard } from "../DevServerDashboard";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

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

const SCRATCH_ID = "0b6c1e2a-3f4d-4a5b-8c6d-7e8f9a0b1c2d";

let restart: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let restartByWorktree: ReturnType<typeof vi.fn>;
let stopDevServerByWorktree: ReturnType<typeof vi.fn>;

beforeEach(() => {
  restart = vi.fn(() => Promise.resolve());
  stop = vi.fn(() => Promise.resolve());
  restartByWorktree = vi.fn(() => Promise.resolve());
  stopDevServerByWorktree = vi.fn(() => Promise.resolve());
  (globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    electron: { devPreview: { restart, stop, restartByWorktree, stopDevServerByWorktree } },
  }) as unknown as Window;
  projectsState = { projects: [{ id: "project-1", name: "Atlas" }] };
  scratchesState = { scratches: [{ id: SCRATCH_ID, name: "Spike" }] };
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
    expect(screen.getByText("Open a Dev server panel in any worktree to start one")).toBeTruthy();
  });

  it("renders no body before the store hydrates", () => {
    mockSessions([], { hydrated: false });
    render(<DevServerDashboard />);
    expect(screen.queryByText("Open a Dev server panel in any worktree to start one")).toBeNull();
    expect(screen.queryByText("Couldn't load dev servers")).toBeNull();
  });

  it("shows a distinct message when the session fetch fails", () => {
    mockSessions([], { fetchError: true });
    render(<DevServerDashboard />);
    expect(screen.getByText("Couldn't load dev servers")).toBeTruthy();
    expect(screen.queryByText("Open a Dev server panel in any worktree to start one")).toBeNull();
  });

  it("hides plain stopped sessions but keeps restored-stopped", () => {
    mockSessions([
      session({ panelId: "p-stopped", status: "stopped", worktreeId: "wt-stopped" }),
      session({ panelId: "p-restored", status: "restored-stopped", worktreeId: "wt-1" }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.queryByText("Open a Dev server panel in any worktree to start one")).toBeNull();
    expect(screen.getByText("feature-foo")).toBeTruthy();
  });

  it("renders a running server's label and port, keeping routine output to the tooltip", async () => {
    mockSessions([session({ url: "http://localhost:4321", lastOutput: "ready in 200ms" })]);
    const { container } = render(<DevServerDashboard />);
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText(":4321")).toBeTruthy();
    expect(screen.queryByText("ready in 200ms")).toBeNull();
    // Through the app's tooltip, never a native title.
    const row = container.querySelector("li")!;
    expect(row.hasAttribute("title")).toBe(false);
    expect(row.querySelectorAll("[title]")).toHaveLength(0);
    // On the status text rather than the row, so the action buttons don't inherit it beside
    // their own tooltips.
    const trigger = screen.getByText(":4321").closest<HTMLElement>("[data-state]")!;
    expect(trigger).toBeTruthy();
    expect(row.contains(trigger)).toBe(true);
    expect(trigger.querySelector("button")).toBeNull();
    fireEvent.focus(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe("ready in 200ms");
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

  it("restarts its own session on click", () => {
    mockSessions([session()]);
    render(<DevServerDashboard />);
    fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo"));
    expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    expect(restartByWorktree).not.toHaveBeenCalled();
  });

  it("stops its own session on click", () => {
    mockSessions([session()]);
    render(<DevServerDashboard />);
    fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo"));
    expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    expect(stopDevServerByWorktree).not.toHaveBeenCalled();
  });

  it("offers to dismiss an errored session's error, which fires the stop call", () => {
    mockSessions([session({ status: "error", terminalId: null, url: null })]);
    render(<DevServerDashboard />);
    const stopButton = screen.getByLabelText("Dismiss error for feature-foo") as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    fireEvent.click(stopButton);
    expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
  });

  it("offers start, never stop, for restored-stopped sessions", () => {
    mockSessions([session({ status: "restored-stopped" })]);
    render(<DevServerDashboard />);
    expect(screen.queryByLabelText("Stop dev server for feature-foo")).toBeNull();
    fireEvent.click(screen.getByLabelText("Start dev server for feature-foo"));
    expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
  });

  it("keeps Stop, not Dismiss, for an error whose server is still running", () => {
    mockSessions([session({ status: "error", terminalId: "t-1", url: null })]);
    render(<DevServerDashboard />);
    expect(screen.queryByLabelText("Dismiss error for feature-foo")).toBeNull();
    fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo"));
    expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
  });

  describe("two dev previews in one worktree", () => {
    const failed = () =>
      session({ panelId: "p-app", status: "error", terminalId: null, url: null, error: null });
    const running = () =>
      session({ panelId: "p-storybook", terminalId: "t-2", url: "http://localhost:6006" });

    function rows(): HTMLElement[] {
      return screen.getAllByRole("listitem");
    }

    it("dismisses the failed row's error without stopping its running sibling", () => {
      mockSessions([failed(), running()]);
      render(<DevServerDashboard />);
      const [failedRow] = rows();
      fireEvent.click(within(failedRow!).getByRole("button", { name: /^Dismiss error for / }));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith({ panelId: "p-app", projectId: "project-1" });
      expect(stopDevServerByWorktree).not.toHaveBeenCalled();
    });

    it("restarts and stops only the row that was clicked", () => {
      mockSessions([failed(), running()]);
      render(<DevServerDashboard />);
      const [failedRow, runningRow] = rows();
      fireEvent.click(within(failedRow!).getByRole("button", { name: /^Restart dev server for / }));
      expect(restart).toHaveBeenLastCalledWith({ panelId: "p-app", projectId: "project-1" });
      fireEvent.click(within(runningRow!).getByRole("button", { name: /^Stop dev server for / }));
      expect(stop).toHaveBeenLastCalledWith({ panelId: "p-storybook", projectId: "project-1" });
      fireEvent.click(
        within(runningRow!).getByRole("button", { name: /^Restart dev server for / })
      );
      expect(restart).toHaveBeenLastCalledWith({ panelId: "p-storybook", projectId: "project-1" });
      expect(restart).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(restartByWorktree).not.toHaveBeenCalled();
      expect(stopDevServerByWorktree).not.toHaveBeenCalled();
    });

    it("numbers the rows that share a worktree name, in every accessible name", () => {
      // Snapshot order is the reverse of key order: numbers follow the key.
      mockSessions([running(), failed()]);
      render(<DevServerDashboard />);
      const [runningRow, failedRow] = rows();
      expect(within(failedRow!).getByText("feature-foo · panel 1")).toBeTruthy();
      expect(within(runningRow!).getByText("feature-foo · panel 2")).toBeTruthy();
      fireEvent.click(screen.getByLabelText("Dismiss error for feature-foo · panel 1"));
      expect(stop).toHaveBeenLastCalledWith({ panelId: "p-app", projectId: "project-1" });
      fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo · panel 1"));
      expect(restart).toHaveBeenLastCalledWith({ panelId: "p-app", projectId: "project-1" });
      fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo · panel 2"));
      expect(stop).toHaveBeenLastCalledWith({ panelId: "p-storybook", projectId: "project-1" });
      fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo · panel 2"));
      expect(restart).toHaveBeenLastCalledWith({
        panelId: "p-storybook",
        projectId: "project-1",
      });
    });

    it("numbers a restored placeholder's Start like its siblings", () => {
      mockSessions([session({ panelId: "p-app", status: "restored-stopped" }), running()]);
      render(<DevServerDashboard />);
      fireEvent.click(screen.getByLabelText("Start dev server for feature-foo · panel 1"));
      expect(restart).toHaveBeenCalledWith({ panelId: "p-app", projectId: "project-1" });
    });

    it("keeps each row's number when the snapshot reorders", () => {
      mockSessions([failed(), running()]);
      const { rerender } = render(<DevServerDashboard />);
      const before = within(rows()[0]!).getByText(/^feature-foo · panel /).textContent;
      mockSessions([running(), failed()]);
      rerender(<DevServerDashboard />);
      const failedRow = rows().find((li) => within(li).queryByText("Error") !== null)!;
      expect(within(failedRow).getByText(/^feature-foo · panel /).textContent).toBe(before);
    });

    it("orders by the whole key, project first, when names collide across projects", () => {
      projectsState = {
        projects: [
          { id: "project-1", name: "Atlas" },
          { id: "project-2", name: "Atlas" },
        ],
      };
      mockSessions([
        session({ projectId: "project-2", panelId: "p-a", worktreeId: undefined }),
        session({ projectId: "project-1", panelId: "p-z", worktreeId: undefined }),
      ]);
      render(<DevServerDashboard />);
      fireEvent.click(screen.getByLabelText("Restart dev server for Atlas · panel 1"));
      expect(restart).toHaveBeenLastCalledWith({ panelId: "p-z", projectId: "project-1" });
      fireEvent.click(screen.getByLabelText("Restart dev server for Atlas · panel 2"));
      expect(restart).toHaveBeenLastCalledWith({ panelId: "p-a", projectId: "project-2" });
    });

    it("leaves a lone row in the worktree unnumbered", () => {
      mockSessions([failed(), running(), session({ panelId: "p-other", worktreeId: "wt-2" })]);
      useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
        selector({
          worktrees: new Map([
            ["wt-1", { id: "wt-1", name: "feature-foo" }],
            ["wt-2", { id: "wt-2", name: "feature-bar" }],
          ]),
        })
      );
      render(<DevServerDashboard />);
      expect(screen.getByText("feature-bar")).toBeTruthy();
    });

    it("starts a restored-stopped panel by its own id", () => {
      mockSessions([session({ panelId: "p-app", status: "restored-stopped" }), running()]);
      render(<DevServerDashboard />);
      const [restoredRow] = rows();
      fireEvent.click(within(restoredRow!).getByRole("button", { name: /^Start dev server for / }));
      expect(restart).toHaveBeenCalledWith({ panelId: "p-app", projectId: "project-1" });
    });
  });

  describe("a session with no worktree", () => {
    it("names a plain folder's row after its project and keeps both controls working", () => {
      mockSessions([session({ status: "running", worktreeId: undefined })]);
      render(<DevServerDashboard />);
      expect(screen.getByText("Atlas")).toBeTruthy();
      expect(screen.queryByText("panel-1")).toBeNull();
      const stopButton = screen.getByLabelText("Stop dev server for Atlas") as HTMLButtonElement;
      const restartButton = screen.getByLabelText(
        "Restart dev server for Atlas"
      ) as HTMLButtonElement;
      expect(stopButton.disabled).toBe(false);
      expect(restartButton.disabled).toBe(false);
      fireEvent.click(stopButton);
      fireEvent.click(restartButton);
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("lets an errored worktree-less session be dismissed", () => {
      mockSessions([
        session({ status: "error", terminalId: null, url: null, worktreeId: undefined }),
      ]);
      render(<DevServerDashboard />);
      fireEvent.click(screen.getByLabelText("Dismiss error for Atlas"));
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("names a scratch workspace's row after the scratch", () => {
      mockSessions([session({ projectId: SCRATCH_ID, worktreeId: undefined })]);
      render(<DevServerDashboard />);
      expect(screen.getByText("Spike")).toBeTruthy();
      fireEvent.click(screen.getByLabelText("Restart dev server for Spike"));
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: SCRATCH_ID });
    });

    it("targets the right project when two projects' panels share a panel id", () => {
      projectsState = {
        projects: [
          { id: "project-1", name: "Atlas" },
          { id: "project-2", name: "Borealis" },
        ],
      };
      mockSessions([
        session({ worktreeId: undefined }),
        session({ projectId: "project-2", worktreeId: undefined }),
      ]);
      render(<DevServerDashboard />);
      fireEvent.click(screen.getByLabelText("Stop dev server for Borealis"));
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-2" });
      fireEvent.click(screen.getByLabelText("Restart dev server for Atlas"));
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("starts a worktree-less restored-stopped session", () => {
      mockSessions([session({ status: "restored-stopped", worktreeId: undefined })]);
      render(<DevServerDashboard />);
      fireEvent.click(screen.getByLabelText("Start dev server for Atlas"));
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("calls an unknown project's row a workspace, never its raw panel id", () => {
      projectsState = { projects: [] };
      mockSessions([session({ panelId: "dev-preview-8f2c", worktreeId: undefined })]);
      render(<DevServerDashboard />);
      expect(screen.queryByText("dev-preview-8f2c")).toBeNull();
      expect(screen.getByText("Workspace")).toBeTruthy();
      const restartButton = screen.getByLabelText(
        "Restart dev server for Workspace"
      ) as HTMLButtonElement;
      expect(restartButton.disabled).toBe(false);
    });

    it("calls a scratch whose name hasn't loaded a scratch workspace", () => {
      scratchesState = { scratches: [] };
      mockSessions([session({ projectId: SCRATCH_ID, worktreeId: undefined })]);
      render(<DevServerDashboard />);
      expect(screen.getByText("Scratch workspace")).toBeTruthy();
      fireEvent.click(screen.getByLabelText("Stop dev server for Scratch workspace"));
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: SCRATCH_ID });
    });
  });

  it("prefers the error's reason over the latest output", () => {
    mockSessions([
      session({
        status: "error",
        terminalId: null,
        url: null,
        lastOutput: "noise line",
        error: {
          type: "port-conflict",
          message: "Port 3000 in use",
        } as DevPreviewSessionState["error"],
      }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.getByText("Port 3000 in use")).toBeTruthy();
    expect(screen.queryByText("noise line")).toBeNull();
  });

  it("summarises running and failed servers in the header", () => {
    mockSessions([
      session({ panelId: "p1" }),
      session({ panelId: "p2", worktreeId: "wt-2" }),
      session({ panelId: "p3", worktreeId: "wt-3", status: "error", terminalId: null }),
    ]);
    render(<DevServerDashboard />);
    expect(screen.getByText("2 running · 1 failed")).toBeTruthy();
  });
});
