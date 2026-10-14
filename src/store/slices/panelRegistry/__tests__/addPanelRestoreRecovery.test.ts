/**
 * A pane held for recovery (#12434) commits without a process, and a later
 * launch replaces it in place — once, and never after it was closed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";

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
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    invalidatePtyGrid: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => ({ width: 500, sessions: {}, activeSlot: 0 }),
  },
  selectActiveSlot: () => ({ terminalId: null, sessionId: null, agentId: null }),
  selectSlotTerminalIds: () => [],
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    innerHeight: 900,
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { usePanelLimitStore } = await import("@/store/panelLimitStore");
const { agentLifecycleLedger } = await import("@/services/terminal/lifecycleLedger");
const { terminalClient } = await import("@/clients");
const spawn = vi.mocked(terminalClient.spawn);
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { saveNormalized } = await import("../persistence");
const { beginBatch, consumeBatch } = await import("../hydrationBatch");

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

function makeAttachedManaged(cols: number, rows: number) {
  return {
    terminal: { cols, rows, element: { isConnected: true } },
  };
}

function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

async function holdPane(id: string): Promise<void> {
  await usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    launchAgentId: "codex",
    command: "codex",
    cwd: "/worktrees/task-a",
    worktreeId: "/worktrees/task-a",
    conversationCwd: "/repo",
    restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
    title: "Task A",
    bypassLimits: true,
  });
}

function launchOver(id: string) {
  return usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    replacesRestoreRecovery: true,
    launchAgentId: "codex",
    command: "codex resume sess-1 -C '.'",
    agentSessionId: "sess-1",
    conversationCwd: "/repo",
    cwd: "/worktrees/task-a",
    worktreeId: "/worktrees/task-a",
    title: "Task A",
  });
}

describe("addPanel — recovery holds (#12434)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    spawn.mockReset();
    spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    vi.mocked(terminalInstanceService.prewarmTerminal).mockReset();
    usePanelLimitStore.setState({ softWarningLimit: 100, confirmationLimit: 200, hardLimit: 300 });
  });

  it("commits a held pane with no process, no startup work and no launch record", async () => {
    await holdPane("held-1");
    await drainMicrotasks();

    const panel = ptyPanel("held-1");
    expect(panel?.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    expect(panel?.hasPty).toBe(false);
    expect(panel?.conversationCwd).toBe("/repo");
    expect(panel?.cwd).toBe("/worktrees/task-a");
    expect(panel?.command).toBe("codex");
    expect(panel?.agentState).toBeUndefined();
    expect(panel?.spawnStatus).toBeUndefined();
    expect(panel?.runtimeStatus).toBeUndefined();
    expect(panel?.startedAt).toBeUndefined();
    expect(usePanelStore.getState().panelIds).toContain("held-1");

    expect(spawn).not.toHaveBeenCalled();
    expect(terminalInstanceService.prewarmTerminal).not.toHaveBeenCalled();
    expect(agentLifecycleLedger.getEntry("held-1")).toBeUndefined();
  });

  it("leaves the startup queue free for the launches that follow", async () => {
    await holdPane("held-1");
    await holdPane("held-2");

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "plain",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ id: "plain" });
  });

  it("launches a held pane in place, keeping its position", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "before",
      cwd: "/repo",
      bypassLimits: true,
    });
    await holdPane("held-1");
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "after",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();
    spawn.mockClear();

    await expect(launchOver("held-1")).resolves.toBe("held-1");
    await drainMicrotasks();

    expect(usePanelStore.getState().panelIds).toEqual(["before", "held-1", "after"]);
    const panel = ptyPanel("held-1");
    expect(panel?.restoreRecovery).toBeUndefined();
    expect(panel?.hasPty).not.toBe(false);
    expect(panel?.agentSessionId).toBe("sess-1");
    expect(panel?.conversationCwd).toBe("/repo");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      id: "held-1",
      cwd: "/worktrees/task-a",
      command: "codex resume sess-1 -C '.'",
      agentSessionId: "sess-1",
    });
  });

  it("keeps notes written while the pane was held when it launches in place (#12835)", async () => {
    await holdPane("held-1");
    await drainMicrotasks();
    usePanelStore.getState().showScratchpad("held-1");
    usePanelStore.getState().setScratchpadContent("held-1", "resume the auth work");

    await expect(launchOver("held-1")).resolves.toBe("held-1");
    await drainMicrotasks();

    const panel = ptyPanel("held-1");
    expect(panel?.restoreRecovery).toBeUndefined();
    expect(panel?.scratchpad).toEqual({ content: "resume the auth work", collapsed: false });
  });

  it("drops a launch for a held pane that was closed while it waited", async () => {
    await holdPane("held-1");
    const pending = launchOver("held-1");
    usePanelStore.getState().removePanel("held-1");

    await expect(pending).resolves.toBeNull();
    await drainMicrotasks();

    expect(usePanelStore.getState().panelsById["held-1"]).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launches a held pane only once however many launches race for it", async () => {
    await holdPane("held-1");

    const results = await Promise.all([launchOver("held-1"), launchOver("held-1")]);
    await drainMicrotasks();

    expect(results.filter((id) => id === "held-1")).toHaveLength(1);
    expect(results.filter((id) => id === null)).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses to treat an ordinary pane as a held one", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "plain",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();
    spawn.mockClear();

    await expect(launchOver("plain")).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("lets a held pane launch at the panel limit, since it replaces rather than adds", async () => {
    await holdPane("held-1");
    usePanelLimitStore.setState({ softWarningLimit: 1, confirmationLimit: 1, hardLimit: 1 });

    await expect(
      usePanelStore.getState().addPanel({ kind: "terminal", requestedId: "extra", cwd: "/repo" })
    ).resolves.toBeNull();
    await expect(launchOver("held-1")).resolves.toBe("held-1");
  });

  it("never hides a launched pane behind a saved hold replayed over it", async () => {
    await holdPane("held-1");
    await launchOver("held-1");
    await drainMicrotasks();

    await holdPane("held-1");
    await drainMicrotasks();

    expect(ptyPanel("held-1")?.restoreRecovery).toBeUndefined();
    expect(ptyPanel("held-1")?.agentSessionId).toBe("sess-1");
  });

  it("writes a launch made while a restore batch is still open", async () => {
    await holdPane("held-1");
    vi.mocked(saveNormalized).mockClear();
    const token = beginBatch();
    try {
      await launchOver("held-1");
      // Written with the launch itself, not left for a batch flush that adds no ids.
      const lastWrite = vi.mocked(saveNormalized).mock.calls.at(-1)?.[0];
      const written = lastWrite?.["held-1"];
      expect(written && isPtyPanel(written) ? written.restoreRecovery : "missing").toBeUndefined();
      expect(usePanelStore.getState().panelIds).toContain("held-1");
    } finally {
      consumeBatch(token);
    }
  });
});

describe("addPanel — scratchpad carry onto an existing record (#12835)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    spawn.mockReset();
    spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    usePanelLimitStore.setState({ softWarningLimit: 100, confirmationLimit: 200, hardLimit: 300 });
  });

  // A restored pane: only a record restore created may be merged into again. A
  // reconnect landing on a pane launched this session is refused outright, so
  // these cases would never reach the merge they exist to test.
  async function openPane(id: string): Promise<void> {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: id,
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();
  }

  function landAgain(id: string, content: string) {
    return usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: id,
      existingId: id,
      cwd: "/repo",
      scratchpad: { content, collapsed: false },
      bypassLimits: true,
    });
  }

  it("keeps notes typed since the snapshot over the snapshot's own", async () => {
    await openPane("p1");
    usePanelStore.getState().showScratchpad("p1");
    usePanelStore.getState().setScratchpadContent("p1", "typed after restore");

    await landAgain("p1", "stale snapshot");
    await drainMicrotasks();

    expect(ptyPanel("p1")?.scratchpad?.content).toBe("typed after restore");
  });

  it("keeps live notes inside a hydration batch too", async () => {
    await openPane("p1");
    usePanelStore.getState().showScratchpad("p1");
    usePanelStore.getState().setScratchpadContent("p1", "typed after restore");

    const token = beginBatch();
    try {
      await landAgain("p1", "stale snapshot");
      await drainMicrotasks();
      expect(ptyPanel("p1")?.scratchpad?.content).toBe("typed after restore");
    } finally {
      consumeBatch(token);
    }
  });

  it("takes the incoming notes when the live record has none", async () => {
    await openPane("p1");

    await landAgain("p1", "from the snapshot");
    await drainMicrotasks();

    expect(ptyPanel("p1")?.scratchpad?.content).toBe("from the snapshot");
  });
});

/**
 * Tests for spawn-time PTY geometry (#10863).
 *
 * The PTY must boot at the grid the renderer is actually showing. The overlay
 * (help panel) XtermAdapter mounts without waiting for spawnStatus, so its
 * xterm can be attached and fitted before the queued spawn runs — booting the
 * PTY at the legacy 80×24 default made the assistant CLI paint its startup
 * banner at a width the renderer wasn't wrapping at, duplicating/garbling the
 * committed output. Three orderings are covered:
 *  - attach before spawn → spawn uses the live attached grid
 *  - attach during the spawn IPC → the dropped fit resize is re-asserted
 *  - no attach yet (overlay) → spawn uses the panel-derived estimate
 */
describe("spawn-time PTY geometry (#10863)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
    terminalClient.resize.mockReset();

    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
    vi.mocked(terminalInstanceService.get).mockReset();
    vi.mocked(terminalInstanceService.get).mockReturnValue(null as never);
    vi.mocked(terminalInstanceService.sendPtyResize).mockReset();
  });

  it("spawns at the live grid when the xterm attached before the queued spawn ran", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
    vi.mocked(terminalInstanceService.get).mockReturnValue(makeAttachedManaged(54, 40) as never);

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "dims-1",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(terminalClient.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dims-1", cols: 54, rows: 40 })
    );
    // Spawn dims already match the live grid — no compensating re-assert.
    const { terminalClient: tc } = (await import("@/clients")) as unknown as {
      terminalClient: { resize: ReturnType<typeof vi.fn> };
    };
    expect(tc.resize).not.toHaveBeenCalledWith("dims-1", 54, 40);
    expect(terminalInstanceService.sendPtyResize).not.toHaveBeenCalledWith("dims-1", 54, 40);
    // Any PTY grid recorded before the spawn landed is untrusted: a later
    // same-grid fit must re-assert rather than skip.
    expect(terminalInstanceService.invalidatePtyGrid).toHaveBeenCalledWith("dims-1");
  });

  it("re-asserts the fitted grid when the attach landed while the spawn IPC was in flight", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> };
    };
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

    // Not attached when the spawn dims are read; attached (and fitted to
    // 54×40) by the time the spawn IPC resolves. The fit's own PTY resize was
    // dropped by the pty-host during this window, so addPanel must re-assert.
    vi.mocked(terminalInstanceService.get)
      .mockReturnValueOnce(null as never)
      .mockReturnValue(makeAttachedManaged(54, 40) as never);

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "dims-2",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(terminalClient.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dims-2", cols: 80, rows: 24 })
    );
    // Direct PTY-only resize — sendPtyResize would defer 500ms for a
    // settled-strategy agent, exactly the window the CLI paints its banner in.
    expect(terminalClient.resize).toHaveBeenCalledWith("dims-2", 54, 40);
    expect(terminalInstanceService.sendPtyResize).not.toHaveBeenCalledWith("dims-2", 54, 40);
  });

  it("boots an overlay panel at the panel-derived estimate, never the 80×24 default", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "dims-3",
      cwd: "/",
      location: "overlay",
      bypassLimits: true,
    });
    await drainMicrotasks();

    const spawnArgs = terminalClient.spawn.mock.calls.find(
      (call) => (call[0] as { id?: string }).id === "dims-3"
    )?.[0] as { cols: number; rows: number };
    expect(spawnArgs).toBeDefined();
    // The estimate derives from the persisted panel width/viewport, so pin
    // only the invariants: not the legacy default, and consistent with the
    // committed panel record (the grid every other consumer sees).
    expect(spawnArgs.cols).not.toBe(80);
    expect(spawnArgs.rows).not.toBe(24);
    const panel = usePanelStore.getState().panelsById["dims-3"] as PtyPanelData;
    expect(spawnArgs.cols).toBe(panel.cols);
    expect(spawnArgs.rows).toBe(panel.rows);
  });
});

/**
 * Construction-time geometry for restored panes (#11718).
 *
 * A pane restored into a non-selected worktree is prewarmed and never attached,
 * so nothing ever fits it — but it stays content-live and parses everything its
 * surviving PTY streams. Born at 80×24 it commits a ~200-column agent's
 * cursor-addressed repaints into an 80-column grid, and no later fit or Redraw
 * can undo committed cells. Hydration hands the persisted grid in so the pane
 * never exists at the default.
 */
describe("construction geometry for restored panes (#11718)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
    terminalClient.resize.mockReset();

    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
    vi.mocked(terminalInstanceService.get).mockReset();
    vi.mocked(terminalInstanceService.get).mockReturnValue(null as never);
    vi.mocked(terminalInstanceService.sendPtyResize).mockReset();
    vi.mocked(terminalInstanceService.prewarmTerminal).mockReset();
  });

  /**
   * The options `id` was prewarmed with — spread straight into `new Terminal()`
   * by `createManagedTerminal`, so cols/rows here are the constructor grid.
   * (`prewarmTerminal` is mocked at this layer; the real constructor behaviour
   * is covered against a live xterm in TerminalRestoreController.replay.test.ts.)
   */
  async function prewarmDims(id: string): Promise<{ cols?: number; rows?: number } | undefined> {
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
    const call = vi
      .mocked(terminalInstanceService.prewarmTerminal)
      .mock.calls.find((c) => c[0] === id);
    return call?.[2] as { cols?: number; rows?: number } | undefined;
  }

  it("builds a reconnected pane's xterm at the persisted grid and never touches its PTY", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> };
    };
    const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      existingId: "restored-1",
      cwd: "/",
      bypassLimits: true,
      initialTerminalGeometry: { cols: 203, rows: 51 },
    });
    await drainMicrotasks();

    // The constructor, not a later resize: the exposure window this closes runs
    // from construction, and a parked xterm has no attach to consume a target.
    expect(await prewarmDims("restored-1")).toMatchObject({ cols: 203, rows: 51 });
    // Panel record agrees, so every other consumer of the pane's grid does too.
    const panel = usePanelStore.getState().panelsById["restored-1"] as PtyPanelData;
    expect(panel.cols).toBe(203);
    expect(panel.rows).toBe(51);
    // Renderer-only. The reconnected PTY is already on this grid, and the
    // estimate this path would otherwise send is a fixed guess, not a fit.
    expect(terminalInstanceService.sendPtyResize).not.toHaveBeenCalled();
    expect(terminalClient.resize).not.toHaveBeenCalled();
    expect(terminalClient.spawn).not.toHaveBeenCalled();
  });

  it("boots a respawned pane's PTY on the same grid it built the xterm at", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "restored-2",
      cwd: "/",
      bypassLimits: true,
      initialTerminalGeometry: { cols: 203, rows: 51 },
    });
    await drainMicrotasks();

    // A respawn creates a NEW PTY, so seeding the renderer alone would just
    // invert the bug — the agent would paint for 80 columns into a 203-column
    // grid. The pair is the invariant, not either value alone.
    const spawnArgs = terminalClient.spawn.mock.calls.find(
      (call) => (call[0] as { id?: string }).id === "restored-2"
    )?.[0] as { cols: number; rows: number };
    expect(spawnArgs).toBeDefined();
    expect(await prewarmDims("restored-2")).toMatchObject({
      cols: spawnArgs.cols,
      rows: spawnArgs.rows,
    });
    expect(spawnArgs.cols).toBe(203);
    expect(spawnArgs.rows).toBe(51);
  });

  it("ignores a geometry that is not a grid a terminal could have had", async () => {
    const { terminalClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
    };

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "restored-3",
      cwd: "/",
      bypassLimits: true,
      // Half-valid: partially defaulting it would boot the pane on a grid the
      // PTY is not on, which is the failure being fixed.
      initialTerminalGeometry: { cols: 0, rows: 51 } as never,
    });
    await drainMicrotasks();

    // All-or-nothing across every consumer — a partial application would leak
    // the valid half into one of them.
    expect(await prewarmDims("restored-3")).not.toMatchObject({ rows: 51 });
    const spawnArgs = terminalClient.spawn.mock.calls.find(
      (call) => (call[0] as { id?: string }).id === "restored-3"
    )?.[0] as { cols: number; rows: number };
    expect(spawnArgs.rows).not.toBe(51);
    const panel = usePanelStore.getState().panelsById["restored-3"] as PtyPanelData;
    expect(panel.rows).not.toBe(51);
  });

  it("rejects a grid beyond the shared maximum, not just a zero one", async () => {
    // Reachable from legacy or corrupted persisted state, and structurally
    // different from the zero case: every field is a positive integer.
    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "restored-4",
      cwd: "/",
      bypassLimits: true,
      initialTerminalGeometry: { cols: 100_000, rows: 51 },
    });
    await drainMicrotasks();

    expect(await prewarmDims("restored-4")).not.toMatchObject({ cols: 100_000 });
    const panel = usePanelStore.getState().panelsById["restored-4"] as PtyPanelData;
    expect(panel.cols).toBe(80);
    expect(panel.rows).toBe(24);
  });
});
