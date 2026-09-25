// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { DriveLeaseEvent } from "@shared/types/ipc/driveLease";
import type { DriveLeaseHolder, OperationOutcome } from "@shared/types/remoteHosts";

const { pluginRefresh, updateAgentState, setAgentState, panels } = vi.hoisted(() => ({
  pluginRefresh: vi.fn(),
  updateAgentState: vi.fn(),
  setAgentState: vi.fn(),
  panels: {} as Record<string, unknown>,
}));

vi.mock("@/lib/remoteHosts", () => ({ isRemoteHostsSupported: () => true }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: { getState: () => ({ refresh: pluginRefresh }) },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: panels, updateAgentState }) },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { setAgentState },
}));

import {
  _resetHostConnectionSyncForTesting,
  drivenElsewhereBy,
  resyncFromHost,
  runHostOperation,
  startHostConnectionSync,
} from "../useHostConnection";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import type { resolveUnknownOutcome } from "@/utils/resolveUnknownOutcome";
import {
  _resetTerminalInputGateForTesting,
  getTerminalInputBlock,
} from "@/services/terminal/inputGate";

const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
} as const;

function holder(overrides: Partial<DriveLeaseHolder> = {}): DriveLeaseHolder {
  return {
    leaseId: 2,
    endpointId: "view-9",
    clientId: "client-2",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 1,
    ...overrides,
  };
}

/** The lease as the host reports it to one view. */
function leaseView(
  leaseHolder: DriveLeaseHolder | null,
  drivingHere: boolean,
  projectId = "proj-1"
): DriveLeaseEvent["state"] {
  return {
    projectId,
    holder: leaseHolder,
    drivingHere,
    isHolderEndpoint: false,
    viewerIsHostLocal: false,
  };
}

function installElectron() {
  let hostListener: ((event: RemoteHostsEvent) => void) | null = null;
  let leaseListener: ((event: DriveLeaseEvent) => void) | null = null;
  const electron = {
    remoteHosts: {
      getWindowHost: vi.fn(async () => ({
        hostId: "studio-01",
        descriptor: { id: "studio-01", name: "studio-01" },
        connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
        hostPlatform: "linux",
        hostHomeDir: null,
        hostTmpDir: null,
      })),
      connect: vi.fn(async () => ({ status: "connecting", attempt: 1 })),
      onEvent: vi.fn((callback: (event: RemoteHostsEvent) => void) => {
        hostListener = callback;
        return () => {
          hostListener = null;
        };
      }),
    },
    driveLease: {
      get: vi.fn(async (): Promise<unknown> => {
        throw new Error("[AppError|UNSUPPORTED] not yet");
      }),
      onEvent: vi.fn((callback: (event: DriveLeaseEvent) => void) => {
        leaseListener = callback;
        return () => {
          leaseListener = null;
        };
      }),
    },
    worktree: { refresh: vi.fn(async () => undefined) },
    worktreePort: { request: vi.fn(async () => undefined) },
    terminal: { getForProject: vi.fn(async (): Promise<unknown[]> => []) },
  };
  Object.defineProperty(window, "electron", {
    value: electron,
    writable: true,
    configurable: true,
  });
  return {
    electron,
    emitHost: (event: RemoteHostsEvent) => hostListener?.(event),
    emitLease: (event: DriveLeaseEvent) => leaseListener?.(event),
  };
}

function bindView(hostId: string | null) {
  if (hostId === null) delete window.__DAINTREE_HOST_ID__;
  else window.__DAINTREE_HOST_ID__ = { id: hostId };
  window.__DAINTREE_INITIAL_PROJECT__ = { id: "proj-1" };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  _resetHostConnectionSyncForTesting();
  _resetTerminalInputGateForTesting();
  useHostConnectionStore.getState().reset();
  pluginRefresh.mockClear();
  updateAgentState.mockClear();
  setAgentState.mockClear();
  for (const key of Object.keys(panels)) delete panels[key];
});

afterEach(() => {
  _resetHostConnectionSyncForTesting();
});

describe("host connection sync", () => {
  it("makes no host calls in a window that runs on this machine", async () => {
    const { electron } = installElectron();
    bindView(null);
    const stop = startHostConnectionSync();
    await flush();

    expect(electron.remoteHosts.getWindowHost).not.toHaveBeenCalled();
    expect(electron.remoteHosts.onEvent).not.toHaveBeenCalled();
    expect(electron.driveLease.get).not.toHaveBeenCalled();
    expect(useHostConnectionStore.getState().hostId).toBeNull();
    // An unanswerable lease leaves input with this view.
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("freezes terminal input while the link is down and releases it on reconnect", async () => {
    const { emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    expect(useHostConnectionStore.getState().hostName).toBe("studio-01");
    expect(getTerminalInputBlock()).toBeNull();

    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 1 },
    });
    expect(getTerminalInputBlock()).toEqual({ kind: "disconnected", hostName: "studio-01" });
    expect(useHostConnectionStore.getState().lastSeenAt).not.toBeNull();

    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    expect(getTerminalInputBlock()).toBeNull();
    stop();
    expect(useHostConnectionStore.getState().hostId).toBeNull();
  });

  it("ignores another host's connection changes", async () => {
    const { emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitHost({
      type: "connection-changed",
      hostId: "studio-02",
      connection: { status: "unreachable", lastSeenAt: 1, detail: null },
    });
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("rehydrates once per resync request and coalesces overlapping ones", async () => {
    const { electron, emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    electron.driveLease.get.mockClear();

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reconnected" });
    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reattached" });
    emitHost({ type: "resync-required", hostId: "studio-02", reason: "reconnected" });
    await vi.waitFor(() => expect(electron.worktree.refresh).toHaveBeenCalledTimes(2));
    await resyncFromHost();

    // One pass for the first request, one follow-up for the overlapping one.
    expect(electron.worktree.refresh).toHaveBeenCalledTimes(3);
    expect(electron.worktreePort.request).toHaveBeenCalledWith("reconcile-topology", {
      force: true,
    });
    expect(electron.terminal.getForProject).toHaveBeenCalledWith("proj-1");
    expect(pluginRefresh).toHaveBeenCalledTimes(3);
    expect(electron.driveLease.get).toHaveBeenCalledWith({ projectId: "proj-1" });
    stop();
  });

  it("adopts the host's agent states only where they are newer", async () => {
    const { electron } = installElectron();
    bindView("studio-01");
    panels["t-1"] = { id: "t-1", kind: "terminal", lastStateChange: 10 };
    panels["t-2"] = { id: "t-2", kind: "terminal", lastStateChange: 50 };
    electron.terminal.getForProject.mockResolvedValue([
      { id: "t-1", agentState: "waiting", lastStateChange: 20, waitingReason: "prompt" },
      { id: "t-2", agentState: "working", lastStateChange: 40 },
    ]);

    await resyncFromHost();

    expect(updateAgentState).toHaveBeenCalledTimes(1);
    expect(updateAgentState).toHaveBeenCalledWith(
      "t-1",
      "waiting",
      undefined,
      20,
      undefined,
      undefined,
      "prompt"
    );
    expect(setAgentState).toHaveBeenCalledWith("t-1", "waiting");
  });

  it("locks input when another frontend drives the project and unlocks when it's back", async () => {
    const { emitLease } = installElectron();
    bindView(null);
    const stop = startHostConnectionSync();
    await flush();

    emitLease({ type: "changed", state: leaseView(holder(), false) });
    expect(getTerminalInputBlock()).toEqual({ kind: "driven-elsewhere", driverName: "greg-mbp" });

    emitLease({ type: "changed", state: leaseView(null, true, "other") });
    expect(getTerminalInputBlock()).not.toBeNull();

    // Taken back by this machine: the host says this view drives again.
    emitLease({ type: "changed", state: leaseView(holder({ isHostLocal: true }), true) });
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });
});

describe("lease and reconnect races", () => {
  it("never lets a slower lease lookup override a newer event", async () => {
    const { electron, emitLease } = installElectron();
    bindView("studio-01");
    let answer: (value: unknown) => void = () => {};
    electron.driveLease.get.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const stop = startHostConnectionSync();
    await flush();
    emitLease({ type: "changed", state: leaseView(holder(), false) });
    expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere");
    answer(leaseView(null, true));
    await flush();
    expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere");
    stop();
  });

  it("rehydrates after an explicit disconnect and connect, which main can't announce", async () => {
    const { electron, emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "disconnected" },
    });
    expect(electron.worktree.refresh).not.toHaveBeenCalled();
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    await vi.waitFor(() => expect(electron.worktree.refresh).toHaveBeenCalledTimes(1));
    stop();
  });
});

describe("drivenElsewhereBy", () => {
  it("locks only when a holder exists and the host says this view isn't driving", () => {
    expect(drivenElsewhereBy(null)).toBeNull();
    expect(drivenElsewhereBy(leaseView(null, true))).toBeNull();
    // Another window of the holder's machine still drives.
    expect(drivenElsewhereBy(leaseView(holder(), true))).toBeNull();
    expect(drivenElsewhereBy(leaseView(holder(), false))).toBe("greg-mbp");
    expect(drivenElsewhereBy(leaseView(holder({ isHostLocal: true }), false))).toBe("greg-mbp");
  });
});

describe("runHostOperation", () => {
  const fromResult = (result: unknown) => result;
  const lost = () => new Error("[AppError|OUTCOME_UNKNOWN] link dropped");

  it("resolves a lost answer with the host's result instead of failing", async () => {
    bindView("studio-01");
    useHostConnectionStore.setState({ hostId: "studio-01", hostName: "studio-01" });
    const outcome: OperationOutcome = { status: "succeeded", result: "done", settledAt: 1 };
    let checkingDuring = -1;
    const resolve = vi.fn(async () => {
      checkingDuring = useHostConnectionStore.getState().checking;
      return outcome;
    });

    await expect(
      runHostOperation("op-1", () => Promise.reject(lost()), { resolve, fromResult })
    ).resolves.toBe("done");
    expect(resolve).toHaveBeenCalledWith("op-1", expect.objectContaining({}));
    expect(checkingDuring).toBe(1);
    expect(useHostConnectionStore.getState().checking).toBe(0);
  });

  it("surfaces the host's own failure once it is known", async () => {
    const resolve = vi.fn(async (): Promise<OperationOutcome> => ({
      status: "failed",
      error: { code: null, message: "push rejected" },
      settledAt: 1,
    }));
    await expect(
      runHostOperation("op-1", () => Promise.reject(lost()), { resolve, fromResult })
    ).rejects.toThrow("push rejected");
  });

  it("passes ordinary failures and untracked calls straight through", async () => {
    const resolve = vi.fn();
    await expect(
      runHostOperation("op-1", () => Promise.reject(new Error("boom")), { resolve, fromResult })
    ).rejects.toThrow("boom");
    await expect(
      runHostOperation(undefined, () => Promise.reject(lost()), { resolve, fromResult })
    ).rejects.toThrow("link dropped");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("waits for the link before asking", async () => {
    useHostConnectionStore.setState({
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 1 },
    });
    let waited = false;
    const resolve = vi.fn<typeof resolveUnknownOutcome>(
      async (_opId, options): Promise<OperationOutcome> => {
        const pending = options.waitForConnected().then(() => {
          waited = true;
        });
        await Promise.resolve();
        expect(waited).toBe(false);
        useHostConnectionStore
          .getState()
          .applyConnection({ status: "connected", rttMs: 1, handshake: HANDSHAKE });
        await pending;
        return { status: "succeeded", result: 1, settledAt: 1 };
      }
    );
    await expect(
      runHostOperation("op-1", () => Promise.reject(lost()), {
        resolve,
        fromResult,
      })
    ).resolves.toBe(1);
    expect(waited).toBe(true);
  });
});
