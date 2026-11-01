import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const running = vi.hoisted(
  () =>
    new Map<string, { sessionId: string; terminalId: string; projectViewWebContentsId: number }>()
);
/** Running lanes whose session no view has attached, by lane key. */
const detached = vi.hoisted(() => new Set<string>());
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
vi.mock("../../../services/globalAssistant.js", () => ({
  peekGlobalAssistantService: () => null,
}));
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
import type { ThrowawayCallAnswer } from "../linkMethods.js";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry } from "../../client/HostRegistry.js";
import { IDLE_RELEASE_MS, RemoteHostManager } from "../../client/RemoteHostManager.js";
import { TransportError } from "../../client/transport.js";

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
  function windowlessHost() {
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
        observeHosts: () => [host(studio.id, "connected")],
        isHostControlEnabled: () => true,
      }),
      manager.addUseCheck(assistantsUseHost)
    );
    runLocally("proj-1", 0, "a");
    manager.connect(studio.id);
    const launch = () =>
      (hostControl.runtime as HostCallRuntime).call(
        "a",
        {
          hostId: studio.id,
          throwaway: true,
          tool: "throwaway.launch",
          args: { agentId: "claude", timeLimitMs: TEN_MINUTES },
        },
        { tier: "core" }
      );
    return { hostId: studio.id, launch, throwawayRelease };
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
