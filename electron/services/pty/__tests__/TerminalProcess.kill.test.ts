import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";

type SpawnFn = (file: string, args: string[], options: any) => IPty;

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

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createTerminal(options?: Partial<TerminalProcessOptions>): TerminalProcess {
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
      } as any,
      ptyPool: null,
      processTreeCache: null,
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
