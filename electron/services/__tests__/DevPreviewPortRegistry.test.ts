/**
 * Adversarial tests for the port registry features added in quick-2.
 * Each test is designed to prove a specific invariant holds (or expose that it breaks).
 *
 * Bugs targeted:
 *   A – PORT env override: caller env.PORT silently beats the allocated port
 *   B – assignedUrl stale after crash exit (handleExit error path)
 *   C – assignedUrl stale after clean exit (handleExit stopped path)
 *   D – assignedUrl stale after install exit failure
 *   E – real net socket calls leak into tests (net not mocked)
 *   F – getByWorktree stale after worktreeId change on same session
 *   G – worktreeToSession not cleaned up after stopByPanel (memory + correctness)
 *   H – port is reused across restarts (regression guard)
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
      once: vi.fn((event: string, cb: Cb) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(cb);
        return srv;
      }),
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

describe("DevPreviewSessionService — port registry (adversarial)", () => {
  const base = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };

  let onStateChanged: ReturnType<typeof vi.fn>;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;

  beforeEach(() => {
    _nextPort = 3100;
    onStateChanged = vi.fn();
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

  // ── Bug A ──────────────────────────────────────────────────────────────────
  it("BUG-A: assignedUrl matches the port injected into the spawn env — caller env.PORT must not override", async () => {
    // If the spread is wrong ({ PORT: allocated, ...session.env }), then
    // session.env.PORT=9000 wins and the spawn env gets PORT=9000 while
    // assignedUrl still says http://localhost:3100 → mismatch.
    const state = await service.ensure({
      ...base,
      worktreeId: "wt-1",
      env: { PORT: "9000" },
    });

    expect(state.assignedUrl).toBeTruthy();
    const allocatedPort = state.assignedUrl!.replace("http://localhost:", "");

    const lastSpawn = ptyClient.spawnCalls[ptyClient.spawnCalls.length - 1];
    const spawnedPort = (lastSpawn.opts.env as Record<string, string>).PORT;

    // The port in assignedUrl must equal the port that was actually injected.
    // Fails if the spread is reversed (caller env.PORT wins).
    expect(spawnedPort).toBe(allocatedPort);
  });

  // ── Bug B ──────────────────────────────────────────────────────────────────
  it("BUG-B: assignedUrl is cleared when the terminal crashes (non-zero exit)", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    // Simulate crash
    ptyClient.emitExit(state.terminalId!, 1);

    const after = service.getState(base);
    // handleExit error-path does not clear assignedUrl → this assertion will fail
    expect(after.assignedUrl).toBeNull();
  });

  // ── Bug C ──────────────────────────────────────────────────────────────────
  it("BUG-C: assignedUrl is cleared when the terminal exits cleanly (zero exit from running state)", async () => {
    mockHttpResponse(200);
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    // Emit URL so status transitions to running
    ptyClient.emitData(state.terminalId!, "ready at http://localhost:5173\n");
    await new Promise((r) => setTimeout(r, 10));

    // Clean exit from running state
    ptyClient.emitExit(state.terminalId!, 0);

    const after = service.getState(base);
    // handleExit stopped-path does not clear assignedUrl → this assertion will fail
    expect(after.assignedUrl).toBeNull();
  });

  // ── Bug D ──────────────────────────────────────────────────────────────────
  it("BUG-D: assignedUrl is cleared when install subprocess exits with failure", async () => {
    // Trigger install path: emit missing-dependencies error, then exit triggers install
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    // Emit a missing-dependencies error to set needsInstall = true
    ptyClient.emitData(
      state.terminalId!,
      "npm error: Cannot find module\nError: Cannot find module"
    );
    await new Promise((r) => setTimeout(r, 10));

    // Mark as install subprocess running (simulate the install terminal exit with failure)
    // The service sets isRunningInstall=true when runInstall is triggered.
    // Exit with failure code should clear assignedUrl.
    ptyClient.emitExit(state.terminalId!, 1);
    await new Promise((r) => setTimeout(r, 20));

    const after = service.getState(base);
    // handleExit install-failure path does not clear assignedUrl
    expect(after.assignedUrl).toBeNull();
  });

  // ── Bug E ──────────────────────────────────────────────────────────────────
  it("BUG-E: net.createServer is called during ensure (not a real socket bind)", async () => {
    // If net is not mocked, this test makes real socket calls — the mock is proof it works.
    await service.ensure(base);

    // net is the default import at the top of this file — same object the service uses.
    expect(vi.mocked(net.createServer)).toHaveBeenCalled();
  });

  // ── Bug F ──────────────────────────────────────────────────────────────────
  it("BUG-F: getByWorktree returns null after worktreeId is changed to a different value", async () => {
    // Ensure with wt-1
    await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(service.getByWorktree("wt-1")).not.toBeNull();

    // Re-ensure same panel/project with a different worktreeId
    await service.ensure({ ...base, worktreeId: "wt-2" });

    // wt-1 should no longer resolve — the session moved to wt-2
    // This fails if worktreeToSession still maps wt-1 → old key that now has worktreeId=wt-2
    expect(service.getByWorktree("wt-1")).toBeNull();
    expect(service.getByWorktree("wt-2")).not.toBeNull();
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
    const portBefore = first.assignedUrl;
    expect(portBefore).toBeTruthy();

    // Snapshot call count after initial allocation.
    const callsAfterEnsure = vi.mocked(net.createServer).mock.calls.length;
    expect(callsAfterEnsure).toBeGreaterThanOrEqual(1);

    await service.restart(base);
    const second = service.getState(base);

    // The same port should be reused after restart.
    expect(second.assignedUrl).toBe(portBefore);
    // Port was reused — allocatePort returned early from registry, no new probe.
    const callsAfterRestart = vi.mocked(net.createServer).mock.calls.length;
    expect(callsAfterRestart).toBe(callsAfterEnsure);
  });

  // ── Positive baseline ──────────────────────────────────────────────────────
  it("assignedUrl is populated immediately after ensure() before server is ready", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });

    expect(state.status).toBe("starting");
    expect(state.assignedUrl).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("getByWorktree returns null for unknown worktreeId", () => {
    expect(service.getByWorktree("nonexistent")).toBeNull();
  });

  it("getByWorktree returns null for session ensured without worktreeId", async () => {
    await service.ensure(base); // no worktreeId
    expect(service.getByWorktree("any-wt")).toBeNull();
  });

  it("two sessions on different panels get different ports", async () => {
    const s1 = await service.ensure({
      panelId: "panel-1",
      projectId: "project-1",
      cwd: "/repo",
      devCommand: "npm run dev",
      worktreeId: "wt-1",
    });
    const s2 = await service.ensure({
      panelId: "panel-2",
      projectId: "project-1",
      cwd: "/repo",
      devCommand: "npm run dev",
      worktreeId: "wt-2",
    });

    expect(s1.assignedUrl).toBeTruthy();
    expect(s2.assignedUrl).toBeTruthy();
    expect(s1.assignedUrl).not.toBe(s2.assignedUrl);
  });

  it("assignedUrl is cleared after explicit stop()", async () => {
    const state = await service.ensure(base);
    expect(state.assignedUrl).toBeTruthy();

    await service.stop(base);
    const after = service.getState(base);
    expect(after.assignedUrl).toBeNull();
  });

  it("assignedUrl is cleared after stopByPanel()", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    await service.stopByPanel({ panelId: base.panelId });
    // Session is removed — getState returns default null state
    const after = service.getState(base);
    expect(after.assignedUrl).toBeNull();
  });
});
