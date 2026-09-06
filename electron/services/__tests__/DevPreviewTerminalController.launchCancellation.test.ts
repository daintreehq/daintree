/**
 * The post-install respawn runs outside the session lock and now awaits command
 * normalization (filesystem reads). A stop that lands inside that window leaves
 * `generation` untouched and sees no terminal, so only the launch epoch can
 * tell the pending launch that its session is gone (#12295).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadFile = vi.hoisted(() => vi.fn<(path: string, encoding: string) => Promise<string>>());

vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])) },
  readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])),
}));

import {
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
    needsInstall: false,
    isRunningInstall: false,
    installAttemptedGeneration: null,
    launchEpoch: 0,
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
    getTerminalAsync: vi.fn(async () => null),
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

describe("dev preview launch cancellation", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
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
