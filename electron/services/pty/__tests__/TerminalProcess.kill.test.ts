import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";

type SpawnFn = (file: string, args: string[], options: Record<string, unknown>) => IPty;

let spawnMock: ReturnType<typeof vi.fn<SpawnFn>>;

const persistSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node-pty", () => {
  return {
    spawn: (...args: Parameters<SpawnFn>) => spawnMock(...args),
  };
});

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TERMINAL_SESSION_PERSISTENCE_ENABLED: true,
    persistSessionSnapshotSync: persistSyncMock,
    persistSessionSnapshotAsync: vi.fn(),
  };
});

function createMockPty(overrides?: Partial<IPty>): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    ...overrides,
  };
  return pty as IPty;
}

function createMockProcessTreeCache(descendantPids: number[] = []): ProcessTreeCache {
  return {
    getDescendantPids: vi.fn().mockReturnValue(descendantPids),
    getChildPids: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getProcess: vi.fn(),
    hasChildren: vi.fn().mockReturnValue(false),
    getDescendantsCpuUsage: vi.fn().mockReturnValue(0),
    hasActiveDescendants: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn(),
    onRefresh: vi.fn().mockReturnValue(() => {}),
    refresh: vi.fn(),
    getLastRefreshTime: vi.fn().mockReturnValue(0),
    getLastError: vi.fn().mockReturnValue(null),
    getCacheSize: vi.fn().mockReturnValue(0),
  } as unknown as ProcessTreeCache;
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  deps?: Partial<TerminalProcessDeps>
): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      type: "terminal",
      ...options,
    },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
      ...deps,
    }
  );
}

describe("TerminalProcess.kill — session persistence", () => {
  beforeEach(() => {
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
    persistSyncMock.mockReset();
  });

  it("persists session snapshot synchronously for non-agent terminal on kill", () => {
    const terminal = createTerminal();

    // Spy on getSerializedState to return known content
    vi.spyOn(terminal, "getSerializedState").mockReturnValue("scrollback-data");

    terminal.kill("test");

    expect(persistSyncMock).toHaveBeenCalledWith("t1", "scrollback-data");
  });

  it("does not persist session for agent terminals on kill", () => {
    const terminal = createTerminal({ kind: "agent", type: "claude" });

    vi.spyOn(terminal, "getSerializedState").mockReturnValue("scrollback-data");

    terminal.kill("test");

    expect(persistSyncMock).not.toHaveBeenCalled();
  });

  it("handles null serialized state gracefully on kill", () => {
    const terminal = createTerminal();

    vi.spyOn(terminal, "getSerializedState").mockReturnValue(null);

    terminal.kill("test");

    expect(persistSyncMock).not.toHaveBeenCalled();
  });

  it("skips persist when serialized state exceeds max bytes", () => {
    const terminal = createTerminal();

    // SESSION_SNAPSHOT_MAX_BYTES is 5MB — create oversized data
    const oversized = "x".repeat(6 * 1024 * 1024);
    vi.spyOn(terminal, "getSerializedState").mockReturnValue(oversized);

    terminal.kill("test");

    expect(persistSyncMock).not.toHaveBeenCalled();
  });

  it("completes kill even if serialization throws", () => {
    const terminal = createTerminal();

    vi.spyOn(terminal, "getSerializedState").mockImplementation(() => {
      throw new Error("serialize failed");
    });

    // Should not throw
    expect(() => terminal.kill("test")).not.toThrow();
  });
});

describe("TerminalProcess.kill — process tree cleanup", () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
    persistSyncMock.mockReset();
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    processKillSpy.mockRestore();
  });

  it("sends SIGTERM to descendants bottom-up before killing shell", () => {
    const mockCache = createMockProcessTreeCache([456, 789]);
    const mockPty = createMockPty();
    spawnMock = vi.fn<SpawnFn>(() => mockPty);

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.kill("test");

    // Descendants should receive SIGTERM in order (bottom-up)
    expect(processKillSpy).toHaveBeenCalledWith(456, "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(789, "SIGTERM");

    // Shell PTY should also be killed
    expect(mockPty.kill).toHaveBeenCalled();

    // SIGTERM calls should come before SIGKILL timer fires
    const sigTermCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGTERM");
    expect(sigTermCalls).toHaveLength(2);
  });

  it("escalates to SIGKILL after 500ms on kill()", () => {
    const mockCache = createMockProcessTreeCache([456]);
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.kill("test");

    // No SIGKILL yet
    const sigkillBefore = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillBefore).toHaveLength(0);

    // Advance timer
    vi.advanceTimersByTime(500);

    // Now SIGKILL should have been sent to descendant + shell
    const sigkillAfter = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillAfter).toHaveLength(2); // pid 456 + pid 123 (shell)
  });

  it("sends SIGKILL immediately on dispose()", () => {
    const mockCache = createMockProcessTreeCache([456]);
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    terminal.dispose();

    // SIGKILL should be sent synchronously without waiting for timer
    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillCalls).toHaveLength(2); // pid 456 + pid 123
  });

  it("handles undefined pty pid gracefully", () => {
    const mockPty = createMockPty({ pid: undefined as unknown as number });
    spawnMock = vi.fn<SpawnFn>(() => mockPty);

    const terminal = createTerminal();
    expect(() => terminal.kill("test")).not.toThrow();

    // Should still call ptyProcess.kill() as fallback
    expect(mockPty.kill).toHaveBeenCalled();

    // Should not call process.kill (no PID to target)
    expect(processKillSpy).not.toHaveBeenCalled();
  });

  it("handles null processTreeCache gracefully", () => {
    const mockPty = createMockPty();
    spawnMock = vi.fn<SpawnFn>(() => mockPty);

    const terminal = createTerminal(undefined, { processTreeCache: null });
    terminal.kill("test");

    // Should still call ptyProcess.kill()
    expect(mockPty.kill).toHaveBeenCalled();

    // No SIGTERM calls to descendants (no cache to query)
    const sigTermCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGTERM");
    expect(sigTermCalls).toHaveLength(0);

    // SIGKILL sweep should still fire for shell pid after 500ms
    vi.advanceTimersByTime(500);
    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillCalls).toHaveLength(1); // Just the shell pid 123
  });

  it("clears pending kill timer when dispose() follows kill()", () => {
    const mockCache = createMockProcessTreeCache([456]);
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });

    // kill() schedules a 500ms timer
    terminal.kill("test");
    processKillSpy.mockClear();

    // dispose() should clear that timer and do immediate SIGKILL
    terminal.dispose();

    const sigkillCalls = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(sigkillCalls.length).toBeGreaterThan(0);

    // Advancing timer should NOT cause a second SIGKILL sweep
    processKillSpy.mockClear();
    vi.advanceTimersByTime(500);
    const lateSigkills = processKillSpy.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(lateSigkills).toHaveLength(0);
  });

  it("handles process.kill throwing ESRCH gracefully", () => {
    const mockCache = createMockProcessTreeCache([456]);
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
    processKillSpy.mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const terminal = createTerminal(undefined, { processTreeCache: mockCache });
    expect(() => terminal.kill("test")).not.toThrow();
  });
});
