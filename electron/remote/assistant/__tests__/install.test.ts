import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const running = vi.hoisted(
  () =>
    new Map<string, { sessionId: string; terminalId: string; projectViewWebContentsId?: number }>()
);
const sessionEnded = vi.hoisted(() => new Set<(event: unknown) => void>());
/** Which project each of this machine's views shows, by WebContents id. */
const views = vi.hoisted(() => new Map<number, string>());
/** Spawn outcomes the lifecycle ledger recorded, by terminal id. */
const ledger = vi.hoisted(
  () => new Map<string, { generation: number; spawnOk?: boolean; closedAt?: number }>()
);
const runbooksHostState = vi.hoisted(() => ({ read: null as (() => unknown) | null }));
const pty = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const generations = new Map<string, number>();
  return {
    generations,
    listeners,
    client: {
      getLiveGeneration: (id: string) => generations.get(id) ?? null,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off: (event: string, fn: (...args: unknown[]) => void) => listeners.get(event)?.delete(fn),
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
  };
});

vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer }));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getRunningLaneSession: (projectId: string, slot: number) => {
      const run = running.get(`${projectId}:${slot}`);
      return run ? { projectViewWebContentsId: 0, ...run } : null;
    },
    listRunningLanes: () =>
      [...running.keys()].map((key) => {
        const [projectId, slot] = key.split(":");
        return { projectId: projectId!, slot: Number(slot), agentId: "claude", attached: true };
      }),
    addSessionEndedListener: (listener: (event: unknown) => void) => {
      sessionEnded.add(listener);
      return () => sessionEnded.delete(listener);
    },

    addSessionReattachedListener: () => () => {},
    setMessagingReach: () => {},
    setRunbooksHostState: (read: (() => unknown) | null) => {
      runbooksHostState.read = read;
    },
  },
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({ peekDriveLeaseService: () => null }));
vi.mock("../../metrics/hostOps.js", () => ({ callerDrives: () => false }));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => pty.client }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: (id: number) => views.get(id) ?? null,
}));
vi.mock("../../../services/pty/lifecycleLedger.js", () => ({
  getLifecycleLedger: () => ({ getEntry: (id: string) => ledger.get(id) }),
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { getEndpointRegistry } from "../../../ipc/endpointRegistry.js";
import { getRemoteService, registerRemoteService } from "../../runtime.js";
import type { HostProjectViewResult } from "../../client/hostProjectViews.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import type { MovedExchange } from "../AssistantExchangeClient.js";
import type { LaneEnrollment } from "../AssistantMessagingPolicy.js";
import type { ObservedHost } from "../HubMessagingRuntime.js";
import { installAssistantMessagingPolicy, wakeHubForMoved } from "../install.js";

describe("installAssistantMessagingPolicy", () => {
  let hosts: string[];
  let hostListeners: Set<() => void>;
  let uninstall: (() => void) | null = null;

  const install = () =>
    (uninstall = installAssistantMessagingPolicy({
      isHostMessagingEnabled: () => false,
      hasHosts: () => hosts.length > 0,
      onHostsChanged: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    }));
  const hostsChanged = () => {
    for (const listener of [...hostListeners]) listener();
  };
  const pushes = () =>
    broadcastToRenderer.mock.calls
      .filter(([channel]) => channel === CHANNELS.ASSISTANT_MESSAGING_CHANGED)
      .map(([, event]) => (event as { revision: number }).revision);

  beforeEach(() => {
    broadcastToRenderer.mockClear();
    running.clear();
    hosts = [];
    hostListeners = new Set();
    pty.listeners.clear();
    pty.generations.clear();
    sessionEnded.clear();
    views.clear();
    ledger.clear();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  describe("runbook host state (#13411)", () => {
    const observed = (overrides: Partial<ObservedHost> = {}): ObservedHost => ({
      hostId: "studio",
      name: "studio-01",
      assistantMessagingEnabled: true,
      connection: { status: "disconnected" },
      lastSeenAt: null,
      summary: null,
      ...overrides,
    });
    const connected = { status: "connected", rttMs: 12, handshake: {} as never } as const;
    let seen: ObservedHost[] | undefined;
    const installObserving = () =>
      (uninstall = installAssistantMessagingPolicy({
        isHostMessagingEnabled: () => false,
        hasHosts: () => hosts.length > 0,
        onHostsChanged: () => () => {},
        observeHosts: seen === undefined ? undefined : () => seen ?? [],
      }));
    const read = () => runbooksHostState.read?.();

    beforeEach(() => {
      seen = [];
      runbooksHostState.read = null;
    });

    it.skipIf(process.platform === "win32")(
      "reports no hosts, and no lane where nothing here listens as a host",
      () => {
        installObserving();
        expect(read()).toEqual({ hosts: "none", laneReachable: false });
      }
    );

    it.skipIf(process.platform === "win32")(
      "reports a listening host with no hosts of its own as a reachable lane",
      () => {
        const unregisterOutbox = registerRemoteService("assistantHostOutbox", {} as never);
        try {
          installObserving();
          expect(read()).toEqual({ hosts: "none", laneReachable: true });
        } finally {
          unregisterOutbox();
        }
      }
    );

    it("reports hosts as configured until one this Shell messages is connected", () => {
      hosts = ["studio", "attic"];
      seen = [
        observed(),
        observed({ hostId: "attic", assistantMessagingEnabled: false, connection: connected }),
      ];
      installObserving();
      // Having hosts makes this machine their hub, not a lane of theirs.
      expect(read()).toEqual({ hosts: "configured", laneReachable: false });

      seen = [observed({ connection: connected })];
      expect(read()).toEqual({ hosts: "connected", laneReachable: false });

      seen = [];
      expect(read()).toEqual({ hosts: "configured", laneReachable: false });
    });

    it("reports nothing when hosts exist but can't be observed", () => {
      hosts = ["studio"];
      seen = undefined;
      installObserving();
      expect(read()).toBeNull();
    });

    it("stops reporting once uninstalled", () => {
      installObserving();
      expect(runbooksHostState.read).not.toBeNull();
      uninstall?.();
      uninstall = null;
      expect(runbooksHostState.read).toBeNull();
    });
  });

  it("gives enrolled lanes their views back on each session opening, retrying until windows are back (#13392)", async () => {
    vi.useFakeTimers();
    try {
      let opened: (hostId: string) => void = () => {};
      let startEnabled = true;
      const prepared: string[] = [];
      const answers: HostProjectViewResult[] = [{ status: "no-window" }];
      const unregisterClient = registerRemoteService("assistantExchangeClient", {
        listOwnLanes: async () => ({
          lanes: [{ projectId: "p1", slot: 0, generation: "g", available: true }],
        }),
      } as never);
      uninstall = installAssistantMessagingPolicy({
        isHostMessagingEnabled: () => true,
        hasHosts: () => true,
        onHostsChanged: () => () => {},
        isHostStartEnabled: () => startEnabled,
        onHostSessionOpened: (listener) => {
          opened = listener;
          return () => {};
        },
        hostAssistants: {
          projectPath: async () => "/repos/p1",
          prepareView: async (_hostId, projectId) => {
            prepared.push(projectId);
            return answers.shift() ?? { status: "ready", webContentsId: 5, created: false };
          },
          dispatch: async () => ({ ok: true, result: null }),
          invoke: async () => ({ isHolderEndpoint: true, holder: { leaseId: 1 } }),
        },
      });

      opened("studio-01");
      await vi.advanceTimersByTimeAsync(3_000);
      // The window on that host wasn't back yet: tried again later, then left alone.
      expect(prepared).toEqual(["p1"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(prepared).toEqual(["p1", "p1"]);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(prepared).toHaveLength(2);

      // Without the person's start consent, nothing is restored.
      startEnabled = false;
      opened("studio-01");
      await vi.advanceTimersByTimeAsync(200_000);
      expect(prepared).toHaveLength(2);

      // Nor once uninstalled, with a round already scheduled.
      startEnabled = true;
      opened("studio-01");
      uninstall();
      uninstall = null;
      await vi.advanceTimersByTimeAsync(200_000);
      expect(prepared).toHaveLength(2);
      unregisterClient();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes once on install, so a view that read it as missing reads it again", () => {
    install();
    expect(pushes()).toEqual([1]);
    expect(getRemoteService("assistantMessagingSurface")?.revision()).toBe(1);
  });

  it("pushes a fresh revision on every policy change", () => {
    install();
    getRemoteService("assistantMessagingPolicy")!.setPaused(true);
    running.set("proj:0", { sessionId: "s1", terminalId: "t1" });
    pty.generations.set("t1", 1);
    getRemoteService("assistantMessagingPolicy")!.enroll(
      { projectId: "proj", slot: 0 },
      { kind: "local" }
    );
    expect(pushes()).toEqual([1, 2, 3]);
  });

  it("pushes only when the first host arrives or the last one goes", () => {
    install();
    expect(getRemoteService("assistantMessagingSurface")?.hasHosts()).toBe(false);
    hosts = ["a"];
    hostsChanged();
    hosts = ["a", "b"];
    hostsChanged();
    hosts = [];
    hostsChanged();
    expect(pushes()).toEqual([1, 2, 3]);
  });

  it("ends an enrollment whose PTY was relaunched in place as soon as it spawns", () => {
    install();
    running.set("proj:0", { sessionId: "s1", terminalId: "t1" });
    pty.generations.set("t1", 1);
    const policy = getRemoteService("assistantMessagingPolicy")!;
    policy.enroll({ projectId: "proj", slot: 0 }, { kind: "remote", linkSessionId: "link" });
    expect(pushes()).toEqual([1, 2]);
    pty.generations.set("t1", 2);
    pty.emit("spawn-result", "t1", { success: true, id: "t1" });
    expect(pushes()).toEqual([1, 2, 3]);
    expect(policy.getEnded({ projectId: "proj", slot: 0 })?.reason).toBe("relaunched");
  });

  it("tells a lane's new run what other machines sent the run before, once it spawns (#13467)", () => {
    install();
    running.set("proj:0", { sessionId: "s1", terminalId: "t1" });
    pty.generations.set("t1", 1);
    const reannounce = vi.spyOn(getRemoteService("assistantMessagingRuntime")!, "reannounce");
    pty.emit("spawn-result", "t-not-a-lane", { success: true, id: "t-not-a-lane" });
    pty.emit("spawn-result", "t1", { success: false, id: "t1" });
    expect(reannounce).not.toHaveBeenCalled();
    pty.generations.set("t1", 2);
    pty.emit("spawn-result", "t1", { success: true, id: "t1" });
    expect(reannounce).toHaveBeenCalledWith({ projectId: "proj", slot: 0 });
  });

  it("unregisters both services and stops listening on teardown", () => {
    install();
    uninstall!();
    uninstall = null;
    expect(getRemoteService("assistantMessagingPolicy")).toBeUndefined();
    expect(getRemoteService("assistantMessagingSurface")).toBeUndefined();
    expect(hostListeners.size).toBe(0);
    expect(pty.listeners.get("spawn-result")?.size ?? 0).toBe(0);
    expect(pty.listeners.get("exit")?.size ?? 0).toBe(0);
    expect(sessionEnded.size).toBe(0);
    hosts = ["a"];
    hostsChanged();
    expect(pushes()).toEqual([1]);
  });
});

describe("installAssistantMessagingPolicy applying the saved default (#13441)", () => {
  let accepts: boolean;
  let messagingHost: boolean;
  let defaultListeners: Set<() => void>;
  let uninstall: (() => void) | null = null;
  const endpoints: Array<() => void> = [];

  const install = () =>
    (uninstall = installAssistantMessagingPolicy({
      isHostMessagingEnabled: () => true,
      hasHosts: () => true,
      onHostsChanged: () => () => {},
      acceptsByDefault: () => accepts,
      onDefaultChanged: (listener) => {
        defaultListeners.add(listener);
        return () => defaultListeners.delete(listener);
      },
      hasMessagingHost: () => messagingHost,
    }));
  const policy = () => getRemoteService("assistantMessagingPolicy")!;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  /**
   * A run in the view `view` (positive ids are this machine's own views),
   * spawned unless `pending`, which leaves it waiting on the pty-host's answer.
   */
  const start = (lane: string, sessionId: string, view: number, pending = false) => {
    const terminalId = `t-${sessionId}`;
    running.set(lane, { sessionId, terminalId, projectViewWebContentsId: view });
    pty.generations.set(terminalId, 1);
    ledger.set(terminalId, pending ? { generation: 1 } : { generation: 1, spawnOk: true });
    if (!pending) {
      pty.emit("spawn-result", terminalId, { success: true, id: terminalId, launchGeneration: 1 });
    }
  };
  const nudge = () => {
    for (const listener of [...defaultListeners]) listener();
  };

  beforeEach(() => {
    broadcastToRenderer.mockClear();
    running.clear();
    pty.listeners.clear();
    pty.generations.clear();
    sessionEnded.clear();
    views.clear();
    ledger.clear();
    accepts = true;
    messagingHost = true;
    defaultListeners = new Set();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    for (const remove of endpoints.splice(0)) remove();
  });

  it("makes a run in this machine's own view the hub once it has spawned", async () => {
    views.set(11, "proj");
    install();
    start("proj:0", "s1", 11, true);
    nudge();
    await settle();
    expect(policy().getHub()).toBeNull();
    pty.emit("spawn-result", "t-s1", { success: true, id: "t-s1", launchGeneration: 1 });
    await settle();
    expect(policy().getHub()).toMatchObject({ projectId: "proj", slot: 0, sessionId: "s1" });
  });

  it("never gives the hub to a spawn that failed, and gives it to the next run instead", async () => {
    views.set(11, "proj");
    install();
    start("proj:0", "s1", 11, true);
    // The pty-host refused it: the pending entry goes, the lane stays bound.
    pty.generations.delete("t-s1");
    ledger.set("t-s1", { generation: 1, spawnOk: false, closedAt: 1 });
    pty.emit("spawn-result", "t-s1", { success: false, id: "t-s1", launchGeneration: 1 });
    await settle();
    expect(policy().getHub()).toBeNull();
    start("proj:1", "s2", 11);
    await settle();
    expect(policy().getHub()).toMatchObject({ slot: 1 });
  });

  it("keeps a run's spawn when a duplicate spawn of the same terminal is refused", async () => {
    views.set(11, "proj");
    accepts = false;
    install();
    start("proj:0", "s1", 11);
    // The ledger now describes the refused attempt; the first one is still the live run.
    ledger.set("t-s1", { generation: 2, spawnOk: false, closedAt: 1 });
    pty.emit("spawn-result", "t-s1", { success: false, id: "t-s1", launchGeneration: 2 });
    accepts = true;
    nudge();
    await settle();
    expect(policy().getHub()).toMatchObject({ slot: 0, launchGeneration: 1 });
  });

  it("leaves a run alone whose view shows another project, or is no view of this machine", async () => {
    views.set(11, "other");
    install();
    start("proj:0", "s1", 11);
    start("proj:1", "s2", 12);
    await settle();
    expect(policy().listEnrollments()).toEqual([]);
  });

  it("waits for the saved default and a host with messaging on, then applies them", async () => {
    views.set(11, "proj");
    accepts = false;
    messagingHost = false;
    install();
    start("proj:0", "s1", 11);
    await settle();
    expect(policy().getHub()).toBeNull();
    accepts = true;
    nudge();
    await settle();
    // Still no host to hear from.
    expect(policy().getHub()).toBeNull();
    messagingHost = true;
    nudge();
    await settle();
    expect(policy().getHub()).not.toBeNull();
  });

  it("gives the hub to a sibling once the hub the person turned off stops", async () => {
    views.set(11, "proj");
    install();
    start("proj:0", "s1", 11);
    start("proj:1", "s2", 11);
    await settle();
    const hub = policy().getHub();
    expect(hub).toMatchObject({ slot: 0 });
    policy().unenroll({ projectId: "proj", slot: 0 }, { kind: "local" }, hub!.generation, {
      decline: true,
    });
    await settle();
    expect(policy().getHub()).toBeNull();

    running.delete("proj:0");
    for (const listener of [...sessionEnded]) {
      listener({ projectId: "proj", slot: 0, sessionId: "s1", reason: "revoked" });
    }
    await settle();
    expect(policy().getHub()).toMatchObject({ slot: 1 });
  });

  it("enrolls a run in a remote Shell's open view for that Shell once it proved its sender", async () => {
    const endpoint = {
      endpointId: "remote-1",
      clientId: "client",
      projectId: "proj",
      kind: "remote-view" as const,
      handle: -5,
      linkSessionId: "link-a",
      send: () => {},
      request: async () => null,
      onClose: () => ({ dispose: () => {} }),
      isClosed: () => false,
    };
    getEndpointRegistry().add(endpoint as never);
    endpoints.push(() => getEndpointRegistry().remove("remote-1"));
    messagingHost = false;
    install();
    start("proj:0", "s1", -5);
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    policy().bindSender("link-a", "sender-a");
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toMatchObject({
      enrolledBy: { kind: "remote", linkSessionId: "link-a" },
    });
  });

  it("stops applying it on teardown", async () => {
    views.set(11, "proj");
    install();
    uninstall!();
    uninstall = null;
    expect(defaultListeners.size).toBe(0);
  });
});

describe("wakeHubForMoved", () => {
  const hub = { projectId: "proj", slot: 0, generation: "hub-2" } as LaneEnrollment;
  const moved = (taskId: string, hubGeneration: string): MovedExchange => ({
    record: { taskId } as ExchangeRecord,
    hubGeneration,
  });

  it("wakes the hub that sent each exchange, as an update from this Shell", () => {
    const wake = vi.fn();
    wakeHubForMoved(
      [moved("task-1", "hub-2"), moved("task-2", "hub-1")],
      { getHub: () => hub },
      {
        wake,
      }
    );
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toMatchObject({
      lane: { projectId: "proj", slot: 0 },
      generation: "hub-2",
      shell: { kind: "local" },
      exchangeId: "task-1",
      kind: "update",
    });
  });

  it("wakes nothing with no hub enrolled, or no waker", () => {
    const wake = vi.fn();
    wakeHubForMoved([moved("task-1", "hub-2")], { getHub: () => null }, { wake });
    wakeHubForMoved([moved("task-1", "hub-2")], undefined, { wake });
    expect(() =>
      wakeHubForMoved([moved("task-1", "hub-2")], { getHub: () => hub }, undefined)
    ).not.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
