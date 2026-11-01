/**
 * A pane restored from a snapshot that recorded its process's own exit
 * (#15941) commits exited, as the exit left it, and starts nothing.
 */

import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
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

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
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
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

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
const { load: loadTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});
const { usePanelLimitStore } = await import("@/store/panelLimitStore");
const { terminalClient } = await import("@/clients");
const spawn = vi.mocked(terminalClient.spawn);
const terminalInstanceService = (
  await import("@/services/TerminalInstanceService")
).createTerminalPaintPlane();

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

function restoreExited(id: string, restoredExitCode: number) {
  return usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    cwd: "/repo",
    command: "npm run dev",
    title: "Dev server",
    restore: true,
    restoredExitCode,
    bypassLimits: true,
  });
}

describe("addPanel — a restored exit (#15941)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    spawn.mockReset();
    spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    vi.mocked(terminalInstanceService.prewarmTerminal).mockReset();
    usePanelLimitStore.setState({ softWarningLimit: 100, confirmationLimit: 200, hardLimit: 300 });
  });

  it("commits the pane exited with its code and spawns nothing", async () => {
    await restoreExited("dev", 3);
    await drainMicrotasks();

    const panel = ptyPanel("dev");
    expect(panel?.runtimeStatus).toBe("exited");
    expect(panel?.exitCode).toBe(3);
    // Ready, so the pane mounts its terminal as it did when the exit happened.
    expect(panel?.spawnStatus).toBe("ready");
    expect(panel?.command).toBe("npm run dev");
    expect(usePanelStore.getState().panelIds).toContain("dev");
    expect(terminalInstanceService.prewarmTerminal).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps a clean exit's code, since zero is a code", async () => {
    await restoreExited("done", 0);
    await drainMicrotasks();

    expect(ptyPanel("done")?.runtimeStatus).toBe("exited");
    expect(ptyPanel("done")?.exitCode).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("leaves the startup queue free for the launches that follow", async () => {
    await restoreExited("dev-1", 1);
    await restoreExited("dev-2", 2);

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

  it("never marks a live launch that already owns the id as exited", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "dev",
      cwd: "/repo",
      bypassLimits: true,
    });
    await drainMicrotasks();
    expect(spawn).toHaveBeenCalledTimes(1);

    await restoreExited("dev", 3);
    await drainMicrotasks();

    expect(ptyPanel("dev")?.runtimeStatus).not.toBe("exited");
    expect(ptyPanel("dev")?.exitCode).toBeUndefined();
  });

  it("reads a reconnect as the live terminal it attaches to", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "live",
      cwd: "/repo",
      restoredExitCode: 3,
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(ptyPanel("live")?.runtimeStatus).not.toBe("exited");
    expect(ptyPanel("live")?.exitCode).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});
