// @vitest-environment jsdom
import {
  act,
  cleanup,
  render as rtlRender,
  screen,
  fireEvent,
  within,
  type RenderOptions,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

let snapshot: DevSessionsSnapshot;
const useWorktreeStore = vi.fn();
let projectsState: { projects: Array<{ id: string; name: string }> };
let scratchesState: { scratches: Array<{ id: string; name: string }> };

function mockSessions(
  sessions: DevPreviewSessionState[],
  overrides: { hydrated?: boolean; fetchError?: boolean } = {}
) {
  snapshot = { sessions, hydrated: true, fetchError: false, ...overrides };
}

const h = vi.hoisted(() => ({
  panelInView: vi.fn<(session: { panelId: string; projectId: string }) => boolean>(() => true),
  expectHandoff: vi.fn(),
  onOpen: vi.fn(),
  onOpenExternal: vi.fn(),
}));

vi.mock("@/services/openDevServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/openDevServer")>()),
  devServerPanelInView: (session: { panelId: string; projectId: string }) =>
    h.panelInView(session) ? { id: session.panelId } : undefined,
}));
vi.mock("@/components/ui/overlay-focus-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/overlay-focus-restore")>()),
  useOverlayFocusRestore: () => ({ expectHandoff: h.expectHandoff }),
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

import { LinksLauncherDevServers, type DevSessionsSnapshot } from "../LinksLauncherDevServers";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_SKELETON_GATE_MS } from "@/lib/animationUtils";

function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

function DevServers() {
  return (
    <LinksLauncherDevServers
      snapshot={snapshot}
      sectionId="dev"
      onOpen={h.onOpen}
      onOpenExternal={h.onOpenExternal}
    />
  );
}

/** The rows that open something: the row's own button, never one of its actions. */
function openableRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("li > button"));
}

/** The accessible description of a row's button, read off its id references. */
function description(row: HTMLElement): string {
  return (row.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
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
  h.panelInView.mockReturnValue(true);
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

describe("LinksLauncherDevServers", () => {
  it("leaves itself out when the load succeeded and no server is listed", () => {
    mockSessions([session({ status: "stopped" })]);
    const { container } = render(<DevServers />);
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows its skeleton once a first load outlasts the onset gate, and nothing before", () => {
    vi.useFakeTimers();
    try {
      mockSessions([], { hydrated: false });
      const { container } = render(<DevServers />);
      expect(container.querySelector("section")).toBeNull();

      act(() => vi.advanceTimersByTime(UI_SKELETON_GATE_MS - 1));
      expect(container.querySelector("section")).toBeNull();
      act(() => vi.advanceTimersByTime(1));

      expect(screen.getByRole("region", { name: "Dev servers" })).toBeTruthy();
      expect(screen.getByRole("status", { name: "Loading dev servers" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so under its heading when the session fetch fails", () => {
    mockSessions([], { fetchError: true });
    render(<DevServers />);
    expect(screen.getByRole("region", { name: "Dev servers" })).toBeTruthy();
    expect(screen.getByText("Couldn't load dev servers")).toBeTruthy();
  });

  it("hides plain stopped sessions but keeps restored-stopped", () => {
    mockSessions([
      session({ panelId: "p-stopped", status: "stopped", worktreeId: "wt-stopped" }),
      session({ panelId: "p-restored", status: "restored-stopped", worktreeId: "wt-1" }),
    ]);
    render(<DevServers />);
    expect(screen.queryByText("wt-stopped")).toBeNull();
    expect(screen.getByText("feature-foo")).toBeTruthy();
  });

  it("renders a running server's address, keeping routine output to the tooltip", async () => {
    mockSessions([session({ url: "http://localhost:4321", lastOutput: "ready in 200ms" })]);
    const { container } = render(<DevServers />);
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText("localhost:4321")).toBeTruthy();
    expect(screen.queryByText("ready in 200ms")).toBeNull();
    // Through the app's tooltip, never a native title.
    const row = container.querySelector("li")!;
    expect(row.hasAttribute("title")).toBe(false);
    expect(row.querySelectorAll("[title]")).toHaveLength(0);
    // On the status text rather than the row, so the action buttons don't inherit it beside
    // their own tooltips.
    const trigger = screen.getByText("localhost:4321").closest<HTMLElement>("[data-state]")!;
    expect(trigger).toBeTruthy();
    expect(row.contains(trigger)).toBe(true);
    expect(trigger.querySelector("button")).toBeNull();
    fireEvent.focus(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe("ready in 200ms");
  });

  it("shows progress output while a server is starting", () => {
    mockSessions([session({ status: "starting", lastOutput: "> app@1.0.0 dev" })]);
    render(<DevServers />);
    expect(screen.getByText("> app@1.0.0 dev")).toBeTruthy();
  });

  it("shows the predicted address while a server has none of its own, without opening it", () => {
    mockSessions([session({ url: null, predictedUrl: "http://localhost:5050" })]);
    render(<DevServers />);
    expect(screen.getByText("localhost:5050")).toBeTruthy();
    expect(openableRows()).toHaveLength(0);
  });

  it("shows a server at its scheme's default port by its host alone", () => {
    mockSessions([session({ url: "http://localhost", predictedUrl: null })]);
    const { container } = render(<DevServers />);
    expect(screen.getByText("localhost")).toBeTruthy();
    expect(container.textContent).not.toContain(":");
  });

  it("falls back to the worktree folder's name, not its full path, when no name is known", () => {
    useWorktreeStore.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ worktrees: new Map() })
    );
    mockSessions([session({ worktreeId: "/Users/dev/Projects/atlas-worktrees/wt-unknown" })]);
    render(<DevServers />);
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
    render(<DevServers />);
    const restart = screen.getAllByRole("button", { name: /^Restart dev server for / });
    const names = restart.map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).not.toContain("/repos/");
  });

  it("restarts its own session on click", () => {
    mockSessions([session()]);
    render(<DevServers />);
    fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo"));
    expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    expect(restartByWorktree).not.toHaveBeenCalled();
  });

  it("stops its own session on click", () => {
    mockSessions([session()]);
    render(<DevServers />);
    fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo"));
    expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    expect(stopDevServerByWorktree).not.toHaveBeenCalled();
  });

  it("keeps a stopping server's Stop focusable but inert", () => {
    mockSessions([session({ status: "stopping" })]);
    render(<DevServers />);
    const stopButton = screen.getByLabelText(
      "Stop dev server for feature-foo"
    ) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    expect(stopButton.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(stopButton);
    expect(stop).not.toHaveBeenCalled();
  });

  it("offers to dismiss an errored session's error, which fires the stop call", () => {
    mockSessions([session({ status: "error", terminalId: null, url: null })]);
    render(<DevServers />);
    const stopButton = screen.getByLabelText("Dismiss error for feature-foo");
    expect(stopButton.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(stopButton);
    expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
  });

  it("offers start, never stop, for restored-stopped sessions", () => {
    mockSessions([session({ status: "restored-stopped" })]);
    render(<DevServers />);
    expect(screen.queryByLabelText("Stop dev server for feature-foo")).toBeNull();
    fireEvent.click(screen.getByLabelText("Start dev server for feature-foo"));
    expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
  });

  it("keeps Stop, not Dismiss, for an error whose server is still running", () => {
    mockSessions([session({ status: "error", terminalId: "t-1", url: null })]);
    render(<DevServers />);
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
      render(<DevServers />);
      const [failedRow] = rows();
      fireEvent.click(within(failedRow!).getByRole("button", { name: /^Dismiss error for / }));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith({ panelId: "p-app", projectId: "project-1" });
      expect(stopDevServerByWorktree).not.toHaveBeenCalled();
    });

    it("restarts and stops only the row that was clicked", () => {
      mockSessions([failed(), running()]);
      render(<DevServers />);
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
      render(<DevServers />);
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
      render(<DevServers />);
      fireEvent.click(screen.getByLabelText("Start dev server for feature-foo · panel 1"));
      expect(restart).toHaveBeenCalledWith({ panelId: "p-app", projectId: "project-1" });
    });

    it("keeps each row's number when the snapshot reorders", () => {
      mockSessions([failed(), running()]);
      const { rerender } = render(<DevServers />);
      const before = within(rows()[0]!).getByText(/^feature-foo · panel /).textContent;
      mockSessions([running(), failed()]);
      rerender(<DevServers />);
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
      render(<DevServers />);
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
      render(<DevServers />);
      expect(screen.getByText("feature-bar")).toBeTruthy();
    });

    it("starts a restored-stopped panel by its own id", () => {
      mockSessions([session({ panelId: "p-app", status: "restored-stopped" }), running()]);
      render(<DevServers />);
      const [restoredRow] = rows();
      fireEvent.click(within(restoredRow!).getByRole("button", { name: /^Start dev server for / }));
      expect(restart).toHaveBeenCalledWith({ panelId: "p-app", projectId: "project-1" });
    });
  });

  describe("a session with no worktree", () => {
    it("names a plain folder's row after its project and keeps both controls working", () => {
      mockSessions([session({ status: "running", worktreeId: undefined })]);
      render(<DevServers />);
      expect(screen.getByText("Atlas")).toBeTruthy();
      expect(screen.queryByText("panel-1")).toBeNull();
      const stopButton = screen.getByLabelText("Stop dev server for Atlas");
      const restartButton = screen.getByLabelText("Restart dev server for Atlas");
      expect(stopButton.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(stopButton);
      fireEvent.click(restartButton);
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("lets an errored worktree-less session be dismissed", () => {
      mockSessions([
        session({ status: "error", terminalId: null, url: null, worktreeId: undefined }),
      ]);
      render(<DevServers />);
      fireEvent.click(screen.getByLabelText("Dismiss error for Atlas"));
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("names a scratch workspace's row after the scratch", () => {
      mockSessions([session({ projectId: SCRATCH_ID, worktreeId: undefined })]);
      render(<DevServers />);
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
      render(<DevServers />);
      fireEvent.click(screen.getByLabelText("Stop dev server for Borealis"));
      expect(stop).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-2" });
      fireEvent.click(screen.getByLabelText("Restart dev server for Atlas"));
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("starts a worktree-less restored-stopped session", () => {
      mockSessions([session({ status: "restored-stopped", worktreeId: undefined })]);
      render(<DevServers />);
      fireEvent.click(screen.getByLabelText("Start dev server for Atlas"));
      expect(restart).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "project-1" });
    });

    it("calls an unknown project's row a workspace, never its raw panel id", () => {
      projectsState = { projects: [] };
      mockSessions([session({ panelId: "dev-preview-8f2c", worktreeId: undefined })]);
      render(<DevServers />);
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
      render(<DevServers />);
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
    render(<DevServers />);
    expect(screen.getByText("Port 3000 in use")).toBeTruthy();
    expect(screen.queryByText("noise line")).toBeNull();
  });

  it("summarises running and failed servers in the header", () => {
    mockSessions([
      session({ panelId: "p1" }),
      session({ panelId: "p2", worktreeId: "wt-2" }),
      session({ panelId: "p3", worktreeId: "wt-3", status: "error", terminalId: null }),
    ]);
    render(<DevServers />);
    expect(screen.getByText("2 running · 1 failed")).toBeTruthy();
  });
});

describe("opening a dev server from its row", () => {
  it("opens a running server's own session from its row, described by the address it opens", () => {
    const running = session({ url: "http://localhost:5824" });
    mockSessions([running]);
    render(<DevServers />);
    const [row] = openableRows();
    // A native button: Enter activates it as a click does.
    expect(row!.tagName).toBe("BUTTON");
    expect(row!.textContent).toContain("feature-foo");
    expect(description(row!)).toContain("localhost:5824");
    fireEvent.click(row!, { detail: 0 });
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onOpen).toHaveBeenCalledWith(running);
    expect(h.onOpenExternal).not.toHaveBeenCalled();
  });

  it("hands focus off when its preview is a panel of this view, and only then", () => {
    mockSessions([
      session({ panelId: "p-here", worktreeId: "wt-1" }),
      session({ panelId: "p-away", projectId: "project-2", worktreeId: "wt-9" }),
    ]);
    h.panelInView.mockImplementation((s) => s.panelId === "p-here");
    render(<DevServers />);
    const [here, away] = openableRows();
    fireEvent.click(away!);
    expect(h.expectHandoff).not.toHaveBeenCalled();
    expect(h.panelInView).toHaveBeenLastCalledWith(
      expect.objectContaining({ panelId: "p-away", projectId: "project-2" })
    );
    fireEvent.click(here!);
    expect(h.expectHandoff).toHaveBeenCalledTimes(1);
    expect(h.onOpen.mock.calls.map(([s]) => [s.panelId, s.projectId])).toEqual([
      ["p-away", "project-2"],
      ["p-here", "project-1"],
    ]);
  });

  it("asks where the server's panel is when the row is pressed, not when it was drawn", () => {
    mockSessions([session()]);
    h.panelInView.mockReturnValue(false);
    render(<DevServers />);
    h.panelInView.mockReturnValue(true);
    fireEvent.click(openableRows()[0]!);
    expect(h.expectHandoff).toHaveBeenCalledTimes(1);
  });

  it("offers Open in external browser for a running server, sending its address", () => {
    mockSessions([session({ url: "http://localhost:5824" })]);
    render(<DevServers />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open dev server for feature-foo in external browser" })
    );
    expect(h.onOpenExternal).toHaveBeenCalledTimes(1);
    expect(h.onOpenExternal).toHaveBeenCalledWith("http://localhost:5824");
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.expectHandoff).not.toHaveBeenCalled();
  });

  it("never opens the row from its Restart or Stop", () => {
    mockSessions([session()]);
    render(<DevServers />);
    fireEvent.click(screen.getByLabelText("Restart dev server for feature-foo"));
    fireEvent.click(screen.getByLabelText("Stop dev server for feature-foo"));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onOpenExternal).not.toHaveBeenCalled();
    expect(h.expectHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["starting", {}],
    ["installing", {}],
    ["stopping", {}],
    ["error", { terminalId: null }],
    ["restored-stopped", {}],
  ] as const)("keeps a %s row's controls and opens nothing from it", (status, extra) => {
    mockSessions([session({ status, ...extra })]);
    render(<DevServers />);
    expect(openableRows()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /in external browser$/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^(Start|Restart) dev server for feature-foo$/ })
    ).toBeTruthy();
  });

  it("keeps a focused Stop mounted as its server stops being openable", () => {
    mockSessions([session()]);
    const { rerender } = render(<DevServers />);
    const stopButton = screen.getByLabelText("Stop dev server for feature-foo");
    stopButton.focus();
    mockSessions([session({ status: "stopping" })]);
    rerender(<DevServers />);
    expect(openableRows()).toHaveLength(0);
    expect(screen.getByLabelText("Stop dev server for feature-foo")).toBe(stopButton);
    expect(document.activeElement).toBe(stopButton);
    expect(stopButton.getAttribute("aria-disabled")).toBe("true");
  });
});
