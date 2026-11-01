// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
import type {
  DriveLeaseHolder,
  HostConnectionState,
  OperationOutcome,
} from "@shared/types/remoteHosts";

const {
  pluginRefresh,
  updateAgentState,
  setAgentState,
  setRuntimeStatus,
  reportLost,
  relaunchLost,
  panels,
  rehydrate,
  applyNavigation,
  reporters,
} = vi.hoisted(() => ({
  rehydrate: vi.fn(async (_projectId: string, _options: unknown) => undefined),
  applyNavigation: vi.fn(async (_navigation: unknown, _isCurrent: () => boolean) => undefined),
  reporters: [] as Array<{
    mayReport: () => boolean;
    send: (navigation: unknown) => void;
    reportNow: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  pluginRefresh: vi.fn(),
  updateAgentState: vi.fn(),
  setAgentState: vi.fn(),
  setRuntimeStatus: vi.fn(),
  reportLost: vi.fn(),
  relaunchLost: vi.fn(
    async (
      _projectId: string,
      _lost: ReadonlyMap<string, number>,
      _options: { isCurrent: () => boolean; drives: () => boolean }
    ): Promise<{ deferred: ReadonlyMap<string, number>; relaunched: number; held: number }> => ({
      deferred: new Map(),
      relaunched: 0,
      held: 0,
    })
  ),
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
  usePanelStore: {
    getState: () => ({
      panelsById: panels,
      panelIds: Object.keys(panels),
      watchedPanels: new Set<string>(),
      updateAgentState,
      setRuntimeStatus,
    }),
  },
}));
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = { setAgentState, reportLost };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});
vi.mock("@/store/hostRestartRecovery", () => ({
  relaunchTerminalsLostToHostRestart: relaunchLost,
}));
const noticeUnclean = vi.hoisted(() => vi.fn());
vi.mock("@/store/hostRestartNotice", () => ({ noticeUncleanHostRestart: noticeUnclean }));
const refreshDrafts = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _options: { isCurrent: () => boolean }) => undefined)
);
vi.mock("@/store/hostProjectRehydrate", () => ({
  rehydrateHostProjectState: rehydrate,
  refreshHostDrafts: refreshDrafts,
}));
vi.mock("@/store/hostDriverNavigation", () => ({
  applyDriverNavigation: applyNavigation,
  startDriverNavigationReporter: (options: {
    mayReport: () => boolean;
    send: (navigation: unknown) => void;
  }) => {
    const reporter = { ...options, reportNow: vi.fn(), dispose: vi.fn() };
    reporters.push(reporter);
    return reporter;
  },
}));
// Following the driver loads these lazily. The real module pulls in every IPC
// client and the agent registry, and a cold load from one test's unawaited
// follow pass held the next test's own lazy imports past vi.waitFor's timeout.
vi.mock("@/store/slices/panelRegistry/helpers", () => ({
  deriveRuntimeStatus: () => "running",
}));

import {
  _reloadHostConnectionSyncForTesting,
  _resetHostConnectionSyncForTesting,
  _restartLossesForTesting,
  drivenElsewhereBy,
  resyncFromHost,
  runHostOperation,
  startHostConnectionSync,
  takeOverDrive,
  useHostConnectionSync,
} from "../useHostConnection";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { onHostResync } from "@/store/hostResyncSignal";
import type { resolveUnknownOutcome } from "@/utils/resolveUnknownOutcome";
import {
  _resetTerminalInputGateForTesting,
  getLeaseInputBlock,
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
      reportNavigation: vi.fn(async () => undefined),
      onEvent: vi.fn((callback: (event: DriveLeaseEvent) => void) => {
        leaseListener = callback;
        return () => {
          leaseListener = null;
        };
      }),
    },
    worktree: { refresh: vi.fn(async () => undefined) },
    worktreePort: { request: vi.fn(async () => undefined) },
    terminal: {
      getForProject: vi.fn(async (): Promise<unknown[]> => []),
      reconnectBulk: vi.fn(async (_ids: string[]): Promise<Record<string, unknown>> => ({})),
    },
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
  call[1] as {
    authoritative: boolean;
    follow?: boolean;
    keepActiveWorktree?: boolean;
    isCurrent: () => boolean;
  };

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** This view's claim on open has gone through, so it drives over the state it opened with. */
async function claimed(electron: ReturnType<typeof installElectron>["electron"]) {
  await vi.waitFor(() => expect(electron.driveLease.takeOver).toHaveBeenCalled());
  await vi.waitFor(() => expect(getLeaseInputBlock()).toBeNull());
  await flush();
}

// Adopting a terminal loads this lazily, and cold it can outlast a vi.waitFor
// in whichever test first reaches it.
beforeAll(async () => {
  await import("@/utils/stateHydration/statePatcher");
});

beforeEach(() => {
  _resetHostConnectionSyncForTesting();
  _resetTerminalInputGateForTesting();
  _resetHostOwnedWritesForTesting();
  useHostConnectionStore.getState().reset();
  pluginRefresh.mockClear();
  updateAgentState.mockClear();
  setAgentState.mockClear();
  setRuntimeStatus.mockClear();
  reportLost.mockClear();
  relaunchLost.mockClear();
  rehydrate.mockClear();
  refreshDrafts.mockClear();
  applyNavigation.mockClear();
  reporters.length = 0;
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
    await claimed(electron);
    electron.driveLease.get.mockClear();

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reconnected" });
    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reattached" });
    emitHost({ type: "resync-required", hostId: "studio-02", reason: "reconnected" });
    // The resync and the follow pass this event also starts both load the
    // terminal resync's lazy modules in the same tick, and the module runner
    // holds the second load for about a second: longer than waitFor's default.
    await vi.waitFor(() => expect(electron.worktree.refresh).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
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
      driverAway: false,
    });

    emitLease({ type: "changed", state: { ...leaseView(holder(), false), holderAwayMs: 9_000 } });
    expect(getTerminalInputBlock()).toMatchObject({ driverName: "greg-mbp", driverAway: true });

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
    electron.driveLease.takeOver.mockResolvedValue({
      ...leaseView(holder({ endpointId: "me" }), true),
      isHolderEndpoint: true,
    });
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await claimed(electron);
    expect(electron.driveLease.takeOver).toHaveBeenCalledWith({
      projectId: "proj-1",
      ifLeaseId: 2,
    });
    // This client's own state, which the view opened with: nothing is read back.
    expect(rehydrate).not.toHaveBeenCalled();
    expect(electron.terminal.getForProject).not.toHaveBeenCalled();
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

  it("leaves the project with the host's own screen while someone is using it there", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue({
      ...leaseView(holder({ isHostLocal: true, clientName: "studio-mbp" }), false),
      hostScreenInUse: true,
    });
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).not.toHaveBeenCalled();
    // Named the way this machine knows the host, as the window banner names it.
    expect(getTerminalInputBlock()).toMatchObject({
      kind: "driven-elsewhere",
      driverName: "studio-01",
      driverIsHostScreen: true,
    });
    stop();
  });

  it("doesn't claim a project nobody holds while the host's screen is in use", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue({ ...leaseView(null, true), hostScreenInUse: true });
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await flush();
    expect(electron.driveLease.takeOver).not.toHaveBeenCalled();
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

describe("coming back to drive after someone else drove meanwhile (#13921)", () => {
  /** This view's own lease, as the host reports it to the holder endpoint. */
  const mine = (overrides: Partial<DriveLeaseHolder> = {}): DriveLeaseView => ({
    ...leaseView(
      holder({
        endpointId: "me",
        clientId: "shell-a",
        clientName: "shell-a",
        leaseId: 3,
        tenureId: "tenure-a",
        ...overrides,
      }),
      true
    ),
    isHolderEndpoint: true,
  });

  const authoritativeReads = () =>
    rehydrate.mock.calls.filter((call) => optionsOf(call).authoritative === true);

  /**
   * This view opens the project under `lease`, then its link drops: a dropped
   * link resumes, an explicit disconnect comes back on a fresh session.
   */
  async function openUnder(
    lease: DriveLeaseView,
    drop: "connecting" | "disconnected" = "connecting"
  ) {
    const installed = installElectron();
    installed.electron.driveLease.get.mockResolvedValue(lease);
    installed.electron.driveLease.takeOver.mockResolvedValue(lease);
    bindView("studio-01");
    const stop = startHostConnectionSync();
    // Opening a project it watches reads it back by following the driver;
    // only what follows is under test.
    if (lease.drivingHere) await claimed(installed.electron);
    else await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    await flush();
    rehydrate.mockClear();
    installed.emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: drop === "connecting" ? { status: "connecting", attempt: 1 } : { status: drop },
    } as RemoteHostsEvent);
    return { ...installed, stop };
  }

  async function holdASave(key = "app-state:mruList") {
    const send = vi.fn(async () => undefined);
    const replay = vi.fn();
    expect(await sendHostOwnedWrite(key, send, replay)).toBe("deferred");
    return { send, replay };
  }

  /** The link comes back; a resumed session also says what it missed. */
  async function bringTheLinkBack(emitHost: (event: RemoteHostsEvent) => void, resumed = true) {
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    await flush();
    if (resumed) emitHost({ type: "resync-required", hostId: "studio-01", reason: "reattached" });
  }

  it("drops what it held and reads the host's state back when another client drove meanwhile", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    const held = await holdASave();

    // Another Shell drove and left inside the outage: the host grants the
    // project back under a lease of a new tenure.
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    expect(optionsOf(authoritativeReads()[0]!)).toMatchObject({ follow: true });
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    expect(held.send).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:mruList")).toBe(false);
    stop();
  });

  it("sends none of its own saves until the host's state is read back, and drops the ones it made meanwhile", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    await holdASave();
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    let finishRead!: () => void;
    rehydrate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishRead = () => resolve(undefined)))
    );
    await bringTheLinkBack(emitHost);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));

    // A save made from the stale state, while the host's is still on its way.
    const meanwhile = await holdASave("app-state:activeWorktreeId");
    finishRead();
    await flush();
    await flush();
    expect(meanwhile.send).not.toHaveBeenCalled();
    expect(meanwhile.replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:activeWorktreeId")).toBe(false);

    // Once the host's state is this view's, its saves go out again.
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it("still replays what it held when nobody else took the project (a blip)", async () => {
    const { emitHost, stop } = await openUnder(mine());
    const held = await holdASave();

    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(held.replay).toHaveBeenCalledTimes(1));
    expect(authoritativeReads()).toHaveLength(0);
    stop();
  });

  it("replays its held drafts when the grace ran out with nobody else there (#15918)", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    const held = await holdASave("project-drafts:proj-1");

    // Nobody held the project once the grace ran out, so the host grants it
    // back to this client under a new lease of the same tenure.
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9 }));
    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(held.replay).toHaveBeenCalledTimes(1));
    await flush();
    expect(authoritativeReads()).toHaveLength(0);
    expect(held.send).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("project-drafts:proj-1")).toBe(false);
    stop();
  });

  it("drops its held drafts and reads the host's back when a successor held the project in the gap", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    const held = await holdASave("project-drafts:proj-1");

    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    expect(held.send).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("project-drafts:proj-1")).toBe(false);
    stop();
  });

  it("keeps its own state on a fresh session when the host kept the project for its client", async () => {
    const { electron, emitHost, stop } = await openUnder(mine(), "disconnected");
    const held = await holdASave();

    // A fresh session is a new endpoint and a new lease, but the same tenure.
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, endpointId: "me-again" }));
    await bringTheLinkBack(emitHost, false);

    await vi.waitFor(() => expect(held.replay).toHaveBeenCalledTimes(1));
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(optionsOf(rehydrate.mock.calls[0]!).authoritative).toBe(false);
    stop();
  });

  it("takes the host's state whole on a fresh session after another client drove", async () => {
    const { electron, emitHost, stop } = await openUnder(mine(), "disconnected");
    const held = await holdASave();

    electron.driveLease.get.mockResolvedValue(
      mine({ leaseId: 9, endpointId: "me-again", tenureId: "tenure-b" })
    );
    await bringTheLinkBack(emitHost, false);

    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    await resyncFromHost();
    await flush();
    // The merge-style read a fresh session makes would let this view's stale state win.
    expect(rehydrate.mock.calls.every((call) => optionsOf(call).authoritative)).toBe(true);
    expect(held.replay).not.toHaveBeenCalled();
    stop();
  });

  it("reads the host's state back when it watched as the link dropped and drives once it is back", async () => {
    const other = holder({ endpointId: "theirs", clientId: "shell-b", clientName: "shell-b" });
    const { electron, emitHost, stop } = await openUnder(leaseView(other, false));

    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-c" }));
    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(authoritativeReads().length).toBeGreaterThan(0));
    const read = optionsOf(authoritativeReads().at(-1)!);
    expect(read.follow).toBe(true);
    expect(read.isCurrent()).toBe(true);
    stop();
  });

  it("reads nothing back when its lease moves while the link stays up", async () => {
    const { emitHost, emitLease, stop } = await openUnder(mine());
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    await flush();
    rehydrate.mockClear();

    emitLease({ type: "changed", state: mine({ leaseId: 9, tenureId: "tenure-b" }) });
    await flush();
    expect(rehydrate).not.toHaveBeenCalled();
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");
    stop();
  });

  it("goes by the lease itself against a host that predates tenures", async () => {
    const { electron, emitHost, stop } = await openUnder(mine({ tenureId: undefined }));
    const held = await holdASave();

    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: undefined }));
    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    stop();
  });

  it("still replays after a blip against a host that predates tenures", async () => {
    const { emitHost, stop } = await openUnder(mine({ tenureId: undefined }));
    const held = await holdASave();

    await bringTheLinkBack(emitHost);

    await vi.waitFor(() => expect(held.replay).toHaveBeenCalledTimes(1));
    expect(authoritativeReads()).toHaveLength(0);
    stop();
  });

  it("refreshes the worktrees before reading the host's saved state back", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.worktree.refresh.mockClear();
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));

    await bringTheLinkBack(emitHost, false);

    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    // The last driver may have made the worktree it left active.
    const [refreshed] = electron.worktree.refresh.mock.invocationCallOrder;
    expect(refreshed).toBeLessThan(rehydrate.mock.invocationCallOrder[0]!);
    stop();
  });

  it("keeps holding through a link that drops again before the host answers", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    await holdASave();
    let answerFirst!: (view: DriveLeaseView) => void;
    electron.driveLease.get.mockImplementationOnce(
      () => new Promise<DriveLeaseView>((resolve) => (answerFirst = resolve))
    );
    await bringTheLinkBack(emitHost, false);
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 2 },
    });
    // The first reconnect's answer lands only after the link dropped again.
    answerFirst(mine());
    await flush();

    electron.driveLease.get.mockImplementation(() => new Promise(() => {}));
    await bringTheLinkBack(emitHost, false);
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("deferred");
    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it("lets no save out early when its read-back ends after the link dropped again", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    let finishRead!: () => void;
    rehydrate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishRead = () => resolve(undefined)))
    );
    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    // A save from the stale state, made while the host's is on its way.
    const stale = await holdASave("app-state:activeWorktreeId");

    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 2 },
    });
    const later = await holdASave("app-state:mruList");
    finishRead();
    await flush();
    await flush();
    expect(hasDeferredHostOwnedWrite("app-state:activeWorktreeId")).toBe(false);
    expect(hasDeferredHostOwnedWrite("app-state:mruList")).toBe(false);

    // Back again before the host answers: still held.
    electron.driveLease.get.mockImplementation(() => new Promise(() => {}));
    await bringTheLinkBack(emitHost, false);
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("deferred");
    expect(send).not.toHaveBeenCalled();
    expect(stale.replay).not.toHaveBeenCalled();
    expect(later.replay).not.toHaveBeenCalled();
    stop();
  });

  it("reads the host's state again when the link drops mid read-back and comes back under the same lease", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    let finishFirst!: () => void;
    rehydrate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishFirst = () => resolve(undefined)))
    );
    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));

    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 2 },
    });
    // The host answers before the first read is done: what it read can't
    // vouch for the outage that came after it started.
    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2));
    await flush();
    await flush();
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");

    finishFirst();
    await flush();
    await flush();
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");
    stop();
  });

  it("counts a link first seen down as lost once it knows the lease", async () => {
    const installed = installElectron({ status: "connecting", attempt: 1 });
    const { electron, emitHost } = installed;
    electron.driveLease.get.mockResolvedValue(mine());
    electron.driveLease.takeOver.mockResolvedValue(mine());
    // The claim on open is answered before this window's link state is.
    const windowHost = electron.remoteHosts.getWindowHost.getMockImplementation()!;
    let answerWindowHost!: () => void;
    electron.remoteHosts.getWindowHost.mockImplementationOnce(
      () => new Promise((resolve) => (answerWindowHost = () => resolve(windowHost())))
    );
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await claimed(electron);
    answerWindowHost();
    await vi.waitFor(() => expect(getTerminalInputBlock()?.kind).toBe("disconnected"));
    const held = await holdASave();

    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    await bringTheLinkBack(emitHost);
    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    stop();
  });

  it("keeps saves held through a takeover made while the host's state was owed, until it is read", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    rehydrate.mockRejectedValueOnce(new Error("[AppError|HOST_DISCONNECTED] down"));
    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    await flush();

    electron.driveLease.takeOver.mockResolvedValue(mine({ leaseId: 11, tenureId: "tenure-b" }));
    let finishRead!: () => void;
    rehydrate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishRead = () => resolve(undefined)))
    );
    await takeOverDrive("proj-1");
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2));
    const meanwhile = await holdASave("app-state:activeWorktreeId");
    expect(meanwhile.send).not.toHaveBeenCalled();

    finishRead();
    await flush();
    await flush();
    expect(meanwhile.replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:activeWorktreeId")).toBe(false);
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");
    stop();
  });

  it("reads the host's state back for a claim that hands nothing over while a lost link holds its saves", async () => {
    const { electron, stop } = await openUnder(mine());
    const held = await holdASave();
    electron.driveLease.takeOver.mockResolvedValue(mine());

    await takeOverDrive("proj-1", { ifLeaseId: 3, readBack: false });

    await vi.waitFor(() => expect(authoritativeReads()).toHaveLength(1));
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:mruList")).toBe(false);
    stop();
  });

  it("drops what it held when the view closes before the host said whether it still drives", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    const held = await holdASave();
    electron.driveLease.get.mockImplementation(() => new Promise(() => {}));
    await bringTheLinkBack(emitHost, false);

    stop();
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:mruList")).toBe(false);
  });

  it("counts a read-back whose worktrees couldn't be refreshed as not done", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    electron.worktree.refresh.mockRejectedValueOnce(new Error("link down"));

    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    await flush();
    const meanwhile = await holdASave("app-state:activeWorktreeId");
    expect(meanwhile.send).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    await flush();
    await flush();
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");
    stop();
  });

  it("counts a read-back whose terminals couldn't be read as not done", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    electron.terminal.getForProject.mockRejectedValueOnce(new Error("link down"));

    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    await flush();
    const meanwhile = await holdASave("app-state:activeWorktreeId");
    expect(meanwhile.send).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    await flush();
    await flush();
    const send = vi.fn(async () => undefined);
    expect(await sendHostOwnedWrite("app-state:mruList", send, vi.fn())).toBe("sent");
    stop();
  });

  it("says where it is only once it has read the host's state back", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    let finishRead!: () => void;
    rehydrate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishRead = () => resolve(undefined)))
    );
    const reporter = reporters.at(-1)!;
    reporter.reportNow.mockClear();

    await bringTheLinkBack(emitHost);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    await flush();
    expect(reporter.reportNow).not.toHaveBeenCalled();
    expect(reporter.mayReport()).toBe(false);

    finishRead();
    await vi.waitFor(() => expect(reporter.reportNow).toHaveBeenCalled());
    expect(reporter.mayReport()).toBe(true);
    stop();
  });

  it("keeps its saves held when the host's state can't be read, and asks again on its own", async () => {
    const { electron, emitHost, stop } = await openUnder(mine());
    const held = await holdASave();
    electron.driveLease.get.mockResolvedValue(mine({ leaseId: 9, tenureId: "tenure-b" }));
    rehydrate.mockRejectedValueOnce(new Error("[AppError|HOST_DISCONNECTED] down"));

    await bringTheLinkBack(emitHost, false);
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    await flush();
    const meanwhile = await holdASave("app-state:activeWorktreeId");
    expect(meanwhile.send).not.toHaveBeenCalled();

    // No other event from the host: a quiet link must not leave saves held for good.
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    expect(optionsOf(rehydrate.mock.calls[1]!).authoritative).toBe(true);
    await flush();
    await flush();
    expect(held.replay).not.toHaveBeenCalled();
    expect(meanwhile.replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("app-state:activeWorktreeId")).toBe(false);
    stop();
  });
});

describe("useHostConnectionSync", () => {
  it("holds the sync only while enabled, and once however often it renders", () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockImplementation(() => new Promise(() => {}));
    bindView("studio-01");
    const { rerender, unmount } = renderHook(({ enabled }) => useHostConnectionSync(enabled), {
      initialProps: { enabled: false },
    });
    expect(electron.driveLease.onEvent).not.toHaveBeenCalled();
    expect(getLeaseInputBlock()).toBeNull();

    rerender({ enabled: true });
    rerender({ enabled: true });
    expect(electron.driveLease.onEvent).toHaveBeenCalledTimes(1);
    expect(getLeaseInputBlock()?.kind).toBe("lease-unknown");

    unmount();
    expect(getLeaseInputBlock()).toBeNull();
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
    electron.terminal.getForProject.mockClear();

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
    electron.terminal.getForProject.mockClear();

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

  it("reads the driver's drafts back, and only the drafts, each time the host says they changed (#13283)", async () => {
    const { electron, emitLease } = hostWindow(false);
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    electron.terminal.getForProject.mockClear();
    refreshDrafts.mockClear();

    emitLease({ type: "drafts-changed", projectId: "proj-1" });
    await vi.waitFor(() => expect(refreshDrafts).toHaveBeenCalledTimes(1));
    expect(refreshDrafts.mock.calls[0]![0]).toBe("proj-1");
    expect(followCalls()).toHaveLength(1);
    expect(electron.terminal.getForProject).not.toHaveBeenCalled();

    emitLease({ type: "drafts-changed", projectId: "another-project" });
    await flush();
    expect(refreshDrafts).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads no drafts back while this view drives (#13283)", async () => {
    const { emitLease } = hostWindow(true);
    const stop = startHostConnectionSync();
    await flush();

    emitLease({ type: "drafts-changed", projectId: "proj-1" });
    await flush();

    expect(refreshDrafts).not.toHaveBeenCalled();
    stop();
  });

  it("gathers draft notices that land during a read into one more read (#13283)", async () => {
    const { emitLease } = hostWindow(false);
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    let answer!: () => void;
    refreshDrafts.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (answer = () => resolve(undefined)))
    );

    emitLease({ type: "drafts-changed", projectId: "proj-1" });
    await vi.waitFor(() => expect(refreshDrafts).toHaveBeenCalledTimes(1));
    const firstIsCurrent = refreshDrafts.mock.calls[0]![1];
    emitLease({ type: "drafts-changed", projectId: "proj-1" });
    emitLease({ type: "drafts-changed", projectId: "proj-1" });
    expect(firstIsCurrent.isCurrent()).toBe(false);
    answer();

    await vi.waitFor(() => expect(refreshDrafts).toHaveBeenCalledTimes(2));
    await flush();
    expect(refreshDrafts).toHaveBeenCalledTimes(2);
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

describe("re-reading the host only when the project changed hands (#15900)", () => {
  const followCalls = () => rehydrate.mock.calls.filter((call) => optionsOf(call).follow === true);
  // A pass loads its stores lazily, which takes more than microtasks to reach the host.
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  const mine = (overrides: Partial<DriveLeaseHolder> = {}): DriveLeaseView => ({
    ...leaseView(holder({ endpointId: "me", clientId: "shell-a", leaseId: 3, ...overrides }), true),
    isHolderEndpoint: true,
  });

  /** A remote view that opens a project another laptop drives, so it watches. */
  async function watchAnotherLaptop() {
    const installed = installElectron();
    installed.electron.driveLease.get.mockResolvedValue(leaseView(holder(), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    await flush();
    return { ...installed, stop };
  }

  it("follows nothing more when the host restates the lease as the driver goes away and comes back", async () => {
    const { electron, emitLease, stop } = await watchAnotherLaptop();
    electron.terminal.getForProject.mockClear();

    emitLease({ type: "changed", state: { ...leaseView(holder(), false), holderAwayMs: 9_000 } });
    expect(getTerminalInputBlock()).toMatchObject({ kind: "driven-elsewhere", driverAway: true });
    emitLease({ type: "changed", state: leaseView(holder(), false) });
    expect(getTerminalInputBlock()).toMatchObject({ kind: "driven-elsewhere", driverAway: false });
    await settle();

    expect(followCalls()).toHaveLength(1);
    expect(electron.terminal.getForProject).not.toHaveBeenCalled();
    stop();
  });

  it("follows again when someone else takes the project over", async () => {
    const { emitLease, stop } = await watchAnotherLaptop();

    emitLease({
      type: "changed",
      state: leaseView(
        holder({ leaseId: 4, endpointId: "view-12", clientId: "client-3", clientName: "mini" }),
        false
      ),
    });

    await vi.waitFor(() => expect(followCalls()).toHaveLength(2));
    expect(getTerminalInputBlock()).toMatchObject({ driverName: "mini" });
    stop();
  });

  it("reads the driver's layout once per resync, not again when the resync's lease read lands", async () => {
    const { electron, emitHost, stop } = await watchAnotherLaptop();
    electron.driveLease.get.mockClear();
    electron.terminal.getForProject.mockClear();

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "overflow" });
    await vi.waitFor(() => expect(followCalls()).toHaveLength(2));
    await vi.waitFor(() => expect(electron.driveLease.get).toHaveBeenCalled());
    await settle();

    expect(followCalls()).toHaveLength(2);
    // The resync's own read of the terminals, and the follow pass's.
    expect(electron.terminal.getForProject).toHaveBeenCalledTimes(2);
    stop();
  });

  it("follows once when a refused claim's answer and the host's event name the same driver", async () => {
    const { electron, emitLease } = installElectron();
    const winner = leaseView(
      holder({ leaseId: 3, clientId: "shell-a", clientName: "shell-a" }),
      false
    );
    electron.driveLease.get.mockResolvedValue(leaseView(holder({ isHostLocal: true }), false));
    electron.driveLease.takeOver.mockResolvedValueOnce(winner);
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));

    emitLease({ type: "changed", state: winner });
    await settle();

    expect(followCalls()).toHaveLength(1);
    stop();
  });

  it("moves to where the driver is when a restatement says so, without reading its panels", async () => {
    const { emitLease, stop } = await watchAnotherLaptop();
    const navigation = {
      activeWorktreeId: "wt-2",
      focusedPanelId: null,
      maximize: null,
      focusMode: false,
    };

    emitLease({
      type: "changed",
      state: { ...leaseView(holder(), false), driverNavigation: navigation },
    });

    await vi.waitFor(() => expect(applyNavigation).toHaveBeenCalledTimes(1));
    expect(applyNavigation.mock.calls[0]![0]).toEqual(navigation);
    await settle();
    expect(followCalls()).toHaveLength(1);
    stop();
  });

  it("follows the driver again after an explicit disconnect and connect, which main can't announce", async () => {
    const { emitHost, stop } = await watchAnotherLaptop();
    const connected = { status: "connected", rttMs: 5, handshake: HANDSHAKE } as const;

    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "disconnected" },
    } as RemoteHostsEvent);
    emitHost({ type: "connection-changed", hostId: "studio-01", connection: connected });

    await vi.waitFor(() => expect(followCalls()).toHaveLength(2));
    await settle();
    expect(followCalls()).toHaveLength(2);
    // The fresh session's project state comes from following, never on the resync's own terms.
    expect(rehydrate.mock.calls.every((call) => optionsOf(call).follow === true)).toBe(true);
    stop();
  });

  it("reads nothing back after claiming a project nobody held on open", async () => {
    const { electron } = installElectron();
    electron.driveLease.takeOver.mockResolvedValue(mine());
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() =>
      expect(electron.driveLease.takeOver).toHaveBeenCalledWith({
        projectId: "proj-1",
        ifLeaseId: null,
      })
    );
    const reporter = reporters.at(-1)!;
    // It drives at once over the state it booted with, and says where it is.
    await vi.waitFor(() => expect(reporter.reportNow).toHaveBeenCalled());
    await flush();

    expect(getTerminalInputBlock()).toBeNull();
    expect(rehydrate).not.toHaveBeenCalled();
    expect(electron.terminal.getForProject).not.toHaveBeenCalled();
    expect(reporter.mayReport()).toBe(true);
    stop();
  });

  it("reads nothing back when the project it opens is already its own", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue(mine());
    electron.driveLease.takeOver.mockResolvedValue(mine());
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(electron.driveLease.takeOver).toHaveBeenCalled());
    await vi.waitFor(() => expect(reporters.at(-1)!.reportNow).toHaveBeenCalled());
    await flush();

    expect(rehydrate).not.toHaveBeenCalled();
    expect(electron.terminal.getForProject).not.toHaveBeenCalled();
    stop();
  });

  it("still reads the host's state back after taking the project from the host's idle screen on open", async () => {
    const { electron } = installElectron();
    electron.driveLease.get.mockResolvedValue(leaseView(holder({ isHostLocal: true }), false));
    electron.driveLease.takeOver.mockResolvedValue(mine({ leaseId: 5 }));
    bindView("studio-01");
    const stop = startHostConnectionSync();

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    expect(electron.terminal.getForProject).toHaveBeenCalledWith("proj-1");
    expect(optionsOf(rehydrate.mock.calls[0]!)).toMatchObject({
      authoritative: true,
      follow: true,
    });
    stop();
  });
});

describe("following the driver's navigation (#13281)", () => {
  const navigation = (activeWorktreeId: string) => ({
    activeWorktreeId,
    focusedPanelId: "t1",
    maximize: null,
    focusMode: false,
  });
  const followCalls = () => rehydrate.mock.calls.filter((call) => optionsOf(call).follow === true);

  function hostWindow(lease: DriveLeaseView) {
    const installed = installElectron();
    Object.assign(installed.electron, {
      remoteHosts: { ...installed.electron.remoteHosts, isInUse: vi.fn(async () => true) },
    });
    installed.electron.driveLease.get.mockResolvedValue(lease);
    bindView(null);
    return installed;
  }

  it("moves to where the driver is once its panels are adopted, and again as it moves", async () => {
    const { emitLease } = hostWindow({
      ...leaseView(holder(), false),
      driverNavigation: navigation("wt-1"),
    });
    const stop = startHostConnectionSync();

    await vi.waitFor(() => expect(applyNavigation).toHaveBeenCalledTimes(1));
    expect(applyNavigation.mock.calls[0]![0]).toEqual(navigation("wt-1"));
    // The driver's live worktree wins over the one the host saved, which may predate it.
    expect(optionsOf(followCalls()[0]!)).toMatchObject({ keepActiveWorktree: true });

    emitLease({ type: "navigation-changed", projectId: "proj-1", navigation: navigation("wt-2") });
    await vi.waitFor(() => expect(applyNavigation).toHaveBeenCalledTimes(2));
    expect(applyNavigation.mock.calls[1]![0]).toEqual(navigation("wt-2"));
    // Only a move: the panels aren't read again.
    expect(followCalls()).toHaveLength(1);

    emitLease({ type: "navigation-changed", projectId: "other", navigation: navigation("wt-3") });
    await flush();
    expect(applyNavigation).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps the host's saved worktree when the driver hasn't said where it is", async () => {
    hostWindow(leaseView(holder(), false));
    const stop = startHostConnectionSync();

    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    expect(optionsOf(followCalls()[0]!).keepActiveWorktree).toBe(false);
    await flush();
    expect(applyNavigation).not.toHaveBeenCalled();
    stop();
  });

  it("reports nothing while it watches, and its own moves once it drives", async () => {
    const { electron, emitLease } = hostWindow(leaseView(holder(), false));
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    const reporter = reporters.at(-1)!;
    expect(reporter.mayReport()).toBe(false);

    emitLease({
      type: "changed",
      state: {
        ...leaseView(holder({ leaseId: 5, isHostLocal: true }), true),
        isHolderEndpoint: true,
      },
    });
    expect(reporter.mayReport()).toBe(true);
    expect(reporter.reportNow).toHaveBeenCalled();
    reporter.send(navigation("wt-1"));
    expect(electron.driveLease.reportNavigation).toHaveBeenCalledWith({
      projectId: "proj-1",
      leaseId: 5,
      navigation: navigation("wt-1"),
    });

    // A move the driver made that lands after this view took over is not followed.
    emitLease({ type: "navigation-changed", projectId: "proj-1", navigation: navigation("wt-9") });
    await flush();
    expect(applyNavigation).not.toHaveBeenCalled();
    stop();
    expect(reporter.dispose).toHaveBeenCalled();
  });

  it("starts a takeover from where the driver was, and reports only once it is there", async () => {
    const { electron, emitLease } = installElectron();
    // The claim on open is turned down, so only the takeover under test is in flight.
    electron.driveLease.takeOver.mockResolvedValueOnce(leaseView(holder(), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    // Watching meanwhile, it follows the driver once; that pass is done with.
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    await flush();
    rehydrate.mockClear();
    const reporter = reporters.at(-1)!;
    const mine = {
      ...leaseView(holder({ endpointId: "me", leaseId: 7 }), true),
      isHolderEndpoint: true,
      driverNavigation: navigation("wt-2"),
    };
    electron.driveLease.takeOver.mockResolvedValue(mine);
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockImplementation(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );
    electron.terminal.getForProject.mockClear();

    await takeOverDrive("proj-1");
    await vi.waitFor(() => expect(electron.terminal.getForProject).toHaveBeenCalled());
    // Its own event about the takeover lands while the project is still being read back.
    emitLease({ type: "changed", state: mine });
    await flush();
    expect(reporter.mayReport()).toBe(false);
    expect(reporter.reportNow).not.toHaveBeenCalled();

    answer([]);
    await vi.waitFor(() => expect(applyNavigation).toHaveBeenCalledTimes(1));
    expect(applyNavigation.mock.calls[0]![0]).toEqual(navigation("wt-2"));
    expect(optionsOf(rehydrate.mock.calls[0]!)).toMatchObject({ keepActiveWorktree: true });
    await vi.waitFor(() => expect(reporter.reportNow).toHaveBeenCalled());
    expect(reporter.mayReport()).toBe(true);
    stop();
  });

  it("moves to where the driver was before reporting, when it comes to drive without taking over", async () => {
    const { emitLease } = hostWindow(leaseView(holder(), false));
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(followCalls()).toHaveLength(1));
    const reporter = reporters.at(-1)!;
    let arrived!: () => void;
    applyNavigation.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (arrived = () => resolve(undefined)))
    );

    // The driver left and this window is next.
    emitLease({
      type: "changed",
      state: {
        ...leaseView(holder({ leaseId: 8, isHostLocal: true }), true),
        isHolderEndpoint: true,
        driverNavigation: navigation("wt-2"),
      },
    });
    expect(applyNavigation.mock.calls.at(-1)![0]).toEqual(navigation("wt-2"));
    expect(reporter.mayReport()).toBe(false);
    expect(reporter.reportNow).not.toHaveBeenCalled();

    arrived();
    await vi.waitFor(() => expect(reporter.reportNow).toHaveBeenCalled());
    expect(reporter.mayReport()).toBe(true);
    stop();
  });

  it("still moves to where the driver was when the saved state can't be read after taking over", async () => {
    const { electron } = installElectron();
    electron.driveLease.takeOver.mockResolvedValueOnce(leaseView(holder(), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    await flush();
    const reporter = reporters.at(-1)!;
    applyNavigation.mockClear();
    rehydrate.mockRejectedValueOnce(new Error("link down"));
    electron.driveLease.takeOver.mockResolvedValue({
      ...leaseView(holder({ endpointId: "me", leaseId: 7 }), true),
      isHolderEndpoint: true,
      driverNavigation: navigation("wt-2"),
    });

    await takeOverDrive("proj-1");

    await vi.waitFor(() => expect(applyNavigation).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(reporter.reportNow).toHaveBeenCalled());
    stop();
  });

  it("reports once its own takeover event has landed, even when the answer is lost", async () => {
    const { electron, emitLease } = installElectron();
    electron.driveLease.takeOver.mockResolvedValueOnce(leaseView(holder(), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled());
    await flush();
    const reporter = reporters.at(-1)!;
    let fail!: (error: Error) => void;
    electron.driveLease.takeOver.mockImplementation(
      () => new Promise((_resolve, reject) => (fail = reject))
    );
    const mine = {
      ...leaseView(holder({ endpointId: "me", leaseId: 7 }), true),
      isHolderEndpoint: true,
    };

    const taking = takeOverDrive("proj-1");
    emitLease({ type: "changed", state: mine });
    expect(reporter.reportNow).not.toHaveBeenCalled();
    fail(new Error("answer lost"));
    await expect(taking).rejects.toThrow("answer lost");

    expect(reporter.reportNow).toHaveBeenCalled();
    expect(reporter.mayReport()).toBe(true);
    stop();
  });

  it("still starts from where the driver was when a claim's answer is lost but the host granted it", async () => {
    const { electron, emitLease } = installElectron();
    let fail!: (error: Error) => void;
    // The claim on open, from a view that never watched.
    electron.driveLease.takeOver.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject))
    );
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(electron.driveLease.takeOver).toHaveBeenCalled());
    const reporter = reporters.at(-1)!;
    const granted = {
      ...leaseView(holder({ endpointId: "me", leaseId: 7 }), true),
      isHolderEndpoint: true,
      driverNavigation: navigation("wt-2"),
    };
    // The lease read again after the failed claim says the same.
    electron.driveLease.get.mockResolvedValue(granted);

    emitLease({ type: "changed", state: granted });
    fail(new Error("answer lost"));

    await vi.waitFor(() => expect(applyNavigation).toHaveBeenCalledTimes(1));
    expect(applyNavigation.mock.calls[0]![0]).toEqual(navigation("wt-2"));
    await vi.waitFor(() => expect(reporter.reportNow).toHaveBeenCalled());
    stop();
  });
});

describe("host restart", () => {
  /** A view that opened its project and drives it, its open read-back done. */
  async function drivingView() {
    const host = installElectron();
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await claimed(host.electron);
    return { ...host, stop };
  }

  function runningAgent(id: string, extra: Record<string, unknown> = {}) {
    panels[id] = {
      id,
      kind: "terminal",
      location: "grid",
      launchAgentId: "claude",
      runtimeStatus: "running",
      restartKey: 2,
      ...extra,
    };
  }

  /** The host lists none of this view's terminals and confirms each one gone. */
  function hostHasNone(electron: ReturnType<typeof installElectron>["electron"]) {
    electron.terminal.getForProject.mockResolvedValue([]);
    electron.terminal.reconnectBulk.mockImplementation(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { exists: false }]))
    );
  }

  it("relaunches the panes a host restart took with it, and only those", async () => {
    const { electron, emitHost, stop } = await drivingView();
    runningAgent("t-agent");
    runningAgent("t-done", { exitCode: 0, runtimeStatus: "exited" });
    // Its agent had quit, leaving the shell it ran in: that agent stays quit.
    runningAgent("t-quit", { agentState: "exited" });
    hostHasNone(electron);

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });

    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const [projectId, lost, options] = relaunchLost.mock.calls[0]!;
    expect(projectId).toBe("proj-1");
    expect([...lost]).toEqual([["t-agent", 2]]);
    expect(options.drives()).toBe(true);
    expect(setRuntimeStatus).toHaveBeenCalledWith("t-quit", "exited");
    expect(setRuntimeStatus).not.toHaveBeenCalledWith("t-done", "exited");
    stop();
  });

  it("relaunches nothing when the session only expired and the host stayed up", async () => {
    const { electron, emitHost, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "reconnected" });

    await vi.waitFor(() => expect(reportLost).toHaveBeenCalledWith("t-agent", expect.any(String)));
    // The fresh session's read of the project state; opening read nothing back.
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i += 1) await flush();
    expect(relaunchLost).not.toHaveBeenCalled();
    stop();
  });

  it("leaves the driver's agents to the driver in a view that watches", async () => {
    const { electron, emitHost, emitLease } = installElectron();
    electron.driveLease.get.mockResolvedValue(leaseView(holder(), false));
    electron.driveLease.takeOver.mockResolvedValue(leaseView(holder(), false));
    bindView("studio-01");
    const stop = startHostConnectionSync();
    await vi.waitFor(() => expect(getTerminalInputBlock()?.kind).toBe("driven-elsewhere"));
    runningAgent("t-agent");
    hostHasNone(electron);

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });
    // What it showed were the driver's: there is nothing of its own to bring back.
    expect(_restartLossesForTesting()).toBeNull();

    await vi.waitFor(() => expect(reportLost).toHaveBeenCalledWith("t-agent", expect.any(String)), {
      timeout: 5_000,
    });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(relaunchLost).not.toHaveBeenCalled();

    // Taking the project over later brings back none of the driver's agents.
    emitLease({ type: "changed", state: leaseView(holder({ endpointId: "me" }), true) });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(relaunchLost).not.toHaveBeenCalled();
    stop();
  });

  it("waits for the host to say who drives, and relaunches once it says this view does", async () => {
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connecting", attempt: 1 },
    });
    // Back up, but the host's answer about the lease is lost on its way.
    electron.driveLease.get.mockRejectedValue(new Error("[AppError|HOST_DISCONNECTED] down"));
    emitHost({
      type: "connection-changed",
      hostId: "studio-01",
      connection: { status: "connected", rttMs: 5, handshake: HANDSHAKE },
    });
    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });

    await vi.waitFor(() => expect(reportLost).toHaveBeenCalledWith("t-agent", expect.any(String)), {
      timeout: 5_000,
    });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(relaunchLost).not.toHaveBeenCalled();

    // It says this view drives, under a lease it has to read the host's state back for first.
    const granted = leaseView(holder({ endpointId: "me", tenureId: "tenure-2" }), true);
    electron.driveLease.get.mockResolvedValue(granted);
    emitLease({ type: "changed", state: granted });

    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect([...relaunchLost.mock.calls[0]![1]]).toEqual([["t-agent", 2]]);
    stop();
  });

  it("gives the panes up once the host says another screen drives, even while still finding them", async () => {
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    let answer!: (infos: unknown[]) => void;
    electron.terminal.getForProject.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => (answer = resolve))
    );

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(_restartLossesForTesting()).not.toBeNull();
    // Another screen drives: the restart's panes are its to bring back.
    emitLease({ type: "changed", state: leaseView(holder(), false) });
    expect(_restartLossesForTesting()).toBeNull();

    // Taking the project over afterwards gives them nothing to come back to.
    emitLease({ type: "changed", state: leaseView(holder({ endpointId: "me" }), true) });
    answer([]);
    await vi.waitFor(() => expect(setRuntimeStatus).toHaveBeenCalledWith("t-agent", "exited"), {
      timeout: 5_000,
    });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(_restartLossesForTesting()).toBeNull();
    expect(relaunchLost).not.toHaveBeenCalled();
    stop();
  });

  it("stops a relaunch under way once the host says another screen drives, and keeps nothing for later", async () => {
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    let fail!: (error: Error) => void;
    relaunchLost.mockImplementationOnce(
      () =>
        new Promise<{ deferred: ReadonlyMap<string, number>; relaunched: number; held: number }>(
          (_resolve, reject) => (fail = reject)
        )
    );

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const options = relaunchLost.mock.calls[0]![2];
    expect(options.isCurrent()).toBe(true);

    emitLease({ type: "changed", state: leaseView(holder(), false) });
    expect(options.isCurrent()).toBe(false);
    fail(new Error("[AppError|HOST_DISCONNECTED] down"));
    for (let i = 0; i < 5; i += 1) await flush();
    expect(_restartLossesForTesting()).toBeNull();

    // Taken over later, the view has nothing of the restart's to relaunch.
    emitLease({ type: "changed", state: leaseView(holder({ endpointId: "me" }), true) });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(relaunchLost).toHaveBeenCalledTimes(1);
    stop();
  });

  it("holds what the relaunch had to leave for the host's next word", async () => {
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    // The view stopped driving on the way, so the pane was left.
    relaunchLost.mockResolvedValueOnce({
      deferred: new Map([["t-agent", 2]]),
      relaunched: 0,
      held: 0,
    });

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    for (let i = 0; i < 5; i += 1) await flush();

    emitLease({ type: "changed", state: leaseView(null, true) });

    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(2));
    expect([...relaunchLost.mock.calls[1]![1]]).toEqual([["t-agent", 2]]);
    stop();
  });

  const watchdogEnd = {
    crashCause: "external-kill" as const,
    cause: "watchdog-deadlock" as const,
    watchdogKillReason: "unresponsive-under-pressure" as const,
    at: 1_000,
  };

  it("says what ended the host and what came back, once the relaunch settles", async () => {
    noticeUnclean.mockClear();
    const { electron, emitHost, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    relaunchLost.mockResolvedValueOnce({ deferred: new Map(), relaunched: 1, held: 2 });

    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: watchdogEnd,
    });

    await vi.waitFor(() => expect(noticeUnclean).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(noticeUnclean).toHaveBeenCalledWith(
      { hostId: "studio-01", hostName: "studio-01" },
      "proj-1",
      watchdogEnd,
      { relaunched: 1, held: 2 }
    );
    stop();
  });

  it("stays quiet after a planned restart", async () => {
    noticeUnclean.mockClear();
    const { electron, emitHost, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    relaunchLost.mockResolvedValueOnce({ deferred: new Map(), relaunched: 1, held: 0 });

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });

    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(noticeUnclean).not.toHaveBeenCalled();
    stop();
  });

  it("still says what ended the host when nothing was running to bring back", async () => {
    noticeUnclean.mockClear();
    const { electron, emitHost, stop } = await drivingView();
    hostHasNone(electron);

    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: watchdogEnd,
    });

    await vi.waitFor(() => expect(noticeUnclean).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(noticeUnclean.mock.calls[0]![3]).toEqual({ relaunched: 0, held: 0 });
    expect(relaunchLost).not.toHaveBeenCalled();
    stop();
  });

  it("waits for what a relaunch had to leave, then counts both runs in one notice", async () => {
    noticeUnclean.mockClear();
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    runningAgent("t-other");
    hostHasNone(electron);
    relaunchLost.mockResolvedValueOnce({
      deferred: new Map([["t-other", 2]]),
      relaunched: 3,
      held: 1,
    });
    relaunchLost.mockResolvedValueOnce({ deferred: new Map(), relaunched: 1, held: 1 });

    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: watchdogEnd,
    });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(noticeUnclean).not.toHaveBeenCalled();

    emitLease({ type: "changed", state: leaseView(null, true) });

    await vi.waitFor(() => expect(noticeUnclean).toHaveBeenCalledTimes(1));
    expect(relaunchLost).toHaveBeenCalledTimes(2);
    expect(noticeUnclean.mock.calls[0]![3]).toEqual({ relaunched: 4, held: 2 });
    stop();
  });

  it("lets a relaunch a newer restart overtook say nothing, so the newer word stands", async () => {
    noticeUnclean.mockClear();
    const { electron, emitHost, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    type Outcome = { deferred: ReadonlyMap<string, number>; relaunched: number; held: number };
    let finishFirst!: (outcome: Outcome) => void;
    relaunchLost.mockImplementationOnce(
      () => new Promise<Outcome>((resolve) => (finishFirst = resolve))
    );
    relaunchLost.mockResolvedValueOnce({ deferred: new Map(), relaunched: 0, held: 1 });
    const newerEnd = { ...watchdogEnd, at: 2_000 };

    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: watchdogEnd,
    });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: newerEnd,
    });
    await vi.waitFor(() => expect(noticeUnclean).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    finishFirst({ deferred: new Map(), relaunched: 5, held: 0 });
    for (let i = 0; i < 10; i += 1) await flush();

    expect(noticeUnclean).toHaveBeenCalledTimes(1);
    expect(noticeUnclean.mock.calls[0]![2]).toEqual(newerEnd);
    expect(noticeUnclean.mock.calls[0]![3]).toEqual({ relaunched: 0, held: 1 });
    stop();
  });

  it("keeps the newer restart's word when an overtaken relaunch leaves work behind first", async () => {
    noticeUnclean.mockClear();
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    type Outcome = { deferred: ReadonlyMap<string, number>; relaunched: number; held: number };
    let finishFirst!: (outcome: Outcome) => void;
    let finishSecond!: (outcome: Outcome) => void;
    relaunchLost.mockImplementationOnce(
      () => new Promise<Outcome>((resolve) => (finishFirst = resolve))
    );
    relaunchLost.mockImplementationOnce(
      () => new Promise<Outcome>((resolve) => (finishSecond = resolve))
    );
    relaunchLost.mockResolvedValueOnce({ deferred: new Map(), relaunched: 0, held: 1 });
    const newerEnd = { ...watchdogEnd, at: 2_000 };

    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: watchdogEnd,
    });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    emitHost({
      type: "resync-required",
      hostId: "studio-01",
      reason: "host-restarted",
      previousEnd: newerEnd,
    });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(2), { timeout: 5_000 });

    // The overtaken run leaves a pane for later, then the newer one does too.
    finishFirst({ deferred: new Map([["t-agent", 2]]), relaunched: 0, held: 0 });
    for (let i = 0; i < 5; i += 1) await flush();
    finishSecond({ deferred: new Map([["t-agent", 2]]), relaunched: 2, held: 0 });
    for (let i = 0; i < 5; i += 1) await flush();
    expect(noticeUnclean).not.toHaveBeenCalled();

    emitLease({ type: "changed", state: leaseView(null, true) });

    await vi.waitFor(() => expect(noticeUnclean).toHaveBeenCalledTimes(1));
    expect(noticeUnclean.mock.calls[0]![2]).toEqual(newerEnd);
    expect(noticeUnclean.mock.calls[0]![3]).toEqual({ relaunched: 2, held: 1 });
    stop();
  });

  it("tries again on the host's next word when the relaunch was cut short", async () => {
    const { electron, emitHost, emitLease, stop } = await drivingView();
    runningAgent("t-agent");
    hostHasNone(electron);
    relaunchLost.mockRejectedValueOnce(new Error("[AppError|HOST_DISCONNECTED] down"));

    emitHost({ type: "resync-required", hostId: "studio-01", reason: "host-restarted" });
    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    for (let i = 0; i < 5; i += 1) await flush();

    emitLease({ type: "changed", state: leaseView(null, true) });

    await vi.waitFor(() => expect(relaunchLost).toHaveBeenCalledTimes(2));
    expect([...relaunchLost.mock.calls[1]![1]]).toEqual([["t-agent", 2]]);
    stop();
  });
});
