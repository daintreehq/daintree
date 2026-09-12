import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssistantTimerService } from "../AssistantTimerService.js";
import { DaemonUnavailableError, daemonCall } from "../DaemonTimerClient.js";

/**
 * Reaching a project's timers with no engine running.
 *
 * The distinction every test here is about: "nobody could be asked" is NOT "nothing
 * is scheduled". A project whose daemon has not started, or whose socket has gone,
 * must never render as an empty timer list — that tells a user their overnight timer
 * is gone at the exact moment it is closest to firing.
 *
 * The server here speaks the daemon's real control framing (NDJSON request/response
 * correlated by id) rather than mocking the client, so the framing itself is covered.
 */

let server: Server | undefined;
let socketPath = "";
let dir = "";

/** Stands up a fake daemon that answers with `reply`, or refuses with `error`. */
function daemon(
  handler: (
    type: string,
    payload: unknown
  ) => { ok: true; payload: unknown } | { ok: false; error: string }
) {
  return new Promise<void>((resolve) => {
    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line) as { id: string; type: string; payload?: unknown };
          const result = handler(req.type, req.payload);
          socket.write(`${JSON.stringify({ v: 1, id: req.id, ...result })}\n`);
        }
      });
    });
    server.listen(socketPath, resolve);
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dt-timers-"));
  socketPath = path.join(dir, "d.sock");
});

afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const VIEW = {
  id: "tmr_1",
  title: "Nightly deploy check",
  nextFireAt: 1700000000000,
  createdAt: 1699999000000,
  payloadKind: "tool_call" as const,
  toolName: "agentTask.spawnForEdits",
  runCount: 2,
  repeat: { everyMs: 86400000, maxRuns: 7 },
  target: { worktreeId: "/p/app" },
  liveGrants: 2,
  grantsUnknown: false,
};

describe("reading a project's timers with no engine running", () => {
  it("normalises the daemon's view onto the same row the host protocol serves", async () => {
    await daemon(() => ({
      ok: true,
      payload: { timers: [VIEW], outcomes: [], takenAtMs: 42 },
    }));
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });

    const result = await service.list("p1");
    expect(result.available).toBe(true);
    // ONE row shape reaches the renderer whichever transport answered, so the manager
    // cannot grow two rendering paths that drift.
    expect(result.timers[0]).toEqual({
      id: "tmr_1",
      label: "Nightly deploy check",
      dueAt: 1700000000000,
      createdAt: 1699999000000,
      payloadKind: "tool_call",
      toolName: "agentTask.spawnForEdits",
      runCount: 2,
      repeatEveryMs: 86400000,
      repeatMaxRuns: 7,
      // The daemon OMITS what it does not have; the wire uses 0. A renderer must not
      // have to tell the two conventions apart.
      repeatUntilAt: 0,
      targetWorktreeId: "/p/app",
      targetTerminalId: "",
      liveGrants: 2,
      grantsUnknown: false,
    });
    expect(result.takenAt).toBe(42);
  });

  it("reports an unreachable daemon as unavailable, never as an empty list", async () => {
    // The failure this whole field exists to prevent: a socket that is not there
    // rendering as "you have no timers".
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });
    const result = await service.list("p1");
    expect(result.available).toBe(false);
    expect(result.timers).toEqual([]);
    expect(result.reason).toContain("No background supervisor");
  });

  it("reports a project it has never seen an engine for as unavailable", async () => {
    const result = await new AssistantTimerService().list("never-opened");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("has not seen this project's assistant");
  });

  it("carries a daemon's refusal through rather than calling it empty", async () => {
    // "Not holding the project" means an attached session took the lease — a real
    // answer, and the caller's cue to route there instead.
    await daemon(() => ({ ok: false, error: "this daemon is not holding the project" }));
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });
    const result = await service.list("p1");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("not holding the project");
  });

  it("distinguishes a daemon that answers with nothing from one that cannot answer", async () => {
    await daemon(() => ({ ok: true, payload: { timers: [], outcomes: [], takenAtMs: 7 } }));
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });
    const result = await service.list("p1");
    // Available with nothing in it: the project genuinely has no pending work.
    expect(result.available).toBe(true);
    expect(result.timers).toEqual([]);
  });
});

describe("cancelling with no engine running", () => {
  it("sends the id and returns what the daemon did", async () => {
    let seen: unknown;
    await daemon((type, payload) => {
      seen = { type, payload };
      return {
        ok: true,
        payload: {
          timerId: "tmr_1",
          cancelled: true,
          alreadyInactive: false,
          priorStatus: "scheduled",
          revokedGrants: 2,
          grantRevokeFailed: false,
          contended: false,
        },
      };
    });
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });

    const result = await service.cancel("p1", "tmr_1");
    expect(seen).toEqual({ type: "timer_cancel", payload: { timerId: "tmr_1" } });
    expect(result.cancelled).toBe(true);
    expect(result.revokedGrants).toBe(2);
  });

  // Unlike a list, a cancel THROWS when it could not happen. A mutation that did not
  // occur must never settle as though it had.
  it("throws when there is no daemon to cancel through", async () => {
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });
    await expect(service.cancel("p1", "tmr_1")).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it("throws when the project was never seen", async () => {
    await expect(new AssistantTimerService().cancel("nope", "tmr_1")).rejects.toBeInstanceOf(
      DaemonUnavailableError
    );
  });

  it("throws the daemon's own refusal", async () => {
    await daemon(() => ({ ok: false, error: "no timer with id tmr_gone" }));
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath, stateDir: dir });
    await expect(service.cancel("p1", "tmr_gone")).rejects.toThrow("no timer with id tmr_gone");
  });
});

describe("the endpoint the engine reports", () => {
  it("is ignored when it names no socket", () => {
    // Nothing to remember is better than a half-entry that later resolves to a path
    // that was never real.
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { stateDir: "/tmp/x" });
    expect(service.endpointFor("p1")).toBeUndefined();
  });

  it("is replaced when an engine reports a new one", () => {
    const service = new AssistantTimerService();
    service.rememberEndpoint("p1", 0, { socketPath: "/tmp/a.sock", stateDir: "/a" });
    service.rememberEndpoint("p1", 0, { socketPath: "/tmp/b.sock", stateDir: "/b" });
    expect(service.endpointFor("p1")?.socketPath).toBe("/tmp/b.sock");
  });
});

describe("the control framing", () => {
  it("rejects a malformed frame rather than hanging", async () => {
    server = createServer((socket) => socket.end("not json\n"));
    await new Promise<void>((r) => server!.listen(socketPath, r));
    await expect(daemonCall(socketPath, "timers")).rejects.toBeInstanceOf(DaemonUnavailableError);
  });
});
