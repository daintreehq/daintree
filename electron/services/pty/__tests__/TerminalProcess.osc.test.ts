import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { TerminalType } from "../../../../shared/types/panel.js";

let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;
let emitDataMock: ReturnType<typeof vi.fn<(id: string, data: string | Uint8Array) => void>>;
let ptyOnDataCallback: ((data: string) => void) | null = null;

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
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

function defaultSpawnContext(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    isAgentTerminal: false,
    agentId: undefined,
    env: {},
    ...overrides,
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createAgentTerminal(
  agentId: TerminalType,
  options?: Partial<TerminalProcessOptions>
): TerminalProcess {
  const ctx = defaultSpawnContext({ isAgentTerminal: true, agentId });
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
    {
      emitData: (id, data) => {
        emitDataMock(id, data);
      },
      onExit: () => {},
    },
    {
      agentStateService: {
        handleActivityState: () => {},
      } as any,
      ptyPool: null,
      processTreeCache: null,
    },
    ctx,
    createMockPty()
  );
}

function createPlainTerminal(): TerminalProcess {
  const ctx = defaultSpawnContext();
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      type: "terminal",
    },
    {
      emitData: (id, data) => {
        emitDataMock(id, data);
      },
      onExit: () => {},
    },
    {
      agentStateService: {
        handleActivityState: () => {},
      } as any,
      ptyPool: null,
      processTreeCache: null,
    },
    ctx,
    createMockPty()
  );
}

describe("TerminalProcess OSC color query responder", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    emitDataMock = vi.fn<(id: string, data: string | Uint8Array) => void>();
    ptyOnDataCallback = null;
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
    expect(ptyWriteMock).toHaveBeenCalledTimes(2);
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

  it("strips handled OSC queries from renderer-forwarded data for spawn-time agents", () => {
    createAgentTerminal("opencode");

    ptyOnDataCallback!("before\x1b]10;?\x1b\\middle\x1b]11;?\x07after");

    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]11;rgb:0000/0000/0000\x1b\\");
    expect(emitDataMock).toHaveBeenCalledTimes(1);
    expect(emitDataMock).toHaveBeenCalledWith("t1", "beforemiddleafter");
  });

  it("forwards OSC queries unchanged to renderer for plain terminals", () => {
    createPlainTerminal();

    const payload = "\x1b]11;?\x1b\\";
    ptyOnDataCallback!(payload);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenCalledWith("t1", payload);
  });

  it("responds and strips queries after runtime promotion via detectedAgentType", () => {
    const proc = createPlainTerminal();

    // Pre-promotion: backend does not respond; renderer receives query.
    ptyOnDataCallback!("\x1b]11;?\x1b\\");
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenLastCalledWith("t1", "\x1b]11;?\x1b\\");

    // Simulate promotion: ProcessDetector would call handleAgentDetection,
    // which sets detectedAgentType on terminalInfo. Mutate directly to isolate
    // the OSC responder behavior.
    proc.getInfo().detectedAgentType = "claude";

    ptyOnDataCallback!("\x1b]11;?\x1b\\");
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]11;rgb:0000/0000/0000\x1b\\");
    // Promoted terminal: renderer receives the query stripped.
    expect(emitDataMock).toHaveBeenLastCalledWith("t1", "");
  });

  it("stops responding after demotion when detectedAgentType clears", () => {
    const proc = createPlainTerminal();
    proc.getInfo().detectedAgentType = "claude";

    ptyOnDataCallback!("\x1b]10;?\x1b\\");
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
    ptyWriteMock.mockClear();

    // Demotion: clear detectedAgentType as handleAgentDetection does on agent exit.
    proc.getInfo().detectedAgentType = undefined;

    ptyOnDataCallback!("\x1b]10;?\x1b\\");
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenLastCalledWith("t1", "\x1b]10;?\x1b\\");
  });

  it("does not strip unrelated OSC sequences (e.g. OSC 52 clipboard)", () => {
    createAgentTerminal("opencode");

    const payload = "\x1b]52;c;SGVsbG8=\x07";
    ptyOnDataCallback!(payload);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenCalledWith("t1", payload);
  });

  it("does not strip OSC 10/11 set requests (no '?'), only queries", () => {
    createAgentTerminal("opencode");

    // Setting the color (not querying) should pass through untouched.
    const payload = "\x1b]10;rgb:ffff/ffff/ffff\x07";
    ptyOnDataCallback!(payload);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenCalledWith("t1", payload);
  });

  it("does not respond to an unterminated OSC query fragment", () => {
    createAgentTerminal("opencode");

    // Split-chunk regression: if the terminator hasn't arrived yet, responding
    // on the fragment would mismatch the terminator-requiring strip and leak
    // the fragment to the renderer, which would double-reply once xterm.js
    // re-assembled the full sequence.
    ptyOnDataCallback!("\x1b]10;?");

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenCalledWith("t1", "\x1b]10;?");
  });

  it("leaves the query in renderer data when the backend write fails", () => {
    createAgentTerminal("opencode");
    ptyWriteMock.mockImplementation(() => {
      throw new Error("PTY dead");
    });

    const payload = "\x1b]11;?\x1b\\";
    ptyOnDataCallback!(payload);

    // Backend tried to respond, but failed. Renderer must still see the query
    // so xterm.js can reply — otherwise the TUI agent hangs with no responder.
    expect(emitDataMock).toHaveBeenCalledWith("t1", payload);
  });

  it("strips only queries whose write succeeded when one of two writes fails", () => {
    createAgentTerminal("opencode");
    // OSC 10 write succeeds, OSC 11 write throws.
    ptyWriteMock
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("PTY dead");
      });

    ptyOnDataCallback!("\x1b]10;?\x07\x1b]11;?\x07");

    // OSC 10 was handled → stripped. OSC 11 failed → left in the stream.
    expect(emitDataMock).toHaveBeenCalledWith("t1", "\x1b]11;?\x07");
  });
});
