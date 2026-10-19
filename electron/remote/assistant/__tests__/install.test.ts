import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const running = vi.hoisted(
  () =>
    new Map<string, { sessionId: string; terminalId: string; projectViewWebContentsId: number }>()
);
/** Running lanes whose session no view has attached, by lane key. */
const detached = vi.hoisted(() => new Set<string>());
/** Which project each of this machine's views shows, by WebContents id. */
const views = vi.hoisted(() => new Map<number, string>());
const runbooksHostState = vi.hoisted(() => ({ read: null as (() => unknown) | null }));
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

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getRunningLaneSession: (projectId: string, slot: number) =>
      running.get(`${projectId}:${slot}`) ?? null,
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
      for (const [key, run] of running) {
        if (run.sessionId !== helpSessionId) continue;
        const [projectId, slot] = key.split(":");
        return { projectId: projectId!, slot: Number(slot) };
      }
      return null;
    },
    getWebContentsIdForSessionId: (helpSessionId: string) =>
      [...running.values()].find((run) => run.sessionId === helpSessionId)
        ?.projectViewWebContentsId ?? null,
    setRunbooksHostState: (read: (() => unknown) | null) => {
      runbooksHostState.read = read;
    },
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({ getLiveGeneration: (id: string) => generations.get(id) ?? null }),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: (id: number) => views.get(id) ?? null,
}));
vi.mock("../../../services/McpServerService.js", () => ({
  mcpServerService: {
    queueLaneWake: (lane: (typeof queued)[number]["lane"], wake: (typeof queued)[number]["wake"]) =>
      queued.push({ lane, wake }),
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
import { getRemoteService } from "../../runtime.js";
import type { ObservedHost } from "../HostCallRuntime.js";
import {
  installHostControl,
  installRetiredSendsNotice,
  observedRunbooksHostsState,
} from "../install.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

function host(hostId: string, status: "connected" | "disconnected"): ObservedHost {
  return {
    hostId,
    name: hostId,
    connection:
      status === "connected"
        ? { status, rttMs: 1, handshake: {} as never }
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
  runbooksHostState.read = null;
  hostControl.runtime = null;
});

describe("observedRunbooksHostsState (#13411, #13496)", () => {
  const controlled = (hostId: string) => hostId === "studio";

  it("names connected for a controlled host the assistant reaches now or on its next call", () => {
    expect(observedRunbooksHostsState(false, null, controlled)).toBe("none");
    expect(observedRunbooksHostsState(true, null, controlled)).toBeNull();
    expect(observedRunbooksHostsState(true, [host("studio", "connected")], controlled)).toBe(
      "connected"
    );
    // No link held, as after the idle release or before the first call: dialled on demand.
    expect(observedRunbooksHostsState(true, [host("studio", "disconnected")], controlled)).toBe(
      "connected"
    );
    const connecting: ObservedHost = {
      ...host("studio", "disconnected"),
      connection: { status: "connecting", attempt: 1 },
    };
    expect(observedRunbooksHostsState(true, [connecting], controlled)).toBe("connected");
    // A host whose switch is off counts for nothing, whatever its link does.
    expect(
      observedRunbooksHostsState(true, [{ ...connecting, hostId: "laptop" }], controlled)
    ).toBe("configured");
  });

  it("names configured when every controlled host's link said why it is down", () => {
    const down: ObservedHost = {
      ...host("studio", "disconnected"),
      connection: { status: "unreachable", lastSeenAt: null, detail: "ssh: no route" },
    };
    expect(observedRunbooksHostsState(true, [down, host("laptop", "connected")], controlled)).toBe(
      "configured"
    );
  });
});

describe("installHostControl (#13493)", () => {
  it("installs the host tools' runtime and tells runbook search what it sees, until torn down", () => {
    const hosts = [host("studio", "connected")];
    const off = installHostControl({
      observeHosts: () => hosts,
      hasHosts: () => true,
      isHostControlEnabled: () => true,
    });
    expect(hostControl.runtime).not.toBeNull();
    expect(getRemoteService("hostCallRelayClient")).toBe(hostControl.runtime);
    expect(runbooksHostState.read?.()).toBe("connected");

    off();
    expect(hostControl.runtime).toBeNull();
    expect(getRemoteService("hostCallRelayClient")).toBeUndefined();
    expect(runbooksHostState.read).toBeNull();
  });

  it("offers the host tools only to an assistant in one of this machine's own views", () => {
    const off = installHostControl({
      observeHosts: () => [],
      hasHosts: () => false,
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
