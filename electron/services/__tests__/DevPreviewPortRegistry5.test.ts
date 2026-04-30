/**
 * Fifth-round adversarial tests — real-life robustness invariants.
 *
 * Bugs targeted:
 *   Y  – ensure() after dispose() spawns a zombie terminal: disposed=true makes
 *        updateSession a no-op, but ptyClient.spawn still fires — the terminal
 *        is never killed or tracked.
 *
 *   CC – stop() releases the port from portRegistry; the next ensure() therefore
 *        allocates a NEW port and broadcasts a different assignedUrl, breaking
 *        any agent that cached the URL. stop() should keep the port (session is
 *        still alive in "stopped" state); only stopByPanel / stopByProject /
 *        dispose should release ports.
 *
 *   ZZ – (positive invariant) concurrent ensure() calls for the same panel must
 *        serialize via the lock — only one terminal spawn, no double-start.
 *
 * Real-life scenario proofs:
 *   RLS-1 – agent can call getByWorktree() immediately after ensure() and get
 *            a non-null assignedUrl even before the server prints its URL.
 *   RLS-2 – after crash-and-re-ensure, getByWorktree() returns the new session
 *            with a valid assignedUrl (previous URL was cleared on crash).
 *   RLS-3 – stop() → ensure() cycle is idempotent: same assignedUrl, server
 *            restarts cleanly (verifies BUG-CC fix).
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

let _nextPort = 7700;

vi.mock("node:net", () => {
  const makeServer = () => {
    type Cb = () => void;
    const srv = {
      once: vi.fn((_event: string, _cb: Cb) => srv),
      listen: vi.fn((_port: number, _host: string, cb: Cb) => {
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

function mockHttpOk() {
  const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
    const req: MockRequest = {
      on: () => req,
      end: () => cb({ statusCode: 200, resume: () => {} }),
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
    emitData(id: string, data: string) {
      for (const cb of dataListeners) cb(id, data);
    },
    emitExit(id: string, code: number) {
      const t = terminals.get(id);
      if (t) t.hasPty = false;
      for (const cb of exitListeners) cb(id, code);
    },
  };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("DevPreviewSessionService — real-life robustness invariants (adversarial)", () => {
  const base = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };

  let broadcasts: DevPreviewSessionState[];
  let onStateChanged: ReturnType<typeof vi.fn>;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;

  beforeEach(() => {
    _nextPort = 7700;
    broadcasts = [];
    onStateChanged = vi.fn((state: DevPreviewSessionState) => broadcasts.push(state));
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged as unknown as (state: DevPreviewSessionState) => void
    );
    mockHttpOk();
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
  });

  // ── Bug Y ──────────────────────────────────────────────────────────────────

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
    vi.mocked(net.createServer).mockImplementationOnce(() => {
      type Cb = () => void;
      const srv = {
        once: vi.fn((_event: string, _cb: Cb) => srv),
        listen: vi.fn((_port: number, _host: string, cb: Cb) => {
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

  // ── Bug CC ─────────────────────────────────────────────────────────────────

  it("BUG-CC: ensure() after stop() reuses the same port (assignedUrl is stable)", async () => {
    // First ensure allocates a port.
    const first = await service.ensure({ ...base, worktreeId: "wt-1" });
    const originalUrl = first.assignedUrl;
    expect(originalUrl).toBeTruthy();

    // Explicit stop keeps the session alive (status=stopped) but releases
    // the port from portRegistry — so the NEXT ensure gets a new port.
    // This breaks agent URL caching: the URL silently changes.
    await service.stop(base);

    // Re-ensure should reuse the original port — same assignedUrl.
    // Fails when stop() calls releasePort() for a still-live session.
    const second = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(second.assignedUrl).toBe(originalUrl);
  });

  it("BUG-CC2: getByWorktree returns the same assignedUrl after stop()+ensure() cycle", async () => {
    await service.ensure({ ...base, worktreeId: "wt-1" });
    const originalUrl = service.getByWorktree("wt-1")?.assignedUrl;
    expect(originalUrl).toBeTruthy();

    await service.stop(base);
    await service.ensure({ ...base, worktreeId: "wt-1" });

    // If stop() released the port, getByWorktree now returns a different URL.
    const afterUrl = service.getByWorktree("wt-1")?.assignedUrl;
    expect(afterUrl).toBe(originalUrl);
  });

  it("BUG-CC3: multiple stop()+ensure() cycles keep the same port throughout", async () => {
    const first = await service.ensure({ ...base, worktreeId: "wt-1" });
    const originalUrl = first.assignedUrl;

    for (let i = 0; i < 3; i++) {
      await service.stop(base);
      const state = await service.ensure({ ...base, worktreeId: "wt-1" });
      expect(state.assignedUrl).toBe(originalUrl);
    }
  });

  // ── Bug ZZ (positive invariant) ────────────────────────────────────────────

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

  // ── Bug TOCTOU ─────────────────────────────────────────────────────────────

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
    expect(a!.assignedUrl).toBeTruthy();
    expect(b!.assignedUrl).toBeTruthy();
    // The invariant: two concurrent allocations never produce the same URL.
    expect(a!.assignedUrl).not.toBe(b!.assignedUrl);
  });

  // ── Real-Life Scenario 1: agent URL pre-fetch ──────────────────────────────

  it("RLS-1: assignedUrl is non-null immediately after ensure() before server prints URL", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });

    // The server has not printed anything yet — url is null, status is starting.
    // But assignedUrl must already be set so agents can navigate before the server is ready.
    expect(state.status).toBe("starting");
    expect(state.url).toBeNull();
    expect(state.assignedUrl).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("RLS-1b: getByWorktree() returns assignedUrl immediately after ensure()", async () => {
    await service.ensure({ ...base, worktreeId: "wt-1" });

    const session = service.getByWorktree("wt-1");
    expect(session).not.toBeNull();
    expect(session!.assignedUrl).toMatch(/^http:\/\/localhost:\d+$/);

    // assignedUrl is available even while status is still starting.
    expect(session!.status).toBe("starting");
  });

  // ── Real-Life Scenario 2: crash-and-recover ────────────────────────────────

  it("RLS-2: after terminal crash and re-ensure, getByWorktree has fresh assignedUrl", async () => {
    const first = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(first.assignedUrl).toBeTruthy();

    // Simulate server crash.
    ptyClient.emitExit(first.terminalId!, 1);

    const crashState = service.getState(base);
    expect(crashState.assignedUrl).toBeNull();
    expect(crashState.status).toBe("error");

    // Re-ensure should spawn a new terminal and set a new assignedUrl.
    const recovered = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(recovered.assignedUrl).toMatch(/^http:\/\/localhost:\d+$/);

    // getByWorktree must reflect the recovered session.
    const byWt = service.getByWorktree("wt-1");
    expect(byWt).not.toBeNull();
    expect(byWt!.assignedUrl).toBe(recovered.assignedUrl);
    expect(byWt!.status).toBe("starting");
  });

  // ── Real-Life Scenario 3: stop / re-start lifecycle ────────────────────────

  it("RLS-3: stop() then ensure() restarts the server with the same assignedUrl", async () => {
    const first = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(first.assignedUrl).toBeTruthy();

    await service.stop(base);

    // After stop: session alive but stopped, assignedUrl null in public state.
    const stopped = service.getState(base);
    expect(stopped.status).toBe("stopped");
    expect(stopped.assignedUrl).toBeNull();

    // Re-ensure restarts the server — same port, same URL.
    const restarted = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(restarted.status).toBe("starting");
    expect(restarted.assignedUrl).toBe(first.assignedUrl);

    // getByWorktree picks up the restarted session.
    const byWt = service.getByWorktree("wt-1");
    expect(byWt!.assignedUrl).toBe(first.assignedUrl);
  });
});
