// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
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
  _reloadHostConnectionSyncForTesting,
  _resetHostConnectionSyncForTesting,
  drivenElsewhereBy,
  resyncFromHost,
  runHostOperation,
  startHostConnectionSync,
  takeOverDrive,
} from "../useHostConnection";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { onHostResync } from "@/store/hostResyncSignal";
import type { resolveUnknownOutcome } from "@/utils/resolveUnknownOutcome";
import {
  _resetTerminalInputGateForTesting,
  getTerminalInputBlock,
} from "@/services/terminal/inputGate";
import {
  _resetHostOwnedWritesForTesting,
  hasDeferredHostOwnedWrite,
  sendHostOwnedWrite,
} from "@/store/persistence/hostOwnedWrites";

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
): DriveLeaseView {
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

/** The options a rehydrate was asked for. */
const optionsOf = (call: unknown[]) =>
  call[1] as { authoritative: boolean; follow?: boolean; isCurrent: () => boolean };

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  _resetHostConnectionSyncForTesting();
  _resetTerminalInputGateForTesting();
  _resetHostOwnedWritesForTesting();
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
    const resyncListener = vi.fn();
    const offResync = onHostResync(resyncListener);
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
    // State kept from host events (dev previews) refetches on every pass.
    expect(resyncListener).toHaveBeenCalledTimes(3);
    offResync();
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
      driverIsHostScreen: false,
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
  it("keeps a remote view read-only until the host answers, then claims the project once the link is up", async () => {
    const { electron, emitHost } = installElectron({ status: "connecting", attempt: 1 });
    // The link is down at open: the claim's lease read and the fallback lookup both go unanswered.
    electron.driveLease.get
      .mockRejectedValueOnce(new Error("[AppError|HOST_DISCONNECTED] down"))
      .mockRejectedValueOnce(new Error("[AppError|HOST_DISCONNECTED] down"));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    // The link is up but the first claim never answered, so ownership is unknown.
    expect(getTerminalInputBlock()).toEqual({ kind: "lease-unknown", hostName: "studio-01" });
    await flush();
    await flush();
    // Opening the project here is taking it over: the claim is retried, not just a lookup.
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(1);
    expect(electron.driveLease.takeOver).toHaveBeenLastCalledWith({
      projectId: "proj-1",
      ifLeaseId: null,
    });
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("moves the project between this machine's own windows without asking", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue({
      ...leaseView(holder({ isHostLocal: false }), false),
      heldByThisClient: true,
    });
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledWith({
      projectId: "proj-1",
      ifLeaseId: 2,
    });
    stop();
  });

  it("reads the lease again when an event lands while it was being read, and takes nothing on the stale read", async () => {
    const { electron, emitLease } = installElectron();
    let answer: (value: unknown) => void = () => {};
    electron.driveLease.get
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue(leaseView(holder({ isHostLocal: false }), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    // Another laptop takes it while the first read is out; that read said nobody held it.
    emitLease({ type: "changed", state: leaseView(holder({ isHostLocal: false }), false) });
    answer(leaseView(null, true));
    await flush();
    expect(electron.driveLease.get).toHaveBeenCalledTimes(2);
    expect(electron.driveLease.takeOver).not.toHaveBeenCalled();
    expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere");
    stop();
  });

  it("leaves a project another machine drives alone on open, offering Take over instead", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue(leaseView(holder({ isHostLocal: false }), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).not.toHaveBeenCalled();
    expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere");
    stop();
  });

  it("takes the project over from the host's own screen when a remote view opens it", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue(leaseView(holder({ isHostLocal: true }), false));
    electron.driveLease.takeOver.mockResolvedValueOnce(leaseView(holder(), true));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    // Only from the holder it read: a Shell that got there first isn't taken from.
    expect(electron.driveLease.takeOver).toHaveBeenCalledWith({
      projectId: "proj-1",
      ifLeaseId: 2,
    });
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("watches when another Shell claimed the project first, keeping what this view holds", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue(leaseView(holder({ isHostLocal: true }), false));
    // The host turned the conditional claim down: shell-a took it between the read and the claim.
    electron.driveLease.takeOver.mockResolvedValueOnce(
      leaseView(holder({ leaseId: 3, clientId: "shell-a", clientName: "shell-a" }), false)
    );
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(1);
    expect(getTerminalInputBlock()).toMatchObject({
      kind: "driven-elsewhere",
      driverName: "shell-a",
    });
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

  it("claims the project once per view, not again when the layout remounts", async () => {
    const { electron } = installElectron();
    bindView("studio-01");
    const first = startHostConnectionSync();
    await flush();
    first();
    // The layout mounts again after hydration; another machine may have taken it meanwhile.
    const second = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(1);
    second();
  });

  it("does not claim again when the view reloads, so a takeover from the host's screen stands", async () => {
    const { electron } = installElectron();
    bindView("studio-01");
    const first = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(1);
    first();
    // The host's own screen takes the project back, then this view reloads.
    electron.driveLease.get.mockResolvedValue(leaseView(holder({ isHostLocal: true }), false));
    _reloadHostConnectionSyncForTesting();
    const second = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(1);
    second();
  });

  it("claims again once a refused claim settles, when the link came up while it was out", async () => {
    const { electron, emitHost } = installElectron({ status: "connecting", attempt: 1 });
    let refuse: (error: Error) => void = () => {};
    electron.driveLease.takeOver.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject))
    );
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(1);
    refuse(new Error("[AppError|HOST_DISCONNECTED] down"));
    await flush();
    await flush();
    expect(electron.driveLease.takeOver).toHaveBeenCalledTimes(2);
    expect(getTerminalInputBlock()).toBeNull();
    stop();
  });

  it("never lets a slower lease lookup override a newer event", async () => {
    const { electron, emitLease } = installElectron();
    bindView("studio-01");
    let answer: (value: unknown) => void = () => {};
    // Every claim is refused, so the view falls back to a lookup, which is slow.
    electron.driveLease.takeOver.mockRejectedValue(new Error("refused"));
    electron.driveLease.get.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.get).toHaveBeenCalled();
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

describe("host-owned saves held through a reconnect", () => {
  it("replays a held save only after the fresh session's rehydrate has finished", async () => {
    const { electron, emitHost } = installElectron();
    // This view's own claim on open stays out, so only the path under test reads state back.
    electron.driveLease.takeOver.mockImplementationOnce(() => new Promise(() => {}));
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
    expect(getTerminalInputBlock()?.kind).toBe("disconnected");

    const send = vi.fn(async () => undefined);
    const replay = vi.fn();
    expect(await sendHostOwnedWrite("app-state:activeWorktreeId", send, replay)).toBe("deferred");

    let finishRehydrate!: () => void;
    rehydrate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishRehydrate = () => resolve(undefined)))
    );
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    await flush();
    expect(replay).not.toHaveBeenCalled();

    finishRehydrate();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it("drops a held save when a reconnect's lease read shows someone else took over", async () => {
    const { electron, emitHost } = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 1 },
    });
    const replay = vi.fn();
    await sendHostOwnedWrite("app-state:mruList", vi.fn(), replay);

    electron.driveLease.get.mockResolvedValue(leaseView(holder(), false));
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    await vi.waitFor(() => expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere"));
    await flush();
    expect(replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:mruList")).toBe(false);
    stop();
  });

  it("taking the project over drops what was held, so the authoritative rehydrate isn't overwritten", async () => {
    const { electron } = installElectron();
    bindView("studio-01");
    // The lease read never answers, so this view's claim on open stays out.
    electron.driveLease.get.mockImplementation(() => new Promise(() => {}));
    const stop = startHostConnectionSync();
    await flush();
    expect(getTerminalInputBlock()?.kind).toBe("lease-unknown");
    const replay = vi.fn();
    await sendHostOwnedWrite("app-state:activeWorktreeId", vi.fn(), replay);

    await takeOverDrive("proj-1");
    await flush();
    expect(getTerminalInputBlock()).toBeNull();
    expect(replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:activeWorktreeId")).toBe(false);
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
  it("reads the host's saved project state back only when the link came back on a fresh session", async () => {
    const { electron, emitHost } = installElectron();
    // This view's own claim on open stays out, so only the path under test reads state back.
    electron.driveLease.takeOver.mockImplementationOnce(() => new Promise(() => {}));
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

    rehydrate.mockClear();
    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reconnected" });
    // Read back by following the driver, never by the resync on its own terms.
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    await resyncFromHost();
    await flush();
    for (const call of rehydrate.mock.calls) {
      expect(optionsOf(call)).toMatchObject({ authoritative: true, follow: true });
    }
    stop();
  });

  it("rehydrates after an explicit disconnect and a new connection", async () => {
    const { electron, emitHost } = installElectron();
    // This view's own claim on open stays out, so only the path under test reads state back.
    electron.driveLease.takeOver.mockImplementationOnce(() => new Promise(() => {}));
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

  it("takes the previous driver's terminals and saved state after taking over", async () => {
    const { electron } = installElectron();
    // This view's own claim on open stays out, so only the path under test reads state back.
    electron.driveLease.takeOver.mockImplementationOnce(() => new Promise(() => {}));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    electron.driveLease.takeOver.mockResolvedValue(leaseView(holder(), true));
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockReset();
    electron.terminal.getForProject.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );

    await takeOverDrive("proj-1");
    await vi.waitFor(() => expect(electron.terminal.getForProject).toHaveBeenCalledWith("proj-1"));
    await flush();
    // The terminals first, so the saved order also places the ones just adopted.
    expect(rehydrate).not.toHaveBeenCalled();
    answer([]);

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    expect(rehydrate.mock.calls[0]![0]).toBe("proj-1");
    const options = optionsOf(rehydrate.mock.calls[0]!);
    expect(options.authoritative).toBe(true);
    expect(options.follow).toBe(true);
    expect(options.isCurrent()).toBe(true);
    stop();
  });

  it("still takes the host's state when its own event about the takeover lands late", async () => {
    const { electron, emitLease } = installElectron();
    electron.driveLease.takeOver.mockImplementationOnce(() => new Promise(() => {}));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    const mine = leaseView(holder({ endpointId: "me" }), true);
    electron.driveLease.takeOver.mockResolvedValue(mine);
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );

    await takeOverDrive("proj-1");
    await vi.waitFor(() => expect(electron.terminal.getForProject).toHaveBeenCalled());
    emitLease({ type: "changed", state: mine });
    answer([]);

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    stop();
  });

  it("reads the host's state after a takeover even when its terminals can't be read", async () => {
    const { electron } = installElectron();
    electron.driveLease.takeOver.mockImplementationOnce(() => new Promise(() => {}));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    electron.driveLease.takeOver.mockResolvedValue(leaseView(holder(), true));
    electron.terminal.getForProject.mockRejectedValue(new Error("link down"));

    await takeOverDrive("proj-1");

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    stop();
  });
});

describe("following the driver while watching (#13280)", () => {
  const followCalls = () => rehydrate.mock.calls.filter((call) => optionsOf(call).follow === true);

  function hostWindow(driving: boolean) {
    const installed = installElectron();
    Object.assign(installed.electron, {
      remoteHosts: { ...installed.electron.remoteHosts, isInUse: vi.fn(async () => true) },
    });
    installed.electron.driveLease.get.mockResolvedValue(leaseView(holder(), driving));
    bindView(null);
    return installed;
  }

  it("shows the host's terminals and layout as soon as the host's own window learns it watches", async () => {
    const { electron } = hostWindow(false);
    const stop = startHostConnectionSync();

    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    expect(electron.terminal.getForProject).toHaveBeenCalledWith("proj-1");
    expect(optionsOf(followCalls()[0]!)).toMatchObject({ authoritative: true, follow: true });
    stop();
  });

  it("reads the panels back each time the host says the driver changed them", async () => {
    const { electron, emitLease } = hostWindow(false);
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    electron.terminal.getForProject.mockClear();

    emitLease({ type: "panels-changed", projectId: "proj-1" });
    await vi.waitFor(() => expect(followCalls()).toHaveLength(2));
    expect(electron.terminal.getForProject).toHaveBeenCalledTimes(1);

    emitLease({ type: "panels-changed", projectId: "another-project" });
    await flush();
    expect(followCalls()).toHaveLength(2);
    stop();
  });

  it("follows nothing while this view drives", async () => {
    const { electron, emitLease } = hostWindow(true);
    const stop = startHostConnectionSync();
    await flush();

    emitLease({ type: "panels-changed", projectId: "proj-1" });
    await flush();

    expect(rehydrate).not.toHaveBeenCalled();
    expect(electron.terminal.getForProject).not.toHaveBeenCalled();
    stop();
  });

  it("still follows the driver's layout when the host's terminals can't be read", async () => {
    const { electron } = hostWindow(false);
    electron.terminal.getForProject.mockRejectedValue(new Error("link down"));
    const stop = startHostConnectionSync();

    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    stop();
  });

  it("gathers notices that land during a pass into one more pass", async () => {
    const { electron, emitLease } = hostWindow(false);
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );

    emitLease({ type: "panels-changed", projectId: "proj-1" });
    await vi.waitFor(() => expect(electron.terminal.getForProject).toHaveBeenCalledTimes(2));
    emitLease({ type: "panels-changed", projectId: "proj-1" });
    emitLease({ type: "panels-changed", projectId: "proj-1" });
    electron.terminal.getForProject.mockResolvedValue([]);
    answer([]);

    // The overtaken pass applies nothing; one follow-up pass reads it all fresh.
    await vi.waitFor(() => expect(followCalls()).toHaveLength(2));
    await flush();
    expect(electron.terminal.getForProject).toHaveBeenCalledTimes(3);
    expect(followCalls()).toHaveLength(2);
    stop();
  });

  it("stops following once the sync is torn down", async () => {
    const { electron } = hostWindow(false);
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(electron.terminal.getForProject).toHaveBeenCalled());

    stop();
    answer([]);
    await flush();

    expect(followCalls()).toHaveLength(0);
  });

  it("drops a pass that a takeover overtook", async () => {
    const { electron, emitLease } = hostWindow(false);
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(electron.terminal.getForProject).toHaveBeenCalled());

    emitLease({ type: "changed", state: leaseView(holder({ isHostLocal: true }), true) });
    answer([]);
    await flush();

    expect(followCalls()).toHaveLength(0);
    stop();
  });
});
