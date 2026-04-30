/**
 * Third-round adversarial tests — assignedUrl leaks through every error/stop code path.
 *
 * Bugs targeted:
 *   N – spawnSessionTerminal spawn-throw:  broadcast has stale assignedUrl
 *   P – ensure invalid-command path:       broadcast has stale assignedUrl
 *   Q – restart invalid-command path:      broadcast has stale assignedUrl
 *   R – handleData non-dep error output:   broadcast has stale assignedUrl
 *   S – runInstall spawn-throw path:       broadcast has stale assignedUrl
 *   T – pollServerReadiness timeout path:  broadcast has stale assignedUrl
 */

import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

let _nextPort = 5500;

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

// ─── http helpers ─────────────────────────────────────────────────────────────

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

// ─── ptyClient mock ───────────────────────────────────────────────────────────

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;

function createPtyClientMock() {
  const dataListeners = new Set<DataListener>();
  const exitListeners = new Set<ExitListener>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();
  let spawnCallCount = 0;

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
      spawnCallCount++;
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
    getSpawnCallCount: () => spawnCallCount,
  };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("DevPreviewSessionService — assignedUrl must be null in every error broadcast (adversarial)", () => {
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
    _nextPort = 5500;
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
    vi.useRealTimers();
  });

  // ── Bug N ──────────────────────────────────────────────────────────────────
  it("BUG-N: assignedUrl is null in error broadcast when spawn throws", async () => {
    // First ensure succeeds and sets assignedUrl on the session.
    const first = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(first.assignedUrl).toBeTruthy();

    // Stop the session so the port stays allocated but the terminal is gone.
    // Next ensure will call spawnSessionTerminal again (spawn #2).
    await service.stop(base);

    // Make the second spawn throw.
    ptyClient.spawn.mockImplementationOnce(() => {
      throw new Error("PTY host crashed");
    });

    broadcasts.length = 0;

    // Re-ensure → spawnSessionTerminal sets assignedUrl then spawn throws.
    await service.ensure({ ...base, worktreeId: "wt-1" });

    // The error broadcast must have assignedUrl: null.
    // Fails if spawnSessionTerminal's catch omits assignedUrl: null.
    const errorBroadcast = broadcasts.find((b) => b.status === "error");
    expect(errorBroadcast).toBeDefined();
    expect(errorBroadcast!.assignedUrl).toBeNull();
  });

  // ── Bug P ──────────────────────────────────────────────────────────────────
  it("BUG-P: assignedUrl is null in error broadcast from ensure() with blank devCommand", async () => {
    // Establish a running session so assignedUrl is populated.
    const first = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(first.assignedUrl).toBeTruthy();

    broadcasts.length = 0;

    // Re-ensure with an empty command → hits the commandError path.
    await service.ensure({ ...base, devCommand: "", worktreeId: "wt-1" });

    // The error broadcast must have assignedUrl: null.
    // Fails if ensure's commandError updateSession omits assignedUrl: null.
    const errorBroadcast = broadcasts.find((b) => b.status === "error");
    expect(errorBroadcast).toBeDefined();
    expect(errorBroadcast!.assignedUrl).toBeNull();
  });

  // ── Bug Q ──────────────────────────────────────────────────────────────────
  it("BUG-Q: assignedUrl is null in error broadcast from restart() with stored blank devCommand", async () => {
    // Establish session with assignedUrl.
    await service.ensure({ ...base, worktreeId: "wt-1" });

    // Corrupt devCommand to blank via a second ensure (exercises Bug P path too,
    // but we are interested in restart here).
    await service.ensure({ ...base, devCommand: "", worktreeId: "wt-1" });

    broadcasts.length = 0;

    // restart() reads stored devCommand="" → hits the commandError path.
    await service.restart(base);

    // The error broadcast must have assignedUrl: null.
    // Fails if restart's commandError updateSession omits assignedUrl: null.
    const errorBroadcast = broadcasts.find((b) => b.status === "error");
    expect(errorBroadcast).toBeDefined();
    expect(errorBroadcast!.assignedUrl).toBeNull();
  });

  // ── Bug R ──────────────────────────────────────────────────────────────────
  it("BUG-R: assignedUrl is null in error broadcast from EACCES output on terminal", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    broadcasts.length = 0;

    // Emit a permission-denied pattern — detected as a non-missing-deps error.
    ptyClient.emitData(state.terminalId!, "Error: EACCES: permission denied /repo/server.js\n");
    await new Promise((r) => setTimeout(r, 10));

    // The error broadcast must have assignedUrl: null.
    // Fails if handleData's non-dep error updateSession omits assignedUrl: null.
    const errorBroadcast = broadcasts.find((b) => b.status === "error");
    expect(errorBroadcast).toBeDefined();
    expect(errorBroadcast!.assignedUrl).toBeNull();
  });

  // ── Bug S ──────────────────────────────────────────────────────────────────
  it("BUG-S: assignedUrl is null in error broadcast when install spawn throws", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

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

    // The error broadcast from the install-spawn failure must have assignedUrl: null.
    // Fails if runInstall's catch-path updateSession omits assignedUrl: null.
    const errorBroadcast = broadcasts.find((b) => b.status === "error");
    expect(errorBroadcast).toBeDefined();
    expect(errorBroadcast!.assignedUrl).toBeNull();
  });

  // ── Bug T ──────────────────────────────────────────────────────────────────
  it("BUG-T: assignedUrl is null in error broadcast when readiness poll times out", async () => {
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
    expect(state.assignedUrl).toBeTruthy();

    broadcasts.length = 0;

    // Emit a localhost URL — triggers pollServerReadiness which will keep failing.
    ptyClient.emitData(state.terminalId!, "Local: http://localhost:3000\n");

    // Exhaust the 30-second readiness deadline by advancing fake time.
    // Each 500ms poll-interval timer fires, http fails, loop re-checks deadline.
    await vi.advanceTimersByTimeAsync(31_000);

    // The error broadcast must have assignedUrl: null.
    // Fails if pollServerReadiness's !ready branch omits assignedUrl: null.
    const errorBroadcast = broadcasts.find((b) => b.status === "error");
    expect(errorBroadcast).toBeDefined();
    expect(errorBroadcast!.assignedUrl).toBeNull();
  });
});
