/**
 * A pane whose terminal its host lost to a restart (#14184) is relaunched in
 * place, on a fresh terminal, and only while it still shows that loss.
 */

import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

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
const { terminalClient } = await import("@/clients");
const spawn = vi.mocked(terminalClient.spawn);
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

async function runningPane(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    cwd: "/repo",
    bypassLimits: true,
    ...extra,
  });
}

function patchPane(id: string, patch: Partial<PtyPanelData>): void {
  usePanelStore.setState((state) => {
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel)) return state;
    return { panelsById: { ...state.panelsById, [id]: { ...panel, ...patch } } };
  });
}

/** As the resync leaves a pane whose terminal the host no longer has. */
function loseTerminal(id: string): void {
  usePanelStore.getState().setRuntimeStatus(id, "exited");
}

function relaunch(id: string, restartKey: number, extra: Record<string, unknown> = {}) {
  return usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    replacesLostTerminal: restartKey,
    launchAgentId: "claude",
    command: "claude --resume sess-1",
    agentSessionId: "sess-1",
    cwd: "/repo",
    title: "Claude",
    bypassLimits: true,
    ...extra,
  });
}

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

describe("addPanel — relaunching a terminal its host lost (#14184)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    spawn.mockReset();
    spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    vi.mocked(terminalInstanceService.destroy).mockClear();
    usePanelLimitStore.setState({ softWarningLimit: 100, confirmationLimit: 200, hardLimit: 300 });
  });

  it("relaunches the pane in place, on a fresh terminal", async () => {
    await runningPane("before");
    await runningPane("lost-1", { launchAgentId: "claude", command: "claude" });
    await runningPane("after");
    await drainMicrotasks();
    loseTerminal("lost-1");
    spawn.mockClear();

    await expect(relaunch("lost-1", 0)).resolves.toBe("lost-1");
    await drainMicrotasks();

    expect(usePanelStore.getState().panelIds).toEqual(["before", "lost-1", "after"]);
    const panel = ptyPanel("lost-1");
    expect(panel?.restartKey).toBe(1);
    expect(panel?.runtimeStatus).not.toBe("exited");
    expect(panel?.agentSessionId).toBe("sess-1");
    expect(terminalInstanceService.destroy).toHaveBeenCalledWith("lost-1");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      id: "lost-1",
      command: "claude --resume sess-1",
    });
  });

  it("drops the relaunch once the pane has been restarted or seen to exit", async () => {
    await runningPane("lost-1", { launchAgentId: "claude", command: "claude" });
    await drainMicrotasks();
    loseTerminal("lost-1");
    // Restarted meanwhile: its restart key moved on.
    patchPane("lost-1", { restartKey: 1 });
    spawn.mockClear();

    await expect(relaunch("lost-1", 0)).resolves.toBeNull();

    await runningPane("exited-1", { launchAgentId: "claude", command: "claude" });
    await drainMicrotasks();
    loseTerminal("exited-1");
    patchPane("exited-1", { exitCode: 0 });
    spawn.mockClear();

    await expect(relaunch("exited-1", 0)).resolves.toBeNull();
    await drainMicrotasks();

    expect(spawn).not.toHaveBeenCalled();
    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });

  it("never relaunches over a pane that is still running", async () => {
    await runningPane("live-1", { launchAgentId: "claude", command: "claude" });
    await drainMicrotasks();
    spawn.mockClear();

    await expect(relaunch("live-1", 0)).resolves.toBeNull();
    await drainMicrotasks();

    expect(spawn).not.toHaveBeenCalled();
    expect(ptyPanel("live-1")?.command).toBe("claude");
  });

  it("holds the pane in place when restore holds it for the user's choice", async () => {
    await runningPane("lost-1", { launchAgentId: "codex", command: "codex" });
    await drainMicrotasks();
    loseTerminal("lost-1");
    spawn.mockClear();

    await expect(
      relaunch("lost-1", 0, {
        launchAgentId: "codex",
        command: "codex",
        agentSessionId: undefined,
        restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
      })
    ).resolves.toBe("lost-1");
    await drainMicrotasks();

    expect(ptyPanel("lost-1")?.restoreRecovery).toEqual({
      reason: "sibling-owns-resume-latest-slot",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
