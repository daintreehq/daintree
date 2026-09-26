// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { DriveLeaseEvent } from "@shared/types/ipc/driveLease";
import type {
  DriveLeaseHolder,
  HostConnectionState,
  OperationOutcome,
} from "@shared/types/remoteHosts";

const { pluginRefresh, updateAgentState, setAgentState, panels, rehydrate } = vi.hoisted(() => ({
  rehydrate: vi.fn(async (_projectId: string, _options: unknown) => undefined),
  pluginRefresh: vi.fn(),
  updateAgentState: vi.fn(),
  setAgentState: vi.fn(),
  panels: {} as Record<string, unknown>,
}));

vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  isRemoteHostSupported: () => true,
  isEitherRemoteRoleSupported: () => true,
}));
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
vi.mock("@/store/hostProjectRehydrate", () => ({ rehydrateHostProjectState: rehydrate }));

import {
  _resetHostConnectionSyncForTesting,
  drivenElsewhereBy,
  resyncFromHost,
  runHostOperation,
  startHostConnectionSync,
  takeOverDrive,
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

function installElectron(
  windowConnection: HostConnectionState = { status: "connected", rttMs: 5, handshake: HANDSHAKE }
) {
  let hostListener: ((event: RemoteHostsEvent) => void) | null = null;
  let leaseListener: ((event: DriveLeaseEvent) => void) | null = null;
  const electron = {
    remoteHosts: {
      getWindowHost: vi.fn(async () => ({
        hostId: "studio-01",
        descriptor: { id: "studio-01", name: "studio-01" },
        connection: windowConnection,
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
      get: vi.fn(async (): Promise<unknown> => leaseView(null, true)),
      takeOver: vi.fn(async (): Promise<unknown> => leaseView(null, true)),
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
  rehydrate.mockClear();
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
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("asks nothing about the lease for a local view when no host is set up", async () => {
    const { electron } = installElectron();
    Object.assign(electron, {
      remoteHosts: { ...electron.remoteHosts, isInUse: vi.fn(async () => false) },
    });
    bindView(null);
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.get).not.toHaveBeenCalled();
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("treats an unanswerable in-use check as unused", async () => {
    const { electron } = installElectron();
    Object.assign(electron, {
      remoteHosts: {
        ...electron.remoteHosts,
        isInUse: vi.fn(async () => {
          throw new Error("No handler registered");
        }),
      },
    });
    bindView(null);
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.get).not.toHaveBeenCalled();
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("reads the lease a local view opens into once remote hosts are in use", async () => {
    const { electron } = installElectron();
    Object.assign(electron, {
      remoteHosts: { ...electron.remoteHosts, isInUse: vi.fn(async () => true) },
    });
    electron.driveLease.get.mockResolvedValue(leaseView(holder(), false));
    bindView(null);
    const stop = startHostConnectionSync();
    await vi.waitFor(() =>
      expect(getTerminalInputBlock()).toMatchObject({
        kind: "driven-elsewhere",
        driverName: "greg-mbp",
        projectId: "proj-1",
      })
    );
    expect(electron.driveLease.get).toHaveBeenCalledWith({ projectId: "proj-1" });
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
    expect(getTerminalInputBlock()).toEqual({
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
      projectId: "proj-1",
      hostLocal: false,
    });

    emitLease({ type: "changed", state: leaseView(null, true, "other") });
    expect(getTerminalInputBlock()).not.toBeNull();

    // Taken back by this machine: the host says this view drives again.
    emitLease({ type: "changed", state: leaseView(holder({ isHostLocal: true }), true) });
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });
});

describe("lease and reconnect races", () => {
  it("keeps a remote view read-only until the host says who drives", async () => {
    const { electron, emitHost } = installElectron({ status: "connecting", attempt: 1 });
    electron.driveLease.get.mockRejectedValueOnce(new Error("[AppError|HOST_DISCONNECTED] down"));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    // The link is up but the first lookup never answered, so ownership is unknown.
    expect(getTerminalInputBlock()).toEqual({ kind: "lease-unknown", hostName: "studio-01" });
    await flush();
    expect(electron.driveLease.get).toHaveBeenCalledTimes(2);
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("never clears an existing block when a lease refresh fails", async () => {
    const { electron, emitLease } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitLease({ type: "changed", state: leaseView(holder(), false) });
    electron.driveLease.get.mockRejectedValue(new Error("[AppError|HOST_DISCONNECTED] down"));

    await resyncFromHost();

    expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere");
    stop();
  });

  it("hands the project over between two clients, each seeing the other drive", async () => {
    const { electron, emitLease } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    const mine = holder({ clientId: "client-1", clientName: "studio-mbp", endpointId: "view-4" });

    // This client (the one being driven over) takes the project.
    emitLease({ type: "changed", state: leaseView(holder(), false) });
    expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere");
    electron.driveLease.takeOver.mockResolvedValue(leaseView(mine, true));
    await takeOverDrive("proj-1");
    expect(electron.driveLease.takeOver).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(getTerminalInputBlock()).toBeNull();

    // The former driver hears the same takeover as an event about someone else.
    emitLease({ type: "changed", state: leaseView(mine, false) });
    expect(getTerminalInputBlock()).toMatchObject({
      kind: "driven-elsewhere",
      driverName: "studio-mbp",
      projectId: "proj-1",
    });
    stop();
  });

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
    // A real reconnect dials first; the pending resync must survive that.
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 1 },
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

describe("project state after a fresh session or a takeover", () => {
  const optionsOf = (call: unknown[]) =>
    call[1] as { authoritative: boolean; isCurrent: () => boolean };

  it("reads the host's saved project state back only when the link came back on a fresh session", async () => {
    const { emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "overflow" });
    await resyncFromHost();
    expect(rehydrate).not.toHaveBeenCalled();

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reconnected" });
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    expect(rehydrate.mock.calls[0]![0]).toBe("proj-1");
    // This view drives, so what it changed while away isn't overwritten.
    expect(optionsOf(rehydrate.mock.calls[0]!).authoritative).toBe(false);
    stop();
  });

  it("takes the host's layout as it is while another screen drives", async () => {
    const { electron, emitHost } = installElectron();
    bindView("studio-01");
    electron.driveLease.get.mockResolvedValue(leaseView(holder(), false));
    const stop = startHostConnectionSync();
    await flush();

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reconnected" });
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    expect(optionsOf(rehydrate.mock.calls[0]!).authoritative).toBe(true);
    stop();
  });

  it("rehydrates after an explicit disconnect and a new connection", async () => {
    const { emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    const connected = { status: "connected", rttMs: 5, handshake: HANDSHAKE } as const;
    emitHost({ type: "connection-changed", hostId: "studio-01", connection: connected });
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "disconnected" },
    } as RemoteHostsEvent);
    emitHost({ type: "connection-changed", hostId: "studio-01", connection: connected });
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    stop();
  });

  it("takes the previous driver's saved state after taking over", async () => {
    const { electron } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    electron.driveLease.takeOver.mockResolvedValue(leaseView(holder(), true));

    await takeOverDrive("proj-1");

    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(rehydrate.mock.calls[0]![0]).toBe("proj-1");
    const options = optionsOf(rehydrate.mock.calls[0]!);
    expect(options.authoritative).toBe(true);
    expect(options.isCurrent()).toBe(true);
    stop();
  });
});
