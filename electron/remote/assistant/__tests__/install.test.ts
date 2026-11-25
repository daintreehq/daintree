import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const running = vi.hoisted(
  () =>
    new Map<string, { sessionId: string; terminalId: string; projectViewWebContentsId: number }>()
);
/** Running lanes whose session no view has attached, by lane key. */
const detached = vi.hoisted(() => new Set<string>());
/** Help sessions a schedule started (#16169), with their run. */
const scheduled = vi.hoisted(() => new Map<string, { scheduleId: string; runId: string }>());
/** The conversation each help session's lane runs, as main minted it (#17919). */
const conversations = vi.hoisted(() => new Map<string, string>());
/** Which project each of this machine's views shows, by WebContents id. */
const views = vi.hoisted(() => new Map<number, string>());
/** The host-control runtime install hands the MCP server. */
const hostControl = vi.hoisted(() => ({ runtime: null as unknown }));
/** Lines queued on assistants' notice lines. */
const queued = vi.hoisted(
  () =>
    [] as Array<{
      lane: { helpSessionId: string; terminalId: string; projectId: string };
      wake: import("../../../services/mcp-server/terminalNotify.js").LaneWake;
    }>
);
const generations = vi.hoisted(() => new Map<string, number>());
/** Who hears help sessions end, and what the MCP server was asked for this machine's own calls. */
const ended = vi.hoisted(
  () =>
    new Set<
      (event: import("../../../services/HelpSessionService.js").HelpSessionEndedEvent) => void
    >()
);
const mcp = vi.hoisted(() => ({
  opened: [] as Array<{ tier: string; workspaceId: string; caller: Record<string, unknown> }>,
  retired: [] as Array<[string, string]>,
  released: [] as Array<[string, string]>,
}));

/** The app's shared database, as the link client's installer finds it. */
const sharedDb = vi.hoisted(() => ({
  sqlite: null as import("better-sqlite3").Database | null,
}));
vi.mock("../../../services/persistence/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/persistence/db.js")>()),
  getSharedDb: () => {},
  getSharedSqlite: () => sharedDb.sqlite,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));
/** A lane key back into its project and slot; the global assistant's id holds a colon of its own. */
const laneOf = vi.hoisted(() => (key: string): [string, string] => {
  const at = key.lastIndexOf(":");
  return [key.slice(0, at), key.slice(at + 1)];
});
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getRunningLaneSession: (projectId: string, slot: number) =>
      running.get(`${projectId}:${slot}`) ?? null,
    getScheduledRunOf: (helpSessionId: string) => scheduled.get(helpSessionId) ?? null,
    getConversationOwnershipId: (helpSessionId: string) => conversations.get(helpSessionId) ?? null,
    listRunningLanes: () =>
      [...running.keys()].map((key) => {
        const [projectId, slot] = laneOf(key);
        return {
          projectId: projectId!,
          slot: Number(slot),
          agentId: "claude",
          attached: !detached.has(key),
        };
      }),
    getSessionLane: (helpSessionId: string) => {
      for (const [key, run] of running) {
        if (run.sessionId !== helpSessionId) continue;
        const [projectId, slot] = laneOf(key);
        return { projectId: projectId!, slot: Number(slot) };
      }
      return null;
    },
    // No view minted a viewless session, so none reads as its own.
    getWebContentsIdForSessionId: (helpSessionId: string) => {
      const handle = [...running.values()].find(
        (run) => run.sessionId === helpSessionId
      )?.projectViewWebContentsId;
      return handle === undefined || handle === 0 ? null : handle;
    },
    addSessionEndedListener: (listener: Parameters<(typeof ended)["add"]>[0]) => {
      ended.add(listener);
      return () => ended.delete(listener);
    },
    ensureAssistantControl: async () => {},
  },
}));
const globalAssistant = vi.hoisted(() => ({
  /** The views showing it, the one holding its input first. Null: no service. */
  views: null as number[] | null,
  /** The session that coordinates (#18143). */
  coordinator: 0,
  standDown: new Set<(sessionId: string) => void>(),
}));
vi.mock("../../../services/globalAssistant.js", () => ({
  globalAssistantCoordinatorSlot: () => globalAssistant.coordinator,
  onGlobalAssistantStandDown: (listener: (sessionId: string) => void) => {
    globalAssistant.standDown.add(listener);
    return () => globalAssistant.standDown.delete(listener);
  },
  peekGlobalAssistantService: () =>
    globalAssistant.views && {
      presenterWebContentsId: (canAsk: (id: number) => boolean = () => true) =>
        globalAssistant.views!.find(canAsk) ?? null,
    },
}));
const askHostApprovalInWindow = vi.hoisted(() => vi.fn(async () => "approved"));
vi.mock("../../client/viewRequests.js", () => ({ askHostApprovalInWindow }));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getProjectById: (id: string) => (["proj-1", "proj-2"].includes(id) ? { id } : null),
    getProjectSummaries: () => [
      { id: "proj-1", name: "daintree", path: "/repos/daintree", emoji: "" },
      { id: "proj-2", name: "website", path: "/repos/website", emoji: "" },
    ],
  },
}));
vi.mock("../../../utils/machineName.js", () => ({ machineDisplayName: () => "greg-mbp" }));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({ getLiveGeneration: (id: string) => generations.get(id) ?? null }),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: (id: number) => views.get(id) ?? null,
  getWebContentsForProject: () => [],
}));
vi.mock("../../../services/McpServerService.js", () => ({
  mcpServerService: {
    queueLaneWake: (lane: (typeof queued)[number]["lane"], wake: (typeof queued)[number]["wake"]) =>
      queued.push({ lane, wake }),
    openRelaySession: async (spec: (typeof mcp)["opened"][number]) => {
      mcp.opened.push(spec);
      let open = true;
      return {
        isOpen: () => open,
        callTool: async () => ({ content: [], structuredContent: { terminals: [] } }),
        close: () => {
          open = false;
        },
      };
    },
    retireRelayPrincipal: (senderId: string, helpSessionId: string) =>
      mcp.retired.push([senderId, helpSessionId]),
    releaseRelayAdoptions: (senderId: string, helpSessionId: string) =>
      mcp.released.push([senderId, helpSessionId]),
  },
}));
vi.mock("../../../services/mcp-server/hostControlTools.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/mcp-server/hostControlTools.js")>();
  return {
    ...actual,
    setHostControlRuntime: (runtime: Parameters<typeof actual.setHostControlRuntime>[0]) => {
      hostControl.runtime = runtime;
      return () => {
        if (hostControl.runtime === runtime) hostControl.runtime = null;
      };
    },
  };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../../../services/persistence/db.js";
import { getRemoteService, registerRemoteService } from "../../runtime.js";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import type { HostCallRuntime, ObservedHost } from "../HostCallRuntime.js";
import type { HostControlLinkClient } from "../HostControlLinkClient.js";
import {
  assistantsUseHost,
  installHostControl,
  installHostControlLinkClient,
  installRetiredSendsNotice,
} from "../install.js";
import type { McpCallAnswer, ThrowawayCallAnswer } from "../linkMethods.js";
import { LAUNCHED_AGENT_GONE_MS } from "../launchedAgents.js";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry } from "../../client/HostRegistry.js";
import { markProjectlessView } from "../../../window/projectlessViews.js";
import { IDLE_RELEASE_MS, RemoteHostManager } from "../../client/RemoteHostManager.js";
import { TransportError } from "../../client/transport.js";
import {
  publishHelpSessionService,
  resetHelpSessionRuntimeForTests,
} from "../../../services/helpSessionRuntime.js";

// The service publishes itself as its module loads; its mock is published in
// its place, so code reading the loaded service finds the mock.
beforeEach(async () => {
  resetHelpSessionRuntimeForTests();
  const { helpSessionService } = await import("../../../services/HelpSessionService.js");
  publishHelpSessionService(helpSessionService);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

function host(hostId: string, status: "connected" | "disconnected"): ObservedHost {
  return {
    hostId,
    name: hostId,
    connection:
      status === "connected"
        ? {
            status,
            rttMs: 1,
            handshake: {
              version: "1.0.0",
              commit: "abc1234",
              protocolVersion: 12,
              platform: "linux",
              arch: "x64",
            },
          }
        : { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
  };
}

/** One of this machine's assistants, in its own view of its project. */
function runLocally(projectId: string, slot: number, sessionId: string, view = 40 + slot): void {
  const terminalId = `t-${sessionId}`;
  running.set(`${projectId}:${slot}`, { sessionId, terminalId, projectViewWebContentsId: view });
  views.set(view, projectId);
  generations.set(terminalId, 1);
}

afterEach(() => {
  running.clear();
  detached.clear();
  scheduled.clear();
  conversations.clear();
  views.clear();
  generations.clear();
  queued.length = 0;
  hostControl.runtime = null;
  mcp.opened.length = 0;
  mcp.retired.length = 0;
  mcp.released.length = 0;
});

describe("installHostControl (#13493)", () => {
  it("installs the host tools' runtime until torn down", () => {
    const hosts = [host("studio", "connected")];
    const off = installHostControl({
      observeHosts: () => hosts,
      isHostControlEnabled: () => true,
    });
    expect(hostControl.runtime).not.toBeNull();
    expect(getRemoteService("hostCallRelayClient")).toBe(hostControl.runtime);

    off();
    expect(hostControl.runtime).toBeNull();
    expect(getRemoteService("hostCallRelayClient")).toBeUndefined();
  });

  it("offers the host tools only to an assistant in one of this machine's own views", () => {
    const off = installHostControl({
      observeHosts: () => [],
      isHostControlEnabled: () => false,
    });
    runLocally("proj-1", 0, "local");
    running.set("proj-1:1", {
      sessionId: "remote",
      terminalId: "t-remote",
      projectViewWebContentsId: -3,
    });
    const runtime = hostControl.runtime as { isCallReachable(id: string): boolean };
    expect(runtime.isCallReachable("local")).toBe(true);
    expect(runtime.isCallReachable("remote")).toBe(false);
    expect(runtime.isCallReachable("nobody")).toBe(false);
    off();
  });

  it("reaches this machine's other projects as local, admitted as a local relay (#14024)", async () => {
    const off = installHostControl({
      observeHosts: () => [host("studio", "connected")],
      isHostControlEnabled: () => true,
    });
    runLocally("proj-1", 0, "a");
    conversations.set("a", "conv-a");
    const runtime = hostControl.runtime as HostCallRuntime;

    const listed = await runtime.list("a");
    if (!listed.ok) throw new Error("refused");
    expect(listed.value.hosts[0]).toMatchObject({
      hostId: "local",
      name: "greg-mbp",
      projects: [{ projectId: "proj-2", name: "website" }],
    });

    const called = await runtime.call(
      "a",
      { hostId: "local", projectId: "proj-2", tool: "terminal.list", args: {} },
      { tier: "core" }
    );
    expect(called).toMatchObject({ ok: true, value: { outcome: "ok" } });
    expect(mcp.opened).toEqual([
      {
        tier: "core",
        workspaceId: "proj-2",
        caller: expect.objectContaining({
          senderId: "local",
          helpSessionId: "a",
          // From main's own record of the lane (#17919).
          conversationId: "conv-a",
          shellName: "greg-mbp",
          local: true,
        }),
      },
    ]);
    expect(mcp.opened[0]!.caller.global).toBeUndefined();
    // Its throwaway runs here and on hosts go with it too (#14447).
    const endOwner = vi.fn();
    const offRuns = registerRemoteService("hostThrowawayRuns", { run: vi.fn(), endOwner });
    const endOnHosts = vi.spyOn(runtime, "endHelpSession");
    const retireWatches = vi.spyOn(runtime, "retireWatches");

    // Relaunched onto a new PTY it is the same assistant; ended, its hold goes.
    const end = (reason: "relaunched" | "revoked") => {
      for (const listener of ended)
        listener({ projectId: "proj-1", slot: 0, sessionId: "a", reason });
    };
    end("relaunched");
    await vi.dynamicImportSettled();
    expect(mcp.retired).toEqual([]);
    expect(mcp.released).toEqual([]);
    expect(endOwner).not.toHaveBeenCalled();
    expect(endOnHosts).not.toHaveBeenCalled();
    // Its earlier run's host watches don't pass to the new one (#14463).
    expect(retireWatches).toHaveBeenCalledWith("a");
    end("revoked");
    expect(endOwner).toHaveBeenCalledWith(
      { senderId: "local", helpSessionId: "a" },
      "session-ended"
    );
    expect(endOnHosts).toHaveBeenCalledWith("a");
    offRuns();
    await vi.waitFor(() => expect(mcp.retired).toEqual([["local", "a"]]));
    // What was handed to it goes with it, whether or not a call retired its principal (#14161).
    await vi.waitFor(() => expect(mcp.released).toEqual([["local", "a"]]));

    off();
    expect(ended.size).toBe(0);
  });

  it("reaches every project as local for the global assistant, which no view shows (#14161)", async () => {
    const off = installHostControl({
      observeHosts: () => [],
      isHostControlEnabled: () => false,
    });
    running.set(`${GLOBAL_ASSISTANT_ID}:0`, {
      sessionId: "global",
      terminalId: "t-global",
      projectViewWebContentsId: 0,
    });
    generations.set("t-global", 1);
    const runtime = hostControl.runtime as HostCallRuntime;
    expect(runtime.isCallReachable("global")).toBe(true);

    const listed = await runtime.list("global");
    if (!listed.ok) throw new Error("refused");
    expect(listed.value.hosts[0]!.projects?.map((p) => p.projectId)).toEqual(["proj-1", "proj-2"]);

    const called = await runtime.call(
      "global",
      { hostId: "local", projectId: "proj-1", tool: "terminal.list", args: {} },
      { tier: "core" }
    );
    expect(called).toMatchObject({ ok: true, value: { outcome: "ok" } });
    expect(mcp.opened).toEqual([
      {
        tier: "core",
        workspaceId: "proj-1",
        caller: expect.objectContaining({
          senderId: "local",
          helpSessionId: "global",
          local: true,
          global: true,
        }),
      },
    ]);

    // Nor anything that acts on what it neither launched nor was handed, nor
    // any tool nobody placed for it.
    for (const tool of [
      "project.runCommand",
      "project.runCheck",
      "terminal.moveToWorktree",
      "devPreview.restart",
      "devPreview.reloadPreview",
      "plugin.reloadProject",
      "agentSessionHistory.resume",
      "acme.unplacedTool",
    ]) {
      const refused = await runtime.call(
        "global",
        { hostId: "local", projectId: "proj-1", tool, args: { terminalId: "t-user" } },
        { tier: "full" }
      );
      expect(refused).toMatchObject({
        ok: true,
        value: { outcome: "policy_rejected", callId: null },
      });
    }
    expect(mcp.opened).toHaveLength(1);
    // A project's own assistant keeps them: the rule is the global caller's, not the tool's.
    runLocally("proj-2", 0, "proj-2-assistant");
    const allowed = await runtime.call(
      "proj-2-assistant",
      { hostId: "local", projectId: "proj-1", tool: "project.runCheck", args: {} },
      { tier: "full" }
    );
    expect(allowed).toMatchObject({ ok: true, value: { outcome: "ok" } });

    off();
  });

  it("lets only the global session that coordinates act, under the work's conversation (#18143)", async () => {
    globalAssistant.coordinator = 0;
    const off = installHostControl({ observeHosts: () => [], isHostControlEnabled: () => false });
    for (const [slot, sessionId, conversation] of [
      [0, "global-a", "work"],
      [1, "global-b", "other"],
    ] as const) {
      running.set(`${GLOBAL_ASSISTANT_ID}:${slot}`, {
        sessionId,
        terminalId: `t-${sessionId}`,
        projectViewWebContentsId: 0,
      });
      generations.set(`t-${sessionId}`, 1);
      conversations.set(sessionId, conversation);
    }
    const runtime = hostControl.runtime as HostCallRuntime;
    const call = (sessionId: string, tool: string) =>
      runtime.call(
        sessionId,
        { hostId: "local", projectId: "proj-1", tool, args: { terminalId: "w", command: "go" } },
        { tier: "full" }
      );
    const opened = () =>
      mcp.opened.map((open) => [open.caller.helpSessionId, open.caller.conversationId]);

    expect(await call("global-b", "terminal.list")).toMatchObject({ value: { outcome: "ok" } });
    expect(await call("global-b", "terminal.sendCommandOwned")).toMatchObject({
      value: { outcome: "policy_rejected", detail: expect.stringContaining("isn't coordinating") },
    });
    expect(await call("global-a", "terminal.sendCommandOwned")).toMatchObject({
      value: { outcome: "ok" },
    });
    expect(opened()).toEqual([
      ["global-b", undefined],
      ["global-a", "work"],
    ]);

    // Handed over: the work's id moved with coordination.
    globalAssistant.coordinator = 1;
    conversations.set("global-a", "other");
    conversations.set("global-b", "work");
    expect(await call("global-a", "terminal.sendCommandOwned")).toMatchObject({
      value: { outcome: "policy_rejected" },
    });
    expect(await call("global-b", "terminal.sendCommandOwned")).toMatchObject({
      value: { outcome: "ok" },
    });
    expect(opened().at(-1)).toEqual(["global-b", "work"]);

    // A stand-down reaches the runtime until the install is torn down.
    const standDown = vi.spyOn(runtime, "standDown");
    for (const listener of globalAssistant.standDown) listener("global-a");
    expect(standDown).toHaveBeenCalledWith("global-a");
    off();
    expect(globalAssistant.standDown.size).toBe(0);
  });

  describe("asking the person for the global assistant", () => {
    const canopyView = { id: 77, once: vi.fn() };

    /** What the runtime was given to put a host's question to the person. */
    function askApproval(): (ask: { helpSessionId: string }) => Promise<unknown> {
      const runtime = hostControl.runtime as unknown as {
        deps: { askApproval: (ask: { helpSessionId: string }) => Promise<unknown> };
      };
      return runtime.deps.askApproval;
    }

    beforeEach(() => {
      askHostApprovalInWindow.mockClear();
      markProjectlessView(canopyView as never, {} as never);
      running.set(`${GLOBAL_ASSISTANT_ID}:0`, {
        sessionId: "global",
        terminalId: "t-global",
        projectViewWebContentsId: 0,
      });
    });

    afterEach(() => {
      globalAssistant.views = null;
      canopyView.once.mock.calls.find(([event]) => event === "destroyed")?.[1]();
      canopyView.once.mockClear();
    });

    it("passes over the Canopy window, which has no dialog, for a view that does", async () => {
      globalAssistant.views = [canopyView.id, 40];
      const off = installHostControl({ observeHosts: () => [], isHostControlEnabled: () => false });

      await askApproval()({ helpSessionId: "global" });

      expect(askHostApprovalInWindow).toHaveBeenCalledWith(40, expect.anything());
      off();
    });

    it("asks nowhere when only the Canopy window shows it", async () => {
      globalAssistant.views = [canopyView.id];
      const off = installHostControl({ observeHosts: () => [], isHostControlEnabled: () => false });

      await expect(askApproval()({ helpSessionId: "global" })).resolves.toBeNull();

      expect(askHostApprovalInWindow).not.toHaveBeenCalled();
      off();
    });
  });

  it("never treats a project lane with no view of its project as this machine's own", () => {
    const off = installHostControl({
      observeHosts: () => [],
      isHostControlEnabled: () => false,
    });
    running.set("proj-1:0", {
      sessionId: "viewless",
      terminalId: "t-v",
      projectViewWebContentsId: 0,
    });
    generations.set("t-v", 1);
    const runtime = hostControl.runtime as HostCallRuntime;
    return runtime.list("viewless").then((listed) => {
      expect(listed.ok).toBe(false);
      off();
    });
  });

  it("treats a schedule's assistant no view has taken over as this machine's own (#16169)", async () => {
    const off = installHostControl({
      observeHosts: () => [],
      isHostControlEnabled: () => false,
    });
    running.set("proj-1:0", {
      sessionId: "scheduled",
      terminalId: "t-s",
      projectViewWebContentsId: 0,
    });
    generations.set("t-s", 1);
    scheduled.set("scheduled", { scheduleId: "schedule-1", runId: "run-1" });
    const runtime = hostControl.runtime as HostCallRuntime;

    // Offered the host tools from the start, and answered as a run of this machine.
    expect(runtime.isCallReachable("scheduled")).toBe(true);
    await expect(runtime.list("scheduled")).resolves.toMatchObject({ ok: true });

    // Once a remote Shell's view holds it, it's that Shell's.
    running.set("proj-1:0", {
      sessionId: "scheduled",
      terminalId: "t-s",
      // A remote endpoint handle is negative.
      projectViewWebContentsId: -7,
    });
    expect(runtime.isCallReachable("scheduled")).toBe(false);
    await expect(runtime.list("scheduled")).resolves.toMatchObject({ ok: false });
    off();
  });

  it("tells an assistant that can't reach hosts what it lacks (#18164)", async () => {
    const off = installHostControl({
      observeHosts: () => [],
      isHostControlEnabled: () => false,
    });
    runLocally("proj-1", 0, "local");
    // A remote Shell's view, no view at all, a window showing another project, a stopped terminal.
    running.set("proj-1:1", {
      sessionId: "remote",
      terminalId: "t-remote",
      projectViewWebContentsId: -3,
    });
    generations.set("t-remote", 1);
    running.set("proj-2:0", {
      sessionId: "viewless",
      terminalId: "t-viewless",
      projectViewWebContentsId: 0,
    });
    generations.set("t-viewless", 1);
    runLocally("proj-2", 1, "moved", 60);
    views.set(60, "proj-1");
    runLocally("proj-1", 2, "stopped");
    generations.delete("t-stopped");
    const runtime = hostControl.runtime as HostCallRuntime;

    expect(runtime.callerRefusal("local")).toBeNull();
    expect(runtime.callerRefusal("remote")).toMatch(/window on another machine/);
    expect(runtime.callerRefusal("viewless")).toMatch(/window of its project on this machine/);
    expect(runtime.callerRefusal("moved")).toBe(runtime.callerRefusal("viewless"));
    expect(runtime.callerRefusal("stopped")).toMatch(/no running terminal/);
    expect(runtime.callerRefusal("nobody")).toMatch(/ending or was revoked/);
    await expect(runtime.list("viewless")).resolves.toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
      message: runtime.callerRefusal("viewless"),
    });
    off();
  });
});

describe("assistantsUseHost (#15878)", () => {
  const TEN_MINUTES = 10 * 60_000;
  let manager: RemoteHostManager | null = null;
  const teardown: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
  });

  afterEach(async () => {
    for (const off of teardown.splice(0).reverse()) off();
    await manager?.disposeAll();
    manager = null;
    vi.useRealTimers();
  });

  /** A Shell whose only link to a host no window shows is its assistant's, with idle release as shipped. */
  function windowlessLink(): string {
    let saved: { hosts: HostDescriptor[] } | undefined;
    const registry = new HostRegistry({
      get: () => saved,
      set: (_key, next) => void (saved = next),
    });
    const studio = registry.add({ name: "studio", connection: { kind: "ssh", target: "studio" } });
    manager = new RemoteHostManager({
      registry,
      createTransport: () => ({
        async open() {
          throw new TransportError("unreachable", "Connection timed out");
        },
      }),
      handshake: () => TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "mbp", platform: "darwin" },
      views: { send: () => true, watch: () => () => {}, resync: () => {} },
      backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
    });
    return studio.id;
  }

  function windowlessHost() {
    const hostId = windowlessLink();
    const launched: ThrowawayCallAnswer = {
      status: "done",
      result: {
        tool: "throwaway.launch",
        run: {
          runId: "run-1",
          agentId: "claude",
          startedAt: 1_000,
          ageMs: 0,
          timeLimitMs: TEN_MINUTES,
          expiresAt: 1_000 + TEN_MINUTES,
          state: "running",
          endedAt: null,
          endReason: null,
        },
      },
    };
    const throwawayRelease = vi.fn(async () => {});
    const client = {
      relayCall: vi.fn(),
      throwawayCall: vi.fn(async () => launched),
      throwawayRelease,
    };
    teardown.push(
      registerRemoteService("hostControlLinkClient", client as unknown as HostControlLinkClient),
      installHostControl({
        observeHosts: () => [host(hostId, "connected")],
        isHostControlEnabled: () => true,
      }),
      manager!.addUseCheck(assistantsUseHost)
    );
    runLocally("proj-1", 0, "a");
    manager!.connect(hostId);
    const launch = () =>
      (hostControl.runtime as HostCallRuntime).call(
        "a",
        {
          hostId,
          throwaway: true,
          tool: "throwaway.launch",
          args: { agentId: "claude", timeLimitMs: TEN_MINUTES },
        },
        { tier: "core" }
      );
    return { hostId, launch, throwawayRelease };
  }

  /** The same Shell, its assistant having launched an agent in the host's copy of a project (#16492). */
  function agentLaunchedOnHost(tool = "agent.launch") {
    const hostId = windowlessLink();
    let listed = ["t-1"];
    const listAgentTargets = vi.fn(async () => ({
      targets: listed.map((terminalId) => ({
        hostId,
        terminalId,
        title: "Claude",
        projectId: "proj-2",
        projectName: "helios",
        agentId: "claude",
        agentState: "idle" as const,
      })),
      complete: true,
    }));
    const answer: McpCallAnswer = {
      status: "done",
      result: { isError: false, structured: { launched: true, terminalId: "t-1" }, text: null },
    };
    const client = { relayCall: vi.fn(async () => answer), throwawayCall: vi.fn() };
    teardown.push(
      registerRemoteService("hostControlLinkClient", client as unknown as HostControlLinkClient),
      installHostControl({
        observeHosts: () => [host(hostId, "connected")],
        isHostControlEnabled: () => true,
        listAgentTargets,
      }),
      manager!.addUseCheck(assistantsUseHost)
    );
    runLocally("proj-1", 0, "a");
    manager!.connect(hostId);
    const launch = () =>
      (hostControl.runtime as HostCallRuntime).call(
        "a",
        { hostId, projectId: "proj-2", tool, args: { agentId: "claude", prompt: "Fix it" } },
        { tier: "core" }
      );
    const agentEnds = () => {
      listed = [];
    };
    return { hostId, launch, agentEnds, listAgentTargets };
  }

  it("is the link client's use check, until it is uninstalled", () => {
    vi.useRealTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-link-client-"));
    const sqlite = openDb(path.join(dir, "shell.db"), migrationsFolder).sqlite;
    sharedDb.sqlite = sqlite;
    teardown.push(() => {
      sharedDb.sqlite = null;
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const holding = new Set(["studio"]);
    teardown.push(
      registerRemoteService("hostCallRelayClient", {
        hasCallInFlight: () => false,
        awaitsNotices: () => false,
        holdsThrowawayRuns: (hostId: string) => holding.has(hostId),
        holdsLaunchedAgents: () => false,
      } as never)
    );
    let check: ((hostId: string) => boolean) | undefined;
    const offCheck = vi.fn();
    const off = installHostControlLinkClient({
      session: async () => null,
      onSessionOpened: () => () => {},
      knownHosts: () => [],
      onHostsChanged: () => () => {},
      addUseCheck: (registered) => {
        check = registered;
        return offCheck;
      },
      hostName: (hostId) => hostId,
    });
    expect(check?.("studio")).toBe(true);
    expect(check?.("other")).toBe(false);
    holding.clear();
    expect(check?.("studio")).toBe(false);
    off();
    expect(offCheck).toHaveBeenCalledTimes(1);
  });

  it("keeps the link to a windowless host while a throwaway run there may still be going", async () => {
    const h = windowlessHost();
    await expect(h.launch()).resolves.toMatchObject({ ok: true, value: { outcome: "ok" } });
    // The assistant ends its turn: nothing calls the host again.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 30_000);
    expect(manager!.get(h.hostId)).toBeDefined();
    // Past its limit the run is over, and the link goes once unused for the
    // usual window, counted from the last sweep that found the run held.
    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_MS - 30_000);
    expect(manager!.get(h.hostId)).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager!.get(h.hostId)).toBeUndefined();
  });

  it("keeps the link to a windowless host while an agent its assistant launched there is listed (#16492)", async () => {
    const h = agentLaunchedOnHost();
    await expect(h.launch()).resolves.toMatchObject({ ok: true, value: { outcome: "ok" } });
    // No notice was asked for and nothing calls the host again: only the agent uses it.
    await vi.advanceTimersByTimeAsync(3 * IDLE_RELEASE_MS);
    expect(manager!.get(h.hostId)).toBeDefined();
    expect(h.listAgentTargets).toHaveBeenCalledWith(h.hostId);
    // Once the host has stopped listing it for a while, the link goes after
    // the usual window unused, counted from the last sweep that found it held.
    h.agentEnds();
    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_MS + LAUNCHED_AGENT_GONE_MS);
    expect(manager!.get(h.hostId)).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager!.get(h.hostId)).toBeUndefined();
  });

  it("releases a link the assistant only read through as usual, with no agents launched there", async () => {
    const h = agentLaunchedOnHost("terminal.list");
    await h.launch();
    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_MS + 30_000);
    expect(manager!.get(h.hostId)).toBeUndefined();
    expect(h.listAgentTargets).not.toHaveBeenCalled();
  });

  it("releases the link as usual once the session that launched the run ends", async () => {
    const h = windowlessHost();
    await h.launch();
    await vi.advanceTimersByTimeAsync(60_000);
    for (const listener of ended) {
      listener({ projectId: "proj-1", slot: 0, sessionId: "a", reason: "revoked" });
    }
    expect(h.throwawayRelease).toHaveBeenCalledWith(h.hostId, { helpSessionId: "a" });
    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_MS + 30_000);
    expect(manager!.get(h.hostId)).toBeUndefined();
  });
});

describe("installRetiredSendsNotice (#13496)", () => {
  let dir: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-retired-sends-"));
    sqlite = openDb(path.join(dir, "shell.db"), migrationsFolder).sqlite;
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function journal(
    hostId: string,
    messageId: string,
    entry: { state?: string; unresolved?: boolean; expiresAt?: number }
  ): void {
    const record =
      entry.state === undefined
        ? null
        : JSON.stringify({ state: entry.state, expiresAt: entry.expiresAt ?? Date.now() + 60_000 });
    sqlite
      .prepare(
        "INSERT INTO assistant_exchange_journal (host_id, message_id, sent_at, unresolved_at, record, updated_at) VALUES (?, ?, 1, ?, ?, 1)"
      )
      .run(hostId, messageId, entry.unresolved ? 5 : null, record);
  }
  const journalled = () =>
    (sqlite.prepare("SELECT COUNT(*) AS n FROM assistant_exchange_journal").get() as { n: number })
      .n;
  const names = (hostId: string) => (hostId === "studio" ? "studio-01" : hostId);

  it("forgets a journal with nothing open, telling no one", () => {
    journal("studio", "m-done", { state: "completed" });
    journal("studio", "m-expired", { state: "working", expiresAt: 1 });
    runLocally("proj-1", 0, "hub");
    installRetiredSendsNotice(sqlite, { hostName: names })();
    expect(queued).toEqual([]);
    expect(journalled()).toBe(0);
  });

  it("tells the first of this machine's assistants what will get no reply, then forgets it", async () => {
    journal("studio", "m-open", { state: "working" });
    journal("studio", "m-unknown", { unresolved: true });
    journal("laptop", "m-asked", { state: "input-required" });
    journal("laptop", "m-done", { state: "completed" });
    const off = installRetiredSendsNotice(sqlite, { hostName: names });

    // Nobody here to tell yet: the records stay.
    await vi.advanceTimersByTimeAsync(0);
    expect(queued).toEqual([]);
    expect(journalled()).toBe(4);

    runLocally("proj-1", 0, "hub");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toHaveLength(1);
    const [{ lane, wake }] = queued;
    expect(lane).toEqual({ helpSessionId: "hub", terminalId: "t-hub", projectId: "proj-1" });
    expect(wake.kind).toBe("retired");
    expect(wake.retired).toEqual([
      { hostName: "laptop", count: 1 },
      { hostName: "studio-01", count: 2 },
    ]);
    expect(wake.recheck()).toEqual({ kind: "ready" });

    wake.report({ kind: "delivered" });
    expect(journalled()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queued).toHaveLength(1);
    off();
  });

  it("keeps the records for another try when the line couldn't be typed", async () => {
    journal("studio", "m-open", { state: "working" });
    runLocally("proj-1", 0, "hub");
    const off = installRetiredSendsNotice(sqlite, { hostName: names });
    await vi.advanceTimersByTimeAsync(0);
    expect(queued).toHaveLength(1);

    // The run was replaced meanwhile: this line was its, so it is not typed elsewhere.
    generations.set("t-hub", 2);
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
    queued[0]!.wake.report({ kind: "unavailable", reason: "relaunched" });
    expect(journalled()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toHaveLength(2);
    // A line that may have been typed is never typed again.
    queued[1]!.wake.report({ kind: "ambiguous", reason: "unconfirmed" });
    expect(journalled()).toBe(0);
    off();
  });

  it("waits out a held line, and tries again once it expires unsent", async () => {
    journal("studio", "m-open", { state: "working" });
    runLocally("proj-1", 0, "hub");
    const off = installRetiredSendsNotice(sqlite, { hostName: names });
    await vi.advanceTimersByTimeAsync(0);
    expect(queued).toHaveLength(1);

    queued[0]!.wake.report({ kind: "held", reason: "driven-elsewhere" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toHaveLength(1);

    queued[0]!.wake.report({ kind: "unavailable", reason: "expired" });
    expect(journalled()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toHaveLength(2);
    off();
  });

  it("never tells an assistant no view here shows, or one a remote Shell's view runs", async () => {
    journal("studio", "m-open", { state: "working" });
    runLocally("proj-1", 0, "detached");
    detached.add("proj-1:0");
    running.set("proj-2:0", {
      sessionId: "remote",
      terminalId: "t-remote",
      projectViewWebContentsId: -3,
    });
    const off = installRetiredSendsNotice(sqlite, { hostName: names });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toEqual([]);
    expect(journalled()).toBe(1);
    off();
  });
});

describe("installHostControlLinkClient forgetting a host's credential (#17207)", () => {
  const teardown: Array<() => void> = [];

  afterEach(() => {
    for (const off of teardown.splice(0).reverse()) off();
  });

  function linkClient(retiring: Set<string>): HostControlLinkClient {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-link-credential-"));
    const sqlite = openDb(path.join(dir, "shell.db"), migrationsFolder).sqlite;
    sharedDb.sqlite = sqlite;
    teardown.push(() => {
      sharedDb.sqlite = null;
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    teardown.push(
      installHostControlLinkClient({
        session: async () => null,
        onSessionOpened: () => () => {},
        // Re-pointing keeps the id: the host is still in the list throughout.
        knownHosts: () => ["studio", "other"],
        onHostsChanged: () => () => {},
        hostName: (hostId) => hostId,
        isRetiring: (hostId) => retiring.has(hostId),
      })
    );
    return getRemoteService("hostControlLinkClient")!;
  }

  it("mints a fresh one for the next machine under the same id, leaving other hosts' alone", () => {
    const client = linkClient(new Set());
    const before = client.pluginCredential("studio");
    const beforeSender = client.senderIdOf("studio");
    const other = client.pluginCredential("other");
    expect(beforeSender).not.toBeNull();

    client.forgetHost("studio");

    expect(client.senderIdOf("studio")).toBeNull();
    expect(client.pluginCredential("studio")).not.toBe(before);
    expect(client.senderIdOf("studio")).not.toBe(beforeSender);
    expect(client.pluginCredential("other")).toBe(other);
  });

  it("neither mints nor presents one while the host is being re-pointed", () => {
    const retiring = new Set<string>();
    const client = linkClient(retiring);
    client.pluginCredential("studio");
    retiring.add("studio");

    // A link still up meanwhile reaches the old machine: it is shown nothing.
    expect(() => client.pluginCredential("studio")).toThrow();
    expect(client.senderIdOf("studio")).toBeNull();
    client.forgetHost("studio");
    expect(() => client.pluginCredential("studio")).toThrow();

    retiring.delete("studio");
    expect(client.pluginCredential("studio")).toEqual(expect.any(String));
    expect(client.senderIdOf("studio")).not.toBeNull();
  });
});
