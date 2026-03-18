import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";

type SpawnFn = (file: string, args: string[], options: Record<string, unknown>) => IPty;

let spawnMock: ReturnType<typeof vi.fn<SpawnFn>>;

const persistAsyncMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
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
    persistSessionSnapshotAsync: persistAsyncMock,
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
      kind: "agent",
      type: "claude",
      agentId: "claude",
      ...options,
    },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as ConstructorParameters<typeof TerminalProcess>[3]["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
    }
  );
}

describe("TerminalProcess.flushEventDrivenSnapshot", () => {
  beforeEach(() => {
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
    persistAsyncMock.mockReset();
    persistAsyncMock.mockReturnValue(Promise.resolve());
    persistSyncMock.mockReset();
  });

  it("calls persistSessionSnapshotAsync for agent terminals", () => {
    const terminal = createTerminal();
    vi.spyOn(terminal, "getSerializedState").mockReturnValue("agent-scrollback");

    terminal.flushEventDrivenSnapshot();

    expect(persistAsyncMock).toHaveBeenCalledWith("t1", "agent-scrollback");
  });

  it("throttles rapid calls within 2 seconds", () => {
    const terminal = createTerminal();
    vi.spyOn(terminal, "getSerializedState").mockReturnValue("data");

    terminal.flushEventDrivenSnapshot();
    expect(persistAsyncMock).toHaveBeenCalledTimes(1);

    // Second call within 2s should be suppressed
    terminal.flushEventDrivenSnapshot();
    expect(persistAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("does not flush when serialized state is null", () => {
    const terminal = createTerminal();
    vi.spyOn(terminal, "getSerializedState").mockReturnValue(null);

    terminal.flushEventDrivenSnapshot();

    expect(persistAsyncMock).not.toHaveBeenCalled();
  });

  it("does not flush when serialized state exceeds max bytes", () => {
    const terminal = createTerminal();
    // SESSION_SNAPSHOT_MAX_BYTES is 5MB; create a string larger than that
    const oversized = "x".repeat(6 * 1024 * 1024);
    vi.spyOn(terminal, "getSerializedState").mockReturnValue(oversized);

    terminal.flushEventDrivenSnapshot();

    expect(persistAsyncMock).not.toHaveBeenCalled();
  });

  it("does not flush when terminal is killed", () => {
    const terminal = createTerminal();
    vi.spyOn(terminal, "getSerializedState").mockReturnValue("data");

    terminal.kill("test");

    persistAsyncMock.mockReset();
    terminal.flushEventDrivenSnapshot();

    expect(persistAsyncMock).not.toHaveBeenCalled();
  });
});
