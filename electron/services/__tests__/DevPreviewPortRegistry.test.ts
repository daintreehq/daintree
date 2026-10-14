/**
 * Adversarial tests for DevPreviewSessionService's port registry, the predictedUrl
 * it advertises, and the worktreeToSession map. Each test pins one invariant that
 * broke (or could break) in a specific code path; the bug letters are referenced
 * from the round comments below.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import { probePortFree } from "../DevPreviewPortAllocator.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

// ─── net mock ────────────────────────────────────────────────────────────────
// allocatePort() uses net.createServer to probe port availability.
// Without this mock every ensure() call makes real socket binds, slowing the
// suite and making it flaky on busy CI machines.
let _nextPort = 3100;

vi.mock("node:net", () => {
  const makeServer = () => {
    type Cb = () => void;
    const handlers: Record<string, Cb[]> = {};
    const srv = {
      unref: vi.fn(() => srv),
      once: vi.fn((event: string, cb: Cb) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(cb);
        return srv;
      }),
      listen: vi.fn((_options: { port: number; host: string; ipv6Only?: boolean }, cb: Cb) => {
        cb();
        return srv;
      }),
      close: vi.fn((cb?: Cb) => {
        cb?.();
        return srv;
      }),
      address: vi.fn(() => ({ port: _nextPort++ })),
    };
    return srv;
  };
  return {
    default: { createServer: vi.fn(makeServer) },
    createServer: vi.fn(makeServer),
  };
});

// ─── helpers ─────────────────────────────────────────────────────────────────

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;
type MockIncomingMessage = { statusCode?: number; resume: () => void };
type MockRequest = {
  on: (event: "error" | "timeout", handler: (...args: unknown[]) => void) => MockRequest;
  end: () => void;
  destroy: () => void;
};

function mockHttpResponse(statusCode: number) {
  const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
    const req: MockRequest = {
      on: () => req,
      end: () => cb({ statusCode, resume: () => {} }),
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

/** Makes every readiness HTTP request immediately fail at the transport level. */
function mockHttpConnectionRefused() {
  const impl = ((_url: unknown, _opts: unknown, _cb: unknown) => {
    let errorCb: ((...args: unknown[]) => void) | null = null;
    const req: MockRequest = {
      on: (event, handler) => {
        if (event === "error") errorCb = handler;
        return req;
      },
      end: () => {
        errorCb?.(new Error("connect ECONNREFUSED 127.0.0.1:5500"));
      },
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

/**
 * A server that accepts the connection and never answers, so the readiness poll
 * stays in flight for the whole test. dispose() aborts it in afterEach.
 */
function mockHttpNeverResponds() {
  const impl = ((_: unknown, __: unknown, _cb: (res: MockIncomingMessage) => void) => {
    const req: MockRequest = {
      on: () => req,
      end: () => {},
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

function createPtyClientMock() {
  const dataListeners = new Set<DataListener>();
  const exitListeners = new Set<ExitListener>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();
  const spawnCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];

  return {
    on: vi.fn((event: string, cb: DataListener | ExitListener) => {
      if (event === "data") dataListeners.add(cb as DataListener);
      if (event === "exit") exitListeners.add(cb as ExitListener);
    }),
    off: vi.fn((event: string, cb: DataListener | ExitListener) => {
      if (event === "data") dataListeners.delete(cb as DataListener);
      if (event === "exit") exitListeners.delete(cb as ExitListener);
    }),
    spawn: vi.fn((id: string, opts: Record<string, unknown>) => {
      terminals.set(id, { projectId: opts.projectId as string | undefined, hasPty: true });
      spawnCalls.push({ id, opts });
    }),
    kill: vi.fn((id: string) => {
      const t = terminals.get(id);
      if (t) t.hasPty = false;
    }),
    submit: vi.fn(),
    hasTerminal: vi.fn((id: string) => terminals.get(id)?.hasPty ?? false),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async () => 0),
    getTerminalAsync: vi.fn(async (id: string) => {
      const t = terminals.get(id);
      if (!t) return null;
      return { id, projectId: t.projectId, hasPty: t.hasPty, cwd: "/repo", spawnedAt: Date.now() };
    }),
    // test helpers
    emitData(id: string, data: string) {
      for (const cb of dataListeners) cb(id, data);
    },
    emitExit(id: string, code: number) {
      const t = terminals.get(id);
      if (t) t.hasPty = false;
      for (const cb of exitListeners) cb(id, code);
    },
    spawnCalls,
  };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("DevPreviewSessionService — port registry and predictedUrl (adversarial)", () => {
  const base = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };
  const project = { projectId: "project-1", cwd: "/repo", devCommand: "npm run dev" };

  let broadcasts: DevPreviewSessionState[];
  let onStateChanged: ReturnType<typeof vi.fn>;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;

  beforeEach(() => {
    _nextPort = 3100;
    broadcasts = [];
    onStateChanged = vi.fn((state: DevPreviewSessionState) => broadcasts.push(state));
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged as unknown as (state: DevPreviewSessionState) => void
    );
    mockHttpResponse(200);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Round 1 — A: caller env.PORT must not beat the allocated port; C/D: predictedUrl
  // stale after clean exit / install failure; G: worktreeToSession stale after
  // stopByPanel; H: port reused across restarts.
  describe("allocation and exit paths", () => {
    // ── Bug A ──────────────────────────────────────────────────────────────────
    it("BUG-A: predictedUrl matches the port injected into the spawn env — caller env.PORT must not override", async () => {
      // If the spread is wrong ({ PORT: allocated, ...session.env }), then
      // session.env.PORT=9000 wins and the spawn env gets PORT=9000 while
      // predictedUrl still says http://localhost:3100 → mismatch.
      const state = await service.ensure({
        ...base,
        worktreeId: "wt-1",
        env: { PORT: "9000" },
      });

      expect(state.predictedUrl).toBeTruthy();
      const allocatedPort = state.predictedUrl!.replace("http://localhost:", "");

      const lastSpawn = ptyClient.spawnCalls[ptyClient.spawnCalls.length - 1];
      const spawnedPort = (lastSpawn.opts.env as Record<string, string>).PORT;

      // The port in predictedUrl must equal the port that was actually injected.
      // Fails if the spread is reversed (caller env.PORT wins).
      expect(spawnedPort).toBe(allocatedPort);
    });

    // ── Bug C ──────────────────────────────────────────────────────────────────
    it("BUG-C: predictedUrl is cleared when the terminal exits cleanly (zero exit from running state)", async () => {
      mockHttpResponse(200);
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      // Emit URL so status transitions to running
      ptyClient.emitData(state.terminalId!, "ready at http://localhost:5173\n");
      await new Promise((r) => setTimeout(r, 10));

      // Clean exit from running state
      ptyClient.emitExit(state.terminalId!, 0);

      const after = service.getState(base);
      // handleExit stopped-path does not clear predictedUrl → this assertion will fail
      expect(after.predictedUrl).toBeNull();
    });

    // ── Bug D ──────────────────────────────────────────────────────────────────
    it("BUG-D: predictedUrl is cleared when install subprocess exits with failure", async () => {
      // Trigger install path: emit missing-dependencies error, then exit triggers install
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      // Emit a missing-dependencies error to set needsInstall = true
      ptyClient.emitData(
        state.terminalId!,
        "npm error: Cannot find module\nError: Cannot find module"
      );
      await new Promise((r) => setTimeout(r, 10));

      // Mark as install subprocess running (simulate the install terminal exit with failure)
      // The service sets isRunningInstall=true when runInstall is triggered.
      // Exit with failure code should clear predictedUrl.
      ptyClient.emitExit(state.terminalId!, 1);
      await new Promise((r) => setTimeout(r, 20));

      const after = service.getState(base);
      // handleExit install-failure path does not clear predictedUrl
      expect(after.predictedUrl).toBeNull();
    });

    // ── Bug G ──────────────────────────────────────────────────────────────────
    it("BUG-G: getByWorktree returns null after stopByPanel removes the session", async () => {
      await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(service.getByWorktree("wt-1")).not.toBeNull();

      await service.stopByPanel({ panelId: base.panelId });

      // Session deleted from sessions map; worktreeToSession stale entry must not cause
      // getByWorktree to return a ghost state.
      const result = service.getByWorktree("wt-1");
      expect(result).toBeNull();
    });

    // ── Regression H ──────────────────────────────────────────────────────────
    it("REGRESSION-H: restart reuses the same port (no orphaned allocations)", async () => {
      const first = await service.ensure({ ...base, worktreeId: "wt-1" });
      const portBefore = first.predictedUrl;
      expect(portBefore).toBeTruthy();

      // Measure one availability check so this invariant is independent of the
      // address families and binding modes the allocator must probe.
      const callsAfterEnsure = vi.mocked(net.createServer).mock.calls.length;
      expect(callsAfterEnsure).toBeGreaterThanOrEqual(1);
      await probePortFree(Number(new URL(portBefore!).port));
      const callsBeforeRestart = vi.mocked(net.createServer).mock.calls.length;
      const callsPerProbe = callsBeforeRestart - callsAfterEnsure;

      await service.restart(base);
      const second = service.getState(base);

      // The same port should be reused after restart.
      expect(second.predictedUrl).toBe(portBefore);
      // allocatePort returned early from registry (no allocation probe), but
      // restart now also calls waitForPortFree, which confirms the old PTY
      // released the port on every address a dev server could hold it — one
      // socket per PROBE_ADDRESSES entry. allocatePort itself does no extra work.
      const callsAfterRestart = vi.mocked(net.createServer).mock.calls.length;
      expect(callsAfterRestart - callsBeforeRestart).toBe(callsPerProbe);
    });

    it("getByWorktree returns null for session ensured without worktreeId", async () => {
      await service.ensure(base); // no worktreeId
      expect(service.getByWorktree("any-wt")).toBeNull();
    });
  });

  // Round 2 — I/J/K: stop broadcasts carried a stale predictedUrl (stopByPanel,
  // stopByProject, and stopByPanel's error-catch branch).
  describe("stop broadcasts", () => {
    // ── Bug I ──────────────────────────────────────────────────────────────────
    it("BUG-I: last onStateChanged broadcast from stopByPanel has predictedUrl: null", async () => {
      // Ensure a session so predictedUrl is populated.
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      broadcasts.length = 0; // reset — watch only stop broadcasts

      await service.stopByPanel({ panelId: base.panelId });

      // At least one broadcast must have been emitted for the stop.
      expect(broadcasts.length).toBeGreaterThan(0);

      // The final broadcast must have predictedUrl: null.
      // Fails when updateSession({ status: "stopped", ... }) omits predictedUrl: null.
      const lastBroadcast = broadcasts[broadcasts.length - 1];
      expect(lastBroadcast.predictedUrl).toBeNull();
    });

    // ── Bug J ──────────────────────────────────────────────────────────────────
    it("BUG-J: last onStateChanged broadcast from stopByProject has predictedUrl: null", async () => {
      await service.ensure({ ...base, worktreeId: "wt-1" });

      broadcasts.length = 0;

      await service.stopByProject(base.projectId);

      expect(broadcasts.length).toBeGreaterThan(0);

      // Fails when updateSession({ status: "stopped", ... }) in stopByProject omits predictedUrl.
      const lastBroadcast = broadcasts[broadcasts.length - 1];
      expect(lastBroadcast.predictedUrl).toBeNull();
    });

    // ── Bug K ──────────────────────────────────────────────────────────────────
    it("BUG-K: onStateChanged broadcast from stopByPanel error-catch has predictedUrl: null", async () => {
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      // Make stopSessionTerminal throw by killing the pty then making kill() throw.
      ptyClient.kill.mockImplementationOnce(() => {
        throw new Error("kill failed");
      });

      broadcasts.length = 0;

      // stopByPanel will hit the catch branch.
      await service.stopByPanel({ panelId: base.panelId });

      // Must have emitted at least one broadcast for the error state.
      expect(broadcasts.length).toBeGreaterThan(0);

      // The final broadcast must have predictedUrl: null.
      // Fails when the catch-branch updateSession({ status: "error", ... }) omits predictedUrl: null.
      const lastBroadcast = broadcasts[broadcasts.length - 1];
      expect(lastBroadcast.predictedUrl).toBeNull();
    });

    // ── Positive baselines ─────────────────────────────────────────────────────
    it("stopByPanel broadcasts status: stopped", async () => {
      await service.ensure({ ...base, worktreeId: "wt-1" });
      broadcasts.length = 0;

      await service.stopByPanel({ panelId: base.panelId });

      expect(broadcasts.length).toBeGreaterThan(0);
      expect(broadcasts[broadcasts.length - 1].status).toBe("stopped");
    });

    it("stopByProject broadcasts status: stopped", async () => {
      await service.ensure({ ...base, worktreeId: "wt-1" });
      broadcasts.length = 0;

      await service.stopByProject(base.projectId);

      expect(broadcasts.length).toBeGreaterThan(0);
      expect(broadcasts[broadcasts.length - 1].status).toBe("stopped");
    });
  });

  // Round 3 — predictedUrl leaked through every error path: N spawn throw, P ensure
  // with a blank command, Q restart with a stored blank command, R non-dependency
  // error output, S install spawn throw, T readiness poll timeout.
  describe("error broadcasts", () => {
    // ── Bug N ──────────────────────────────────────────────────────────────────
    it("BUG-N: predictedUrl is null in error broadcast when spawn throws", async () => {
      // First ensure succeeds and sets predictedUrl on the session.
      const first = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(first.predictedUrl).toBeTruthy();

      // Stop the session so the port stays allocated but the terminal is gone.
      // Next ensure will call spawnSessionTerminal again (spawn #2).
      await service.stop(base);

      // Make the second spawn throw.
      ptyClient.spawn.mockImplementationOnce(() => {
        throw new Error("PTY host crashed");
      });

      broadcasts.length = 0;

      // Re-ensure → spawnSessionTerminal sets predictedUrl then spawn throws.
      await service.ensure({ ...base, worktreeId: "wt-1", resumeUserStopped: true });

      // The error broadcast must have predictedUrl: null.
      // Fails if spawnSessionTerminal's catch omits predictedUrl: null.
      const errorBroadcast = broadcasts.find((b) => b.status === "error");
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast!.predictedUrl).toBeNull();
    });

    // ── Bug P ──────────────────────────────────────────────────────────────────
    it("BUG-P: predictedUrl is null in error broadcast from ensure() with blank devCommand", async () => {
      // Establish a running session so predictedUrl is populated.
      const first = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(first.predictedUrl).toBeTruthy();

      broadcasts.length = 0;

      // Re-ensure with an empty command → hits the commandError path.
      await service.ensure({ ...base, devCommand: "", worktreeId: "wt-1" });

      // The error broadcast must have predictedUrl: null.
      // Fails if ensure's commandError updateSession omits predictedUrl: null.
      const errorBroadcast = broadcasts.find((b) => b.status === "error");
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast!.predictedUrl).toBeNull();
    });

    // ── Bug Q ──────────────────────────────────────────────────────────────────
    it("BUG-Q: predictedUrl is null in error broadcast from restart() with stored blank devCommand", async () => {
      // Establish session with predictedUrl.
      await service.ensure({ ...base, worktreeId: "wt-1" });

      // Corrupt devCommand to blank via a second ensure (exercises Bug P path too,
      // but we are interested in restart here).
      await service.ensure({ ...base, devCommand: "", worktreeId: "wt-1" });

      broadcasts.length = 0;

      // restart() reads stored devCommand="" → hits the commandError path.
      await service.restart(base);

      // The error broadcast must have predictedUrl: null.
      // Fails if restart's commandError updateSession omits predictedUrl: null.
      const errorBroadcast = broadcasts.find((b) => b.status === "error");
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast!.predictedUrl).toBeNull();
    });

    // ── Bug R ──────────────────────────────────────────────────────────────────
    it("BUG-R: predictedUrl is null in error broadcast from EACCES output on terminal", async () => {
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      broadcasts.length = 0;

      // Emit a permission-denied pattern — detected as a non-missing-deps error.
      ptyClient.emitData(state.terminalId!, "Error: EACCES: permission denied /repo/server.js\n");
      await new Promise((r) => setTimeout(r, 10));

      // The error broadcast must have predictedUrl: null.
      // Fails if handleData's non-dep error updateSession omits predictedUrl: null.
      const errorBroadcast = broadcasts.find((b) => b.status === "error");
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast!.predictedUrl).toBeNull();
    });

    // ── Bug S ──────────────────────────────────────────────────────────────────
    it("BUG-S: predictedUrl is null in error broadcast when install spawn throws", async () => {
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      // Emit missing-deps output → needsInstall = true.
      ptyClient.emitData(state.terminalId!, "Error: Cannot find module 'express'\n");
      await new Promise((r) => setTimeout(r, 10));

      // Make the install spawn (second spawn call) throw.
      ptyClient.spawn.mockImplementationOnce(() => {
        throw new Error("PTY failed to start install");
      });

      broadcasts.length = 0;

      // Exit from the dev terminal → handleExit sees needsInstall → calls runInstall → spawn throws.
      ptyClient.emitExit(state.terminalId!, 1);
      await new Promise((r) => setTimeout(r, 30));

      // The error broadcast from the install-spawn failure must have predictedUrl: null.
      // Fails if runInstall's catch-path updateSession omits predictedUrl: null.
      const errorBroadcast = broadcasts.find((b) => b.status === "error");
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast!.predictedUrl).toBeNull();
    });

    // ── Bug T ──────────────────────────────────────────────────────────────────
    it("BUG-T: predictedUrl is null in error broadcast when readiness poll times out", async () => {
      vi.useFakeTimers();

      // Rebuild service under fake timers so Date.now() is controlled.
      service.dispose();
      broadcasts.length = 0;
      service = new DevPreviewSessionService(
        ptyClient as unknown as PtyClient,
        onStateChanged as unknown as (state: DevPreviewSessionState) => void
      );

      mockHttpConnectionRefused();

      // ensure() only uses the (mocked) net.createServer, no wall-clock sleeps.
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      broadcasts.length = 0;

      // Emit a localhost URL — triggers pollServerReadiness which will keep failing.
      ptyClient.emitData(state.terminalId!, "Local: http://localhost:3000\n");

      // Exhaust the 30-second readiness deadline by advancing fake time.
      // Each 500ms poll-interval timer fires, http fails, loop re-checks deadline.
      await vi.advanceTimersByTimeAsync(31_000);

      // The error broadcast must have predictedUrl: null.
      // Fails if pollServerReadiness's !ready branch omits predictedUrl: null.
      const errorBroadcast = broadcasts.find((b) => b.status === "error");
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast!.predictedUrl).toBeNull();
    });
  });

  // Round 4 — V: two panels sharing a worktreeId, the second's stop orphaned the
  // first; W: the dead-terminal path advertised a URL with no terminal; X: stop()
  // keeps the session discoverable but stopped.
  describe("worktreeToSession invariants", () => {
    it("BUG-V: getByWorktree still resolves panel-1 after panel-2 (same worktreeId) is stopped", async () => {
      // Panel 1 ensures with wt-1.
      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      expect(service.getByWorktree("wt-1")).not.toBeNull();
      expect(service.getByWorktree("wt-1")!.panelId).toBe("panel-1");

      // Panel 2 ensures with the SAME worktreeId — overwrites worktreeToSession["wt-1"].
      await service.ensure({ ...project, panelId: "panel-2", worktreeId: "wt-1" });
      expect(service.getByWorktree("wt-1")!.panelId).toBe("panel-2");

      // Panel 2 stops — its session is deleted.
      await service.stopByPanel({ panelId: "panel-2" });

      // Panel 1 is still running on wt-1. getByWorktree MUST find it.
      // Fails when worktreeToSession["wt-1"] still points to the deleted panel-2 key,
      // and the surviving panel-1 mapping is never restored.
      const result = service.getByWorktree("wt-1");
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe("panel-1");
    });

    it("BUG-V2: getByWorktree is null for worktreeId after stopByProject removes both panels", async () => {
      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      await service.ensure({ ...project, panelId: "panel-2", worktreeId: "wt-1" });

      await service.stopByProject(project.projectId);

      // Both sessions gone — getByWorktree must return null, not crash.
      expect(service.getByWorktree("wt-1")).toBeNull();
    });

    it("BUG-V3: after panel-2 steals wt-1 then stops, panel-1 getState still works normally", async () => {
      // This case asserts a transient status, so the readiness probe must not be
      // able to resolve underneath it. `mockHttpOk` would flip panel-1 to
      // "running" on the predicted-port poll, and only the latency of the old HMR
      // handshake was keeping that from happening inside the test's window.
      mockHttpNeverResponds();

      const s1 = await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      expect(s1.predictedUrl).toBeTruthy();

      await service.ensure({ ...project, panelId: "panel-2", worktreeId: "wt-1" });
      await service.stopByPanel({ panelId: "panel-2" });

      // Panel 1's session should still be accessible via getState (different lookup path).
      const direct = service.getState({ ...project, panelId: "panel-1" });
      expect(direct.status).toBe("starting");
      expect(direct.predictedUrl).toBeTruthy();

      // AND via getByWorktree (requires the fix).
      const byWt = service.getByWorktree("wt-1");
      expect(byWt).not.toBeNull();
      expect(byWt!.predictedUrl).toBe(direct.predictedUrl);
    });

    it("BUG-W: ensureSessionTerminal dead-terminal intermediate broadcast has no predictedUrl", async () => {
      // Ensure a session so a terminal is spawned and predictedUrl is set.
      const state = await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      expect(state.predictedUrl).toBeTruthy();

      // Kill the terminal silently (no exit event) so isTerminalAlive returns false.
      ptyClient.kill(state.terminalId!);

      broadcasts.length = 0;

      // Re-ensure — ensureSessionTerminal detects dead terminal, clears terminalId/url,
      // then re-spawns. The intermediate broadcast should NOT expose a non-null predictedUrl
      // with a null terminalId (server not running but URL still advertised).
      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });

      // Find any broadcast where terminalId was null but predictedUrl was non-null.
      // Fails if the intermediate updateSession({ terminalId: null, url: null }) omits predictedUrl: null.
      const inconsistentBroadcast = broadcasts.find(
        (b) => b.terminalId === null && b.predictedUrl !== null
      );
      expect(inconsistentBroadcast).toBeUndefined();
    });

    it("BUG-X: getByWorktree returns null after explicit stop() (not stopByPanel)", async () => {
      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      expect(service.getByWorktree("wt-1")).not.toBeNull();

      await service.stop({ ...project, panelId: "panel-1" });

      // stop() does not delete the session (unlike stopByPanel), but the worktreeId
      // should be removed from the map so the session is not falsely advertised.
      // Current behavior: getByWorktree returns a stopped session (non-null).
      // Expected behavior: depends on contract — document and pin it here.
      //
      // If the contract is "stopped session is still discoverable", this should pass:
      const result = service.getByWorktree("wt-1");

      // The session still exists (stop() keeps it), so getByWorktree returns it.
      // Assert the returned state is correct — status stopped, predictedUrl null.
      expect(result).not.toBeNull();
      expect(result!.status).toBe("stopped");
      expect(result!.predictedUrl).toBeNull();
    });

    it("worktreeToSession maps to the correct panel after worktreeId changes", async () => {
      // Panel 1 starts on wt-1, moves to wt-2.
      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      expect(service.getByWorktree("wt-1")!.panelId).toBe("panel-1");

      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-2" });
      expect(service.getByWorktree("wt-1")).toBeNull(); // old entry cleaned up
      expect(service.getByWorktree("wt-2")!.panelId).toBe("panel-1");
    });

    it("getByWorktree returns null for all worktrees after dispose", async () => {
      await service.ensure({ ...project, panelId: "panel-1", worktreeId: "wt-1" });
      await service.ensure({ ...project, panelId: "panel-2", worktreeId: "wt-2" });

      service.dispose();

      expect(service.getByWorktree("wt-1")).toBeNull();
      expect(service.getByWorktree("wt-2")).toBeNull();
    });
  });

  // Round 5 — Y: ensure()/restart() after dispose() spawned zombie terminals; ZZ:
  // concurrent ensure() must serialize; TOCTOU: concurrent allocations must never
  // share a port; RLS-1..3: agent-facing scenarios (URL available before the server
  // prints it, crash-and-recover, stop/re-start keeps the same URL — the BUG-CC fix).
  describe("robustness invariants", () => {
    it("BUG-Y: ensure() after dispose() does not spawn a terminal", async () => {
      service.dispose();

      // Calling ensure() on a disposed service must be a no-op.
      // Fails when ensure() lacks a disposed guard: ptyClient.spawn fires,
      // producing a zombie terminal that is never killed.
      await service.ensure({ ...base, worktreeId: "wt-1" });

      expect(ptyClient.spawn).not.toHaveBeenCalled();
    });

    it("BUG-Y2: ensure() after dispose() does not broadcast any state", async () => {
      service.dispose();
      broadcasts.length = 0;

      await service.ensure({ ...base, worktreeId: "wt-1" });

      // A disposed service must not fire onStateChanged.
      expect(broadcasts).toHaveLength(0);
    });

    it("BUG-Y-RACE: dispose() during in-flight allocatePort net probe does not spawn a terminal", async () => {
      // Override net.createServer once so the listen callback is deferred. This
      // simulates dispose() firing while allocatePort() is awaiting its probe.
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      // probePortFree opens one socket per probed address, so every socket this
      // allocation attempt makes must be gated — a single mockImplementationOnce
      // would leave the rest ungated and leak into the next test's first probe.
      const defaultCreateServer = vi.mocked(net.createServer).getMockImplementation();
      vi.mocked(net.createServer).mockImplementation(() => {
        type Cb = () => void;
        const srv = {
          unref: vi.fn(() => srv),
          once: vi.fn((_event: string, _cb: Cb) => srv),
          listen: vi.fn((_options: { port: number; host: string; ipv6Only?: boolean }, cb: Cb) => {
            probeGate.then(() => cb());
            return srv;
          }),
          close: vi.fn((cb?: Cb) => {
            cb?.();
            return srv;
          }),
          address: vi.fn(() => ({ port: _nextPort++ })),
        };
        return srv as unknown as net.Server;
      });

      // Start ensure — it enters spawnSessionTerminal and awaits allocatePort.
      const ensurePromise = service.ensure({ ...base, worktreeId: "wt-1" });

      // Yield to let the allocation reach the net probe.
      await Promise.resolve();

      // Dispose mid-flight.
      service.dispose();

      // Release the probe so allocatePort resolves after disposal.
      releaseProbe();
      await ensurePromise;

      // No spawn should have fired for this disposed service.
      expect(ptyClient.spawn).not.toHaveBeenCalled();
      if (defaultCreateServer) vi.mocked(net.createServer).mockImplementation(defaultCreateServer);
    });

    it("BUG-Y3: restart() after dispose() does not spawn a terminal", async () => {
      // Establish a session first, then dispose.
      await service.ensure({ ...base, worktreeId: "wt-1" });
      service.dispose();
      broadcasts.length = 0;
      const spawnCountAfterDispose = ptyClient.spawn.mock.calls.length;

      await service.restart(base);

      expect(ptyClient.spawn.mock.calls.length).toBe(spawnCountAfterDispose);
    });

    it("BUG-ZZ: concurrent ensure() calls for same panel fire spawn exactly once", async () => {
      // Two simultaneous ensure() calls for the same panel must serialize.
      // The second call finds the terminal alive and skips spawn.
      await Promise.all([
        service.ensure({ ...base, worktreeId: "wt-1" }),
        service.ensure({ ...base, worktreeId: "wt-1" }),
      ]);

      // Exactly one spawn, not two.
      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    });

    it("BUG-ZZ2: concurrent ensure() for different panels each get their own terminal", async () => {
      await Promise.all([
        service.ensure({ ...base, panelId: "panel-1", worktreeId: "wt-1" }),
        service.ensure({ ...base, panelId: "panel-2", worktreeId: "wt-2" }),
      ]);

      // Two different panels: two independent terminals.
      expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
    });

    it("BUG-TOCTOU: concurrent ensure() for different panels never assign the same port", async () => {
      // Force Math.random so both sessions' first candidate is identical (6500).
      // Without reserve-before-probe, the cross-session allocatePort calls both
      // see an empty usedPorts snapshot at the start of their loop and both
      // pick candidate=6500. With the fix, the second caller sees the first
      // caller's reservation in portRegistry and advances.
      let rngCallCount = 0;
      vi.spyOn(Math, "random").mockImplementation(() => {
        rngCallCount++;
        // First two calls (one per session, first iteration): collide at 0.5 → 6500.
        // Subsequent iterations pick a different value so the second session advances.
        if (rngCallCount <= 2) return 0.5;
        return 0.6;
      });

      await Promise.all([
        service.ensure({ ...base, panelId: "panel-a", worktreeId: "wt-a" }),
        service.ensure({ ...base, panelId: "panel-b", worktreeId: "wt-b" }),
      ]);

      const a = service.getByWorktree("wt-a");
      const b = service.getByWorktree("wt-b");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.predictedUrl).toBeTruthy();
      expect(b!.predictedUrl).toBeTruthy();
      // The invariant: two concurrent allocations never produce the same URL.
      expect(a!.predictedUrl).not.toBe(b!.predictedUrl);
    });

    it("RLS-1: predictedUrl is non-null immediately after ensure() before server prints URL", async () => {
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });

      // The server has not printed anything yet — url is null, status is starting.
      // But predictedUrl must already be set so agents can navigate before the server is ready.
      expect(state.status).toBe("starting");
      expect(state.url).toBeNull();
      expect(state.predictedUrl).toMatch(/^http:\/\/localhost:\d+$/);
    });

    it("RLS-2: after terminal crash and re-ensure, getByWorktree has fresh predictedUrl", async () => {
      const first = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(first.predictedUrl).toBeTruthy();

      // Simulate server crash.
      ptyClient.emitExit(first.terminalId!, 1);

      const crashState = service.getState(base);
      expect(crashState.predictedUrl).toBeNull();
      expect(crashState.status).toBe("error");

      // Re-ensure should spawn a new terminal and set a new predictedUrl.
      const recovered = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(recovered.predictedUrl).toMatch(/^http:\/\/localhost:\d+$/);

      // getByWorktree must reflect the recovered session.
      const byWt = service.getByWorktree("wt-1");
      expect(byWt).not.toBeNull();
      expect(byWt!.predictedUrl).toBe(recovered.predictedUrl);
      expect(byWt!.status).toBe("starting");
    });

    it("RLS-3: stop() then ensure() restarts the server with the same predictedUrl", async () => {
      const first = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(first.predictedUrl).toBeTruthy();

      await service.stop(base);

      // After stop: session alive but stopped, predictedUrl null in public state.
      const stopped = service.getState(base);
      expect(stopped.status).toBe("stopped");
      expect(stopped.predictedUrl).toBeNull();

      // Re-ensure restarts the server — same port, same URL.
      const restarted = await service.ensure({
        ...base,
        worktreeId: "wt-1",
        resumeUserStopped: true,
      });
      expect(restarted.status).toBe("starting");
      expect(restarted.predictedUrl).toBe(first.predictedUrl);

      // getByWorktree picks up the restarted session.
      const byWt = service.getByWorktree("wt-1");
      expect(byWt!.predictedUrl).toBe(first.predictedUrl);
    });
  });
});
