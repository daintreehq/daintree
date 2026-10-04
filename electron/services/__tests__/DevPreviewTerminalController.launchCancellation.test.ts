/**
 * The post-install respawn runs outside the session lock and now awaits command
 * normalization (filesystem reads). A stop that lands inside that window leaves
 * `generation` untouched and sees no terminal, so only the launch epoch can
 * tell the pending launch that its session is gone (#12295).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReadFile = vi.hoisted(() => vi.fn<(path: string, encoding: string) => Promise<string>>());

vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])) },
  readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])),
}));

const portGate = vi.hoisted(() => ({ pending: null as Promise<void> | null, reached: false }));

// Holds the reservation open across the allocate await, the way a real net
// probe does, so a cancellation can land while the port is already registered.
vi.mock("../DevPreviewPortAllocator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../DevPreviewPortAllocator.js")>();
  return {
    ...actual,
    allocatePort: async (registry: Map<string, number>, key: string) => {
      const port = await actual.allocatePort(registry, key);
      portGate.reached = true;
      if (portGate.pending) await portGate.pending;
      return port;
    },
  };
});

import {
  attachTerminal,
  cancelSessionWork,
  ensureSessionTerminal,
  invalidatePendingLaunch,
  spawnSessionTerminal,
  stopSessionTerminal,
  type TerminalControllerDeps,
  type TerminalControllerSession,
} from "../DevPreviewTerminalController.js";
import { createSessionKey } from "../DevPreviewRequestValidators.js";
import type { PtyClient } from "../PtyClient.js";

function makeSession(): TerminalControllerSession {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
    turbopackEnabled: true,
    buffer: "",
    lastErrorKey: null,
    terminalId: null,
    status: "installing",
    url: null,
    predictedUrl: null,
    pendingUrl: null,
    readinessAbort: null,
    markerSeen: false,
    sawOutput: false,
    readinessDeadline: null,
    readinessSaw5xx: false,
    needsInstall: false,
    isRunningInstall: false,
    installAttemptedGeneration: null,
    launchEpoch: 0,
    killedTerminalId: null,
    startupReplayTimer: null,
    updatedAtPerformanceMs: 0,
    compiling: false,
    compilingTimer: null,
    compilingClearTimer: null,
    backoffAbort: null,
    crashCount: 0,
    devSpawnedAt: null,
    crashLoopStopped: false,
    generation: 3,
  };
}

function makeDeps(): {
  deps: TerminalControllerDeps<TerminalControllerSession>;
  spawn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn();
  const ptyClient = {
    spawn,
    kill: vi.fn(),
    submit: vi.fn(),
    hasTerminal: vi.fn(() => true),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async () => 0),
    getTerminalAsync: vi.fn(async (): Promise<unknown> => null),
  } as unknown as PtyClient;

  const portRegistry = new Map<string, number>();
  // Pre-reserved so allocatePort returns synchronously and normalization is the
  // only await this test has to gate.
  portRegistry.set(createSessionKey("project-1", "panel-1"), 4321);

  return {
    spawn,
    deps: {
      ptyClient,
      portRegistry,
      terminalToSession: new Map<string, string>(),
      portWaitAborts: new Set<AbortController>(),
      isDisposed: () => false,
      recordDiagnostic: vi.fn(),
      recordSessionDiagnostic: vi.fn(),
      updateSession: vi.fn((session, updates) => {
        if (updates.status !== undefined) session.status = updates.status;
        if (updates.terminalId !== undefined) session.terminalId = updates.terminalId;
        if (updates.generation !== undefined) session.generation = updates.generation;
      }),
      clearCompiling: vi.fn(),
      pollServerReadiness: vi.fn(),
    },
  };
}

/**
 * One shared gate: normalization makes several reads in sequence, so releasing
 * a single pending promise would only unblock the first of them.
 */
function gateReadFile(): () => void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  mockReadFile.mockImplementation(() =>
    gate.then(() => {
      throw new Error("ENOENT");
    })
  );
  return open;
}

function gatePortAllocation(): () => void {
  let open!: () => void;
  portGate.pending = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    portGate.pending = null;
    open();
  };
}

describe("dev preview launch cancellation", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    portGate.pending = null;
    portGate.reached = false;
  });

  it("abandons a launch whose session was stopped while its command was resolving", async () => {
    const releaseNormalization = gateReadFile();

    const session = makeSession();
    const { deps, spawn } = makeDeps();

    const launch = spawnSessionTerminal(session, deps);
    await vi.waitFor(() => expect(mockReadFile).toHaveBeenCalled());

    // The stop finds no terminal (the install PTY already exited) and does not
    // touch `generation` — the epoch is the only thing that changes.
    await stopSessionTerminal(session, "stop", deps);
    releaseNormalization();
    await launch;

    expect(spawn).not.toHaveBeenCalled();
    expect(session.terminalId).toBeNull();
  });

  // stop() and the config-change path cancel this way: they never reach
  // stopSessionTerminal when the session has no terminal yet.
  it("abandons a launch invalidated without going through stopSessionTerminal", async () => {
    const releaseNormalization = gateReadFile();

    const session = makeSession();
    const { deps, spawn } = makeDeps();

    const launch = spawnSessionTerminal(session, deps);
    await vi.waitFor(() => expect(mockReadFile).toHaveBeenCalled());

    invalidatePendingLaunch(session);
    releaseNormalization();
    await launch;

    expect(spawn).not.toHaveBeenCalled();
  });

  // stopSessionTerminal deliberately keeps the registry entry so a restart
  // reuses the port, so by the time this launch resumes the reservation may
  // belong to the launch that replaced it.
  it("leaves the port reservation alone when the launch was superseded mid-allocation", async () => {
    const releaseAllocation = gatePortAllocation();

    const session = makeSession();
    const { deps, spawn } = makeDeps();
    const key = createSessionKey("project-1", "panel-1");

    const launch = spawnSessionTerminal(session, deps);
    await vi.waitFor(() => expect(portGate.reached).toBe(true));

    invalidatePendingLaunch(session);
    releaseAllocation();
    await launch;

    expect(deps.portRegistry.get(key)).toBe(4321);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rolls the reservation back when the service was disposed mid-allocation", async () => {
    const releaseAllocation = gatePortAllocation();

    const session = makeSession();
    const { deps: baseDeps, spawn } = makeDeps();
    let disposed = false;
    const deps = { ...baseDeps, isDisposed: () => disposed };
    const key = createSessionKey("project-1", "panel-1");

    const launch = spawnSessionTerminal(session, deps);
    await vi.waitFor(() => expect(portGate.reached).toBe(true));

    disposed = true;
    releaseAllocation();
    await launch;

    expect(deps.portRegistry.has(key)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still spawns when nothing cancelled the launch", async () => {
    const releaseNormalization = gateReadFile();

    const session = makeSession();
    const { deps, spawn } = makeDeps();

    const launch = spawnSessionTerminal(session, deps);
    await vi.waitFor(() => expect(mockReadFile).toHaveBeenCalled());
    releaseNormalization();
    await launch;

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

// A project-wide kill (close with kill, Sleep, idle auto-close) never calls
// stopSessionTerminal — PtyClient announces it and the service runs
// cancelSessionWork on each of the project's sessions before the kill lands.
describe("dev preview external kill cancellation", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    portGate.pending = null;
    portGate.reached = false;
  });

  it("abandons a launch still allocating its port when the project is killed", async () => {
    const releaseAllocation = gatePortAllocation();

    const session = makeSession();
    const { deps, spawn } = makeDeps();

    const launch = spawnSessionTerminal(session, deps);
    await vi.waitFor(() => expect(portGate.reached).toBe(true));

    cancelSessionWork(session, deps);
    releaseAllocation();
    await launch;

    expect(spawn).not.toHaveBeenCalled();
  });

  it("revokes the reinstall chain and a pending crash-loop backoff", () => {
    const session = makeSession();
    const { deps } = makeDeps();
    const backoff = new AbortController();
    session.needsInstall = true;
    session.isRunningInstall = true;
    session.backoffAbort = backoff;
    const epoch = session.launchEpoch;

    cancelSessionWork(session, deps);

    expect(session.needsInstall).toBe(false);
    expect(session.isRunningInstall).toBe(false);
    expect(backoff.signal.aborted).toBe(true);
    expect(session.backoffAbort).toBeNull();
    expect(session.launchEpoch).toBe(epoch + 1);
  });
});

describe("dev preview stop keeps ownership until the terminal is gone", () => {
  type TerminalInfo = { id: string; projectId: string; hasPty: boolean; isExited?: boolean };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupRunning(info: () => TerminalInfo | null) {
    const session = makeSession();
    session.status = "running";
    const { deps } = makeDeps();
    vi.mocked(deps.ptyClient.getTerminalAsync).mockImplementation(async () => info() as never);
    attachTerminal(session, "term-1", deps);
    return { session, deps };
  }

  it("does not treat a killed-but-running terminal as stopped", async () => {
    // hasPty drops the moment the kill is issued; only isExited says it's down.
    let info: TerminalInfo | null = {
      id: "term-1",
      projectId: "project-1",
      hasPty: false,
      isExited: false,
    };
    const { session, deps } = setupRunning(() => info);

    let settled = false;
    const stop = stopSessionTerminal(session, "stop", deps).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);

    info = null;
    await vi.advanceTimersByTimeAsync(200);
    await stop;
    expect(session.terminalId).toBeNull();
    expect(deps.terminalToSession.has("term-1")).toBe(false);
  });

  it("re-attaches and reports an error when the terminal outlives the stop", async () => {
    const info: TerminalInfo = {
      id: "term-1",
      projectId: "project-1",
      hasPty: false,
      isExited: false,
    };
    const { session, deps } = setupRunning(() => info);

    const stop = stopSessionTerminal(session, "stop", deps);
    const assertion = expect(stop).rejects.toThrow(/Timed out waiting for terminal term-1/);
    await vi.advanceTimersByTimeAsync(9000);
    await assertion;

    expect(session.terminalId).toBe("term-1");
    expect(deps.terminalToSession.get("term-1")).toBe(createSessionKey("project-1", "panel-1"));
    expect(deps.updateSession).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ status: "error", terminalId: "term-1" })
    );
  });

  it("settles cleanly when the exit lands just as the wait runs out", async () => {
    // Still running for the whole wait (the session is detached meanwhile), and
    // gone by the re-check that follows the re-attach — the exit fired while
    // nothing was listening, so that re-check is the only thing that sees it.
    const holder: { session: TerminalControllerSession | null } = { session: null };
    const { session, deps } = setupRunning(() => ({
      id: "term-1",
      projectId: "project-1",
      hasPty: false,
      isExited: holder.session?.terminalId === "term-1",
    }));
    holder.session = session;

    const stop = stopSessionTerminal(session, "stop", deps);
    await vi.advanceTimersByTimeAsync(9000);
    await stop;

    expect(session.terminalId).toBeNull();
    expect(deps.terminalToSession.has("term-1")).toBe(false);
    expect(deps.updateSession).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ status: "error" })
    );
  });

  it("re-attaches the terminal when the kill itself throws", async () => {
    const { session, deps } = setupRunning(() => null);
    vi.mocked(deps.ptyClient.kill).mockImplementation(() => {
      throw new Error("host unavailable");
    });

    await expect(stopSessionTerminal(session, "stop", deps)).rejects.toThrow(/host unavailable/);
    expect(session.terminalId).toBe("term-1");
    expect(deps.updateSession).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ status: "error", terminalId: "term-1" })
    );
  });

  it("does not read an unanswered liveness query as the terminal being gone", async () => {
    let answering = false;
    const { session, deps } = setupRunning(() => null);
    vi.mocked(deps.ptyClient.getTerminalAsync).mockImplementation(async () => {
      if (!answering) throw new Error("get-terminal timed out");
      return null as never;
    });

    let settled = false;
    const stop = stopSessionTerminal(session, "stop", deps).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);

    answering = true;
    await vi.advanceTimersByTimeAsync(200);
    await stop;
    expect(session.terminalId).toBeNull();
  });

  it("stale-start recovery stands down when the project is killed during replay", async () => {
    const { session, deps } = setupRunning(() => ({
      id: "term-1",
      projectId: "project-1",
      hasPty: true,
      isExited: false,
    }));
    session.status = "starting";
    session.updatedAtPerformanceMs = -60_000;
    vi.mocked(deps.ptyClient.replayHistoryAsync).mockImplementation(async () => {
      cancelSessionWork(session, deps);
      return 0;
    });

    await ensureSessionTerminal(session, deps);

    expect(deps.ptyClient.kill).not.toHaveBeenCalled();
    expect(deps.ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("ensure takes back a terminal a project kill claimed but never stopped", async () => {
    const { session, deps } = setupRunning(() => ({
      id: "term-1",
      projectId: "project-1",
      hasPty: true,
      isExited: false,
    }));
    session.killedTerminalId = "term-1";

    await ensureSessionTerminal(session, deps);

    expect(session.killedTerminalId).toBeNull();
    expect(session.terminalId).toBe("term-1");
  });

  it("ensure does not spawn a second server beside one that is still dying", async () => {
    const info: TerminalInfo = {
      id: "term-1",
      projectId: "project-1",
      hasPty: false,
      isExited: false,
    };
    const { session, deps } = setupRunning(() => info);
    session.status = "error";

    await ensureSessionTerminal(session, deps);

    expect(deps.ptyClient.spawn).not.toHaveBeenCalled();
    expect(session.terminalId).toBe("term-1");
  });
});
