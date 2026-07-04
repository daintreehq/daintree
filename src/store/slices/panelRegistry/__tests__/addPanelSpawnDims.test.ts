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
