import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";

type SpawnFn = (file: string, args: string[], options: any) => IPty;

let spawnMock: ReturnType<typeof vi.fn<SpawnFn>>;
let ptyWriteMock: ReturnType<typeof vi.fn>;

vi.mock("node-pty", () => {
  return {
    spawn: (...args: any[]) => spawnMock(...args),
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

function createTerminal(): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "shell",
      type: "terminal",
    },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {} as any,
      ptyPool: null,
      processTreeCache: null,
    }
  );
}

describe("TerminalProcess.submit", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn();
    spawnMock = vi.fn(() => createMockPty());
  });

  it("treats a trailing newline as Enter (not multiline paste)", () => {
    const terminal = createTerminal();
    terminal.submit("test\n");
    expect(ptyWriteMock).toHaveBeenCalledWith("test\r");
  });

  it("uses bracketed paste for multiline input and then sends CR", () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("line1\nline2");

    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock.mock.calls[0]?.[0]).toMatch(/^\x1b\[200~line1\rline2\x1b\[201~$/);

    vi.advanceTimersByTime(10);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("sends multiple CRs when input has multiple trailing newlines", () => {
    const terminal = createTerminal();
    terminal.submit("test\n\n");
    expect(ptyWriteMock).toHaveBeenCalledWith("test\r\r");
  });

  it("submits empty input as a single CR", () => {
    const terminal = createTerminal();
    terminal.submit("");
    expect(ptyWriteMock).toHaveBeenCalledWith("\r");
  });
});
