import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";
import type { PtyClient } from "../PtyClient.js";

// The crash-loop guard lives in DevPreviewSessionService.handleExit. The loop
// it guards is: dev server emits a missing-dependencies error and exits ->
// runInstall -> install exits 0 -> dev server respawns -> emits the error
// again. A broken config never resolves the missing dep, so the cycle is
// otherwise unbounded. These tests drive that cycle manually via the PTY mock.

const scanOutputMock = vi.hoisted(() =>
  vi.fn<
    (
      data: string,
      buffer: string
    ) => {
      buffer: string;
      url?: string;
      error?: { type: string; message: string };
      readyMarker?: boolean;
    }
  >()
);

vi.mock("../UrlDetector.js", () => ({
  UrlDetector: class {
    scanOutput(data: string, buffer: string) {
      return scanOutputMock(data, buffer);
    }
  },
}));

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;

function mockHttpResponse(statusCode: number): void {
  const impl = ((
    _: unknown,
    __: unknown,
    cb: (res: { statusCode: number; resume: () => void }) => void
  ) => {
    const req = {
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
    on: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.add(callback as DataListener);
      if (event === "exit") exitListeners.add(callback as ExitListener);
    }),
    off: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.delete(callback as DataListener);
      if (event === "exit") exitListeners.delete(callback as ExitListener);
    }),
    spawn: vi.fn((id: string, options: { projectId?: string }) => {
      terminals.set(id, { projectId: options.projectId, hasPty: true });
    }),
    kill: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
    }),
    submit: vi.fn(),
    hasTerminal: vi.fn((id: string) => terminals.get(id)?.hasPty ?? false),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async () => 0),
    getTerminalAsync: vi.fn(async (id: string) => {
      const terminal = terminals.get(id);
      if (!terminal) return null;
      return {
        id,
        projectId: terminal.projectId,
        hasPty: terminal.hasPty,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    }),
    emitData(id: string, data: string | Uint8Array) {
      for (const listener of dataListeners) listener(id, data);
    },
    emitExit(id: string, exitCode: number) {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
      for (const listener of exitListeners) listener(id, exitCode);
    },
  };
}

// Captured before vi.useFakeTimers() swaps the global. spawnSessionTerminal
// awaits command normalization, which reads package.json — real threadpool I/O
// that neither a microtask flush nor a faked timer can advance.
const realSetTimeout = globalThis.setTimeout;

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

describe("DevPreviewSessionService crash-loop guard", () => {
  const baseRequest = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };
  const stateRequest = { panelId: baseRequest.panelId, projectId: baseRequest.projectId };

  let service: (typeof import("../DevPreviewSessionService.js"))["DevPreviewSessionService"]["prototype"];
  let DevPreviewSessionServiceCtor: (typeof import("../DevPreviewSessionService.js"))["DevPreviewSessionService"];
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let onStateChanged: ReturnType<typeof vi.fn<(state: DevPreviewSessionState) => void>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    // Default: only output containing "missing deps" reports the error that
    // drives the install cycle; everything else is inert.
    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("missing deps")) {
        return {
          buffer,
          error: { type: "missing-dependencies", message: "Cannot find module 'react'" },
        };
      }
      return { buffer };
    });
    mockHttpResponse(200);
    ({ DevPreviewSessionService: DevPreviewSessionServiceCtor } =
      await import("../DevPreviewSessionService.js"));
    onStateChanged = vi.fn();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionServiceCtor(ptyClient as unknown as PtyClient, onStateChanged);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function currentTerminalId(): string | null {
    return service.getState(stateRequest).terminalId;
  }

  // Crash the given dev terminal with a missing-deps error, then let the
  // resulting install complete (firing any backoff timer). Returns the
  // respawned dev terminal id, or null if the guard halted auto-respawn.
  async function crashThroughInstall(devTerminalId: string): Promise<string | null> {
    ptyClient.emitData(devTerminalId, "missing deps");
    ptyClient.emitExit(devTerminalId, 1);
    // Fire any pending backoff timer (max ~1.7s before the cap) plus the
    // post-spawn submit delay so runInstall actually runs.
    await vi.advanceTimersByTimeAsync(2000);

    const installTerminalId = currentTerminalId();
    if (installTerminalId === null) {
      return null; // guard stopped auto-respawn
    }
    // Install succeeds -> handleExit respawns the dev server (awaits port
    // allocation, which reuses the registered port -> microtask resolution).
    ptyClient.emitExit(installTerminalId, 0);
    await flushAsyncWork();
    return currentTerminalId();
  }

  it("installs immediately on the first missing-deps cycle (no backoff delay)", async () => {
    const started = await service.ensure(baseRequest);
    const devId = started.terminalId!;
    const spawnsBefore = ptyClient.spawn.mock.calls.length;

    ptyClient.emitData(devId, "missing deps");
    ptyClient.emitExit(devId, 1);

    // First attempt runs without waiting on a timer: the install PTY is spawned
    // synchronously in handleExit, no fake-timer advance required.
    const state = service.getState(stateRequest);
    expect(state.status).toBe("installing");
    expect(state.crashLoopStopped).toBeUndefined();
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBefore + 1);
  });

  it("delays the second consecutive install behind a geometric backoff", async () => {
    const started = await service.ensure(baseRequest);
    let devId = started.terminalId!;

    // First cycle (immediate) gets us a respawned dev server.
    devId = (await crashThroughInstall(devId))!;
    expect(devId).toBeTruthy();

    const spawnsBeforeSecond = ptyClient.spawn.mock.calls.length;
    ptyClient.emitData(devId, "missing deps");
    ptyClient.emitExit(devId, 1);

    // Second attempt must wait for the 500ms initial backoff — no install yet.
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBeforeSecond);
    expect(currentTerminalId()).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBeforeSecond + 1);
    expect(service.getState(stateRequest).status).toBe("installing");
  });

  it("halts auto-respawn into a recoverable stopped state after repeated fast cycles", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    // Five fast install cycles are tolerated; the sixth crash trips the guard.
    for (let cycle = 0; cycle < 5; cycle++) {
      devId = await crashThroughInstall(devId!);
      expect(devId, `cycle ${cycle} should respawn`).toBeTruthy();
      expect(service.getState(stateRequest).crashLoopStopped).toBeUndefined();
    }

    const spawnsBeforeStop = ptyClient.spawn.mock.calls.length;
    const result = await crashThroughInstall(devId!);

    expect(result).toBeNull();
    const stopped = service.getState(stateRequest);
    expect(stopped.status).toBe("stopped");
    expect(stopped.crashLoopStopped).toBe(true);
    expect(stopped.terminalId).toBeNull();
    // No further dev server or install PTY is spawned after the guard trips.
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBeforeStop);
  });

  it("graduates and resets the counter when a dev server survives the min-uptime window", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    // Four fast cycles bring the counter close to the limit.
    for (let cycle = 0; cycle < 4; cycle++) {
      devId = await crashThroughInstall(devId!);
      expect(devId).toBeTruthy();
    }

    // This dev server survives past CRASH_LOOP_MIN_UPTIME_MS (5s) — it reaches
    // "running" — so the next crash must reset the counter rather than trip it.
    await vi.advanceTimersByTimeAsync(6000);
    expect(service.getState(stateRequest).status).toBe("running");

    // Crash it after the long, healthy run.
    devId = await crashThroughInstall(devId!);
    expect(devId, "post-graduation crash must not be stopped").toBeTruthy();
    expect(service.getState(stateRequest).crashLoopStopped).toBeUndefined();

    // The counter restarted from zero: it now takes a fresh run of fast cycles
    // (not a single one) to trip the guard again.
    devId = await crashThroughInstall(devId!);
    expect(devId).toBeTruthy();
    expect(service.getState(stateRequest).crashLoopStopped).toBeUndefined();
  });

  it("clears the stopped guard and respawns when the user restarts", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    for (let cycle = 0; cycle < 5; cycle++) {
      devId = await crashThroughInstall(devId!);
    }
    const result = await crashThroughInstall(devId!);
    expect(result).toBeNull();
    expect(service.getState(stateRequest).crashLoopStopped).toBe(true);

    const restarted = await service.restart(stateRequest);
    expect(restarted.crashLoopStopped).toBeUndefined();
    expect(restarted.status).toBe("starting");
    expect(restarted.terminalId).toBeTruthy();
  });

  it("cancels a pending backoff install when the user restarts mid-wait", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    // One immediate cycle, then start a second cycle and crash it so a backoff
    // re-install is scheduled but not yet fired.
    devId = await crashThroughInstall(devId!);
    ptyClient.emitData(devId!, "missing deps");
    ptyClient.emitExit(devId!, 1);
    const spawnsWhilePending = ptyClient.spawn.mock.calls.length;
    expect(currentTerminalId()).toBeNull(); // backoff pending, no install yet

    const restarted = await service.restart(stateRequest);
    expect(restarted.status).toBe("starting");

    // The previously scheduled backoff install must not fire after the restart.
    const spawnsAfterRestart = ptyClient.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsAfterRestart);
    // (restart itself spawned a fresh dev server.)
    expect(spawnsAfterRestart).toBeGreaterThan(spawnsWhilePending);
  });

  it("does not run a backoff install after the service is disposed", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    devId = await crashThroughInstall(devId!);
    ptyClient.emitData(devId!, "missing deps");
    ptyClient.emitExit(devId!, 1);
    expect(currentTerminalId()).toBeNull(); // backoff pending

    const spawnsBeforeDispose = ptyClient.spawn.mock.calls.length;
    service.dispose();
    await vi.advanceTimersByTimeAsync(2000);

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBeforeDispose);
  });

  it("cancels a pending backoff install when the user stops the session", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    // One immediate cycle, then crash again so a backoff re-install is pending.
    devId = await crashThroughInstall(devId!);
    ptyClient.emitData(devId!, "missing deps");
    ptyClient.emitExit(devId!, 1);
    expect(currentTerminalId()).toBeNull(); // backoff pending, no install yet

    const stopped = await service.stop(stateRequest);
    expect(stopped.status).toBe("stopped");

    // The deferred install must not fire after the explicit stop.
    const spawnsAfterStop = ptyClient.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsAfterStop);
    expect(service.getState(stateRequest).status).toBe("stopped");
  });

  it("does not auto-respawn a crash-loop-stopped session on ensure with unchanged config", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    for (let cycle = 0; cycle < 5; cycle++) {
      devId = await crashThroughInstall(devId!);
    }
    expect(await crashThroughInstall(devId!)).toBeNull();
    expect(service.getState(stateRequest).crashLoopStopped).toBe(true);

    // A remount re-runs ensure() with the same config. The guard must hold —
    // no fresh PTY, still stopped — until the user restarts explicitly.
    const spawnsBeforeEnsure = ptyClient.spawn.mock.calls.length;
    const reEnsured = await service.ensure(baseRequest);
    await flushAsyncWork();

    expect(reEnsured.status).toBe("stopped");
    expect(reEnsured.crashLoopStopped).toBe(true);
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBeforeEnsure);
  });

  it("clears the guard and respawns when ensure arrives with a changed config", async () => {
    const started = await service.ensure(baseRequest);
    let devId: string | null = started.terminalId!;

    for (let cycle = 0; cycle < 5; cycle++) {
      devId = await crashThroughInstall(devId!);
    }
    expect(await crashThroughInstall(devId!)).toBeNull();
    expect(service.getState(stateRequest).crashLoopStopped).toBe(true);

    // A different dev command is an explicit "try again" — the guard resets and
    // the server spawns fresh.
    const reEnsured = await service.ensure({ ...baseRequest, devCommand: "npm run dev:alt" });
    expect(reEnsured.crashLoopStopped).toBeUndefined();
    expect(reEnsured.status).toBe("starting");
    expect(reEnsured.terminalId).toBeTruthy();
  });

  it("surfaces an install failure as an error without consuming guard budget", async () => {
    const started = await service.ensure(baseRequest);
    const devId = started.terminalId!;

    ptyClient.emitData(devId, "missing deps");
    ptyClient.emitExit(devId, 1);
    const installId = currentTerminalId();
    expect(installId).toBeTruthy();

    // The install itself fails (nonzero exit) — handleExit reports an error and
    // does not respawn. No backoff is scheduled.
    const spawnsAfterInstall = ptyClient.spawn.mock.calls.length;
    ptyClient.emitExit(installId!, 1);
    await vi.advanceTimersByTimeAsync(2000);

    const state = service.getState(stateRequest);
    expect(state.status).toBe("error");
    expect(state.crashLoopStopped).toBeUndefined();
    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsAfterInstall);
  });
});
