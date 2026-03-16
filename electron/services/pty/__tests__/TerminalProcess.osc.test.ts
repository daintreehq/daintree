import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { TerminalType } from "../../../../shared/types/panel.js";

type SpawnFn = (file: string, args: string[], options: any) => IPty;

let spawnMock: ReturnType<typeof vi.fn<SpawnFn>>;
let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;
let ptyOnDataCallback: ((data: string) => void) | null = null;

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
    onData: (cb: (data: string) => void) => {
      ptyOnDataCallback = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createAgentTerminal(
  agentId: TerminalType,
  options?: Partial<TerminalProcessOptions>
): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "agent",
      type: agentId,
      agentId,
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

function createPlainTerminal(): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      type: "terminal",
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

describe("TerminalProcess OSC color query responder", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    ptyOnDataCallback = null;
    spawnMock = vi.fn<SpawnFn>(() => createMockPty());
  });

  it("responds to OSC 11 (background color query) for agent terminals", () => {
    createAgentTerminal("opencode");
    expect(ptyOnDataCallback).not.toBeNull();

    ptyOnDataCallback!("\x1b]11;?\x1b\\");

    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]11;rgb:0000/0000/0000\x1b\\");
  });

  it("responds to OSC 10 (foreground color query) for agent terminals", () => {
    createAgentTerminal("opencode");
    expect(ptyOnDataCallback).not.toBeNull();

    ptyOnDataCallback!("\x1b]10;?\x1b\\");

    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
  });

  it("responds to both OSC 10 and 11 when both appear in one chunk", () => {
    createAgentTerminal("opencode");

    ptyOnDataCallback!("\x1b]10;?\x07\x1b]11;?\x07");

    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]11;rgb:0000/0000/0000\x1b\\");
  });

  it("does not respond to OSC 10/11 for non-agent terminals", () => {
    createPlainTerminal();
    expect(ptyOnDataCallback).not.toBeNull();

    ptyOnDataCallback!("\x1b]11;?\x1b\\");

    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("does not respond when data does not contain OSC queries", () => {
    createAgentTerminal("opencode");

    ptyOnDataCallback!("Hello world\r\n");

    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("works for any agent type, not just opencode", () => {
    createAgentTerminal("claude");

    ptyOnDataCallback!("\x1b]11;?\x07");

    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]11;rgb:0000/0000/0000\x1b\\");
  });
});
