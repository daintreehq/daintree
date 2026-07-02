import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;

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
    onData: () => ({ dispose: () => {} }),
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

function createTerminal(options?: Partial<TerminalProcessOptions>): TerminalProcess {
  const merged = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal" as const,
    ...options,
  };
  const ctx = defaultSpawnContext();
  return new TerminalProcess(
    "t1",
    merged,
    { emitData: () => {}, onExit: () => {} },
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

describe("TerminalProcess.submit", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
  });

  it("treats a trailing newline as Enter (not multiline paste)", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    terminal.submit("test\n");
    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("test");
    await vi.advanceTimersByTimeAsync(250);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("uses bracketed paste for multiline input and then sends CR", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("line1\nline2");

    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock.mock.calls[0]?.[0]).toBe("\x1b[200~line1\rline2\x1b[201~");
    await vi.advanceTimersByTimeAsync(250);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("sends multiple CRs when input has multiple trailing newlines", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    terminal.submit("test\n\n");
    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("test");
    await vi.advanceTimersByTimeAsync(250);
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
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "gemini" });
    // Input protocol is driven by detectedAgentId (live process), not the launch hint.
    // Simulate the process detector firing for Gemini.
    (
      terminal as unknown as { terminalInfo: { detectedAgentId: string } }
    ).terminalInfo.detectedAgentId = "gemini";

    terminal.submit("line1\nline2");

    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock.mock.calls[0]?.[0]).toBe("line1\x1b\rline2");
    await vi.advanceTimersByTimeAsync(250);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("routes focus-in (CSI I) to activityMonitor.notifyFocus instead of onInput (#8865)", () => {
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "claude" });
    const monitor = (
      terminal as unknown as { activityMonitor: { notifyFocus: () => void; onInput: () => void } }
    ).activityMonitor;
    expect(monitor).toBeTruthy();
    const notifyFocusSpy = vi.spyOn(monitor, "notifyFocus");
    const onInputSpy = vi.spyOn(monitor, "onInput");

    const result = terminal.tryWrite("\x1b[I");

    expect(result.ok).toBe(true);
    expect(notifyFocusSpy).toHaveBeenCalledTimes(1);
    expect(onInputSpy).not.toHaveBeenCalled();
    // Focus bytes still reach the PTY (vim's FocusGained etc. must keep working).
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b[I");
  });

  it("routes focus-out (CSI O) to activityMonitor.notifyFocus on write() too (#8865)", () => {
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "claude" });
    const monitor = (
      terminal as unknown as { activityMonitor: { notifyFocus: () => void; onInput: () => void } }
    ).activityMonitor;
    const notifyFocusSpy = vi.spyOn(monitor, "notifyFocus");
    const onInputSpy = vi.spyOn(monitor, "onInput");

    terminal.write("\x1b[O");

    expect(notifyFocusSpy).toHaveBeenCalledTimes(1);
    expect(onInputSpy).not.toHaveBeenCalled();
    expect(ptyWriteMock).toHaveBeenCalledWith("\x1b[O");
  });

  it("normal keystrokes still go through onInput, not notifyFocus (#8865)", () => {
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "claude" });
    const monitor = (
      terminal as unknown as { activityMonitor: { notifyFocus: () => void; onInput: () => void } }
    ).activityMonitor;
    const notifyFocusSpy = vi.spyOn(monitor, "notifyFocus");
    const onInputSpy = vi.spyOn(monitor, "onInput");

    terminal.tryWrite("a");

    expect(onInputSpy).toHaveBeenCalledWith("a");
    expect(notifyFocusSpy).not.toHaveBeenCalled();
  });

  it("focus event resets the agentOutputTemperature baseline (#8865)", () => {
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "claude" });
    const internals = terminal as unknown as {
      agentOutputTemperature: { reset: () => void };
      agentOutputContentSnapshot: unknown;
    };
    const tempResetSpy = vi.spyOn(internals.agentOutputTemperature, "reset");

    terminal.tryWrite("\x1b[I");

    expect(tempResetSpy).toHaveBeenCalledTimes(1);
    expect(internals.agentOutputContentSnapshot).toBeUndefined();
  });

  it("noteAgentOutputActivity respects ActivityMonitor focus suppression (#8865)", () => {
    const handleActivityState = vi.fn();
    const ctx = defaultSpawnContext();
    const terminal = new TerminalProcess(
      "t-focus-bypass",
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: "claude",
      },
      { emitData: () => {}, onExit: () => {} },
      {
        agentStateService: { handleActivityState } as any,
        ptyPool: null,
        processTreeCache: null,
      },
      ctx,
      createMockPty()
    );

    const internals = terminal as unknown as {
      isAgentLive: boolean;
      terminalInfo: { agentState: string };
      activityMonitor: { notifyFocus: (ms?: number) => void };
      agentOutputContentSnapshot: unknown;
      noteAgentOutputActivity: (before: unknown) => void;
      getAgentOutputContentSnapshot: () => unknown;
    };

    // Force a busy-promoting condition: agent live, state idle, baseline set,
    // visible delta after focus is non-trivial.
    Object.defineProperty(terminal, "isAgentLive", { value: true, configurable: true });
    internals.terminalInfo.agentState = "idle";
    // Seed the snapshot baseline so the activity check has something to diff
    // against in the noteAgentOutputActivity call below.
    internals.agentOutputContentSnapshot = { lines: ["before"] };
    internals.getAgentOutputContentSnapshot = () => ({ lines: ["after redraw with lots of new"] });

    internals.activityMonitor.notifyFocus(2000);
    // Clear any busy emissions from startPolling()'s initial state — we only
    // care about whether noteAgentOutputActivity promotes during the window.
    handleActivityState.mockClear();
    internals.noteAgentOutputActivity({ lines: ["before"] });

    const busyCalls = handleActivityState.mock.calls.filter((call) => call[1] === "busy");
    expect(busyCalls.length).toBe(0);
  });

  it("noteAgentOutputActivity respects ActivityMonitor recent-user-input suppression (#10925)", () => {
    const handleActivityState = vi.fn();
    const ctx = defaultSpawnContext();
    const terminal = new TerminalProcess(
      "t-input-bypass",
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: "claude",
      },
      { emitData: () => {}, onExit: () => {} },
      {
        agentStateService: { handleActivityState } as any,
        ptyPool: null,
        processTreeCache: null,
      },
      ctx,
      createMockPty()
    );

    const internals = terminal as unknown as {
      isAgentLive: boolean;
      terminalInfo: { agentState: string };
      activityMonitor: { onInput: (data: string) => void };
      agentOutputContentSnapshot: unknown;
      noteAgentOutputActivity: (before: unknown) => void;
      getAgentOutputContentSnapshot: () => unknown;
    };

    // Force a busy-promoting condition: agent live, state idle, baseline set,
    // visible delta after a mouse-report-driven redraw is non-trivial.
    Object.defineProperty(terminal, "isAgentLive", { value: true, configurable: true });
    internals.terminalInfo.agentState = "idle";
    internals.agentOutputContentSnapshot = { lines: ["before"] };
    internals.getAgentOutputContentSnapshot = () => ({ lines: ["after redraw with lots of new"] });

    // A wheel tick sends an SGR mouse-report sequence, which stamps
    // lastUserInputAt (mouse bytes aren't diverted to focus handling). The
    // direct promotion path must not flip the idle agent to busy while that
    // input-echo window is open.
    internals.activityMonitor.onInput("\x1b[<64;10;5M");
    handleActivityState.mockClear();
    internals.noteAgentOutputActivity({ lines: ["before"] });

    const busyCalls = handleActivityState.mock.calls.filter((call) => call[1] === "busy");
    expect(busyCalls.length).toBe(0);
  });

  it("noteAgentOutputActivity arms ActivityMonitor via notifyExternalPromotion when it promotes (#9875)", () => {
    const handleActivityState = vi.fn();
    const ctx = defaultSpawnContext();
    const terminal = new TerminalProcess(
      "t-ext-promo",
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: "claude",
      },
      { emitData: () => {}, onExit: () => {} },
      {
        agentStateService: { handleActivityState } as any,
        ptyPool: null,
        processTreeCache: null,
      },
      ctx,
      createMockPty()
    );

    const internals = terminal as unknown as {
      terminalInfo: { agentState: string };
      activityMonitor: { notifyExternalPromotion: (now?: number) => void };
      agentOutputTemperature: { observeDelta: (...args: unknown[]) => unknown };
      agentOutputContentSnapshot: unknown;
      noteAgentOutputActivity: (before: unknown) => void;
      getAgentOutputContentSnapshot: () => unknown;
    };

    Object.defineProperty(terminal, "isAgentLive", { value: true, configurable: true });
    internals.terminalInfo.agentState = "waiting";
    internals.agentOutputContentSnapshot = { lines: ["before"] };
    internals.getAgentOutputContentSnapshot = () => ({ lines: ["after redraw with new text"] });
    // The temperature needs several sustained samples before hinting busy;
    // force the hint so the test exercises the promotion branch directly.
    vi.spyOn(internals.agentOutputTemperature, "observeDelta").mockReturnValue({
      stateHint: "busy",
      changed: true,
      changedChars: 64,
      heatAdded: 50,
      temperature: 80,
      suppressed: false,
      seeded: false,
    });
    const promoteSpy = vi.spyOn(internals.activityMonitor, "notifyExternalPromotion");
    handleActivityState.mockClear();

    internals.noteAgentOutputActivity({ lines: ["before"] });

    // The direct FSM promotion still fires…
    expect(handleActivityState).toHaveBeenCalledWith(expect.anything(), "busy", {
      trigger: "output",
    });
    // …and now also arms the monitor so its idle paths can bring the FSM back.
    expect(promoteSpy).toHaveBeenCalledTimes(1);
  });

  it("noteAgentOutputActivity does not arm ActivityMonitor while focus-suppressed (#9875)", () => {
    const handleActivityState = vi.fn();
    const ctx = defaultSpawnContext();
    const terminal = new TerminalProcess(
      "t-ext-promo-focus",
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: "claude",
      },
      { emitData: () => {}, onExit: () => {} },
      {
        agentStateService: { handleActivityState } as any,
        ptyPool: null,
        processTreeCache: null,
      },
      ctx,
      createMockPty()
    );

    const internals = terminal as unknown as {
      terminalInfo: { agentState: string };
      activityMonitor: {
        notifyFocus: (ms?: number) => void;
        notifyExternalPromotion: (now?: number) => void;
      };
      agentOutputTemperature: { observeDelta: (...args: unknown[]) => unknown };
      agentOutputContentSnapshot: unknown;
      noteAgentOutputActivity: (before: unknown) => void;
      getAgentOutputContentSnapshot: () => unknown;
    };

    Object.defineProperty(terminal, "isAgentLive", { value: true, configurable: true });
    internals.terminalInfo.agentState = "waiting";
    internals.agentOutputContentSnapshot = { lines: ["before"] };
    internals.getAgentOutputContentSnapshot = () => ({ lines: ["after redraw with new text"] });
    vi.spyOn(internals.agentOutputTemperature, "observeDelta").mockReturnValue({
      stateHint: "busy",
      changed: true,
      changedChars: 64,
      heatAdded: 50,
      temperature: 80,
      suppressed: false,
      seeded: false,
    });
    const promoteSpy = vi.spyOn(internals.activityMonitor, "notifyExternalPromotion");

    internals.activityMonitor.notifyFocus(2000);
    handleActivityState.mockClear();
    internals.noteAgentOutputActivity({ lines: ["before"] });

    expect(promoteSpy).not.toHaveBeenCalled();
    const busyCalls = handleActivityState.mock.calls.filter((call) => call[1] === "busy");
    expect(busyCalls.length).toBe(0);
  });

  it("delays Enter for Copilot (submitEnterDelayMs: 200) so Ink TUI registers input", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "copilot" });
    // Input protocol is driven by detectedAgentId (live process), not the launch hint.
    // Simulate the process detector firing for Copilot.
    (
      terminal as unknown as { terminalInfo: { detectedAgentId: string } }
    ).terminalInfo.detectedAgentId = "copilot";

    terminal.submit("test");

    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("test");
    await vi.advanceTimersByTimeAsync(50);
    expect(ptyWriteMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(ptyWriteMock).toHaveBeenCalledTimes(2);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });
});
