import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import { ActivityMonitor } from "../../ActivityMonitor.js";
import type { SpawnContext } from "../terminalSpawn.js";

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
    env: {},
    ...overrides,
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createAgentTerminal(
  agentId: string,
  options?: Partial<TerminalProcessOptions>
): TerminalProcess {
  const ctx = defaultSpawnContext();
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal",
      launchAgentId: agentId,
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

  it("responds and strips queries after runtime promotion via detectedAgentId", () => {
    const proc = createPlainTerminal();

    // Pre-promotion: backend does not respond; renderer receives query.
    ptyOnDataCallback!("\x1b]11;?\x1b\\");
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(emitDataMock).toHaveBeenLastCalledWith("t1", "\x1b]11;?\x1b\\");

    // Simulate promotion: ProcessDetector would call handleAgentDetection,
    // which sets detectedAgentId on terminalInfo. Mutate directly to isolate
    // the OSC responder behavior.
    proc.getInfo().detectedAgentId = "claude";

    ptyOnDataCallback!("\x1b]11;?\x1b\\");
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]11;rgb:0000/0000/0000\x1b\\");
    // Promoted terminal: renderer receives the query stripped.
    expect(emitDataMock).toHaveBeenLastCalledWith("t1", "");
  });

  it("stops responding after demotion when detectedAgentId clears", () => {
    const proc = createPlainTerminal();
    proc.getInfo().detectedAgentId = "claude";

    ptyOnDataCallback!("\x1b]10;?\x1b\\");
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
    ptyWriteMock.mockClear();

    // Demotion: clear detectedAgentId as handleAgentDetection does on agent exit.
    proc.getInfo().detectedAgentId = undefined;

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

describe("TerminalProcess OSC 9;4 progress signal wiring (Issue #8701)", () => {
  // Launched agents start in "busy" from startPolling(), so we can't observe
  // OSC working as a state transition without driving the monitor to idle first
  // (slow path through boot detection + 8s debounce). Instead, spy on the
  // monitor's OSC handlers and assert they're invoked — this directly
  // verifies the parser-to-monitor wiring in TerminalProcess.handlePtyData.
  let workingSpy: ReturnType<typeof vi.spyOn>;
  let idleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    emitDataMock = vi.fn<(id: string, data: string | Uint8Array) => void>();
    ptyOnDataCallback = null;
    workingSpy = vi.spyOn(ActivityMonitor.prototype, "onOscProgressWorking");
    idleSpy = vi.spyOn(ActivityMonitor.prototype, "onOscProgressIdle");
    // vi.spyOn may return the same spy across tests when the prop has been
    // spied before; clear history explicitly so each test starts fresh.
    workingSpy.mockClear();
    idleSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards OSC 9;4 state=1 to the activity monitor as a working signal", () => {
    createAgentTerminal("claude");
    expect(ptyOnDataCallback).not.toBeNull();
    workingSpy.mockClear();

    ptyOnDataCallback!("\x1b]9;4;1;50\x07");

    expect(workingSpy).toHaveBeenCalledTimes(1);
    expect(idleSpy).not.toHaveBeenCalled();
  });

  it("forwards OSC 9;4 state=3 (indeterminate) as a working signal", () => {
    createAgentTerminal("claude");
    workingSpy.mockClear();

    ptyOnDataCallback!("\x1b]9;4;3\x07");

    expect(workingSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards OSC 9;4 state=0 as an idle signal", () => {
    createAgentTerminal("claude");
    idleSpy.mockClear();

    ptyOnDataCallback!("\x1b]9;4;0\x07");

    expect(idleSpy).toHaveBeenCalledTimes(1);
    expect(workingSpy).not.toHaveBeenCalled();
  });

  it("recognizes OSC 9;4 sequences split across two PTY chunks", () => {
    createAgentTerminal("claude");
    workingSpy.mockClear();

    // First chunk has only the prefix — must NOT fire on its own.
    ptyOnDataCallback!("\x1b]9;4;1;5");
    expect(workingSpy).not.toHaveBeenCalled();

    // Second chunk completes the sequence.
    ptyOnDataCallback!("0\x07");
    expect(workingSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fire OSC handlers when data has no OSC 9;4 sequence", () => {
    createAgentTerminal("claude");
    workingSpy.mockClear();
    idleSpy.mockClear();

    ptyOnDataCallback!("just some normal output\n");
    ptyOnDataCallback!("\x1b]0;Window Title\x07"); // OSC 0 — unrelated
    ptyOnDataCallback!("\x1b[31mred\x1b[0m"); // SGR — unrelated

    expect(workingSpy).not.toHaveBeenCalled();
    expect(idleSpy).not.toHaveBeenCalled();
  });

  it("forwards OSC 9;4 bytes to the renderer (xterm.js renders the progress bar)", () => {
    // Confirm the OSC 9;4 stays in the renderer-bound emit. Stripping happens
    // downstream inside ActivityMonitor's byte-volume gate via IdleSequenceFilter,
    // not in TerminalProcess.
    createAgentTerminal("claude");
    const payload = "\x1b]9;4;1;50\x07";
    ptyOnDataCallback!(payload);
    expect(emitDataMock).toHaveBeenCalledWith("t1", payload);
  });

  it("does not throw for plain (non-agent) terminals — the parser feeds but the callback no-ops", () => {
    // Plain terminals have no activity monitor at spawn (only after promotion).
    // The optional-chaining guard in TerminalProcess.osc94Parser callbacks
    // makes the OSC parse a safe no-op.
    createPlainTerminal();
    expect(() => ptyOnDataCallback!("\x1b]9;4;1;42\x07")).not.toThrow();
    expect(workingSpy).not.toHaveBeenCalled();
  });
});
