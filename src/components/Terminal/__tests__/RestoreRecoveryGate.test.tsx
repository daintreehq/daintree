// @vitest-environment jsdom
/**
 * The in-pane surface of a pane restore held instead of launching (#12434).
 * Real store, the launch controller swapped for a spy — whether a choice
 * reaches the controller, and what the pane says while it waits, is what is
 * under test here; the launch itself is covered in `restoreRecoveryLaunch.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

const findSessions = vi.hoisted(() => vi.fn());
const launchFromRestoreRecovery = vi.hoisted(() => vi.fn());

const viewObservable = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  isProjectViewObservable: () => viewObservable.value,
}));

vi.mock("@/clients/codexClient", () => ({
  codexClient: { findSessions },
}));

vi.mock("@/services/terminal/restoreRecoveryLaunch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/terminal/restoreRecoveryLaunch")>()),
  launchFromRestoreRecovery,
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("@/store/panelStore");
const { RestoreRecoveryGate, __resetRestoreRecoveryAutoResumeForTests } =
  await import("../RestoreRecoveryGate");
const { useAgentSettingsStore } = await import("@/store/agentSettingsStore");

function heldPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/worktrees/task-a",
    conversationCwd: "/repo",
    worktreeId: "/worktrees/task-a",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId: "codex",
    hasPty: false,
    restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
    ...overrides,
  };
}

function seed(...panels: PanelInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

function held(id: string): PtyPanelData {
  const panel = usePanelStore.getState().panelsById[id];
  if (!panel || !isPtyPanel(panel)) throw new Error(`${id} is not a terminal pane`);
  return panel;
}

// The app root supplies the TooltipProvider.
function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

beforeEach(() => {
  findSessions.mockReset();
  launchFromRestoreRecovery.mockReset();
  launchFromRestoreRecovery.mockResolvedValue("launched");
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("RestoreRecoveryGate (#12434)", () => {
  it("says why the pane waited, where its conversation lives and where it will run", () => {
    seed(heldPanel("p-1"));

    render(<RestoreRecoveryGate panelId="p-1" />);

    expect(screen.getByRole("heading", { name: "Choose this pane's conversation" })).toBeTruthy();
    expect(screen.getByText("/repo")).toBeTruthy();
    expect(screen.getByText("/worktrees/task-a")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start new session" })).toBeTruthy();
    // No candidate was kept, so there is nothing to offer by name.
    expect(screen.queryByRole("button", { name: "Resume session" })).toBeNull();
  });

  it("names the pane's own folder when its conversation began where it runs", () => {
    seed(heldPanel("p-1", { cwd: "/repo", conversationCwd: undefined }));

    render(<RestoreRecoveryGate panelId="p-1" />);

    expect(screen.getAllByText("/repo")).toHaveLength(2);
  });

  it("starts a new session only when asked", async () => {
    seed(heldPanel("p-1"));

    render(<RestoreRecoveryGate panelId="p-1" />);
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start new session" }));

    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenCalledWith("p-1", { kind: "fresh" })
    );
  });

  it("resumes the conversation restore already knew, when it kept one", async () => {
    seed(
      heldPanel("p-1", {
        restoreRecovery: { reason: "destination-unavailable", sessionId: "sess-a" },
      })
    );

    render(<RestoreRecoveryGate panelId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));

    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenCalledWith("p-1", {
        kind: "resume",
        sessionId: "sess-a",
      })
    );
  });

  it("searches the conversation's folder and resumes the pick in place", async () => {
    findSessions.mockResolvedValue({
      status: "ok",
      sessions: [{ id: "sess-9", preview: "that task", updatedAt: 1 }],
    });
    seed(heldPanel("p-1", { env: { CODEX_HOME: "/profiles/work" } }));

    render(<RestoreRecoveryGate panelId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Find session" }));
    fireEvent.click(await screen.findByText("that task"));

    expect(findSessions).toHaveBeenCalledWith({ cwd: "/repo", codexHome: "/profiles/work" });
    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenCalledWith("p-1", {
        kind: "resume",
        sessionId: "sess-9",
      })
    );
  });

  it("says so when the chosen conversation is already open somewhere else", async () => {
    launchFromRestoreRecovery.mockResolvedValue("held-elsewhere");
    seed(
      heldPanel("p-1", {
        restoreRecovery: { reason: "destination-unavailable", sessionId: "sess-a" },
      })
    );

    render(<RestoreRecoveryGate panelId="p-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));

    expect(await screen.findByText("Conversation already open")).toBeTruthy();
  });

  it("asks where to run before offering anything that would launch", async () => {
    seed(
      heldPanel("p-1", {
        cwd: "/repo",
        conversationCwd: undefined,
        restoreRecovery: {
          reason: "destination-unavailable",
          sessionId: "sess-a",
          awaitingDestination: true,
        },
      })
    );

    render(<RestoreRecoveryGate panelId="p-1" />);

    expect(screen.getByRole("heading", { name: "Worktree no longer available" })).toBeTruthy();
    expect(screen.queryByText("Runs in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start new session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume session" })).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Keep original folder" }));
    });

    expect(held("p-1").restoreRecovery).toEqual({
      reason: "destination-unavailable",
      sessionId: "sess-a",
    });
    expect(held("p-1").cwd).toBe("/repo");
    expect(await screen.findByRole("button", { name: "Resume session" })).toBeTruthy();
    expect(screen.getByText("Runs in")).toBeTruthy();
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
  });

  it("keeps the folder it shows, even when the pane last ran somewhere else", () => {
    seed(
      heldPanel("p-1", {
        cwd: "/worktrees/task-a",
        conversationCwd: "/repo",
        restoreRecovery: { reason: "destination-unavailable", awaitingDestination: true },
      })
    );

    render(<RestoreRecoveryGate panelId="p-1" />);
    expect(screen.getByText("/repo")).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Keep original folder" }));
    });

    expect(held("p-1").cwd).toBe("/repo");
    expect(held("p-1").conversationCwd).toBeUndefined();
    expect(held("p-1").restoreRecovery).toEqual({ reason: "destination-unavailable" });
  });

  it("opens nothing and takes no focus when several held panes appear at once", () => {
    seed(heldPanel("p-1"), heldPanel("p-2"), heldPanel("p-3"));

    render(
      <>
        <RestoreRecoveryGate panelId="p-1" />
        <RestoreRecoveryGate panelId="p-2" />
        <RestoreRecoveryGate panelId="p-3" />
      </>
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(findSessions).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    expect(screen.getAllByRole("button", { name: "Start new session" })).toHaveLength(3);
  });

  it("renders nothing for a pane that isn't held", () => {
    seed(heldPanel("p-1", { restoreRecovery: undefined }));

    const { container } = render(<RestoreRecoveryGate panelId="p-1" />);

    expect(container.innerHTML).toBe("");
  });
});

describe("RestoreRecoveryGate — held by the resume setting (#13509)", () => {
  const deferred = (sessionId?: string, id = "p-1") =>
    heldPanel(id, {
      launchAgentId: "claude",
      cwd: "/repo",
      conversationCwd: undefined,
      restoreRecovery: {
        reason: "resume-deferred",
        ...(sessionId !== undefined && { sessionId }),
      },
    });

  function setPolicy(resumeOnRestart: "always" | "on-focus" | "never" | undefined) {
    useAgentSettingsStore.setState({
      settings: { agents: {}, ...(resumeOnRestart && { resumeOnRestart }) },
      isInitialized: true,
    });
  }

  const resumeOf = (panelId: string, sessionId: string) => [panelId, { kind: "resume", sessionId }];

  let windowFocused = true;
  beforeEach(() => {
    windowFocused = true;
    viewObservable.value = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
    __resetRestoreRecoveryAutoResumeForTests();
    setPolicy("on-focus");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAgentSettingsStore.setState({ settings: null, isInitialized: false });
  });

  it("resumes the conversation it kept once the pane is selected, and not before", async () => {
    seed(deferred("sess-c"));

    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    expect(screen.getByRole("heading", { name: "Resumes when you focus this pane" })).toBeTruthy();
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();

    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);

    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenCalledWith(...resumeOf("p-1", "sess-c"))
    );
  });

  it("resumes a pane that is already selected when it appears", async () => {
    seed(deferred("sess-c"));

    render(<RestoreRecoveryGate panelId="p-1" isFocused />);

    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenCalledWith(...resumeOf("p-1", "sess-c"))
    );
  });

  it("starts nothing when the setting is switched on under a selected pane", () => {
    setPolicy("never");
    seed(deferred("sess-c"));
    render(<RestoreRecoveryGate panelId="p-1" isFocused />);

    act(() => setPolicy("on-focus"));

    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Not resumed after restart" })).toBeTruthy();
  });

  it("arms from the first setting it sees once the settings load", async () => {
    useAgentSettingsStore.setState({ settings: null, isInitialized: false });
    seed(deferred("sess-c"));
    render(<RestoreRecoveryGate panelId="p-1" isFocused />);
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();

    act(() => setPolicy("on-focus"));

    await waitFor(() => expect(launchFromRestoreRecovery).toHaveBeenCalledTimes(1));
  });

  it("leaves a pressed button to its own choice", async () => {
    seed(deferred("sess-c"));
    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);

    const startNew = screen.getByRole("button", { name: "Start new session" });
    fireEvent.pointerDown(startNew);
    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);
    fireEvent.click(startNew);

    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenCalledWith("p-1", { kind: "fresh" })
    );
    expect(launchFromRestoreRecovery).toHaveBeenCalledTimes(1);
  });

  it("resumes nothing while the view is cached behind another project", () => {
    viewObservable.value = false;
    seed(deferred("sess-c"));

    render(<RestoreRecoveryGate panelId="p-1" isFocused />);

    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
  });

  it("waits for the window to have focus before resuming", async () => {
    windowFocused = false;
    seed(deferred("sess-c"));
    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);

    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();

    windowFocused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(launchFromRestoreRecovery).toHaveBeenCalledTimes(1));
  });

  it("forgets a selection the user turned away from before the window had focus", () => {
    windowFocused = false;
    seed(deferred("sess-c"));
    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);
    rerender(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);

    windowFocused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
  });

  it("tries once, even across a remount, leaving a launch that didn't happen to the buttons", async () => {
    launchFromRestoreRecovery.mockResolvedValue("held-elsewhere");
    seed(deferred("sess-c"));

    const first = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    first.rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);
    await waitFor(() => expect(screen.getByText("Conversation already open")).toBeTruthy());
    first.unmount();

    const second = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    second.rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);

    expect(launchFromRestoreRecovery).toHaveBeenCalledTimes(1);
  });

  it("still tries another pane after one pane's attempt failed", async () => {
    launchFromRestoreRecovery.mockResolvedValue("unavailable");
    seed(deferred("sess-a", "p-1"), deferred("sess-b", "p-2"));

    const first = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    first.rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);
    await waitFor(() => expect(launchFromRestoreRecovery).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = render(<RestoreRecoveryGate panelId="p-2" isFocused={false} />);
    second.rerender(<RestoreRecoveryGate panelId="p-2" isFocused />);

    await waitFor(() =>
      expect(launchFromRestoreRecovery).toHaveBeenLastCalledWith(...resumeOf("p-2", "sess-b"))
    );
  });

  it("resumes nothing under never", () => {
    setPolicy("never");
    seed(deferred("sess-c"));

    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);

    expect(screen.getByRole("heading", { name: "Not resumed after restart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume session" })).toBeTruthy();
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
  });

  it("resumes nothing before the setting is known", () => {
    useAgentSettingsStore.setState({ settings: null, isInitialized: false });
    seed(deferred("sess-c"));

    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);

    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
  });

  it("offers only a new session to a pane with no conversation to resume", () => {
    seed(deferred());

    const { rerender } = render(<RestoreRecoveryGate panelId="p-1" isFocused={false} />);
    rerender(<RestoreRecoveryGate panelId="p-1" isFocused />);

    expect(screen.getByRole("heading", { name: "Not resumed after restart" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume session" })).toBeNull();
    expect(launchFromRestoreRecovery).not.toHaveBeenCalled();
  });
});
