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

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

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
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => ({ width: 500 }),
  },
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

function makeAttachedManaged(cols: number, rows: number) {
  return {
    terminal: { cols, rows, element: { isConnected: true } },
  };
}

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

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
