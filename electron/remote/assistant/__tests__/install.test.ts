import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const running = vi.hoisted(
  () =>
    new Map<
      string,
      {
        sessionId: string;
        terminalId: string;
        projectViewWebContentsId?: number;
        startedBy?: { senderId: string; linkSessionId: string; askingHelpSessionId: string };
      }
    >()
);
/**
 * The lane each help session was provisioned for, by session id, kept apart
 * from `running`: a session its lane displaced still has its lane until it is
 * revoked, as the real service keeps it.
 */
const provisioned = vi.hoisted(() => new Map<string, string>());
/** Running lanes whose session no view has attached, by lane key. */
const detached = vi.hoisted(() => new Set<string>());
const sessionEnded = vi.hoisted(() => new Set<(event: unknown) => void>());
/** Which project each of this machine's views shows, by WebContents id. */
const views = vi.hoisted(() => new Map<number, string>());
/** Spawn outcomes the lifecycle ledger recorded, by terminal id. */
const ledger = vi.hoisted(
  () => new Map<string, { generation: number; spawnOk?: boolean; closedAt?: number }>()
);
const runbooksHostState = vi.hoisted(() => ({ read: null as (() => unknown) | null }));
/** The exchange database the installed store opens; null leaves it without one. */
const sharedDb = vi.hoisted(() => ({ sqlite: null as unknown }));
/** The host messaging runtime install hands the MCP server. */
const hostMessaging = vi.hoisted(() => ({ runtime: null as unknown }));
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
        return {
          projectId: projectId!,
          slot: Number(slot),
          agentId: "claude",
          attached: !detached.has(key),
        };
      }),
    getSessionLane: (helpSessionId: string) => {
      const lane = provisioned.get(helpSessionId);
      if (lane !== undefined) {
        const [projectId, slot] = lane.split(":");
        return { projectId: projectId!, slot: Number(slot) };
      }
      for (const [key, run] of running) {
        if (run.sessionId !== helpSessionId) continue;
        const [projectId, slot] = key.split(":");
        return { projectId: projectId!, slot: Number(slot) };
      }
      return null;
    },
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
vi.mock("../../../services/persistence/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/persistence/db.js")>()),
  getSharedSqlite: () => sharedDb.sqlite,
}));
vi.mock("../../../services/mcp-server/hostMessagingTools.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/mcp-server/hostMessagingTools.js")>();
  return {
    ...actual,
    setHostMessagingRuntime: (runtime: Parameters<typeof actual.setHostMessagingRuntime>[0]) => {
      hostMessaging.runtime = runtime;
      return () => {
        if (hostMessaging.runtime === runtime) hostMessaging.runtime = null;
      };
    },
  };
});
vi.mock("../../../services/pty/lifecycleLedger.js", () => ({
  getLifecycleLedger: () => ({ getEntry: (id: string) => ledger.get(id) }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../../../ipc/channels.js";
import { openDb } from "../../../services/persistence/db.js";
import { getEndpointRegistry } from "../../../ipc/endpointRegistry.js";
import { getRemoteService, registerRemoteService } from "../../runtime.js";
import type { HostProjectViewResult } from "../../client/hostProjectViews.js";
import { AssistantExchangeStore } from "../../exchange/AssistantExchangeStore.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import type { MovedExchange } from "../AssistantExchangeClient.js";
import { OPEN_LANE_GENERATION, type OpenRun } from "../AssistantMessagingPolicy.js";
import { openReceiverFor } from "../AssistantMessagingRuntime.js";
import type { HubMessagingRuntime, ObservedHost } from "../HubMessagingRuntime.js";
import {
  installAssistantMessagingPolicy,
  wakeAskersForMoved,
  type AssistantMessagingPolicyInstallDeps,
} from "../install.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../services/persistence/migrations"
);

const remoteEndpoints: Array<() => void> = [];
/** A remote Shell's open view of `projectId` at `handle`, over link session `linkSessionId`. */
const remoteView = (handle: number, linkSessionId: string, projectId = "proj") => {
  const endpointId = `remote${handle}`;
  getEndpointRegistry().add({
    endpointId,
    clientId: "client",
    projectId,
    kind: "remote-view" as const,
    handle,
    linkSessionId,
    send: () => {},
    request: async () => null,
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => false,
  } as never);
  remoteEndpoints.push(() => getEndpointRegistry().remove(endpointId));
};

beforeEach(() => {
  provisioned.clear();
  detached.clear();
});

afterEach(() => {
  for (const remove of remoteEndpoints.splice(0)) remove();
});

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
      // Having hosts lets this machine's assistants reach theirs; it isn't a lane of theirs.
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
  let defaultListeners: Set<() => void>;
  let uninstall: (() => void) | null = null;

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
    }));
  const policy = () => getRemoteService("assistantMessagingPolicy")!;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  /**
   * A run in the view `view` (positive ids are this machine's own views,
   * negative ones remote Shells'), spawned unless `pending`, which leaves it
   * waiting on the pty-host's answer.
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
    defaultListeners = new Set();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("enrolls no run in this machine's own views: they reach hosts without one (#13468)", async () => {
    views.set(11, "proj");
    install();
    start("proj:0", "s1", 11);
    start("proj:1", "s2", 11);
    nudge();
    await settle();
    expect(policy().listEnrollments()).toEqual([]);
    // Nor does the default ask whether this Shell has a host to hear from: there is no hub to want.
    expectTypeOf<AssistantMessagingPolicyInstallDeps>().not.toHaveProperty("hasMessagingHost");
  });

  it("never enrolls a spawn that failed, and enrolls the next run instead", async () => {
    remoteView(-5, "link-a");
    install();
    policy().bindSender("link-a", "sender-a");
    start("proj:0", "s1", -5, true);
    // The pty-host refused it: the pending entry goes, the lane stays bound.
    pty.generations.delete("t-s1");
    ledger.set("t-s1", { generation: 1, spawnOk: false, closedAt: 1 });
    pty.emit("spawn-result", "t-s1", { success: false, id: "t-s1", launchGeneration: 1 });
    await settle();
    expect(policy().listEnrollments()).toEqual([]);
    start("proj:1", "s2", -5);
    await settle();
    expect(policy().listEnrollments()).toEqual([
      expect.objectContaining({ slot: 1, enrolledBy: { kind: "remote", linkSessionId: "link-a" } }),
    ]);
  });

  it("enrolls a remote Shell's run only once it has spawned", async () => {
    remoteView(-5, "link-a");
    install();
    policy().bindSender("link-a", "sender-a");
    start("proj:0", "s1", -5, true);
    nudge();
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    pty.emit("spawn-result", "t-s1", { success: true, id: "t-s1", launchGeneration: 1 });
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toMatchObject({
      sessionId: "s1",
    });
  });

  it("keeps a run's spawn when a duplicate spawn of the same terminal is refused", async () => {
    remoteView(-5, "link-a");
    accepts = false;
    install();
    policy().bindSender("link-a", "sender-a");
    start("proj:0", "s1", -5);
    // The ledger now describes the refused attempt; the first one is still the live run.
    ledger.set("t-s1", { generation: 2, spawnOk: false, closedAt: 1 });
    pty.emit("spawn-result", "t-s1", { success: false, id: "t-s1", launchGeneration: 2 });
    accepts = true;
    nudge();
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toMatchObject({
      launchGeneration: 1,
    });
  });

  it("leaves a run alone whose view shows another project, or is no view of this machine", async () => {
    views.set(11, "other");
    install();
    start("proj:0", "s1", 11);
    start("proj:1", "s2", 12);
    await settle();
    expect(policy().listEnrollments()).toEqual([]);
  });

  it("waits for the saved default, then applies it", async () => {
    remoteView(-5, "link-a");
    accepts = false;
    install();
    policy().bindSender("link-a", "sender-a");
    start("proj:0", "s1", -5);
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    accepts = true;
    nudge();
    await settle();
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).not.toBeNull();
  });

  it("enrolls a run the host started with no view for the Shell that asked, and no other (#13511)", async () => {
    install();
    start("proj:0", "s1", 0);
    running.get("proj:0")!.startedBy = {
      senderId: "sender-a",
      linkSessionId: "link-a",
      askingHelpSessionId: "hub-help-1",
    };
    policy().bindSender("link-b", "sender-b");
    await settle();
    expect(
      policy().enrollStarted(
        { projectId: "proj", slot: 0 },
        { kind: "remote", linkSessionId: "link-b" },
        "s1"
      )
    ).toEqual({ ok: false, reason: "wrong-session" });
    expect(policy().getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    policy().bindSender("link-a", "sender-a");
    expect(
      policy().enrollStarted(
        { projectId: "proj", slot: 0 },
        { kind: "remote", linkSessionId: "link-a" },
        "s1"
      )
    ).toMatchObject({
      ok: true,
      enrollment: { enrolledBy: { kind: "remote", linkSessionId: "link-a" } },
    });
  });

  it("enrolls a run in a remote Shell's open view for that Shell once it proved its sender", async () => {
    remoteView(-5, "link-a");
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

describe.skipIf(process.platform === "win32")(
  "installAssistantMessagingPolicy handing a host's messages to an assistant here (#13468)",
  () => {
    let accepts: boolean;
    let tmpDir: string;
    let uninstall: (() => void) | null = null;
    let wakes: Array<{ lane: unknown; generation: string; exchangeId?: string }>;
    const studio: ObservedHost = {
      hostId: "studio",
      name: "studio-01",
      assistantMessagingEnabled: true,
      connection: { status: "disconnected" },
      lastSeenAt: null,
      summary: null,
    };

    const install = () => {
      uninstall = installAssistantMessagingPolicy({
        isHostMessagingEnabled: () => true,
        hasHosts: () => true,
        onHostsChanged: () => () => {},
        observeHosts: () => [studio],
        acceptsByDefault: () => accepts,
      });
      vi.spyOn(getRemoteService("assistantLaneWaker")!, "wake").mockImplementation((request) => {
        wakes.push(request);
      });
    };
    /**
     * A spawned run in view `view`: 11 is this machine's view of `proj`, -12 a
     * remote Shell's open view of it once `remoteView(-12, ...)` registered it.
     */
    const start = (lane: string, sessionId: string, view: number) => {
      const terminalId = `t-${sessionId}`;
      running.set(lane, { sessionId, terminalId, projectViewWebContentsId: view });
      pty.generations.set(terminalId, 1);
    };
    let sent = 0;
    const receive = (sourceLane = { projectId: "host-proj", slot: 0 }) =>
      getRemoteService("assistantHubReceiver")!.receive("studio", {
        messageId: `m-${++sent}`,
        contextId: `ctx-${sent}`,
        referenceTaskIds: [],
        sourceLane,
        hopCount: 1,
        body: "the migration landed",
      });
    const lastWake = () => wakes.at(-1);

    beforeEach(() => {
      broadcastToRenderer.mockClear();
      running.clear();
      pty.listeners.clear();
      pty.generations.clear();
      sessionEnded.clear();
      views.clear();
      ledger.clear();
      views.set(11, "proj");
      accepts = true;
      wakes = [];
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-install-receiver-"));
      sharedDb.sqlite = openDb(path.join(tmpDir, "exchange.db"), migrationsFolder).sqlite;
    });

    afterEach(() => {
      uninstall?.();
      uninstall = null;
      (sharedDb.sqlite as { close(): void } | null)?.close();
      sharedDb.sqlite = null;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("goes to the earliest of this machine's assistants taking messages, at its open address", () => {
      // A remote Shell's run here is that Shell's, never a recipient for this one's hosts.
      remoteView(-12, "link-a");
      start("proj:0", "s0", -12);
      start("proj:1", "s1", 11);
      start("proj:2", "s2", 11);
      install();
      const received = receive();
      if (received.status !== "accepted") throw new Error(`not accepted: ${received.status}`);
      expect(lastWake()).toMatchObject({
        lane: { projectId: "proj", slot: 1 },
        generation: OPEN_LANE_GENERATION,
        shell: { kind: "local" },
        exchangeId: received.taskId,
      });
      // Filed at that lane's open address, so a run that replaces it reads it too.
      const filed = new AssistantExchangeStore(sharedDb.sqlite as never).listChangesSince(
        { kind: "receiver", ...openReceiverFor({ projectId: "proj", slot: 1 }) },
        0
      );
      expect(filed.records.map((record) => record.taskId)).toEqual([received.taskId]);
    });

    it("skips an assistant the person turned off", () => {
      start("proj:1", "s1", 11);
      start("proj:2", "s2", 11);
      install();
      getRemoteService("assistantMessagingPolicy")!.declineRun(
        { projectId: "proj", slot: 1 },
        { kind: "local" }
      );
      expect(receive()).toMatchObject({ status: "accepted" });
      expect(lastWake()).toMatchObject({ lane: { projectId: "proj", slot: 2 } });
    });

    it("refuses as unavailable with nobody here taking messages, recording nothing", () => {
      remoteView(-12, "link-a");
      start("proj:0", "s0", -12);
      install();
      expect(receive()).toEqual({ status: "refused", refusal: "hub_unavailable" });
      expect(wakes).toEqual([]);
    });

    it("goes to the assistant that last spoke to the sending lane, while it takes messages", async () => {
      start("proj:1", "s1", 11);
      start("proj:2", "s2", 11);
      install();
      const unregisterClient = registerRemoteService("assistantExchangeClient", {
        send: async () => ({ status: "unknown" }),
      } as never);
      try {
        const hub = hostMessaging.runtime as HubMessagingRuntime;
        await expect(
          hub.sendMessage("s2", {
            hostId: "studio",
            projectId: "host-proj",
            slot: 0,
            generation: "g",
            text: "did the migration land?",
          })
        ).resolves.toMatchObject({ ok: true });

        expect(receive()).toMatchObject({ status: "accepted" });
        expect(lastWake()).toMatchObject({
          lane: { projectId: "proj", slot: 2 },
          generation: OPEN_LANE_GENERATION,
        });
        // Another lane on the host has no route: the earliest one takes it.
        receive({ projectId: "host-proj", slot: 1 });
        expect(lastWake()).toMatchObject({ lane: { projectId: "proj", slot: 1 } });

        // The asker turned off: the earliest one taking messages gets it instead.
        getRemoteService("assistantMessagingPolicy")!.declineRun(
          { projectId: "proj", slot: 2 },
          { kind: "local" }
        );
        receive();
        expect(lastWake()).toMatchObject({ lane: { projectId: "proj", slot: 1 } });
      } finally {
        unregisterClient();
      }
    });

    it("lets any live assistant in this machine's views send, never one a remote view runs", async () => {
      remoteView(-12, "link-a");
      start("proj:0", "s0", -12);
      start("proj:1", "s1", 11);
      install();
      const send = vi.fn(async () => ({ status: "unknown" }));
      const unregisterClient = registerRemoteService("assistantExchangeClient", {
        send,
      } as never);
      try {
        const hub = hostMessaging.runtime as HubMessagingRuntime;
        const args = {
          hostId: "studio",
          projectId: "host-proj",
          slot: 0,
          generation: "g",
          text: "hello",
        };
        // A live run here, in a real remote Shell's view of its own project: that Shell's.
        expect(
          getRemoteService("assistantMessagingPolicy")!.checkOpen(
            { projectId: "proj", slot: 0 },
            "admit"
          ).ok
        ).toBe(true);
        await expect(hub.sendMessage("s0", args)).resolves.toMatchObject({
          ok: false,
          code: "NOT_ELIGIBLE",
        });
        await expect(hub.list("s0")).resolves.toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
        await expect(hub.sendMessage("s1", args)).resolves.toMatchObject({ ok: true });
        // Sent as that run, so only it is woken when the exchange moves.
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]).toEqual([
          "studio",
          expect.objectContaining({ projectId: "host-proj", slot: 0 }),
          {
            projectId: "proj",
            slot: 1,
            sessionId: "s1",
            terminalId: "t-s1",
            launchGeneration: 1,
          } satisfies OpenRun,
        ]);
      } finally {
        unregisterClient();
      }
    });

    it("skips a running lane no view has attached as recipient", () => {
      start("proj:0", "s0", 11);
      start("proj:1", "s1", 11);
      detached.add("proj:0");
      install();
      expect(
        getRemoteService("assistantMessagingPolicy")!.checkOpen(
          { projectId: "proj", slot: 0 },
          "admit"
        ).ok
      ).toBe(true);
      expect(receive()).toMatchObject({ status: "accepted" });
      expect(lastWake()).toMatchObject({ lane: { projectId: "proj", slot: 1 } });
      detached.add("proj:1");
      expect(receive()).toEqual({ status: "refused", refusal: "hub_unavailable" });
    });

    it("refuses a session its lane displaced, while the session that replaced it may send", async () => {
      start("proj:1", "s-old", 11);
      provisioned.set("s-old", "proj:1");
      install();
      // The lane runs a new session now; the old one is still provisioned for it.
      start("proj:1", "s-new", 11);
      provisioned.set("s-new", "proj:1");
      const send = vi.fn(async (_hostId: string, _payload: unknown, _asker?: unknown) => ({
        status: "unknown",
      }));
      const unregisterClient = registerRemoteService("assistantExchangeClient", {
        send,
      } as never);
      try {
        const hub = hostMessaging.runtime as HubMessagingRuntime;
        const args = {
          hostId: "studio",
          projectId: "host-proj",
          slot: 0,
          generation: "g",
          text: "hello",
        };
        expect(hub.isReachable("s-old")).toBe(true);
        expect(hub.isAvailable("s-old")).toBe(false);
        await expect(hub.sendMessage("s-old", args)).resolves.toMatchObject({
          ok: false,
          code: "NOT_ELIGIBLE",
        });
        await expect(hub.list("s-old")).resolves.toMatchObject({
          ok: false,
          code: "NOT_ELIGIBLE",
        });
        expect(send).not.toHaveBeenCalled();
        await expect(hub.sendMessage("s-new", args)).resolves.toMatchObject({ ok: true });
        expect(send.mock.calls[0]?.[2]).toMatchObject({ slot: 1, sessionId: "s-new" });
      } finally {
        unregisterClient();
      }
    });
  }
);

describe("wakeAskersForMoved", () => {
  const asker = (slot: number, sessionId: string): OpenRun => ({
    projectId: "proj",
    slot,
    sessionId,
    terminalId: `t-${sessionId}`,
    launchGeneration: 2,
  });
  const moved = (taskId: string, run: OpenRun): MovedExchange => ({
    record: { taskId } as ExchangeRecord,
    asker: run,
  });

  it("wakes the run that sent each exchange, at its lane's open address, as an update", () => {
    const wake = vi.fn();
    wakeAskersForMoved([moved("task-1", asker(0, "s1")), moved("task-2", asker(1, "s2"))], {
      wake,
    });
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[0]![0]).toMatchObject({
      lane: { projectId: "proj", slot: 0 },
      generation: OPEN_LANE_GENERATION,
      shell: { kind: "local" },
      exchangeId: "task-1",
      kind: "update",
      run: asker(0, "s1"),
    });
    expect(wake.mock.calls[1]![0]).toMatchObject({
      lane: { projectId: "proj", slot: 1 },
      exchangeId: "task-2",
      run: asker(1, "s2"),
    });
    // The lane lifts the run off the request: only the exact asker is checked, never its lane.
    expect(Object.keys(wake.mock.calls[0]![0].lane)).toEqual(["projectId", "slot"]);
  });

  it("wakes nothing with nothing moved, and never throws without a waker", () => {
    const wake = vi.fn();
    wakeAskersForMoved([], { wake });
    expect(() => wakeAskersForMoved([moved("task-1", asker(0, "s1"))], undefined)).not.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
