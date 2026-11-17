import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDescriptor } from "@shared/types/remoteHosts";

const dispatch = vi.hoisted(() => vi.fn());
const worktreeClient = vi.hoisted(() => ({
  getAllWithStatus: vi.fn(),
  resourceAction: vi.fn(),
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
  listeners: new Set<() => void>(),
}));
const view = vi.hoisted(() => ({
  observable: true,
  listeners: new Set<(observable: boolean) => void>(),
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
  subscribeHostSwitchRequests: (listener: () => void) => {
    switches.listeners.add(listener);
    return () => switches.listeners.delete(listener);
  },
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => view.observable,
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
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

/** What the host reports for the worktree; the status command fills in `resourceStatus`. */
let hostRow: Record<string, unknown>;
/** What each status run reports, in order; the last one repeats. */
let statusRuns: Array<Record<string, unknown>>;
/** What each `worktree.waitUntilReady` answers, in order; the last one repeats. */
let setupAnswers: Array<{ setupState: string; timedOut: boolean }>;
let now: number;

const clock = {
  now: () => now,
  sleep: async (ms: number) => {
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

describe("openCreatedWorktreeOnMachine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPendingPlacementsForTesting();
    now = 0;
    view.observable = true;
    view.listeners.clear();
    switches.current = null;
    switches.listeners.clear();
    switches.request.mockReturnValue(1);
    store.worktrees = new Map([[WORKTREE_ID, { id: WORKTREE_ID, worktreeMode: "cloud" }]]);
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
      hostRow = { ...hostRow, resourceStatus: run };
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
  });

  it("waits for setup, asks the box's status, and places the branch on it", async () => {
    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.waitUntilReady",
      expect.objectContaining({ worktreeId: WORKTREE_ID }),
      { source: "user" }
    );
    expect(worktreeClient.resourceAction).toHaveBeenCalledWith(WORKTREE_ID, "status");
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      worktreeClient.resourceAction.mock.invocationCallOrder[0]!
    );
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

  it("asks the status even when the box already named one, and goes by the fresh answer", async () => {
    hostRow = { ...hostRow, resourceStatus: { lastStatus: "ready", ssh: "old-box" } };
    statusRuns = [{ lastStatus: "ready", ssh: "dt-feature-x" }];

    await openCreatedWorktreeOnMachine(request, { clock });

    expect(hostsClient.probe).toHaveBeenCalledWith({ kind: "ssh", target: "dt-feature-x" });
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
      pendingPlacement: expect.objectContaining({
        projectId: "proj-1",
        worktreeId: WORKTREE_ID,
        worktreePath: WORKTREE_ID,
        label: "feature/x",
      }),
    });
    const held = hostsClient.update.mock.calls[0]![0].pendingPlacement;
    expect(held.askFirst).toBeUndefined();
    expect(requestHostUpdate).toHaveBeenCalledWith("dt-feature-x", "setup");
    expect(openHostsSettingsTab).toHaveBeenCalled();
    expect(switches.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "setup", hostId: "dt-feature-x" });
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

  it("waits through a command approval once, then carries on", async () => {
    setupAnswers = [
      { setupState: "needs-approval", timedOut: false },
      { setupState: "needs-approval", timedOut: false },
      { setupState: "running", timedOut: true },
      { setupState: "ready", timedOut: false },
    ];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
    const told = notify.mock.calls.filter(([n]) => n.title === "Waiting to open on its machine");
    expect(told).toHaveLength(1);
  });

  it("hands the wait back when setup outlasts the budget, and Keep waiting starts again", async () => {
    setupAnswers = [{ setupState: "running", timedOut: true }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock, budgetMs: 60_000 });

    expect(outcome).toEqual({ status: "still-running" });
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

  it("asks a booting box again until it names its machine", async () => {
    statusRuns = [
      { lastStatus: "starting" },
      { lastStatus: "starting" },
      { lastStatus: "ready", ssh: "dt-feature-x" },
    ];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(worktreeClient.resourceAction).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("gives up on a box that never says ready, naming what it said", async () => {
    statusRuns = [{ lastStatus: "starting" }];

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "no-machine", lastStatus: "starting" });
    expect(lastNotice()?.message).toContain('said "starting"');
  });

  it("reports a failed status run with Try again, adding no host", async () => {
    worktreeClient.resourceAction.mockRejectedValue(new Error("status exited 1"));

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "error", message: "status exited 1" });
    expect(hostsClient.add).not.toHaveBeenCalled();
    expect(lastNotice()).toMatchObject({
      type: "error",
      title: "Couldn't open on its machine",
      action: { label: "Try again" },
    });
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

  it("stops quietly when the worktree is switched to another environment", async () => {
    store.worktrees.set(WORKTREE_ID, { id: WORKTREE_ID, worktreeMode: "gpu" });

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "gone" });
    expect(hostsClient.probe).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("waits for a row still on its way to the store rather than calling it deleted", async () => {
    store.worktrees.clear();

    const outcome = await openCreatedWorktreeOnMachine(request, { clock });

    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("waits for the view to be seen, then asks before moving the window", async () => {
    view.observable = false;

    const pending = openCreatedWorktreeOnMachine(request, { clock });
    await vi.waitFor(() => expect(view.listeners.size).toBe(1));
    expect(hostsClient.probe).not.toHaveBeenCalled();

    view.observable = true;
    for (const listener of [...view.listeners]) listener(true);
    const outcome = await pending;

    expect(view.listeners.size).toBe(0);
    expect(switches.listeners.size).toBe(0);
    expect(switches.request).toHaveBeenCalledWith(expect.objectContaining({ askFirst: true }));
    expect(outcome).toEqual({ status: "placing", hostId: "dt-feature-x" });
  });

  it("never replaces a switch already under way", async () => {
    switches.current = { id: 7 };

    const pending = openCreatedWorktreeOnMachine(request, { clock });
    await vi.waitFor(() => expect(switches.listeners.size).toBe(1));
    expect(switches.request).not.toHaveBeenCalled();

    switches.current = null;
    for (const listener of [...switches.listeners]) listener();
    await pending;

    expect(switches.request).toHaveBeenCalledWith(expect.objectContaining({ askFirst: true }));
  });
});
