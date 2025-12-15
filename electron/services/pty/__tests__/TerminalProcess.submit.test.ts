import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";

type SpawnFn = (file: string, args: string[], options: any) => IPty;

let spawnMock: ReturnType<typeof vi.fn<SpawnFn>>;
let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;

vi.mock("node-pty", () => {
  return {
    spawn: (...args: Parameters<SpawnFn>) => spawnMock(...args),
  };
});

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      ptyWriteMock(data);
    },
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
      } as any,
      ptyPool: null,
      processTreeCache: null,
    }
  );
}

describe("TerminalProcess.submit", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
  });

  it("treats a trailing newline as Enter (not multiline paste)", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    terminal.submit("test\n");
    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("test");
    await vi.advanceTimersByTimeAsync(10);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("uses bracketed paste for multiline input and then sends CR", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("line1\nline2");

    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock.mock.calls[0]?.[0]).toBe("\x1b[200~line1\rline2\x1b[201~");
    await vi.advanceTimersByTimeAsync(10);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("sends multiple CRs when input has multiple trailing newlines", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    terminal.submit("test\n\n");
    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("test");
    await vi.advanceTimersByTimeAsync(10);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r\r");
    vi.useRealTimers();
  });

  it("submits empty input as a single CR", () => {
    const terminal = createTerminal();
    terminal.submit("");
    expect(ptyWriteMock).toHaveBeenCalledWith("\r");
  });

  it("does not use bracketed paste for Gemini; uses soft newlines and then sends CR", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ kind: "agent", type: "gemini" });

    terminal.submit("line1\nline2");

    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock.mock.calls[0]?.[0]).toBe("line1\x1b\rline2");
    await vi.advanceTimersByTimeAsync(10);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });
});
