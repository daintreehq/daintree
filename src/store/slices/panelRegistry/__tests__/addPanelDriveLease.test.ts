/**
 * Launches the drive lease blocks (#13913). The host refuses a spawn from a
 * view that doesn't drive the project; the pane waits for control rather than
 * failing, and its launch, the restore's resume included, runs once this view
 * drives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    reconnect: vi.fn(),
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

const isMemoryPressureCriticalMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("@/clients/systemClient", () => ({
  systemClient: { isMemoryPressureCritical: isMemoryPressureCriticalMock },
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
    fetchAndRestore: vi.fn().mockResolvedValue(true),
    get: vi.fn(() => null),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

const PROJECT_ID = "proj-1";

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    __DAINTREE_INITIAL_PROJECT__: { id: PROJECT_ID },
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const clients = await import("@/clients");
const terminalClient = {
  spawn: vi.mocked(clients.terminalClient.spawn),
  reconnect: vi.mocked(clients.terminalClient.reconnect),
  kill: vi.mocked(clients.terminalClient.kill),
};
const { setDriveLeaseSnapshot, _resetTerminalInputGateForTesting } =
  await import("@/services/terminal/inputGate");
const { resetDriveLeaseHoldsForTesting, useDriveLeaseWaitStore } =
  await import("@/store/driveLeaseWaitStore");
const { ClientAppError } = await import("@/utils/clientAppError");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const {
  launchDespiteMemoryPressure,
  panelHoldKey,
  resetMemoryPressureHoldsForTesting,
  useMemoryPressureWaitStore,
} = await import("@/store/memoryPressureWaitStore");

function getPtyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

const spawnedIds = () => terminalClient.spawn.mock.calls.map(([options]) => options.id);

const isWaiting = (id: string) => useDriveLeaseWaitStore.getState().heldPanelIds[id] === true;

function lease(drivingHere: boolean, projectId = PROJECT_ID): DriveLeaseView {
  return {
    projectId,
    holder: {
      leaseId: 1,
      endpointId: drivingHere ? "view-6" : "view-2",
      clientId: drivingHere ? "client-here" : "client-studio",
      clientName: "Greg's Mac Studio",
      isHostLocal: !drivingHere,
      acquiredAt: 1,
    },
    drivingHere,
    isHolderEndpoint: drivingHere,
    viewerIsHostLocal: false,
  };
}

function refusal() {
  return new ClientAppError(
    "DRIVEN_ELSEWHERE",
    "terminal:spawn changes proj-1, which another window drives",
    "Greg's Mac Studio has control of this project. Take control first."
  );
}

/** A cold restore respawning an agent pane with the resume its restore resolved. */
function restoreAgent(requestedId: string, extra: Record<string, unknown> = {}) {
  return usePanelStore.getState().addPanel({
    kind: "terminal",
    launchAgentId: "claude",
    command: "claude --resume session-abc",
    agentSessionId: "session-abc",
    requestedId,
    cwd: "/",
    restore: true,
    bypassLimits: true,
    ...extra,
  });
}

describe("launches the drive lease blocks (#13913)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    _resetTerminalInputGateForTesting();
    resetDriveLeaseHoldsForTesting();
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    terminalClient.reconnect.mockReset();
    terminalClient.reconnect.mockResolvedValue({ exists: false });
    terminalClient.kill.mockClear();
    vi.mocked(terminalInstanceService.fetchAndRestore).mockClear();
    isMemoryPressureCriticalMock.mockReset();
    isMemoryPressureCriticalMock.mockResolvedValue(false);
    resetMemoryPressureHoldsForTesting();
  });

  afterEach(() => {
    resetMemoryPressureHoldsForTesting();
    resetDriveLeaseHoldsForTesting();
    _resetTerminalInputGateForTesting();
  });

  it("waits for control rather than failing when the host refuses the spawn", async () => {
    terminalClient.spawn.mockRejectedValueOnce(refusal());

    await restoreAgent("refused-1");
    await drainMicrotasks();

    const panel = getPtyPanel("refused-1");
    expect(panel?.spawnStatus).toBe("spawning");
    expect(panel?.spawnError).toBeUndefined();
    expect(isWaiting("refused-1")).toBe(true);
  });

  it("runs the restore with its resume once the lease passes to this view", async () => {
    terminalClient.spawn.mockRejectedValueOnce(refusal());
    await restoreAgent("refused-1");
    await drainMicrotasks();
    setDriveLeaseSnapshot(lease(false));
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["refused-1"]);

    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["refused-1", "refused-1"]);
    const retried = terminalClient.spawn.mock.calls[1]![0];
    expect(retried.command).toBe("claude --resume session-abc");
    expect(retried.agentSessionId).toBe("session-abc");
    expect(getPtyPanel("refused-1")?.spawnStatus).toBe("ready");
    expect(isWaiting("refused-1")).toBe(false);
  });

  it("doesn't send a spawn while this view knows it only watches", async () => {
    setDriveLeaseSnapshot(lease(false));

    await restoreAgent("watched-1");
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "shell-1",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(isWaiting("watched-1")).toBe(true);
    expect(isWaiting("shell-1")).toBe(true);

    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["watched-1", "shell-1"]);
  });

  it("ignores a lease for another project", async () => {
    setDriveLeaseSnapshot(lease(false, "other-project"));

    await restoreAgent("free-1");
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["free-1"]);
    expect(isWaiting("free-1")).toBe(false);
  });

  it("keeps waiting through a change of driver that isn't this view", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("waiting-1");
    await drainMicrotasks();

    setDriveLeaseSnapshot({ ...lease(false), holder: { ...lease(false).holder!, leaseId: 2 } });
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(isWaiting("waiting-1")).toBe(true);
  });

  it("spawns once when Retry is pressed while the pane waits", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("retry-1");
    await drainMicrotasks();

    await usePanelStore.getState().restartTerminal("retry-1");
    await drainMicrotasks();
    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(terminalClient.kill).not.toHaveBeenCalled();

    setDriveLeaseSnapshot(lease(true));
    // Pressed again while the released launch is still on its way.
    await usePanelStore.getState().restartTerminal("retry-1");
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["retry-1"]);
    expect(terminalClient.kill).not.toHaveBeenCalled();
  });

  it("attaches to a terminal the driver started under the same id meanwhile", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("adopt-1");
    await drainMicrotasks();

    terminalClient.reconnect.mockResolvedValue({ exists: true, id: "adopt-1", hasPty: true });
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(terminalClient.reconnect).toHaveBeenCalledWith("adopt-1");
    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(getPtyPanel("adopt-1")?.spawnStatus).toBe("ready");
    expect(isWaiting("adopt-1")).toBe(false);
    // What the driver's terminal printed before this pane attached.
    expect(terminalInstanceService.fetchAndRestore).toHaveBeenCalledWith("adopt-1");
  });

  it("spawns rather than attaching to a terminal the host has trashed", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("trashed-on-host-1");
    await drainMicrotasks();

    terminalClient.reconnect.mockResolvedValue({
      exists: true,
      id: "trashed-on-host-1",
      hasPty: true,
      isTrashed: true,
    });
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["trashed-on-host-1"]);
  });

  it("refuses a restart while the released launch is still on its way to the host", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("in-flight-1");
    await drainMicrotasks();

    let finishSpawn: () => void = () => {};
    terminalClient.spawn.mockImplementationOnce(
      ({ id }) =>
        new Promise((resolve) => {
          finishSpawn = () => resolve(id ?? "in-flight-1");
        })
    );
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["in-flight-1"]);

    await usePanelStore.getState().restartTerminal("in-flight-1");
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["in-flight-1"]);
    expect(terminalClient.kill).not.toHaveBeenCalled();

    finishSpawn();
    await drainMicrotasks();
    expect(getPtyPanel("in-flight-1")?.spawnStatus).toBe("ready");
    expect(isWaiting("in-flight-1")).toBe(false);
  });

  it("waits again when control is gone by the time the released launch runs", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("flap-1");
    await drainMicrotasks();

    // The probe is out when another screen takes control back.
    let answerProbe: () => void = () => {};
    terminalClient.reconnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerProbe = () => resolve({ exists: false });
        })
    );
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();
    setDriveLeaseSnapshot(lease(false));
    answerProbe();
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(getPtyPanel("flap-1")?.spawnStatus).toBe("spawning");
    expect(getPtyPanel("flap-1")?.spawnError).toBeUndefined();
    expect(isWaiting("flap-1")).toBe(true);

    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();
    expect(getPtyPanel("flap-1")?.spawnStatus).toBe("ready");
  });

  it("spawns when the host's answer about the id fails", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("probe-fail-1");
    await drainMicrotasks();

    terminalClient.reconnect.mockRejectedValue(new Error("link down"));
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["probe-fail-1"]);
  });

  it("fails as before when the host refuses a view that still reads as driving", async () => {
    setDriveLeaseSnapshot(lease(true));
    terminalClient.spawn.mockRejectedValueOnce(refusal());

    await restoreAgent("disagree-1");
    await drainMicrotasks();

    const panel = getPtyPanel("disagree-1");
    expect(panel?.spawnStatus).toBe("failed");
    expect(panel?.spawnError?.message).toBe(
      "Greg's Mac Studio has control of this project. Take control first."
    );
    expect(isWaiting("disagree-1")).toBe(false);
  });

  it("tries once more at once when control arrived while the refusal travelled", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("crossed-1");
    await drainMicrotasks();

    // The held launch goes out, and the lease moves again before its refusal lands.
    let refuse: () => void = () => {};
    terminalClient.spawn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(refusal());
        })
    );
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();
    setDriveLeaseSnapshot({ ...lease(true), holder: { ...lease(true).holder!, leaseId: 3 } });
    refuse();
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["crossed-1", "crossed-1"]);
    expect(getPtyPanel("crossed-1")?.spawnStatus).toBe("ready");
  });

  it("keeps a restart off the retry of a refusal that crossed control on its way", async () => {
    // Nothing known about the lease yet, so the first attempt goes out unmarked.
    let refuse: () => void = () => {};
    terminalClient.spawn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(refusal());
        })
    );
    await restoreAgent("crossed-2");
    await drainMicrotasks();
    setDriveLeaseSnapshot(lease(true));

    let finishRetry: () => void = () => {};
    terminalClient.spawn.mockImplementationOnce(
      ({ id }) =>
        new Promise((resolve) => {
          finishRetry = () => resolve(id ?? "crossed-2");
        })
    );
    refuse();
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["crossed-2", "crossed-2"]);

    await usePanelStore.getState().restartTerminal("crossed-2");
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["crossed-2", "crossed-2"]);
    expect(terminalClient.kill).not.toHaveBeenCalled();

    finishRetry();
    await drainMicrotasks();
    expect(getPtyPanel("crossed-2")?.spawnStatus).toBe("ready");
    expect(isWaiting("crossed-2")).toBe(false);
  });

  it("puts a released launch closed before its turn back to waiting in the trash", async () => {
    terminalClient.spawn.mockRejectedValueOnce(refusal());
    await restoreAgent("queued-1");
    await drainMicrotasks();
    expect(isWaiting("queued-1")).toBe(true);

    // A shell occupies the queue, so the launch control releases waits behind it.
    let releaseBlocker: () => void = () => {};
    terminalClient.spawn.mockImplementationOnce(async ({ id }) => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      return id ?? "blocker";
    });
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "blocker",
      cwd: "/",
      bypassLimits: true,
    });
    await drainMicrotasks();
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    usePanelStore.getState().trashPanel("queued-1");
    releaseBlocker();
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["queued-1", "blocker"]);
    expect(isWaiting("queued-1")).toBe(true);

    usePanelStore.getState().restoreTerminal("queued-1");
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["queued-1", "blocker", "queued-1"]);
  });

  it("attaches after a memory-pressure wait to a terminal the driver started meanwhile", async () => {
    setDriveLeaseSnapshot(lease(true));
    isMemoryPressureCriticalMock.mockResolvedValue(true);
    await restoreAgent("memory-1");
    await drainMicrotasks();
    expect(terminalClient.spawn).not.toHaveBeenCalled();

    terminalClient.reconnect.mockResolvedValue({ exists: true, id: "memory-1", hasPty: true });
    launchDespiteMemoryPressure(panelHoldKey("memory-1"));
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(getPtyPanel("memory-1")?.spawnStatus).toBe("ready");
  });

  it("keeps a restart off a released launch through a memory-pressure wait", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("memory-2");
    await drainMicrotasks();

    // Control arrives while memory pressure is critical: the launch waits again.
    isMemoryPressureCriticalMock.mockResolvedValue(true);
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();
    expect(useMemoryPressureWaitStore.getState().heldPanelIds["memory-2"]).toBe(true);
    expect(terminalClient.spawn).not.toHaveBeenCalled();

    let finishSpawn: () => void = () => {};
    terminalClient.spawn.mockImplementationOnce(
      ({ id }) =>
        new Promise((resolve) => {
          finishSpawn = () => resolve(id ?? "memory-2");
        })
    );
    launchDespiteMemoryPressure(panelHoldKey("memory-2"));
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["memory-2"]);

    await usePanelStore.getState().restartTerminal("memory-2");
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["memory-2"]);
    expect(terminalClient.kill).not.toHaveBeenCalled();

    finishSpawn();
    await drainMicrotasks();
    expect(getPtyPanel("memory-2")?.spawnStatus).toBe("ready");
    expect(isWaiting("memory-2")).toBe(false);
  });

  it("puts a launch back to its memory wait when it is closed while the host is asked", async () => {
    setDriveLeaseSnapshot(lease(true));
    isMemoryPressureCriticalMock.mockResolvedValue(true);
    await restoreAgent("memory-3");
    await drainMicrotasks();

    let answerProbe: () => void = () => {};
    terminalClient.reconnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerProbe = () => resolve({ exists: false });
        })
    );
    launchDespiteMemoryPressure(panelHoldKey("memory-3"));
    await drainMicrotasks();
    expect(terminalClient.reconnect).toHaveBeenCalledWith("memory-3");

    usePanelStore.getState().trashPanel("memory-3");
    answerProbe();
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(useMemoryPressureWaitStore.getState().heldPanelIds["memory-3"]).toBe(true);
  });

  it("leaves the assistant's launch to fail as before", async () => {
    setDriveLeaseSnapshot(lease(false));

    await restoreAgent("assistant-1", { location: "overlay" });
    await drainMicrotasks();

    expect(spawnedIds()).toEqual(["assistant-1"]);
    expect(isWaiting("assistant-1")).toBe(false);
  });

  it("forgets the wait of a pane whose trash is emptied", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("emptied-1");
    await drainMicrotasks();
    usePanelStore.getState().trashPanel("emptied-1");

    usePanelStore.getState().emptyTrash(["emptied-1"]);
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(isWaiting("emptied-1")).toBe(false);
  });

  it("drops the launch of a pane removed while it waited", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("gone-1");
    await drainMicrotasks();

    usePanelStore.getState().removePanel("gone-1");
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();

    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(isWaiting("gone-1")).toBe(false);
  });

  it("keeps a pane closed while it waited held in the trash, and starts it after an undo", async () => {
    setDriveLeaseSnapshot(lease(false));
    await restoreAgent("trashed-1");
    await drainMicrotasks();

    usePanelStore.getState().trashPanel("trashed-1");
    setDriveLeaseSnapshot(lease(true));
    await drainMicrotasks();
    expect(terminalClient.spawn).not.toHaveBeenCalled();
    expect(isWaiting("trashed-1")).toBe(true);

    usePanelStore.getState().restoreTerminal("trashed-1");
    await drainMicrotasks();
    expect(spawnedIds()).toEqual(["trashed-1"]);
  });
});
