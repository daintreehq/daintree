import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDescriptor } from "@shared/types/remoteHosts";

const dispatch = vi.hoisted(() => vi.fn());
const port = vi.hoisted(() => ({ ready: true, listeners: new Set<() => void>() }));
const worktreeClient = vi.hoisted(() => ({
  getAllWithStatus: vi.fn(),
  resourceAction: vi.fn(),
  isPortReady: () => port.ready,
  onPortReady: (listener: () => void) => {
    port.listeners.add(listener);
    return () => port.listeners.delete(listener);
  },
}));
const hostsClient = vi.hoisted(() => ({
  probe: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  connectAndSettle: vi.fn(),
  forget: vi.fn(),
  update: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());
const switches = vi.hoisted(() => ({
  request: vi.fn(),
  current: null as object | null,
}));
const view = vi.hoisted(() => ({
  observable: true,
  cached: false,
  listeners: new Set<() => void>(),
}));
const requestHostUpdate = vi.hoisted(() => vi.fn());
const openHostsSettingsTab = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ worktrees: new Map<string, Record<string, unknown>>() }));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/clients", () => ({ worktreeClient }));
vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: hostsClient }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/components/HostSwitch/hostSwitchRequests", () => ({
  requestHostSwitch: switches.request,
  currentHostSwitchRequest: () => switches.current,
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => view.observable,
  isProjectViewCached: () => view.cached,
  subscribeProjectViewLifecycle: (listener: () => void) => {
    view.listeners.add(listener);
    return () => view.listeners.delete(listener);
  },
}));
vi.mock("@/components/Settings/Hosts/hostUpdateRequests", () => ({ requestHostUpdate }));
vi.mock("@/components/Settings/Hosts/hostSettingsRequests", () => ({ openHostsSettingsTab }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => null }));
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  remoteConnectionKind: () => "ssh",
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => ({ getState: () => store }),
}));

import { openCreatedWorktreeOnMachine } from "../openCreatedWorktreeOnMachine";
import { _resetPendingPlacementsForTesting } from "@/components/Hosts/pendingPlacement";

const WORKTREE_ID = "/repo/wt/feature-x";
const request = {
  worktreeId: WORKTREE_ID,
  projectId: "proj-1",
  environment: "cloud",
  label: "feature/x",
};

/** What the host reports for the worktree; each status run replaces `resourceStatus`. */
let hostRow: Record<string, unknown>;
/** What each status run reports, in order; the last one repeats. */
let statusRuns: Array<Record<string, unknown>>;
/** What each `worktree.waitUntilReady` answers, in order; the last one repeats. */
let setupAnswers: Array<{ setupState: string; timedOut: boolean }>;
/** The fake clock: every wait the handoff makes moves it on. */
let now: number;
const sleeps: number[] = [];

const clock = {
  now: () => now,
  sleep: async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  },
};

function descriptor(id: string, target: string, ownerWorktreeId?: string): HostDescriptor {
  return {
    id,
    name: id,
    connection: { kind: "ssh", target },
    platform: null,
    arch: null,
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled: false,
    assistantControlEnabled: true,
    ...(ownerWorktreeId ? { ownerWorktreeId } : {}),
  };
}

function lastNotice() {
  return notify.mock.calls.at(-1)?.[0] as
    | {
        type: string;
        title: string;
        message: string;
        placement?: string;
        action?: { label: string; onClick: () => void };
      }
    | undefined;
}

/** The store catching up with the host's row, as a worktree-update would. */
function storeCatchesUp(overrides: Record<string, unknown> = {}) {
  store.worktrees.set(WORKTREE_ID, {
    id: WORKTREE_ID,
    worktreeMode: hostRow.worktreeMode,
    resourceStatus: hostRow.resourceStatus,
    generation: 1,
    ...overrides,
  });
}

describe("openCreatedWorktreeOnMachine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPendingPlacementsForTesting();
    now = 0;
    sleeps.length = 0;
    view.observable = true;
    view.cached = false;
    view.listeners.clear();
    port.ready = true;
    port.listeners.clear();
    switches.current = null;
    switches.request.mockReturnValue(1);
    store.worktrees = new Map([
      [WORKTREE_ID, { id: WORKTREE_ID, worktreeMode: "cloud", generation: 1 }],
    ]);
    hostRow = {
      id: WORKTREE_ID,
      path: WORKTREE_ID,
      worktreeMode: "cloud",
      hasStatusCommand: true,
    };
    statusRuns = [{ lastStatus: "ready", ssh: "dt-feature-x" }];
    setupAnswers = [{ setupState: "ready", timedOut: false }];
    dispatch.mockImplementation(async (_id: string, args: { timeoutMs: number }) => {
      const answer = setupAnswers.length > 1 ? setupAnswers.shift()! : setupAnswers[0]!;
      if (answer.timedOut) now += args.timeoutMs;
      return { ok: true, result: answer };
    });
    worktreeClient.getAllWithStatus.mockImplementation(async () => ({
      worktrees: [hostRow],
      gitBacked: true,
    }));
    worktreeClient.resourceAction.mockImplementation(async () => {
      const run = statusRuns.length > 1 ? statusRuns.shift()! : statusRuns[0]!;
      hostRow = { ...hostRow, resourceStatus: { ...run, lastCheckedAt: Date.now() } };
    });
    hostsClient.probe.mockResolvedValue({
      reachable: true,
      sshError: null,
      hostModeListening: true,
    });
    hostsClient.list.mockResolvedValue([]);
    hostsClient.add.mockImplementation(
      async (payload: { name: string; ownerWorktreeId?: string }) =>
        descriptor(payload.name, "dt-feature-x", payload.ownerWorktreeId)
    );
    hostsClient.connectAndSettle.mockResolvedValue({ status: "connected" });
    hostsClient.update.mockResolvedValue({});
    hostsClient.forget.mockResolvedValue(undefined);
  });

  it("waits for setup, asks the box's status, and places the branch on it", async () => {
    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(worktreeClient.resourceAction).toHaveBeenCalledWith(WORKTREE_ID, "status");
    expect(hostsClient.add).toHaveBeenCalledWith({
      name: "dt-feature-x",
      connection: { kind: "ssh", target: "dt-feature-x" },
      ownerWorktreeId: WORKTREE_ID,
    });
    expect(switches.request).toHaveBeenCalledWith({
      toHostId: "dt-feature-x",
      projectId: "proj-1",
      worktreePath: WORKTREE_ID,
      askFirst: false,
    });
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("asks nothing of the box until setup has finished", async () => {
    let finishSetup!: () => void;
    dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSetup = () =>
            resolve({ ok: true, result: { setupState: "ready", timedOut: false } });
        })
    );

    const pending = openCreatedWorktreeOnMachine(request, { clock });
    await vi.waitFor(() => expect(finishSetup).toBeTypeOf("function"));
    await Promise.resolve();
    expect(worktreeClient.getAllWithStatus).not.toHaveBeenCalled();
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();

    finishSetup();
    await expect(pending).resolves.toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("goes by the status run's own answer, never a list read from before it", async () => {
    hostRow = {
      ...hostRow,
      resourceStatus: { lastStatus: "ready", ssh: "old-box", lastCheckedAt: 1 },
    };
    // Main answers the first reads after the run from its earlier list.
    const stale = { ...hostRow };
    let staleReads = 2;
    worktreeClient.getAllWithStatus.mockImplementation(async () => {
      const calls = worktreeClient.resourceAction.mock.calls.length;
      if (calls > 0 && staleReads > 0) {
        staleReads -= 1;
        return { worktrees: [stale], gitBacked: true };
      }
      return { worktrees: [hostRow], gitBacked: true };
    });

    await openCreatedWorktreeOnMachine(request, { clock });

    expect(staleReads).toBe(0);
    expect(hostsClient.probe).toHaveBeenCalledTimes(1);
    expect(hostsClient.probe).toHaveBeenCalledWith({ kind: "ssh", target: "dt-feature-x" });
  });

  it("says so when the status answer never reaches the host's list", async () => {
    worktreeClient.resourceAction.mockResolvedValue(undefined);

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toMatchObject({ status: "error" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
  });

  it("holds the worktree on a box that needs setup and opens that setup", async () => {
    hostsClient.probe.mockResolvedValue({
      reachable: true,
      sshError: null,
      hostModeListening: false,
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(hostsClient.update).toHaveBeenCalledWith({
      hostId: "dt-feature-x",
      pendingPlacement: {
        projectId: "proj-1",
        worktreeId: WORKTREE_ID,
        worktreePath: WORKTREE_ID,
        label: "feature/x",
        requestedAt: expect.any(Number),
      },
    });
    expect(requestHostUpdate).toHaveBeenCalledWith("dt-feature-x", "setup");
    expect(openHostsSettingsTab).toHaveBeenCalled();
    expect(switches.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "setup", hostId: "dt-feature-x" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves the worktree here after a failed provision, touching no host", async () => {
    setupAnswers = [{ setupState: "failed", timedOut: false }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "setup-failed" });
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();
    expect(hostsClient.probe).not.toHaveBeenCalled();
    expect(hostsClient.add).not.toHaveBeenCalled();
    expect(switches.request).not.toHaveBeenCalled();
    expect(lastNotice()).toMatchObject({
      type: "warning",
      title: "Not opened on its machine",
      message: expect.stringContaining("feature/x stays on this machine"),
    });
  });

  it("treats a timed-out setup as one that didn't finish", async () => {
    setupAnswers = [{ setupState: "timed-out", timedOut: false }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "setup-failed" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
  });

  it("reports a setup state it can't read as an error, touching no host", async () => {
    setupAnswers = [{ setupState: "unknown", timedOut: false }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toMatchObject({ status: "error" });
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();
    expect(lastNotice()?.action?.label).toBe("Try again");
  });

  it("reports a wait the action refused, touching no host", async () => {
    dispatch.mockResolvedValue({ ok: false, error: { message: "Worktree not found" } });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "error", message: "Worktree not found" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
  });

  it("re-asks a setup waiting for approval on a timer, says so once, then carries on", async () => {
    setupAnswers = [
      { setupState: "needs-approval", timedOut: false },
      { setupState: "needs-approval", timedOut: false },
      { setupState: "ready", timedOut: false },
    ];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3_000, 3_000]);
    const told = notify.mock.calls.filter(([n]) => n.title === "Waiting to open on its machine");
    expect(told).toHaveLength(1);
  });

  it("says a setup still waiting for approval at the end is waiting for approval", async () => {
    setupAnswers = [{ setupState: "needs-approval", timedOut: false }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock, budgetMs: 10_000 });

    expect(outcome).toEqual({ status: "still-running", awaitingApproval: true });
    expect(lastNotice()?.message).toContain("waiting for you to approve its commands");
    expect(lastNotice()?.action?.label).toBe("Keep waiting");
  });

  it("hands the wait back when setup outlasts the budget, and Keep waiting starts again", async () => {
    setupAnswers = [{ setupState: "running", timedOut: true }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock, budgetMs: 60_000 });

    expect(outcome).toEqual({ status: "still-running", awaitingApproval: false });
    expect(now).toBe(60_000);
    expect(hostsClient.probe).not.toHaveBeenCalled();
    const notice = lastNotice()!;
    expect(notice).toMatchObject({ placement: "grid-bar" });
    expect(notice.action?.label).toBe("Keep waiting");

    const calls = dispatch.mock.calls.length;
    setupAnswers = [{ setupState: "ready", timedOut: false }];
    notice.action!.onClick();
    notice.action!.onClick();
    await vi.waitFor(() => expect(switches.request).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls.length).toBe(calls + 1);
  });

  it("says so when the environment has no status command", async () => {
    hostRow = { ...hostRow, hasStatusCommand: false };

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "no-status-command" });
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();
    expect(lastNotice()?.message).toContain("cloud has no status command");
  });

  it("stops at a ready status that names no machine, with Check again", async () => {
    statusRuns = [{ lastStatus: "ready" }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "no-machine", lastStatus: "ready" });
    expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(1);
    expect(hostsClient.probe).not.toHaveBeenCalled();
    expect(lastNotice()?.action?.label).toBe("Check again");
  });

  it("asks a booting box again every 10 seconds until it names its machine", async () => {
    statusRuns = [
      { lastStatus: "starting" },
      { lastStatus: "starting" },
      { lastStatus: "ready", ssh: "dt-feature-x" },
    ];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("gives up on a box that never says ready, starting no run past two minutes", async () => {
    statusRuns = [{ lastStatus: "starting" }];
    const startedAt: number[] = [];
    const run = worktreeClient.resourceAction.getMockImplementation()!;
    worktreeClient.resourceAction.mockImplementation(async (...args: unknown[]) => {
      startedAt.push(now);
      return run(...args);
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "no-machine", lastStatus: "starting" });
    expect(startedAt).toHaveLength(12);
    expect(Math.max(...startedAt)).toBeLessThan(120_000);
    expect(lastNotice()?.message).toContain('said "starting"');
  });

  it("reports a failed status run, never falling back to a machine named before it", async () => {
    hostRow = {
      ...hostRow,
      resourceStatus: { lastStatus: "ready", ssh: "old-box", lastCheckedAt: 1 },
    };
    worktreeClient.resourceAction.mockRejectedValue(new Error("status exited 1"));

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "error", message: "status exited 1" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
    expect(hostsClient.add).not.toHaveBeenCalled();
    expect(lastNotice()).toMatchObject({
      type: "error",
      title: "Couldn't open on its machine",
      placement: "grid-bar",
      action: { label: "Try again" },
    });
  });

  it("reports a host list it couldn't read rather than taking it for a deletion", async () => {
    worktreeClient.getAllWithStatus.mockResolvedValue({ worktrees: [], gitBacked: null });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toMatchObject({ status: "error" });
    expect(lastNotice()?.type).toBe("error");
  });

  it("stops quietly when the host's list no longer has the worktree", async () => {
    worktreeClient.getAllWithStatus.mockResolvedValue({ worktrees: [], gitBacked: true });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports ssh's refusal from the probe, adding no host", async () => {
    hostsClient.probe.mockResolvedValue({
      reachable: false,
      sshError: "Permission denied (publickey).",
      hostModeListening: false,
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toMatchObject({ status: "error" });
    expect(hostsClient.add).not.toHaveBeenCalled();
    expect(lastNotice()?.message).toContain("Permission denied (publickey).");
  });

  it("waits out a cached view and its port's return before asking the status", async () => {
    view.cached = true;
    port.ready = false;

    const pending = openCreatedWorktreeOnMachine(request, { clock });
    await vi.waitFor(() => expect(view.listeners.size).toBe(1));
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();

    view.cached = false;
    for (const listener of [...view.listeners]) listener();
    await vi.waitFor(() => expect(port.listeners.size).toBe(1));
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();

    port.ready = true;
    for (const listener of [...port.listeners]) listener();
    const outcome = await pending;

    expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(1);
    expect(view.listeners.size).toBe(0);
    expect(port.listeners.size).toBe(0);
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("asks again, a second apart, when the port went away under the status run", async () => {
    worktreeClient.resourceAction
      .mockImplementationOnce(async () => {
        throw new Error("[BrokerError|HOST_EXITED] Worktree port retired");
      })
      .mockImplementationOnce(async () => {
        throw new Error("[BrokerError|HOST_EXITED] Worktree port not ready");
      });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("stops asking after five retries for a port that never comes back, and says so", async () => {
    vi.useFakeTimers();
    try {
      port.ready = false;
      worktreeClient.resourceAction.mockRejectedValue(
        new Error("[BrokerError|HOST_EXITED] Worktree port not ready")
      );

      const pending = openCreatedWorktreeOnMachine(request, { clock });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(worktreeClient.resourceAction).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      const outcome = await pending;

      expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(6);
      expect(port.listeners.size).toBe(0);
      expect(outcome).toMatchObject({ status: "error" });
      expect(lastNotice()?.action?.label).toBe("Try again");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a status command that itself failed", async () => {
    worktreeClient.resourceAction.mockRejectedValue(
      new Error("[BrokerError|TIMEOUT] resource-action timed out")
    );

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "error" });
  });

  it("stops quietly when the worktree is deleted while setup runs", async () => {
    setupAnswers = [
      { setupState: "running", timedOut: true },
      { setupState: "ready", timedOut: false },
    ];
    dispatch.mockImplementationOnce(async () => {
      store.worktrees.delete(WORKTREE_ID);
      return { ok: true, result: { setupState: "running", timedOut: true } };
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("never carries on for a new worktree made at the same path meanwhile", async () => {
    setupAnswers = [
      { setupState: "running", timedOut: true },
      { setupState: "ready", timedOut: false },
    ];
    dispatch.mockImplementationOnce(async () => {
      store.worktrees.set(WORKTREE_ID, { id: WORKTREE_ID, worktreeMode: "cloud", generation: 2 });
      return { ok: true, result: { setupState: "running", timedOut: true } };
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
  });

  it("never takes the host's row for a new worktree made at the same path", async () => {
    hostRow = { ...hostRow, generation: 2 };

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(worktreeClient.resourceAction).not.toHaveBeenCalled();
  });

  it("stops quietly when the worktree is switched to another environment", async () => {
    store.worktrees.set(WORKTREE_ID, { id: WORKTREE_ID, worktreeMode: "gpu" });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stops, taking back the host it added, when the worktree goes Local during the probe", async () => {
    hostsClient.connectAndSettle.mockImplementation(async () => {
      store.worktrees.set(WORKTREE_ID, { id: WORKTREE_ID, generation: 1 });
      return { status: "connected" };
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(hostsClient.forget).toHaveBeenCalledWith("dt-feature-x");
    expect(switches.request).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stops when the box is paused while it connects", async () => {
    hostsClient.connectAndSettle.mockImplementation(async () => {
      // The store has the status run's answer, then the pause that took the target away.
      storeCatchesUp();
      storeCatchesUp({
        resourceStatus: { ...(hostRow.resourceStatus as object), ssh: undefined, pausedAt: 5 },
      });
      return { status: "connected" };
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(switches.request).not.toHaveBeenCalled();
  });

  it("carries on while the store hasn't caught up with the status run", async () => {
    store.worktrees.set(WORKTREE_ID, {
      id: WORKTREE_ID,
      worktreeMode: "cloud",
      generation: 1,
      resourceStatus: { lastStatus: "provisioning", lastCheckedAt: 0 },
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("waits for a row still on its way to the store rather than calling it deleted", async () => {
    store.worktrees.clear();

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("holds the worktree on the host, to ask first, when nobody can see this view", async () => {
    view.observable = false;

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(switches.request).not.toHaveBeenCalled();
    expect(hostsClient.update).toHaveBeenCalledWith({
      hostId: "dt-feature-x",
      pendingPlacement: expect.objectContaining({ worktreeId: WORKTREE_ID, askFirst: true }),
    });
    expect(requestHostUpdate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "waiting", hostId: "dt-feature-x" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("never replaces a switch that started while the box connected", async () => {
    hostsClient.connectAndSettle.mockImplementation(async () => {
      switches.current = { id: 7 };
      return { status: "connected" };
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(switches.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "waiting", hostId: "dt-feature-x" });
  });

  it("stops quietly when the handoff itself is cancelled for a worktree that went", async () => {
    let checks = 0;
    hostsClient.connectAndSettle.mockImplementation(async () => {
      checks += 1;
      store.worktrees.delete(WORKTREE_ID);
      return { status: "connected" };
    });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(checks).toBe(1);
    expect(outcome).toEqual({ status: "gone" });
    expect(hostsClient.forget).toHaveBeenCalledWith("dt-feature-x");
    expect(notify).not.toHaveBeenCalled();
  });
});
