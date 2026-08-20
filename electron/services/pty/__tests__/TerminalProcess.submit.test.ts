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
      agentOutputTemperature: { observeDelta: (...args: unknown[]) => unknown };
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
    // Force the temperature to hint busy so the test actually reaches the
    // promotion branch — otherwise a single delta never hints busy and the
    // test would pass even with the input gate removed (mirrors #9875).
    vi.spyOn(internals.agentOutputTemperature, "observeDelta").mockReturnValue({
      stateHint: "busy",
      changed: true,
      changedChars: 64,
      heatAdded: 50,
      temperature: 80,
      suppressed: false,
      seeded: false,
    });

    // A wheel tick sends an SGR mouse-report sequence, which stamps
    // lastUserInputAt (mouse bytes aren't diverted to focus handling). The
    // direct promotion path must not flip the idle agent to busy while that
    // input-echo window is open — even though the temperature hints busy.
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

  // #11875. A slow submit must keep exclusive ownership of the agent's composer
  // until it finishes. The old `Promise.race` in `drainSubmitQueue` released the
  // serialiser when the 3000ms timer fired but left `performSubmit` running, so
  // the next submit wrote its body into the same composer and the abandoned
  // submit's trailing Enter arrived afterwards — submitting `<FIRST><SECOND>`
  // as one merged prompt.
  //
  // The delay here is an explicitly deferred output-settle gate, NOT a large
  // paced payload. The byte pacing that used to create this window was deleted
  // in this same change, so a size-based trigger would quietly stop exercising
  // the bug. The 4096-char sentinel stays as a stream-integrity payload: it
  // proves a >512-byte write still arrives whole and in order now that it goes
  // straight to node-pty instead of through a 50-byte chunk queue.
  it("keeps the composer exclusive while a slow submit is still in flight", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ kind: "terminal", launchAgentId: "gemini" });
    // Gemini has supportsBracketedPaste: false, which is what routes performSubmit
    // through the waitForOutputSettle branch this test gates on.
    (
      terminal as unknown as { terminalInfo: { detectedAgentId: string } }
    ).terminalInfo.detectedAgentId = "gemini";

    // CR/LF-free on purpose: the assertions below locate composer frames by
    // counting "\r", and a newline would also trip the shell-submit detection
    // in write().
    const sentinel = "S".repeat(4096);
    terminal.write(sentinel);
    await vi.advanceTimersByTimeAsync(1000);

    const writeQueue = (
      terminal as unknown as {
        writeQueue: { waitForOutputSettle: (opts: unknown) => Promise<void> };
      }
    ).writeQueue;

    // Hold the first submit past the slow threshold, let the second settle
    // immediately. This is the whole clock of the test.
    let releaseFirstSettle: (() => void) | undefined;
    const firstSettle = new Promise<void>((resolve) => {
      releaseFirstSettle = resolve;
    });
    let settleCalls = 0;
    vi.spyOn(writeQueue, "waitForOutputSettle").mockImplementation(() => {
      settleCalls++;
      return settleCalls === 1 ? firstSettle : Promise.resolve();
    });

    terminal.submit("<FIRST>");
    terminal.submit("<SECOND>");

    // The first body is written before performSubmit's first await.
    expect(ptyWriteMock.mock.calls.map((c) => c[0]).join("")).toContain("<FIRST>");

    // Past the 3000ms slow threshold: the first submit is still holding the
    // composer, so the second must not have written anything yet.
    await vi.advanceTimersByTimeAsync(3100);
    {
      const midStream = ptyWriteMock.mock.calls.map((c) => c[0]).join("");
      expect(midStream).not.toContain("<SECOND>");
      expect(midStream).not.toContain("\r");
    }

    releaseFirstSettle?.();
    await vi.advanceTimersByTimeAsync(1000);

    const stream = ptyWriteMock.mock.calls.map((c) => c[0]).join("");
    const firstEnter = stream.indexOf("\r");
    const secondEnter = stream.indexOf("\r", firstEnter + 1);
    expect(stream.indexOf("<FIRST>")).toBeLessThan(firstEnter);
    expect(stream.indexOf("<SECOND>")).toBeGreaterThan(firstEnter);
    expect(stream.indexOf("<SECOND>")).toBeLessThan(secondEnter);
    expect(stream.match(/\r/g)).toHaveLength(2);

    // The oversized write arrived whole and ahead of both composer frames.
    expect(stream.indexOf(sentinel)).toBe(0);

    vi.useRealTimers();
  });
});
