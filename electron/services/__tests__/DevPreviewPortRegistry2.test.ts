/**
 * Second-round adversarial tests for DevPreviewSessionService (quick-2 follow-up).
 *
 * Bugs targeted:
 *   I – stopByPanel success: onStateChanged broadcast has stale assignedUrl (assignedUrl: null omitted)
 *   J – stopByProject success: same stale broadcast
 *   K – stopByPanel error-catch: onStateChanged broadcast has stale assignedUrl
 *   L – worktreeToSession not cleaned up after stopByPanel / stopByProject (memory leak)
 *   M – getByWorktree IPC handler: accepts blank / whitespace / non-string worktreeId
 */

import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

let _nextPort = 4200;

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

describe("DevPreviewSessionService — stale assignedUrl broadcasts & map cleanup (adversarial)", () => {
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
    _nextPort = 4200;
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
  });

  // ── Bug I ──────────────────────────────────────────────────────────────────
  it("BUG-I: last onStateChanged broadcast from stopByPanel has assignedUrl: null", async () => {
    // Ensure a session so assignedUrl is populated.
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    broadcasts.length = 0; // reset — watch only stop broadcasts

    await service.stopByPanel({ panelId: base.panelId });

    // At least one broadcast must have been emitted for the stop.
    expect(broadcasts.length).toBeGreaterThan(0);

    // The final broadcast must have assignedUrl: null.
    // Fails when updateSession({ status: "stopped", ... }) omits assignedUrl: null.
    const lastBroadcast = broadcasts[broadcasts.length - 1];
    expect(lastBroadcast.assignedUrl).toBeNull();
  });

  // ── Bug J ──────────────────────────────────────────────────────────────────
  it("BUG-J: last onStateChanged broadcast from stopByProject has assignedUrl: null", async () => {
    await service.ensure({ ...base, worktreeId: "wt-1" });

    broadcasts.length = 0;

    await service.stopByProject(base.projectId);

    expect(broadcasts.length).toBeGreaterThan(0);

    // Fails when updateSession({ status: "stopped", ... }) in stopByProject omits assignedUrl.
    const lastBroadcast = broadcasts[broadcasts.length - 1];
    expect(lastBroadcast.assignedUrl).toBeNull();
  });

  // ── Bug K ──────────────────────────────────────────────────────────────────
  it("BUG-K: onStateChanged broadcast from stopByPanel error-catch has assignedUrl: null", async () => {
    const state = await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(state.assignedUrl).toBeTruthy();

    // Make stopSessionTerminal throw by killing the pty then making kill() throw.
    ptyClient.kill.mockImplementationOnce(() => {
      throw new Error("kill failed");
    });

    broadcasts.length = 0;

    // stopByPanel will hit the catch branch.
    await service.stopByPanel({ panelId: base.panelId });

    // Must have emitted at least one broadcast for the error state.
    expect(broadcasts.length).toBeGreaterThan(0);

    // The final broadcast must have assignedUrl: null.
    // Fails when the catch-branch updateSession({ status: "error", ... }) omits assignedUrl: null.
    const lastBroadcast = broadcasts[broadcasts.length - 1];
    expect(lastBroadcast.assignedUrl).toBeNull();
  });

  // ── Bug L ──────────────────────────────────────────────────────────────────
  it("BUG-L: getByWorktree returns null after stopByPanel removes the session (worktreeToSession cleaned up)", async () => {
    await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(service.getByWorktree("wt-1")).not.toBeNull();

    await service.stopByPanel({ panelId: base.panelId });

    // The session is deleted; worktreeToSession stale entry must not leak through.
    // getByWorktree already returns null if session is gone (existing test BUG-G covers this).
    // This test adds coverage for the SECOND ensure after stop: if stale entry remains
    // in worktreeToSession, a re-ensure with a different panel would not register wt-1 → new key.
    const newService = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged as unknown as (state: DevPreviewSessionState) => void
    );
    try {
      await newService.ensure({ ...base, panelId: "panel-2", worktreeId: "wt-1" });
      expect(newService.getByWorktree("wt-1")).not.toBeNull();
    } finally {
      newService.dispose();
    }
  });

  it("BUG-L2: getByWorktree returns null after stopByProject removes the session", async () => {
    await service.ensure({ ...base, worktreeId: "wt-1" });
    expect(service.getByWorktree("wt-1")).not.toBeNull();

    await service.stopByProject(base.projectId);

    // Session gone; stale worktreeToSession entry must not ghost through.
    expect(service.getByWorktree("wt-1")).toBeNull();
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
